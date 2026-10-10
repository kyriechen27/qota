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
      (2,1,'developer',1),(3,1,'viewer',1),(4,1,'viewer',1),(5,1,'customer_admin',1),(7,1,'developer',1),(8,2,'developer',1);
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
    method: 'POST', body: {
      projectId: options.projectId ?? 1, content,
      ...(Object.hasOwn(options, 'version') ? { version: options.version } : {}),
      ...(Object.hasOwn(options, 'recipientIds') ? { recipientIds: options.recipientIds } : {}),
    }, status: 201, ...options,
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
  const sent = [];
  env.MAILER = { send: async (_config, message) => { sent.push(message); } };
  const configureMail = () => request('/api/mail/settings', { method: 'PUT', userId: 1, body: {
    enabled: true, host: 'smtp.example.test', port: 465, security: 'tls',
    username: 'test-user', password: 'synthetic-password', fromEmail: 'sender@example.test', fromName: 'Test QOTA',
  } });
  const retry = (item, options = {}) => request(`/api/announcements/${item.id}/mail/retry`, {
    method: 'POST', body: {}, ...options,
  });
  return { db, request, create, list, init, complete, storage, objects, env, sent, configureMail, retry };
}

function seedVersion(f, version, { projectId = 1, status = 'ready', filename = 'firmware.bin' } = {}) {
  const result = f.db._db.prepare(`
    INSERT INTO versions (project_id,version,release_channel,status,r2_key,filename,size,uploaded_by,created_at,updated_at)
    VALUES (?,?,'ota',?,?,?,1024,2,1,1)
  `).run(projectId, version, status, randomUUID(), filename);
  return Number(result.lastInsertRowid);
}

test('standalone announcement version omission and explicit null keep project-wide compatibility', async (t) => {
  const f = await fixture(t);
  seedVersion(f, 'v1');
  const omitted = await f.create('Project-wide announcement');
  const explicitNull = await f.create('Explicitly project-wide announcement', { version: null });
  assert.equal(omitted.version, null);
  assert.equal(explicitNull.version, null);
  assert.ok((await f.list()).items.every((item) => item.version === null));
});

test('standalone announcements can link ready or archived versions and labels with multiple files', async (t) => {
  const f = await fixture(t);
  seedVersion(f, 'v1.2.3', { filename: 'firmware.bin' });
  seedVersion(f, 'v1.2.3', { filename: 'resources.bin' });
  seedVersion(f, 'v0.9', { status: 'archived' });
  const ready = await f.create('Ready version notice', { version: 'v1.2.3' });
  const archived = await f.create('Archived version notice', { version: 'v0.9' });
  assert.equal(ready.version, 'v1.2.3');
  assert.equal(archived.version, 'v0.9');
  assert.equal(ready.projectId, 1);
  assert.equal(ready.authorId, 2);
  const rows = (await f.list()).items;
  assert.equal(rows.length, 2, 'multiple files must not duplicate one standalone announcement');
  assert.equal(rows.find((item) => item.id === ready.id).version, 'v1.2.3');
  assert.equal(rows.find((item) => item.id === archived.id).version, 'v0.9');
});

test('standalone announcement versions reject invalid, pending-only, missing and cross-project labels', async (t) => {
  const f = await fixture(t);
  seedVersion(f, 'pending', { status: 'pending' });
  seedVersion(f, 'private-only', { projectId: 2 });
  for (const version of ['', false, 123, ' v1 ', 'contains space', 'x'.repeat(65)]) {
    await f.create('Invalid version reference', { version, status: 400 });
  }
  for (const version of ['pending', 'missing', 'private-only']) {
    await f.create('Unavailable version reference', { version, status: 404 });
  }
  await f.create('Even a global admin must match the target project', { userId: 1, version: 'private-only', status: 404 });
  await f.create('No publish access to this project', { projectId: 2, version: 'private-only', status: 403 });
  assert.deepEqual((await f.list({ userId: 1 })).items, []);
  const allowed = await f.create('Correct project and authorized publisher', { userId: 1, projectId: 2, version: 'private-only' });
  assert.equal(allowed.projectId, 2);
  assert.equal(allowed.version, 'private-only');
});

