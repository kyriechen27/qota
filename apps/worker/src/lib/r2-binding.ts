// R2-binding storage backend (Cloudflare) — uses the native R2 binding
// (env.BUCKET) directly, like the remote-file project. No R2_ACCOUNT_ID, no S3
// access keys, no presigned URLs needed; deployment only needs the BUCKET binding.
//
// Since an R2 binding can't issue presigned URLs, the worker serves the bytes
// itself through the /api/storage/* routes (HMAC-signed + TTL-bound — the same
// trust model as a presigned URL). Multipart upload streams each part to R2 via
// uploadPart; download streams the object body back.

import type { R2Bucket } from '@cloudflare/workers-types';
import type { Bindings } from '../env';
import type { StorageBackend } from './s3';
import { constantTimeEqual } from '../utils/encoding';
import { HttpError } from '../utils/errors';

const PART_PATH = '/api/storage/part';
const BLOB_PATH = '/api/storage/blob';
const TEXT = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', TEXT.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, TEXT.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Canonical string = "<path>\n<sorted key=value, excluding sig>" — host-independent.
function canonical(path: string, params: Record<string, string>): string {
  const q = Object.keys(params)
    .filter((k) => k !== 'sig')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return `${path}\n${q}`;
}

export function makeR2Storage(env: Bindings): StorageBackend {
  const bucket = env.BUCKET as R2Bucket;
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new HttpError(503, 'jwt_secret_missing', 'JWT_SECRET 未配置(R2 存储链接签名需要)。');
  }

  async function signedUrl(path: string, params: Record<string, string>, ttlSeconds: number): Promise<string> {
    const withExp = { ...params, exp: String(Math.floor(Date.now() / 1000) + ttlSeconds) };
    const sig = await hmacHex(secret, canonical(path, withExp));
    return `${path}?${new URLSearchParams({ ...withExp, sig }).toString()}`;
  }
  async function verify(urlString: string): Promise<Record<string, string>> {
    const u = new URL(urlString, 'http://local');
    const params = Object.fromEntries(u.searchParams.entries());
    const expect = await hmacHex(secret, canonical(u.pathname, params));
    if (!constantTimeEqual(params.sig || '', expect)) throw new HttpError(403, 'bad_signature', 'invalid storage token');
    if (!params.exp || Number(params.exp) * 1000 < Date.now()) throw new HttpError(403, 'expired', 'storage token expired');
    return params;
  }

  return {
    bucket: 'r2',
    endpoint: 'r2-binding',
    objectUrl: (key) => key,

    async createMultipartUpload(key, contentType) {
      const up = await bucket.createMultipartUpload(key, contentType ? { httpMetadata: { contentType } } : undefined);
      return up.uploadId;
    },
    signPartUrl(key, uploadId, partNumber, ttlSeconds) {
      return signedUrl(PART_PATH, { key, uploadId, part: String(partNumber) }, ttlSeconds);
    },
    signGetUrl(key, ttlSeconds, opts) {
      const params: Record<string, string> = { key };
      if (opts?.filename) params.filename = opts.filename;
      if (opts?.contentType) params.ct = opts.contentType;
      return signedUrl(BLOB_PATH, params, ttlSeconds);
    },
    async completeMultipartUpload(key, uploadId, parts) {
      const up = bucket.resumeMultipartUpload(key, uploadId);
      const sorted = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ partNumber: p.partNumber, etag: p.etag.replace(/^"|"$/g, '') }));
      const obj = await up.complete(sorted);
      return { etag: obj.etag };
    },
    async abortMultipartUpload(key, uploadId) {
      try {
        await bucket.resumeMultipartUpload(key, uploadId).abort();
      } catch {
        /* ignore */
      }
    },
    async headObject(key) {
      const o = await bucket.head(key);
      if (!o) return null;
      return { size: o.size, etag: o.etag, contentType: o.httpMetadata?.contentType };
    },
    async deleteObject(key) {
      await bucket.delete(key);
    },

    // ---- byte handlers (invoked by /api/storage/* routes) ------------------
    async writePart(urlString, body) {
      const { key, uploadId, part } = await verify(urlString);
      if (!key || !uploadId || !part) throw new HttpError(400, 'bad_request', 'missing key/uploadId/part');
      const uploaded = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(Number(part), body);
      return { etag: uploaded.etag };
    },
    async readBlob(urlString) {
      const { key, filename, ct } = await verify(urlString);
      if (!key) throw new HttpError(400, 'bad_request', 'missing key');
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { stream: obj.body, size: obj.size, contentType: ct || obj.httpMetadata?.contentType, filename };
    },
  };
}
