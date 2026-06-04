// R2 S3 endpoint client built on aws4fetch. Used for multipart upload
// orchestration (create / sign-part / complete / abort) and for issuing
// short-lived presigned GET URLs for downloads.

import { AwsClient } from 'aws4fetch';
import type { Bindings } from '../env';
import { HttpError } from '../utils/errors';

export interface StorageBackend {
  bucket: string;
  endpoint: string;
  objectUrl(key: string): string;

  createMultipartUpload(key: string, contentType?: string): Promise<string>;
  signPartUrl(key: string, uploadId: string, partNumber: number, ttlSeconds: number): Promise<string>;
  signGetUrl(key: string, ttlSeconds: number, opts?: { filename?: string; contentType?: string }): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<{ etag: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  headObject(key: string): Promise<{ size: number; etag: string; contentType?: string } | null>;
  deleteObject(key: string): Promise<void>;

  // Local-filesystem backend only (Node runtime). With S3/R2 these stay
  // undefined: clients transfer bytes directly to object storage via presigned
  // URLs, so the worker never serves them. See apps/worker/node/local-storage.mjs.
  writePart?(url: string, body: ArrayBuffer): Promise<{ etag: string }>;
  readBlob?(
    url: string,
  ): Promise<{ stream: ReadableStream; size: number; contentType?: string; filename?: string } | null>;
}

// Picks the storage backend for a request. A Node-runtime local-filesystem
// backend can be injected via env.STORAGE (see apps/worker/node/server.mjs);
// on Cloudflare there's no filesystem, so this is always the S3/R2 client.
export function makeStorage(env: Bindings): StorageBackend {
  if (env.STORAGE) return env.STORAGE;
  return makeS3(env);
}

export function makeS3(env: Bindings): StorageBackend {
  // Fail loudly (and clearly) when object storage isn't configured, instead of
  // letting a bogus endpoint surface as an opaque "internal server error".
  const accountConfigured = !!env.R2_ACCOUNT_ID && !env.R2_ACCOUNT_ID.includes('REPLACE');
  const missing: string[] = [];
  if (!env.S3_ENDPOINT && !accountConfigured) missing.push('S3_ENDPOINT 或 R2_ACCOUNT_ID');
  if (!env.R2_ACCESS_KEY_ID) missing.push('S3_ACCESS_KEY_ID');
  if (!env.R2_SECRET_ACCESS_KEY) missing.push('S3_SECRET_ACCESS_KEY');
  if (missing.length) {
    throw new HttpError(
      503,
      'storage_not_configured',
      `对象存储未配置：缺少 ${missing.join('、')}。Cloudflare/wrangler 运行时没有本地磁盘，必须配置 R2/S3 凭据；` +
        `若是本地或自托管，改用 Node 运行时（npm run dev:node / docker compose），默认即用本地文件夹存储。`,
    );
  }

  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: env.S3_REGION || 'auto',
  });
  const r2Default = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  // `endpoint` is what the worker itself calls (create/complete/abort/head/delete).
  // `publicEndpoint` is baked into presigned URLs handed to browsers/devices — it
  // may differ from `endpoint` in split-horizon setups (e.g. minio:9000 internally
  // vs localhost:9000 for the browser). Both default to the R2 endpoint.
  const endpoint = (env.S3_ENDPOINT || r2Default).replace(/\/+$/, '');
  const publicEndpoint = (env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT || r2Default).replace(/\/+$/, '');
  const bucket = env.R2_BUCKET_NAME;

  function buildUrl(base: string, key: string): string {
    // Path-style: <endpoint>/<bucket>/<key>. Key path-segments are encoded
    // but '/' is preserved so directory-like paths still work in the dashboard.
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${base}/${bucket}/${encoded}`;
  }
  // Server-side requests go to the internal endpoint.
  function objectUrl(key: string): string {
    return buildUrl(endpoint, key);
  }
  // Presigned URLs handed to clients go to the public endpoint.
  function signUrl(key: string): string {
    return buildUrl(publicEndpoint, key);
  }

  return {
    bucket,
    endpoint,
    objectUrl,

    async createMultipartUpload(key, contentType) {
      const headers: Record<string, string> = {};
      if (contentType) headers['content-type'] = contentType;
      const res = await aws.fetch(`${objectUrl(key)}?uploads=`, {
        method: 'POST',
        headers,
        body: '',
      });
      if (!res.ok) {
        throw new Error(`CreateMultipartUpload failed: ${res.status} ${await res.text()}`);
      }
      const xml = await res.text();
      const m = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
      if (!m || !m[1]) throw new Error(`CreateMultipartUpload: no UploadId in response: ${xml}`);
      return m[1];
    },

    async signPartUrl(key, uploadId, partNumber, ttlSeconds) {
      // We use query-signed URLs (signQuery: true) so the browser/CLI can PUT
      // directly without computing signatures client-side.
      const url =
        `${signUrl(key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}` +
        `&X-Amz-Expires=${ttlSeconds}`;
      const req = await aws.sign(url, {
        method: 'PUT',
        aws: { signQuery: true },
      });
      return req.url;
    },

    async signGetUrl(key, ttlSeconds, opts) {
      const params = new URLSearchParams();
      params.set('X-Amz-Expires', String(ttlSeconds));
      if (opts?.filename) {
        params.set('response-content-disposition', `attachment; filename="${opts.filename.replace(/"/g, '\\"')}"`);
      }
      if (opts?.contentType) {
        params.set('response-content-type', opts.contentType);
      }
      const req = await aws.sign(`${signUrl(key)}?${params.toString()}`, {
        method: 'GET',
        aws: { signQuery: true },
      });
      return req.url;
    },

    async completeMultipartUpload(key, uploadId, parts) {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        sorted
          .map(
            (p) =>
              `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
          )
          .join('') +
        `</CompleteMultipartUpload>`;
      const res = await aws.fetch(`${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body,
      });
      if (!res.ok) {
        throw new Error(`CompleteMultipartUpload failed: ${res.status} ${await res.text()}`);
      }
      const xml = await res.text();
      const m = xml.match(/<ETag>([^<]+)<\/ETag>/);
      return { etag: m?.[1] ?? '' };
    },

    async abortMultipartUpload(key, uploadId) {
      const res = await aws.fetch(`${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`AbortMultipartUpload failed: ${res.status} ${await res.text()}`);
      }
    },

    async headObject(key) {
      const res = await aws.fetch(objectUrl(key), { method: 'HEAD' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HeadObject failed: ${res.status}`);
      return {
        size: Number(res.headers.get('content-length') ?? '0'),
        etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
        contentType: res.headers.get('content-type') ?? undefined,
      };
    },

    async deleteObject(key) {
      const res = await aws.fetch(objectUrl(key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        throw new Error(`DeleteObject failed: ${res.status}`);
      }
    },
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
