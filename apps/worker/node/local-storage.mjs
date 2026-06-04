// Local-filesystem storage backend for the Node runtime (dev:node / Docker /
// bare metal). It implements the same StorageBackend surface as the S3/R2
// client in apps/worker/src/lib/s3.ts — but since there's no object-storage
// server to presign against, the worker serves the bytes itself:
//
//   • signPartUrl / signGetUrl return URLs pointing back at the worker's own
//     /api/storage/* routes, carrying a short-lived HMAC token (TTL-bound and
//     tamper-proof — the same trust model as an S3 presigned URL).
//   • writePart / readBlob are the byte handlers those routes delegate to.
//
// URLs are returned RELATIVE (/api/storage/...) so they resolve against the
// caller's own origin — no public-host config and proxy-friendly. On Cloudflare
// there is no filesystem, so this module is never imported there; only
// apps/worker/node/server.mjs wires it in.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { HttpError } from '../src/utils/errors.ts';

const PART_PATH = '/api/storage/part';
const BLOB_PATH = '/api/storage/blob';

export function makeLocalStorage({ baseDir, bucket, secret }) {
  if (!secret) throw new Error('local storage requires a signing secret (JWT_SECRET)');
  const objectsDir = normalize(join(baseDir, bucket));
  const uploadsDir = join(baseDir, '.uploads');

  // ---- path helpers (keys may contain '/'; keep them as nested dirs) -------
  function objectPath(key) {
    const p = normalize(join(objectsDir, key));
    // Defense in depth: keys are HMAC-signed so can't be tampered, but never
    // let one escape the objects dir via '..'.
    if (p !== objectsDir && !p.startsWith(objectsDir + sep)) {
      throw new HttpError(400, 'bad_key', 'invalid object key');
    }
    return p;
  }
  const partsDir = (uploadId) => join(uploadsDir, uploadId);
  const partPath = (uploadId, partNumber) => join(partsDir(uploadId), String(partNumber));

  // ---- HMAC URL signing (mirrors S3 presigned-URL semantics) ---------------
  // Canonical string = "<path>\n<sorted key=value pairs, excluding sig>".
  // Independent of host, so it survives reverse proxies / vite's dev proxy.
  function canonical(path, params) {
    const q = Object.keys(params)
      .filter((k) => k !== 'sig')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return `${path}\n${q}`;
  }
  const hmac = (data) => createHmac('sha256', secret).update(data).digest('hex');

  function signedUrl(path, params, ttlSeconds) {
    const withExp = { ...params, exp: String(Math.floor(Date.now() / 1000) + ttlSeconds) };
    const sig = hmac(canonical(path, withExp));
    return `${path}?${new URLSearchParams({ ...withExp, sig }).toString()}`;
  }
  function verify(urlString) {
    const u = new URL(urlString, 'http://local'); // base lets us accept relative URLs too
    const params = Object.fromEntries(u.searchParams.entries());
    const expect = hmac(canonical(u.pathname, params));
    const got = Buffer.from(params.sig || '');
    const want = Buffer.from(expect);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new HttpError(403, 'bad_signature', 'invalid storage token');
    }
    if (!params.exp || Number(params.exp) * 1000 < Date.now()) {
      throw new HttpError(403, 'expired', 'storage token expired');
    }
    return params;
  }

  return {
    bucket,
    endpoint: 'local',
    objectUrl: (key) => objectPath(key),

    async createMultipartUpload(_key, _contentType) {
      const uploadId = randomBytes(16).toString('hex');
      await mkdir(partsDir(uploadId), { recursive: true });
      return uploadId;
    },

    async signPartUrl(_key, uploadId, partNumber, ttlSeconds) {
      return signedUrl(PART_PATH, { uploadId, part: String(partNumber) }, ttlSeconds);
    },

    async signGetUrl(key, ttlSeconds, opts) {
      const params = { key };
      if (opts?.filename) params.filename = opts.filename;
      if (opts?.contentType) params.ct = opts.contentType;
      return signedUrl(BLOB_PATH, params, ttlSeconds);
    },

    async completeMultipartUpload(key, uploadId, parts) {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const finalPath = objectPath(key);
      await mkdir(dirname(finalPath), { recursive: true });
      const hash = createHash('md5');
      const out = createWriteStream(finalPath);
      try {
        for (const p of sorted) {
          const data = await readFile(partPath(uploadId, p.partNumber)); // one part (<=64MB) at a time
          hash.update(data);
          if (!out.write(data)) await new Promise((r) => out.once('drain', r));
        }
      } catch (e) {
        out.destroy();
        throw new HttpError(400, 'assemble_failed', `failed to assemble parts: ${e.message ?? e}`);
      }
      await new Promise((res, rej) => {
        out.on('error', rej);
        out.end(res);
      });
      await rm(partsDir(uploadId), { recursive: true, force: true });
      return { etag: `"${hash.digest('hex')}"` };
    },

    async abortMultipartUpload(_key, uploadId) {
      await rm(partsDir(uploadId), { recursive: true, force: true });
    },

    async headObject(key) {
      try {
        const st = await stat(objectPath(key));
        return { size: st.size, etag: '', contentType: undefined };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },

    async deleteObject(key) {
      try {
        await unlink(objectPath(key));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },

    // ---- byte handlers — invoked by the /api/storage/* routes ---------------
    async writePart(urlString, body) {
      const { uploadId, part } = verify(urlString);
      if (!uploadId || !part) throw new HttpError(400, 'bad_request', 'missing uploadId/part');
      await mkdir(partsDir(uploadId), { recursive: true });
      const buf = Buffer.from(body);
      await writeFile(partPath(uploadId, Number(part)), buf);
      return { etag: `"${createHash('md5').update(buf).digest('hex')}"` };
    },

    async readBlob(urlString) {
      const { key, filename, ct } = verify(urlString);
      if (!key) throw new HttpError(400, 'bad_request', 'missing key');
      let st;
      try {
        st = await stat(objectPath(key));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      return {
        stream: Readable.toWeb(createReadStream(objectPath(key))),
        size: st.size,
        contentType: ct,
        filename,
      };
    },
  };
}
