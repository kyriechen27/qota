import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/lib/api.ts';
import { startUpload } from '../src/lib/upload.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mockApi(t) {
  const init = t.mock.method(api, 'uploadInit', async () => ({ sessionId: 12, partCount: 1, partSize: 16 }));
  const sign = t.mock.method(api, 'uploadSignPart', async () => ({ url: 'https://upload.example.test/part' }));
  const complete = t.mock.method(api, 'uploadComplete', async () => ({ id: 42 }));
  const abort = t.mock.method(api, 'uploadAbort', async () => ({ ok: true }));
  return { init, sign, complete, abort };
}

const file = () => new File(['firmware'], 'firmware.bin');
const opts = () => ({ projectId: 1, version: '1.0.0', file: file() });

function mockXhr(t, finish) {
  const previous = globalThis.XMLHttpRequest;
  let sends = 0;
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    getResponseHeader() { return 'test-etag'; }
    send(blob) {
      sends++;
      queueMicrotask(() => finish(this, blob, sends));
    }
    abort() { this.onabort?.(); }
  };
  t.after(() => { globalThis.XMLHttpRequest = previous; });
  return () => sends;
}

test('a cancelled file stops before init while its file read is pending', async (t) => {
  const calls = mockApi(t);
  const read = deferred();
  const job = startUpload({ ...opts(), file: { size: 8, slice: () => ({ arrayBuffer: () => read.promise }) } });
  const result = assert.rejects(job.promise, { name: 'AbortError' });
  const aborted = job.abort();
  read.resolve(new ArrayBuffer(8));
  await Promise.all([aborted, result]);
  assert.equal(calls.init.mock.callCount(), 0);
  assert.equal(calls.abort.mock.callCount(), 0);
});

test('cancellation during init cleans up the late session without starting a part', async (t) => {
  const calls = mockApi(t);
  const started = deferred();
  const response = deferred();
  calls.init.mock.mockImplementation(() => { started.resolve(); return response.promise; });
  const job = startUpload(opts());
  const result = assert.rejects(job.promise, { name: 'AbortError' });
  await started.promise;
  const aborted = job.abort();
  response.resolve({ sessionId: 12, partCount: 1, partSize: 16 });
  await Promise.all([aborted, result]);
  assert.equal(calls.sign.mock.callCount(), 0);
  assert.equal(calls.abort.mock.callCount(), 1);
  assert.equal(calls.abort.mock.calls[0].arguments[0], 12);
});

test('an already-aborted external signal never creates a session', async (t) => {
  const calls = mockApi(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startUpload({ ...opts(), signal: controller.signal }).promise, { name: 'AbortError' });
  assert.equal(calls.init.mock.callCount(), 0);
});

test('cancellation while signing rejects without hanging or sending an XHR', async (t) => {
  const calls = mockApi(t);
  const started = deferred();
  const response = deferred();
  calls.sign.mock.mockImplementation(() => { started.resolve(); return response.promise; });
  const sent = mockXhr(t, () => assert.fail('Cancelled upload must not send a part'));
  const job = startUpload(opts());
  const result = assert.rejects(job.promise, { name: 'AbortError' });
  await started.promise;
  const aborted = job.abort();
  response.resolve({ url: 'https://upload.example.test/part' });
  await Promise.all([aborted, result]);
  assert.equal(sent(), 0);
  assert.equal(calls.complete.mock.callCount(), 0);
  assert.equal(calls.abort.mock.callCount(), 1);
});

test('cancelling after completion was submitted preserves its successful result', async (t) => {
  const calls = mockApi(t);
  const started = deferred();
  const response = deferred();
  calls.complete.mock.mockImplementation(() => { started.resolve(); return response.promise; });
  mockXhr(t, (xhr) => { xhr.status = 200; xhr.onload(); });
  const job = startUpload(opts());
  await started.promise;
  const aborted = job.abort();
  response.resolve({ id: 42 });
  assert.equal((await job.promise).versionId, 42);
  await aborted;
  assert.equal(calls.abort.mock.callCount(), 0);
});

test('retrying a part resets its progress and never reports more than the file size', async (t) => {
  mockApi(t);
  const sent = mockXhr(t, (xhr, blob, attempt) => {
    xhr.upload.onprogress({ lengthComputable: true, loaded: blob.size });
    if (attempt === 1) xhr.onerror();
    else { xhr.status = 200; xhr.onload(); }
  });
  const progress = [];
  await startUpload({ ...opts(), onProgress: (loaded, total, phase) => {
    if (phase === 'upload') progress.push([loaded, total]);
  } }).promise;
  assert.equal(sent(), 2);
  assert(progress.every(([loaded, total]) => loaded >= 0 && loaded <= total));
  assert.deepEqual(progress.at(-1), [8, 8]);
});
