// Byte endpoints for the local-filesystem storage backend (Node runtime only).
//
// The signed URL itself is the authorization (HMAC + TTL, minted by
// apps/worker/node/local-storage.mjs), so these are PUBLIC — no JWT middleware,
// exactly like an S3 presigned URL. With an S3/R2 backend env.STORAGE is
// undefined and these 404: clients PUT/GET object storage directly instead.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { notFound } from '../utils/errors';

export const storageRoutes = new Hono<AppEnv>();

// PUT /api/storage/part?uploadId=..&part=..&exp=..&sig=..
storageRoutes.put('/part', async (c) => {
  const store = c.env.STORAGE;
  if (!store?.writePart) throw notFound();
  const body = await c.req.arrayBuffer();
  const { etag } = await store.writePart(c.req.url, body);
  // Clients read the ETag header back to confirm the part (same-origin here, so
  // it's readable without Access-Control-Expose-Headers).
  return new Response(null, { status: 200, headers: { ETag: etag } });
});

// GET /api/storage/blob?key=..&filename=..&ct=..&exp=..&sig=..
storageRoutes.get('/blob', async (c) => {
  const store = c.env.STORAGE;
  if (!store?.readBlob) throw notFound();
  const blob = await store.readBlob(c.req.url);
  if (!blob) throw notFound();
  const headers: Record<string, string> = {
    'content-length': String(blob.size),
    'content-type': blob.contentType || 'application/octet-stream',
    'cache-control': 'private, max-age=0',
  };
  if (blob.filename) {
    headers['content-disposition'] = `attachment; filename="${blob.filename.replace(/"/g, '\\"')}"`;
  }
  return new Response(blob.stream, { status: 200, headers });
});