test('standalone version association is checked atomically and requires at least one eligible file', async (t) => {
  for (const removeAll of [false, true]) {
    const f = await fixture(t);
    const first = seedVersion(f, 'v1', { filename: 'firmware.bin' });
    seedVersion(f, 'v1', { filename: 'resources.bin', status: 'archived' });
    const prepare = f.db.prepare.bind(f.db);
    let interleaved = false;
    f.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/INSERT INTO announcements/.test(sql)) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            if (removeAll) f.db._db.prepare("DELETE FROM versions WHERE project_id=1 AND version='v1'").run();
            else f.db._db.prepare('DELETE FROM versions WHERE id=?').run(first);
            interleaved = true;
            return run();
          };
          return bound;
        };
      }
      return statement;
    };
    await f.create('Version association during deletion', { version: 'v1', status: removeAll ? 409 : 201 });
    assert.equal(interleaved, true);
    assert.equal((await f.list()).items.length, removeAll ? 0 : 1);
  }
});

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
  assert.deepEqual(observer.items.map((item) => item.id).sort(), [main.id, restricted.id].sort());
  assert.ok(!observer.items.some((item) => item.id === privateItem.id));
  await f.list({ userId: 4, status: 403 }, '?projectId=2');
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

test('mail recipient choices include only active project viewers and require publish permission', async (t) => {
  const f = await fixture(t);
  f.db._db.prepare('UPDATE users SET is_active=0 WHERE id=7').run();
  f.db._db.prepare("INSERT INTO project_memberships(user_id,project_id,role,created_at) VALUES(9,1,'viewer',1)").run();
  const choices = await f.request('/api/announcements/recipients?projectId=1');
  assert.deepEqual(choices.items.map((u) => u.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 9]);
  assert.ok(choices.items.every((u) => Object.keys(u).sort().join() === 'displayName,email,id'));
  for (const userId of [3, 4, 8, 9]) {
    await f.request('/api/announcements/recipients?projectId=1', { userId, status: 403 });
  }
  await f.request('/api/announcements/recipients?projectId=3', { userId: 5, status: 403 });
  await f.request('/api/announcements/recipients', { status: 400 });
  await f.request('/api/announcements/recipients?projectId=999', { status: 404 });
});

test('mail selection validates settings, user ids and project access before publication or upload', async (t) => {
  const f = await fixture(t);
  const noMail = await f.create('No SMTP configuration needed');
  assert.deepEqual(noMail.mail, { total: 0, sent: 0, failed: 0, pending: 0, skipped: 0 });
  await f.create('Missing configuration', { recipientIds: [3], status: 400 });
  await f.init('missing-mail-config.bin', { batchKey: randomUUID(), content: 'Missing configuration', recipientIds: [3] }, { status: 400 });
  await f.configureMail();
  for (const recipientIds of [null, '3', [0], ['3'], [1.5], [999], [8], Array(201).fill(3)]) {
    await f.create('Invalid selection', { recipientIds, status: 400 });
    await f.init('invalid-mail-selection.bin', { batchKey: randomUUID(), content: 'Invalid selection', recipientIds }, { status: 400 });
  }
  f.db._db.prepare('UPDATE users SET is_active=0 WHERE id=3').run();
  await f.create('Inactive recipient', { recipientIds: [3], status: 400 });
  assert.equal((await f.list()).items.length, 1);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM upload_sessions').first('count'), 0);
  assert.equal(f.sent.length, 0);
});

