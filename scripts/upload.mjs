#!/usr/bin/env node
// qota CLI multipart uploader.
//
// Usage:
//   QOTA_API=https://api.qota.example.com \
//   QOTA_TOKEN=<jwt or paste a developer's bearer> \
//   node scripts/upload.mjs \
//     --project-id 3 --version 1.2.3 [--channel stable] \
//     [--notes 'nightly build'] [--mandatory] \
//     [--min 1.0.0] [--max 1.9.9] [--rollout 100] \
//     [--part-size 16] [--concurrency 4] \
//     --file ./build/firmware-1.2.3.bin
//
// Also accepts `--resume <sessionId>` to continue a previously interrupted upload
// (re-reads the file, skips already-uploaded parts based on /api/upload/sessions/:id).

import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { argv, exit, env, stdout } from 'node:process';

const ALL_OPTS = {
  api: { type: 'string' },
  token: { type: 'string' },
  'project-id': { type: 'string' },
  version: { type: 'string' },
  channel: { type: 'string' },
  notes: { type: 'string' },
  mandatory: { type: 'boolean' },
  min: { type: 'string' },
  max: { type: 'string' },
  rollout: { type: 'string' },
  'part-size': { type: 'string' },
  concurrency: { type: 'string' },
  file: { type: 'string' },
  resume: { type: 'string' },
  help: { type: 'boolean' },
};

const { values } = parseArgs({ args: argv.slice(2), options: ALL_OPTS, allowPositionals: false });

if (values.help) {
  console.log(`qota multipart uploader
  --file <path>           OTA file to upload (required)
  --project-id <id>       Target project (required, unless --resume)
  --version <semver>      Target version label (required, unless --resume)
  --channel <ch>          Release channel (default: stable)
  --notes <text>          Release notes (optional)
  --mandatory             Mark as mandatory upgrade
  --min <ver>             Minimum installed version that is allowed to upgrade
  --max <ver>             Maximum installed version that is allowed to upgrade
  --rollout <0..100>      Rollout percentage (default 100; MVP doesn't enforce)
  --part-size <MB>        Multipart chunk size hint (default 16; clamped 5..64)
  --concurrency <N>       Parallel part uploads (default 4)
  --resume <sessionId>    Resume an in_progress upload session
Env:
  QOTA_API      API base URL, e.g. https://api.qota.example.com
  QOTA_TOKEN    Bearer JWT (developer / customer_admin / super_admin)
`);
  exit(0);
}

const apiBase = values.api ?? env.QOTA_API;
const apiToken = values.token ?? env.QOTA_TOKEN;
if (!apiBase) die('--api or QOTA_API required');
if (!apiToken) die('--token or QOTA_TOKEN required');
if (!values.file) die('--file required');

const filePath = values.file;
const concurrency = Math.max(1, Math.min(16, Number(values.concurrency ?? '4')));
const partSizeMB = Math.max(5, Math.min(64, Number(values['part-size'] ?? '16')));
const partSize = partSizeMB * 1024 * 1024;
const stat = statSync(filePath);
const totalSize = stat.size;
const filename = filePath.split('/').pop() ?? 'firmware.bin';

console.log(`[qota] file=${filePath} size=${humanBytes(totalSize)} part=${partSizeMB}MB conc=${concurrency}`);

const sha256 = sha256File(filePath);
console.log(`[qota] sha256=${sha256}`);

let session, uploadedParts;

if (values.resume) {
  const r = await api(`/api/upload/sessions/${values.resume}`);
  session = r;
  uploadedParts = r.uploadedParts ?? [];
  console.log(`[qota] resume session=${session.id} uploadedParts=${uploadedParts.length}/${Math.ceil(session.totalSize / session.partSize)}`);
  if (session.status !== 'in_progress') die(`session is ${session.status}, cannot resume`);
  if (session.totalSize !== totalSize) die(`local file size (${totalSize}) != session totalSize (${session.totalSize})`);
} else {
  if (!values['project-id']) die('--project-id required');
  if (!values.version) die('--version required');
  const init = await api(`/api/upload/init`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: Number(values['project-id']),
      filename,
      totalSize,
      contentType: 'application/octet-stream',
      version: values.version,
      releaseChannel: values.channel ?? undefined,
      notes: values.notes ?? undefined,
      isMandatory: !!values.mandatory,
      minVersion: values.min ?? undefined,
      maxVersion: values.max ?? undefined,
      rolloutPercentage: values.rollout ? Number(values.rollout) : undefined,
      partSizeHint: partSize,
      expectedSha256: sha256,
    }),
  });
  session = {
    id: init.sessionId,
    uploadId: init.uploadId,
    r2Key: init.key,
    totalSize,
    partSize: init.partSize,
  };
  uploadedParts = init.uploadedParts ?? [];
  console.log(`[qota] init session=${session.id} key=${session.r2Key} partSize=${session.partSize}`);
}

