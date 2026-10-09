import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createSqliteD1 } from '../node/d1-sqlite.mjs';
import app from '../src/index.ts';
import { signJwt } from '../src/utils/jwt.ts';
import { HttpError } from '../src/utils/errors.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Real migrations and application routes; synthetic users and storage only.
// A separate in-memory database keeps these tests independent of other suites.
async function fixture(t) {
  const db = createSqliteD1(':memory:');
  t.after(() => db._db.close());
  const migrationDir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
    db._db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  }
  db._db.exec(`
    INSERT INTO users (id,email,display_name,password_hash,role,created_at,updated_at) VALUES
      (1,'super@example.test','Super admin','unused','super_admin',1,1),
      (2,'author@example.test','Author','unused','developer',1,1),
      (3,'viewer@example.test','Viewer','unused','developer',1,1),
      (4,'observer@example.test','Observer','unused','developer',1,1),
      (5,'scoped@example.test','Scoped admin','unused','developer',1,1),
      (6,'admin@example.test','Global admin','unused','developer',1,1),
      (7,'peer@example.test','Peer developer','unused','developer',1,1),
      (8,'other@example.test','Other customer developer','unused','developer',1,1),
      (9,'outsider@example.test','Outsider','unused','developer',1,1);
    INSERT INTO user_global_roles (user_id,role,updated_at) VALUES (4,'observer',1),(6,'admin',1);
    INSERT INTO customers (id,code,name,created_at,updated_at) VALUES
      (1,'first','First customer',1,1),(2,'second','Second customer',1,1);
    INSERT INTO projects (id,customer_id,code,name,created_at,updated_at) VALUES
      (1,1,'main','Main project',1,1),(2,2,'private','Private project',1,1),(3,1,'restricted','Restricted project',1,1);
    INSERT INTO memberships (user_id,customer_id,role,created_at) VALUES
      (2,1,'developer',1),(3,1,'viewer',1),(5,1,'customer_admin',1),(7,1,'developer',1),(8,2,'developer',1);
    INSERT INTO project_memberships (user_id,project_id,role,created_at) VALUES (5,3,'viewer',1);
  `);
  const objects = new Map();
  const storage = {
    createMultipartUpload: async (key) => `upload-${key}`,
    completeMultipartUpload: async (key, uploadId) => { objects.set(key, uploadId); return { etag: 'test-etag' }; },
    headObject: async (key) => objects.has(key) ? { size: 1024, etag: 'test-etag' } : null,
    deleteObject: async (key) => { objects.delete(key); },
    abortMultipartUpload: async () => {},
  };
  const secret = 'isolated-announcement-regression-test';
  const tokens = new Map();
  const env = { DB: db, STORAGE: storage, JWT_SECRET: secret, ALLOWED_ORIGINS: '' };
  async function request(path, { method = 'GET', body, userId = 2, status = 200 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (userId !== null) {
      if (!tokens.has(userId)) {
        const user = db._db.prepare('SELECT email,role FROM users WHERE id=?').get(userId);
        tokens.set(userId, await signJwt({ sub: userId, ...user }, secret, 3600));
      }
      headers.authorization = `Bearer ${tokens.get(userId)}`;
    }
    const pending = [];
    const response = await app.fetch(new Request(`https://qota.example.test${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} });
    await Promise.all(pending);
    const result = await response.json();
    const allowed = Array.isArray(status) ? status : [status];
    assert.ok(allowed.includes(response.status), `${method} ${path}: expected ${allowed.join('/')} got ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  const create = (content, options = {}) => request('/api/announcements', {
    method: 'POST', body: { projectId: options.projectId ?? 1, content }, status: 201, ...options,
  });
  const list = (options = {}, query = '') => request(`/api/announcements${query}`, options);
  const init = (filename, announcement, options = {}) => {
    const { userId = 2, status = 200, ...fields } = options;
    return request('/api/upload/init', { method: 'POST', userId, status, body: {
      projectId: 1, version: 'v1', releaseChannel: 'ota', totalSize: 1024, filename,
      ...(announcement === undefined ? {} : { announcement }), ...fields,
    } });
  };
  const complete = (session, options = {}) => request('/api/upload/complete', {
    method: 'POST', status: 201, body: { sessionId: session.sessionId, parts: [{ partNumber: 1, etag: 'etag', size: 1024 }] }, ...options,
  });
  return { db, request, create, list, init, complete, storage, objects };
}

test('announcement visibility and publishing follow effective project permissions', async (t) => {
  const f = await fixture(t);
  const main = await f.create('Main announcement');
  const privateItem = await f.create('Private announcement', { userId: 8, projectId: 2 });
  const restricted = await f.create('Restricted announcement', { userId: 7, projectId: 3 });
  const viewer = await f.list({ userId: 3 });
  assert.deepEqual(viewer.items.map((item) => item.id).sort(), [main.id, restricted.id].sort());
  assert.deepEqual(viewer.publishableProjects, []);
  assert.deepEqual((await f.list({ userId: 2 })).publishableProjects.map((p) => p.id).sort(), [1, 3]);
  assert.deepEqual((await f.list({ userId: 5 })).publishableProjects.map((p) => p.id), [1]);
  const observer = await f.list({ userId: 4 });
  assert.equal(observer.items.length, 3);
  assert.ok(observer.items.some((item) => item.id === privateItem.id));
  assert.deepEqual(observer.publishableProjects, []);
  assert.deepEqual((await f.list({ userId: 9 })).items, []);
  for (const userId of [3, 4, 9]) await f.create('Denied publication', { userId, status: 403 });
  await f.create('Project override denied', { userId: 5, projectId: 3, status: 403 });
  await f.create('Wrong customer denied', { userId: 2, projectId: 2, status: 403 });
  await f.list({ userId: 2, status: 403 }, '?projectId=2');
  await f.list({ userId: 2, status: 404 }, '?projectId=999');
  await f.list({ userId: null, status: 401 });
  await f.create('Anonymous denied', { userId: null, status: 401 });
});

test('authors with view access and effective admins can manage announcements but peers cannot', async (t) => {
  const f = await fixture(t);
  const item = await f.create('  Initial announcement\nSecond line  ');
  assert.equal(item.content, 'Initial announcement\nSecond line');
  assert.equal(item.authorId, 2);
  assert.equal(item.authorName, 'Author');
  assert.equal(item.projectName, 'Main project');
  assert.equal(item.customerName, 'First customer');
  assert.equal(item.version, null);
  assert.equal(item.canEdit, true);
  assert.equal(item.canDelete, true);
  const patch = (content, options = {}) => f.request(`/api/announcements/${item.id}`, { method: 'PATCH', body: { content }, ...options });
  for (const userId of [3, 4, 7]) {
    await patch('Denied peer edit', { userId, status: 403 });
    await f.request(`/api/announcements/${item.id}`, { method: 'DELETE', userId, status: 403 });
    const view = (await f.list({ userId })).items.find((row) => row.id === item.id);
    assert.equal(view.canEdit, false);
    assert.equal(view.canDelete, false);
  }
  for (const userId of [1, 5, 6]) await patch(`Admin ${userId} edit`, { userId });
  f.db._db.prepare("UPDATE memberships SET role='viewer' WHERE user_id=2 AND customer_id=1").run();
  const edited = await patch('Author retains management after viewer downgrade');
  assert.equal(edited.content, 'Author retains management after viewer downgrade');
  assert.equal((await f.list()).publishableProjects.length, 0);
  await f.request(`/api/announcements/${item.id}`, { method: 'DELETE' });
  assert.deepEqual((await f.list()).items, []);
  await patch('Deleted item', { status: 404 });
  await f.request(`/api/announcements/${item.id}`, { method: 'DELETE', status: 404 });
  const restricted = await f.create('Scoped override protects this', { userId: 7, projectId: 3 });
  await f.request(`/api/announcements/${restricted.id}`, { method: 'PATCH', userId: 5, body: { content: 'Denied override' }, status: 403 });
  await f.request(`/api/announcements/${restricted.id}`, { method: 'DELETE', userId: 6 });
});

test('an author who loses project visibility cannot edit or delete their old announcement', async (t) => {
  const f = await fixture(t);
  const item = await f.create('Published before removal');
  f.db._db.prepare('DELETE FROM memberships WHERE user_id=2').run();
  assert.deepEqual((await f.list()).items, []);
  await f.request(`/api/announcements/${item.id}`, { method: 'PATCH', body: { content: 'Denied' }, status: 403 });
  await f.request(`/api/announcements/${item.id}`, { method: 'DELETE', status: 403 });
  assert.equal((await f.list({ userId: 1 })).items[0].content, 'Published before removal');
});

test('announcement validation and pagination preserve content and never expose deleted or hidden projects', async (t) => {
  const f = await fixture(t);
  for (const invalid of ['', '  \n ', false, 'x'.repeat(10001)]) await f.create(invalid, { status: 400 });
  const created = [];
  for (let i = 0; i < 5; i++) created.push(await f.create(`Announcement ${i}\nFull content`));
  await f.create('Hidden project content', { userId: 8, projectId: 2 });
  await f.request(`/api/announcements/${created[2].id}`, { method: 'DELETE' });
  await f.request(`/api/announcements/${created[0].id}`, { method: 'PATCH', body: { content: ' ' }, status: 400 });
  const ids = [];
  let cursor = null;
  do {
    const page = await f.list({}, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.ok(page.items.length <= 2);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, created.filter((item) => item.id !== created[2].id).map((item) => item.id).reverse());
  assert.equal(new Set(ids).size, ids.length);
  for (const query of ['?limit=0', '?limit=101', '?cursor=invalid']) await f.list({ status: 400 }, query);
});

test('upload announcement drafts publish only after success and use the session author and version', async (t) => {
  const f = await fixture(t);
  const session = await f.init('firmware.bin', { batchKey: randomUUID(), content: 'Firmware release announcement' }, {
    notes: 'File instructions', versionNotes: 'Version summary', specialVersion: 'HW-B',
  });
  assert.deepEqual((await f.list()).items, []);
  const version = await f.complete(session, { userId: 7 });
  assert.equal(version.notes, 'File instructions');
  assert.equal(version.versionNotes, 'Version summary');
  assert.equal(version.specialVersion, 'HW-B');
  const items = (await f.list()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].authorId, 2);
  assert.equal(items[0].version, 'v1');
  assert.equal(items[0].projectId, 1);
  assert.equal(items[0].content, 'Firmware release announcement');
  assert.equal((await f.list({ userId: 7 })).items[0].canEdit, false);
});

test('another developer cannot publish an upload announcement after its original author loses upload permission', async (t) => {
  const f = await fixture(t);
  const cases = [
    ["UPDATE memberships SET role='viewer' WHERE user_id=2", "UPDATE memberships SET role='developer' WHERE user_id=2"],
    ["INSERT INTO user_global_roles (user_id,role,updated_at) VALUES (2,'observer',1)", 'DELETE FROM user_global_roles WHERE user_id=2'],
    ['UPDATE users SET is_active=0 WHERE id=2', 'UPDATE users SET is_active=1 WHERE id=2'],
    ['DELETE FROM memberships WHERE user_id=2', "INSERT INTO memberships (user_id,customer_id,role,created_at) VALUES (2,1,'developer',1)"],
    ["INSERT INTO project_memberships (user_id,project_id,role,created_at) VALUES (2,1,'viewer',1)", 'DELETE FROM project_memberships WHERE user_id=2 AND project_id=1'],
  ];
  for (const [index, [restrict, restore]] of cases.entries()) {
    const session = await f.init(`revoked-${index}.bin`, { batchKey: randomUUID(), content: 'Requires original author permission' });
    f.db._db.exec(restrict);
    await f.complete(session, { userId: 7, status: 403 });
    f.db._db.exec(restore);
  }
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM versions').first('count'), 0);
  assert.deepEqual((await f.list()).items, []);
  assert.equal(f.objects.size, 0);
});

test('announcement publishing permission is rechecked inside the final database transaction', async (t) => {
  const f = await fixture(t);
  const session = await f.init('permission-race.bin', { batchKey: randomUUID(), content: 'Must not publish after permission loss' });
  const batch = f.db.batch.bind(f.db);
  f.db.batch = async (queries) => {
    f.db.batch = batch;
    f.db._db.prepare("UPDATE memberships SET role='viewer' WHERE user_id=2 AND customer_id=1").run();
    return batch(queries);
  };
  await f.complete(session, { userId: 7, status: 409 });
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM versions').first('count'), 0);
  assert.deepEqual((await f.list()).items, []);
  assert.ok(!f.objects.has(session.key));
});

test('aborted and storage-failed uploads publish no announcements', async (t) => {
  const f = await fixture(t);
  for (const announcement of [
    { batchKey: 'invalid-key', content: 'Valid content' },
    { batchKey: randomUUID(), content: '  ' },
    { batchKey: randomUUID(), content: 'x'.repeat(10001) },
  ]) await f.init('invalid.bin', announcement, { status: 400 });
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM upload_sessions').first('count'), 0);
  const aborted = await f.init('aborted.bin', { batchKey: randomUUID(), content: 'Must not publish aborted upload' });
  await f.request('/api/upload/abort', { method: 'POST', body: { sessionId: aborted.sessionId } });
  await f.complete(aborted, { status: 400 });
  const failed = await f.init('failed.bin', { batchKey: randomUUID(), content: 'Must not publish failed upload' });
  f.storage.completeMultipartUpload = async () => { throw new HttpError(503, 'storage_unavailable', 'Simulated test storage failure'); };
  await f.complete(failed, { status: 503 });
  assert.deepEqual((await f.list()).items, []);
  assert.equal((await f.db.prepare('SELECT status FROM upload_sessions WHERE id=?').bind(failed.sessionId).first()).status, 'failed');
});

test('concurrent files sharing one announcement batch publish only one item', async (t) => {
  const f = await fixture(t);
  const batchKey = randomUUID();
  const first = await f.init('firmware.bin', { batchKey, content: 'Shared release announcement' });
  const second = await f.init('resources.bin', { batchKey: batchKey.toUpperCase(), content: 'Shared release announcement' });
  await f.init('other-version.bin', { batchKey, content: 'Pending batch belongs to v1' }, { version: 'v2', status: 409 });
  const complete = f.storage.completeMultipartUpload;
  let release;
  let arrivals = 0;
  const barrier = new Promise((resolve) => { release = resolve; });
  f.storage.completeMultipartUpload = async (...args) => {
    const result = await complete(...args);
    if (++arrivals === 2) release();
    await barrier;
    return result;
  };
  await Promise.all([f.complete(first), f.complete(second)]);
  assert.equal((await f.list()).items.length, 1);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM versions').first('count'), 2);
});

test('batch deduplication preserves edits, isolates authors and projects, and rejects cross-version reuse', async (t) => {
  const f = await fixture(t);
  const batchKey = randomUUID();
  await f.complete(await f.init('first.bin', { batchKey, content: 'First announcement' }));
  const firstItem = (await f.list()).items[0];
  await f.request(`/api/announcements/${firstItem.id}`, { method: 'PATCH', body: { content: 'Edited after publishing' } });
  await f.complete(await f.init('second.bin', { batchKey, content: 'A later draft must not replace the edit' }));
  assert.equal((await f.list()).items[0].content, 'Edited after publishing');
  await f.init('other-version.bin', { batchKey, content: 'Wrong version reuse' }, { version: 'v2', status: 409 });
  await f.complete(await f.init('peer.bin', { batchKey, content: 'Independent author announcement' }, { userId: 7 }), { userId: 7 });
  f.db._db.prepare("INSERT INTO project_memberships (user_id,project_id,role,created_at) VALUES (2,2,'developer',1)").run();
  await f.complete(await f.init('other-project.bin', { batchKey, content: 'Independent project announcement' }, { projectId: 2 }));
  const all = (await f.list({ userId: 1 })).items;
  assert.equal(all.length, 3);
  assert.equal(all.filter((item) => item.authorId === 7).length, 1);
  assert.equal(all.filter((item) => item.projectId === 2).length, 1);
});

test('deleting an upload announcement keeps its batch from publishing again on later files', async (t) => {
  const f = await fixture(t);
  const batchKey = randomUUID();
  const first = await f.init('first.bin', { batchKey, content: 'Release notice' });
  const pending = await f.init('second.bin', { batchKey, content: 'Release notice' });
  await f.complete(first);
  const announcement = (await f.list()).items[0];
  await f.request(`/api/announcements/${announcement.id}`, { method: 'DELETE' });
  await f.complete(pending);
  await f.complete(first, { status: 400 });
  await f.complete(await f.init('third.bin', { batchKey, content: 'Retry draft must stay deleted' }));
  assert.deepEqual((await f.list()).items, []);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM versions').first('count'), 3);
});

test('a filename conflict cannot publish its losing upload announcement', async (t) => {
  const f = await fixture(t);
  const first = await f.init('same.bin', { batchKey: randomUUID(), content: 'First upload notice' });
  const second = await f.init('same.bin', { batchKey: randomUUID(), content: 'Second upload notice' });
  const complete = f.storage.completeMultipartUpload;
  let release;
  let arrivals = 0;
  const barrier = new Promise((resolve) => { release = resolve; });
  f.storage.completeMultipartUpload = async (...args) => {
    const result = await complete(...args);
    if (++arrivals === 2) release();
    await barrier;
    return result;
  };
  const results = await Promise.all([f.complete(first, { status: [201, 409] }), f.complete(second, { status: [201, 409] })]);
  const winners = results.filter((item) => typeof item.id === 'number');
  assert.equal(winners.length, 1);
  const items = (await f.list()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].content, winners[0].r2Key === first.key ? 'First upload notice' : 'Second upload notice');
});

test('a final-batch current lock rejects the new file and its announcement together', async (t) => {
  const f = await fixture(t);
  await f.complete(await f.init('original.bin', undefined, { versionNotes: 'Published summary' }));
  const session = await f.init('new.bin', { batchKey: randomUUID(), content: 'Blocked update notice' }, { versionNotes: 'Changed summary' });
  const batch = f.db.batch.bind(f.db);
  f.db.batch = async (queries) => {
    f.db.batch = batch;
    f.db._db.prepare("INSERT INTO project_current_versions (project_id,version) VALUES (1,'v1')").run();
    return batch(queries);
  };
  await f.complete(session, { status: 409 });
  assert.deepEqual((await f.list()).items, []);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM versions').first('count'), 1);
  assert.equal((await f.db.prepare("SELECT notes FROM version_metadata WHERE project_id=1 AND version='v1'").first()).notes, 'Published summary');
  assert.ok(!f.objects.has(session.key));
});