test('standalone email sends private messages once per selected user and editing never resends', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  seedVersion(f, 'v1');
  const item = await f.create('Release details\nSecond line', { version: 'v1', recipientIds: [7, 3, 3, 4] });
  assert.deepEqual(item.mail, { total: 3, sent: 3, failed: 0, pending: 0, skipped: 0 });
  assert.deepEqual(f.sent.map((m) => m.to).sort(), ['peer@example.test', 'viewer@example.test', 'observer@example.test'].sort());
  assert.ok(f.sent.every((m) => typeof m.to === 'string' && !('cc' in m) && !('bcc' in m)));
  assert.ok(f.sent.every((m) => m.subject.includes('Main project') && m.subject.includes('v1') && m.text.includes('Release details\nSecond line')));
  await f.request(`/api/announcements/${item.id}`, { method: 'PATCH', body: { content: 'Revised text' } });
  await f.retry(item);
  assert.equal(f.sent.length, 3);
  assert.equal((await f.list()).items[0].mail.sent, 3);
});

test('bounded mail continuation sends pending only and explicit retry excludes already sent recipients', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  let fail = true;
  f.env.MAILER.send = async (_config, message) => {
    f.sent.push(message);
    if (fail && message.to === 'viewer@example.test') throw Object.assign(new Error('remote secret must not persist'), { code: 'smtp_recipient' });
  };
  const item = await f.create('Bounded delivery', { recipientIds: [1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(item.mail, { total: 7, sent: 2, failed: 1, pending: 4, skipped: 0 });
  assert.equal(f.sent.length, 3);
  const next = await f.retry(item, { body: { retryFailed: false } });
  assert.deepEqual(next.mail, { total: 7, sent: 5, failed: 1, pending: 1, skipped: 0 });
  const completed = await f.retry(item, { body: { retryFailed: false } });
  assert.deepEqual(completed.mail, { total: 7, sent: 6, failed: 1, pending: 0, skipped: 0 });
  await f.retry(item, { body: { retryFailed: false } });
  assert.equal(f.sent.length, 7, 'automatic continuation does not retry failures');
  assert.equal((await f.db.prepare('SELECT error FROM announcement_mail_deliveries WHERE user_id=3').first()).error, 'smtp_recipient');
  fail = false;
  const retried = await f.retry(item);
  assert.deepEqual(retried.mail, { total: 7, sent: 7, failed: 0, pending: 0, skipped: 0 });
  assert.equal(f.sent.length, 8);
  assert.equal(f.sent.filter((m) => m.to === 'viewer@example.test').length, 2);
  assert.ok(f.sent.filter((m) => m.to !== 'viewer@example.test').every((m, index, messages) => messages.findIndex((other) => other.to === m.to) === index));
});

test('mail retry requires author or effective administrator with current view access', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  const item = await f.create('Author management', { recipientIds: [1, 2, 3, 4] });
  for (const userId of [3, 4, 7, 8]) await f.retry(item, { userId, status: 403 });
  await f.retry(item, { body: { retryFailed: 'false' }, status: 400 });
  f.db._db.prepare("UPDATE memberships SET role='viewer' WHERE user_id=2").run();
  assert.equal((await f.retry(item)).mail.sent, 4, 'author may finish after viewer downgrade');
  f.db._db.prepare('DELETE FROM memberships WHERE user_id=2').run();
  await f.retry(item, { status: 403 });
  await f.retry(item, { userId: 5 });
  const restricted = await f.create('Scoped override', { userId: 7, projectId: 3, recipientIds: [1, 3, 4, 5] });
  await f.retry(restricted, { userId: 5, status: 403 });
  await f.retry(restricted, { userId: 6 });
});

test('manual retries prioritize failures and rotate old failures so persistent rejects cannot block others', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  const persistent = new Set(['super@example.test', 'author@example.test', 'viewer@example.test']);
  let failAll = true;
  f.env.MAILER.send = async (_config, message) => {
    f.sent.push(message);
    if (failAll || persistent.has(message.to)) throw Object.assign(new Error('rejected'), { code: 'smtp_recipient' });
  };
  const item = await f.create('Fair retry ordering', { recipientIds: [1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(item.mail, { total: 7, sent: 0, failed: 3, pending: 4, skipped: 0 });
  const manual = await f.retry(item);
  assert.deepEqual(manual.mail, item.mail, 'manual retry must attempt failed addresses before pending recipients');
  assert.deepEqual(new Set(f.sent.slice(3).map((message) => message.to)), persistent);
  await f.retry(item, { body: { retryFailed: false } });
  const allFailed = await f.retry(item, { body: { retryFailed: false } });
  assert.equal(allFailed.mail.failed, 7);
  assert.equal(allFailed.mail.pending, 0);
  // Make the ordering deterministic without relying on millisecond clock resolution.
  f.db._db.prepare('UPDATE announcement_mail_deliveries SET updated_at=1 WHERE announcement_id=?').run(item.id);
  failAll = false;
  const first = await f.retry(item);
  assert.equal(first.mail.failed, 7);
  const second = await f.retry(item);
  assert.equal(second.mail.sent, 3, 'next retry must move past the three newly attempted permanent failures');
  const third = await f.retry(item);
  assert.equal(third.mail.sent, 4);
  assert.equal(third.mail.failed, 3);
  const sentUsers = (await f.db.prepare("SELECT user_id FROM announcement_mail_deliveries WHERE announcement_id=? AND status='sent' ORDER BY user_id").bind(item.id).all()).results;
  assert.deepEqual(sentUsers.map((row) => row.user_id), [4, 5, 6, 7]);
});

test('recipient permission is rechecked after publishing and before pending mail is sent', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  const batch = f.db.batch.bind(f.db);
  f.db.batch = async (queries) => {
    f.db.batch = batch;
    const results = await batch(queries);
    f.db._db.prepare('DELETE FROM memberships WHERE user_id=3').run();
    return results;
  };
  const item = await f.create('Permission changed during publication', { recipientIds: [3, 4] });
  assert.deepEqual(item.mail, { total: 2, sent: 1, failed: 0, pending: 0, skipped: 1 });
  assert.deepEqual(f.sent.map((m) => m.to), ['observer@example.test']);
  await f.retry(item);
  assert.equal(f.sent.length, 1, 'skipped recipient must not be retried');
});

test('concurrent upload files persist recipients and publish one immutable mail recipient set', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  const batchKey = randomUUID();
  const first = await f.init('firmware-mail.bin', { batchKey, content: 'First content', recipientIds: [3, 3] });
  const second = await f.init('resources-mail.bin', { batchKey, content: 'Different draft', recipientIds: [7] });
  const session = await f.request(`/api/upload/sessions/${first.sessionId}`);
  assert.deepEqual(session.announcement.recipientIds, [3]);
  assert.equal(f.sent.length, 0);
  await Promise.all([f.complete(first), f.complete(second)]);
  const item = (await f.list()).items[0];
  assert.equal(item.mail.total, 1);
  assert.equal(item.mail.sent, 1);
  assert.equal(f.sent[0].to, item.content === 'First content' ? 'viewer@example.test' : 'peer@example.test');
  await f.request(`/api/announcements/${item.id}`, { method: 'PATCH', body: { content: 'Manually edited' } });
  await f.complete(await f.init('third-mail.bin', { batchKey, content: 'Third draft', recipientIds: [1, 2, 3] }));
  assert.equal((await f.list()).items[0].mail.total, 1);
  assert.equal(f.sent.length, 1);
  await f.request(`/api/announcements/${item.id}`, { method: 'DELETE' });
  await f.complete(await f.init('fourth-mail.bin', { batchKey, content: 'Deleted draft', recipientIds: [7] }));
  assert.equal(f.sent.length, 1);
  assert.deepEqual((await f.list()).items, []);
});

test('failed and aborted upload announcements never send and mail failure never fails completed firmware', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  const draft = () => ({ batchKey: randomUUID(), content: 'Upload notice', recipientIds: [3] });
  const aborted = await f.init('aborted-mail.bin', draft());
  await f.request('/api/upload/abort', { method: 'POST', body: { sessionId: aborted.sessionId } });
  const failed = await f.init('failed-mail.bin', draft());
  const complete = f.storage.completeMultipartUpload;
  f.storage.completeMultipartUpload = async () => { throw new HttpError(503, 'storage_unavailable'); };
  await f.complete(failed, { status: 503 });
  f.storage.completeMultipartUpload = complete;
  assert.equal(f.sent.length, 0);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM announcement_mail_deliveries').first('count'), 0);
  f.env.MAILER.send = async () => { throw new Error('untrusted SMTP error with a secret'); };
  const good = await f.init('good-mail.bin', draft());
  const version = await f.complete(good);
  assert.equal(version.status, 'ready');
  assert.equal((await f.request(`/api/upload/sessions/${good.sessionId}`)).status, 'completed');
  const item = (await f.list()).items[0];
  assert.deepEqual(item.mail, { total: 1, sent: 0, failed: 1, pending: 0, skipped: 0 });
  assert.equal((await f.db.prepare('SELECT error FROM announcement_mail_deliveries').first()).error, 'smtp_send');
});

