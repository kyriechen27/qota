// Browser-side multipart upload orchestration. Drives the same protocol as
// scripts/upload.mjs but runs in the browser using File / Blob slicing and
// XHR PUT (so we get per-part progress events).

import { api } from './api';

const SHA256_CHUNK = 4 * 1024 * 1024;

export interface UploadPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface UploadJobOptions {
  projectId: number;
  file: File;
  version: string;
  releaseChannel?: string;
  notes?: string;
  isMandatory?: boolean;
  minVersion?: string | null;
  maxVersion?: string | null;
  rolloutPercentage?: number;
  overwriteExisting?: boolean;
  partSizeHint?: number;
  concurrency?: number;
  onProgress?: (loaded: number, total: number, phase: 'sha256' | 'upload') => void;
  signal?: AbortSignal;
}

export interface UploadJobHandle {
  sessionId: number;
  abort: () => Promise<void>;
  promise: Promise<{
    versionId: number;
    sessionId: number;
    sha256: string;
  }>;
}

export async function sha256File(file: File, onProgress?: (loaded: number, total: number) => void): Promise<string> {
  // crypto.subtle.digest doesn't stream, so we chunk-hash via WebCrypto subtle on each slice
  // and combine using crypto.subtle's incremental API... which doesn't exist. So we read the
  // whole file. For huge files this is slow but unavoidable in a browser today. Acceptable
  // for OTA images up to a few GB on a modern laptop.
  let loaded = 0;
  const total = file.size;
  const chunks: ArrayBuffer[] = [];
  for (let off = 0; off < total; off += SHA256_CHUNK) {
    const slice = file.slice(off, Math.min(off + SHA256_CHUNK, total));
    const buf = await slice.arrayBuffer();
    chunks.push(buf);
    loaded += buf.byteLength;
    onProgress?.(loaded, total);
  }
  // Concatenate into one buffer for digest
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const c of chunks) {
    merged.set(new Uint8Array(c), cursor);
    cursor += c.byteLength;
  }
  const hash = await crypto.subtle.digest('SHA-256', merged);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.responseType = 'text';
    let lastLoaded = 0;
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      onProgress(ev.loaded - lastLoaded);
      lastLoaded = ev.loaded;
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = (xhr.getResponseHeader('ETag') ?? '').replace(/^"|"$/g, '');
        if (!etag) return reject(new Error('R2 did not return ETag (check bucket CORS — ExposeHeaders must include ETag)'));
        resolve(`"${etag}"`);
      } else {
        reject(new Error(`PUT part: ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
      }
    };
    xhr.onerror = () => reject(new Error('network error during PUT'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}

export function startUpload(opts: UploadJobOptions): UploadJobHandle {
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  let sessionId = 0;
  let aborted = false;
  const internalAbort = new AbortController();
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => internalAbort.abort(), { once: true });
  }

  const promise = (async () => {
    opts.onProgress?.(0, opts.file.size, 'sha256');
    const sha256 = await sha256File(opts.file, (loaded, total) => opts.onProgress?.(loaded, total, 'sha256'));

    const init = await api.uploadInit({
      projectId: opts.projectId,
      filename: opts.file.name,
      totalSize: opts.file.size,
      contentType: opts.file.type || 'application/octet-stream',
      version: opts.version,
      releaseChannel: opts.releaseChannel,
      notes: opts.notes,
      isMandatory: opts.isMandatory,
      minVersion: opts.minVersion,
      maxVersion: opts.maxVersion,
      rolloutPercentage: opts.rolloutPercentage,
      overwriteExisting: opts.overwriteExisting,
      expectedSha256: sha256,
      partSizeHint: opts.partSizeHint,
    });
    sessionId = init.sessionId;

    const partCount = init.partCount;
    const partSize = init.partSize;
    const known = new Map((init.uploadedParts ?? []).map((p) => [p.partNumber, p]));
    const parts: UploadPart[] = new Array(partCount);
    let bytesDone = [...known.values()].reduce((a, b) => a + b.size, 0);
    for (const k of known.values()) parts[k.partNumber - 1] = { partNumber: k.partNumber, etag: k.etag, size: k.size };
    opts.onProgress?.(bytesDone, opts.file.size, 'upload');

    const todo: number[] = [];
    for (let i = 1; i <= partCount; i++) if (!known.has(i)) todo.push(i);

    async function uploadOne(partNumber: number) {
      if (internalAbort.signal.aborted) throw new DOMException('aborted', 'AbortError');
      const offset = (partNumber - 1) * partSize;
      const end = Math.min(offset + partSize, opts.file.size);
      const blob = opts.file.slice(offset, end);
      let { url } = await api.uploadSignPart(sessionId, partNumber);
      let tries = 0;
      while (true) {
        tries++;
        try {
          const etag = await putPart(
            url,
            blob,
            (delta) => {
              bytesDone += delta;
              opts.onProgress?.(bytesDone, opts.file.size, 'upload');
            },
            internalAbort.signal,
          );
          parts[partNumber - 1] = { partNumber, etag, size: blob.size };
          return;
        } catch (e: any) {
          if (e?.name === 'AbortError' || internalAbort.signal.aborted) throw e;
          if (tries >= 3) throw e;
          const re = await api.uploadSignPart(sessionId, partNumber);
          url = re.url;
          await new Promise((r) => setTimeout(r, 400 * tries));
        }
      }
    }

    // Concurrent pool
    const queue = [...todo];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
      workers.push(
        (async () => {
          while (queue.length) {
            if (internalAbort.signal.aborted) throw new DOMException('aborted', 'AbortError');
            const partNumber = queue.shift();
            if (partNumber === undefined) return;
            await uploadOne(partNumber);
          }
        })(),
      );
    }
    await Promise.all(workers);

    const assembled = parts.filter(Boolean);
    if (assembled.length !== partCount) {
      throw new Error(`assembled ${assembled.length}/${partCount} parts`);
    }
    const ver = await api.uploadComplete({ sessionId, parts: assembled, sha256 });
    return { versionId: ver.id, sessionId, sha256 };
  })().catch(async (e) => {
    aborted = true;
    if (sessionId) {
      try {
        await api.uploadAbort(sessionId);
      } catch {
        /* ignore */
      }
    }
    throw e;
  });

  return {
    get sessionId() {
      return sessionId;
    },
    abort: async () => {
      aborted = true;
      internalAbort.abort();
      if (sessionId) {
        try {
          await api.uploadAbort(sessionId);
        } catch {
          /* ignore */
        }
      }
    },
    promise,
  };
}