const partCount = Math.ceil(session.totalSize / session.partSize);
const knownParts = new Map(uploadedParts.map((p) => [p.partNumber, p]));
const allParts = new Array(partCount).fill(null);
for (const p of uploadedParts) allParts[p.partNumber - 1] = { partNumber: p.partNumber, etag: p.etag, size: p.size };

const fd = openSync(filePath, 'r');
try {
  const todo = [];
  for (let i = 1; i <= partCount; i++) if (!knownParts.has(i)) todo.push(i);
  console.log(`[qota] uploading ${todo.length} new parts (${partCount - todo.length} already done)`);

  let done = partCount - todo.length;
  const startedAt = Date.now();

  await runPool(todo, concurrency, async (partNumber) => {
    const offset = (partNumber - 1) * session.partSize;
    const length = Math.min(session.partSize, session.totalSize - offset);
    const buf = Buffer.allocUnsafe(length);
    readSync(fd, buf, 0, length, offset);
    const { url } = await api(`/api/upload/sign-part`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id, partNumber }),
    });
    let etag;
    let tries = 0;
    while (true) {
      tries++;
      try {
        etag = await putPart(url, buf);
        break;
      } catch (e) {
        if (tries >= 3) throw e;
        console.warn(`[qota] part ${partNumber} retry ${tries}: ${e.message}`);
        await sleep(500 * tries);
      }
    }
    allParts[partNumber - 1] = { partNumber, etag, size: length };
    done++;
    const pct = ((done / partCount) * 100).toFixed(1);
    const speed = ((done * session.partSize) / 1024 / 1024 / ((Date.now() - startedAt) / 1000 + 1e-9)).toFixed(1);
    stdout.write(`\r[qota] ${done}/${partCount} parts  ${pct}%  ~${speed} MB/s   `);
  });
  stdout.write('\n');

  // Complete
  const parts = allParts.filter(Boolean);
  if (parts.length !== partCount) die(`assembled ${parts.length} parts, expected ${partCount}`);
  console.log(`[qota] completing…`);
  const ver = await api(`/api/upload/complete`, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: session.id,
      parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag, size: p.size })),
      sha256,
    }),
  });
  console.log(`[qota] ok → version id=${ver.id} version=${ver.version} channel=${ver.releaseChannel} sha=${ver.sha256?.slice(0, 12)}…`);
} catch (e) {
  console.error('\n[qota] upload failed:', e.message ?? e);
  if (!values.resume && session?.id) {
    console.log(`[qota] aborting session ${session.id}…`);
    await api(`/api/upload/abort`, { method: 'POST', body: JSON.stringify({ sessionId: session.id }) }).catch(() => {});
  } else if (session?.id) {
    console.log(`[qota] keeping session ${session.id} for resume (--resume ${session.id})`);
  }
  exit(1);
} finally {
  closeSync(fd);
}

// ============================================================
// helpers
// ============================================================
function die(msg) {
  console.error(`[qota] ${msg}`);
  exit(2);
}
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function sha256File(path) {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}
async function api(path, init = {}) {
  const headers = { Authorization: `Bearer ${apiToken}`, ...(init.headers ?? {}) };
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(new URL(path, apiBase), { ...init, headers });
  if (!res.ok) {
    let body = await res.text();
    try {
      const j = JSON.parse(body);
      body = j.message ?? j.error ?? body;
    } catch {}
    throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}
async function putPart(url, buf) {
  // S3/R2 hand back absolute presigned URLs; the local-folder backend hands back
  // relative ones (/api/storage/part?…) — resolve those against the API base.
  const res = await fetch(new URL(url, apiBase), {
    method: 'PUT',
    body: buf,
    headers: { 'content-length': String(buf.length) },
  });
  if (!res.ok) {
    throw new Error(`PUT part: ${res.status} ${await res.text()}`);
  }
  const etag = (res.headers.get('etag') ?? '').replace(/"/g, '');
  if (!etag) throw new Error('R2 did not return ETag');
  return `"${etag}"`;
}
async function runPool(items, conc, fn) {
  const queue = [...items];
  const workers = [];
  for (let i = 0; i < Math.min(conc, queue.length); i++) {
    workers.push(
      (async () => {
        while (queue.length) {
          const item = queue.shift();
          if (item === undefined) return;
          await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