test('concurrent retry claims prevent duplicate sends and explicit retry recovers only stale claims', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  const item = await f.create('Continuation claims', { recipientIds: [1, 2, 3, 4] });
  const sending = [];
  f.env.MAILER.send = async (_config, message) => {
    f.sent.push(message);
    await new Promise((resolve) => { sending.push(resolve); setTimeout(resolve, 5); });
  };
  await Promise.all([f.retry(item), f.retry(item)]);
  assert.equal(f.sent.length, 4);
  assert.equal((await f.list()).items[0].mail.sent, 4);
  f.db._db.prepare("UPDATE announcement_mail_deliveries SET status='sending',claim_token='old',updated_at=? WHERE announcement_id=? AND user_id=4")
    .run(Date.now(), item.id);
  await f.retry(item);
  assert.equal(f.sent.length, 4, 'fresh claim must not be stolen');
  f.db._db.prepare('UPDATE announcement_mail_deliveries SET updated_at=1 WHERE announcement_id=? AND user_id=4').run(item.id);
  await f.retry(item, { body: { retryFailed: false } });
  assert.equal(f.sent.length, 4, 'automatic continuation must not recover ambiguous SMTP outcomes');
  assert.equal((await f.retry(item)).mail.sent, 4);
  assert.equal(f.sent.length, 5);
  assert.equal((await f.db.prepare('SELECT claim_token FROM announcement_mail_deliveries WHERE announcement_id=? AND user_id=4').bind(item.id).first()).claim_token, null);
});

test('deletion cancels pending mail and SMTP disabled after publication records a retryable failure', async (t) => {
  const f = await fixture(t);
  await f.configureMail();
  const deleted = await f.create('Cancel remaining mail', { recipientIds: [1, 2, 3, 4, 5] });
  await f.request(`/api/announcements/${deleted.id}`, { method: 'DELETE' });
  await f.retry(deleted, { status: 404 });
  assert.equal(f.sent.length, 3);
  assert.equal(await f.db.prepare("SELECT COUNT(*) AS count FROM announcement_mail_deliveries WHERE announcement_id=? AND status='skipped'").bind(deleted.id).first('count'), 2);
  const batch = f.db.batch.bind(f.db);
  f.db.batch = async (queries) => {
    f.db.batch = batch;
    const results = await batch(queries);
    f.db._db.prepare('UPDATE mail_settings SET enabled=0').run();
    return results;
  };
  const disabled = await f.create('Publication still succeeds', { recipientIds: [3] });
  assert.equal(disabled.mail.failed, 1);
  assert.equal(f.sent.length, 3);
  await f.configureMail();
  assert.equal((await f.retry(disabled)).mail.sent, 1);
});
