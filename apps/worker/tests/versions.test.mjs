import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import app from '../src/index.ts';
import { signJwt } from '../src/utils/jwt.ts';
import { sha256Hex } from '../src/utils/sha.ts';
import { createSqliteD1 } from '../node/d1-sqlite.mjs';
import { runMigrations } from '../node/migrate.mjs';

// Exercise production routes, SQL migrations, permissions, and the Node D1
// adapter together. Every test owns a new in-memory database; no local data,
// storage files, or external services are used.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const migrationsDir = new URL('../migrations/', import.meta.url);
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
const secret = 'isolated-version-regression-tests';

async function fixture(t, { beforeCurrentMigration = false, beforeMultiFileMigration = false } = {}) {
  const db = createSqliteD1(':memory:');
  t.after(() => db._db.close());
  for (const migration of migrations) {
    if (beforeCurrentMigration && migration >= '0007_') continue;
    if (beforeMultiFileMigration && migration >= '0008_') continue;
    db._db.exec(readFileSync(new URL(migration, migrationsDir), 'utf8'));
  }
  db._db.exec(`
    INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES
      (1, 'admin@example.test', 'unused', 'super_admin', 1, 1),
      (2, 'developer@example.test', 'unused', 'developer', 1, 1),
      (3, 'viewer@example.test', 'unused', 'developer', 1, 1),
      (4, 'observer@example.test', 'unused', 'developer', 1, 1),
      (5, 'customer-admin@example.test', 'unused', 'developer', 1, 1),
      (6, 'global-admin@example.test', 'unused', 'developer', 1, 1),
      (7, 'other-developer@example.test', 'unused', 'developer', 1, 1);
    INSERT INTO user_global_roles (user_id, role, updated_at) VALUES
      (4, 'observer', 1), (6, 'admin', 1);
    INSERT INTO customers (id, code, name, created_at, updated_at) VALUES
      (1, 'first', 'First customer', 1, 1), (2, 'second', 'Second customer', 1, 1);
    INSERT INTO projects (id, customer_id, code, name, created_at, updated_at) VALUES
      (1, 1, 'one', 'Project one', 1, 1), (2, 2, 'two', 'Project two', 1, 1);
    INSERT INTO memberships (user_id, customer_id, role, created_at) VALUES
      (2, 1, 'developer', 1), (3, 1, 'viewer', 1),
      (5, 1, 'customer_admin', 1), (7, 1, 'developer', 1);
  `);
  const tokens = new Map();
  const storageCalls = [];
  const env = {
    DB: db,
    JWT_SECRET: secret,
    ALLOWED_ORIGINS: '',
    DOWNLOAD_URL_TTL_SECONDS: '300',
    STORAGE: {
      signGetUrl: async (key) => `https://storage.example.test/${key}`,
      deleteObject: async () => {},
      createMultipartUpload: async (key) => { storageCalls.push('create'); return `upload-${key}`; },
      completeMultipartUpload: async () => { storageCalls.push('complete'); return { etag: 'test-etag' }; },
      headObject: async () => ({ size: 1024, etag: 'test-etag' }),
    },
  };
  async function request(path, { method = 'GET', body, userId = 1, token, status = 200 } = {}) {
    const pending = [];
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    else if (userId !== null) {
      if (!tokens.has(userId)) {
        const user = db._db.prepare('SELECT email, role FROM users WHERE id = ?').get(userId);
        tokens.set(userId, await signJwt({ sub: userId, ...user }, secret, 3600));
      }
      headers.authorization = `Bearer ${tokens.get(userId)}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.fetch(new Request(`https://qota.example.test${path}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), env, { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} });
    await Promise.all(pending);
    const result = await response.json();
    const expectedStatuses = Array.isArray(status) ? status : [status];
    assert.ok(expectedStatuses.includes(response.status), `${method} ${path}: expected ${expectedStatuses.join('/')} got ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  function version(label, channel = 'stable', options = {}) {
    const { projectId = 1, status = 'ready', notes = null, createdAt = 100, uploadedBy = 1, filename = `${label}-${channel}.bin` } = options;
    const key = options.r2Key ?? `${projectId}/${label}/${channel}/${filename}`;
    const result = db._db.prepare(`
      INSERT INTO versions (project_id, version, release_channel, status, r2_key,
        filename, size, notes, uploaded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1024, ?, ?, ?, ?)
    `).run(projectId, label, channel, status, key, filename, notes, uploadedBy, createdAt, createdAt);
    return Number(result.lastInsertRowid);
  }
  async function group(label, fields, projectId = 1, options = {}) {
    return request('/api/versions/group', {
      method: 'PATCH', body: { projectId, version: label, ...fields }, ...options,
    });
  }
  async function deviceToken(projectId = 1, channel = null) {
    const token = `test-device-${projectId}-${channel ?? 'any'}`;
    db._db.prepare(`
      INSERT INTO api_tokens (project_id, name, token_hash, token_prefix, kind,
        scope, channel, created_by, created_at)
      VALUES (?, 'Test device', ?, 'test', 'device', 'download', ?, 1, 1)
    `).run(projectId, await sha256Hex(token), channel);
    return token;
  }
  function row(id) { return db._db.prepare('SELECT * FROM versions WHERE id = ?').get(id); }
  async function current(projectId = 1) {
    const project = await request(`/api/projects/${projectId}`);
    return [...project.currentVersions].sort();
  }
  return { db, request, version, group, deviceToken, row, current, storageCalls, storage: env.STORAGE };
}

test('migration preserves valid legacy current labels and excludes unavailable selections', async (t) => {
  const f = await fixture(t, { beforeCurrentMigration: true });
  f.version('v1', 'ota');
  f.version('v1', 'flash');
  f.version('v1', 'ufw', { status: 'archived' });
  f.version('retired', 'ota', { projectId: 2, status: 'archived' });
  f.db._db.exec(`
    UPDATE projects SET current_version = 'v1' WHERE id = 1;
    UPDATE projects SET current_version = 'retired' WHERE id = 2;
    INSERT INTO projects (id, customer_id, code, name, current_version, created_at, updated_at)
      VALUES (3, 1, 'empty', 'Missing label', 'missing', 1, 1);
  `);
  for (const migration of migrations.filter((name) => name >= '0007_')) {
    f.db._db.exec(readFileSync(new URL(migration, migrationsDir), 'utf8'));
  }
  assert.deepEqual(f.db._db.prepare('SELECT project_id, version FROM project_current_versions').all(), [
    { project_id: 1, version: 'v1' },
  ]);
  assert.deepEqual(await f.current(), ['v1']);
  assert.deepEqual(await f.current(2), []);
  assert.deepEqual(await f.current(3), []);
  const versions = await f.request('/api/versions?projectId=1');
  assert.equal(versions.filter((v) => v.isCurrent).length, 2);
  assert.equal(versions.find((v) => v.status === 'archived').isCurrent, false);
});

test('multiple current labels can be independently enabled and disabled across channels', async (t) => {
  const f = await fixture(t);
  f.version('v1', 'ota');
  f.version('v1', 'flash');
  f.version('v1', 'ufw', { status: 'archived' });
  f.version('v2', 'ota');
  f.version('v2', 'pending', { status: 'pending' });
  f.version('v1', 'ota', { projectId: 2 });
  await f.group('v1', { isCurrent: true });
  await f.group('v2', { isCurrent: true });
  await f.group('v1', { isCurrent: true }); // repeated clicks remain idempotent
  assert.deepEqual(await f.current(), ['v1', 'v2']);
  assert.deepEqual(await f.current(2), []);
  const all = await f.request('/api/versions?projectId=1&includePending=1');
  assert.equal(all.filter((v) => v.isCurrent).length, 3);
  assert.ok(all.filter((v) => v.status !== 'ready').every((v) => !v.isCurrent));
  await f.group('v1', { isCurrent: false });
  assert.deepEqual(await f.current(), ['v2']);
  const projectList = await f.request('/api/projects');
  assert.deepEqual(projectList.find((p) => p.id === 1).currentVersions, ['v2']);
  await f.group('v2', { isCurrent: false });
  assert.deepEqual(await f.current(), []);
});

test('archiving one artifact preserves its current label until the last ready channel is archived', async (t) => {
  const f = await fixture(t);
  const ota = f.version('v1', 'ota');
  const flash = f.version('v1', 'flash');
  f.version('v2', 'ota');
  await f.group('v1', { isCurrent: true });
  await f.group('v2', { isCurrent: true });
  const archived = await f.request(`/api/versions/${ota}`, { method: 'PATCH', body: { status: 'archived' } });
  assert.equal(archived.isCurrent, false);
  assert.deepEqual(await f.current(), ['v1', 'v2']);
  assert.equal((await f.request(`/api/versions/${flash}`)).isCurrent, true);
  await f.request(`/api/versions/${flash}`, { method: 'PATCH', body: { status: 'archived' } });
  assert.deepEqual(await f.current(), ['v2']);
  const restored = await f.request(`/api/versions/${ota}`, { method: 'PATCH', body: { status: 'ready' } });
  assert.equal(restored.isCurrent, false);
  assert.deepEqual(await f.current(), ['v2']);
});

test('group archive and restore are scoped to one project and label and preserve pending uploads and notes', async (t) => {
  const f = await fixture(t);
  const notes = '修复升级失败\n兼容说明：' + '长备注内容 '.repeat(800);
  const ota = f.version('v1', 'ota', { notes });
  const flash = f.version('v1', 'flash', { notes: 'Flash-specific detail' });
  const pending = f.version('v1', 'ufw', { status: 'pending', notes: 'Uploading' });
  const otherLabel = f.version('v2', 'ota');
  const otherProject = f.version('v1', 'ota', { projectId: 2 });
  await f.group('v1', { isCurrent: true });
  await f.group('v2', { isCurrent: true });
  await f.group('v1', { isCurrent: true }, 2);
  const archived = await f.group('v1', { status: 'archived' });
  assert.ok(Array.isArray(archived));
  assert.deepEqual(archived.map((v) => v.id).sort(), [ota, flash, pending].sort());
  assert.equal(f.row(ota).status, 'archived');
  assert.equal(f.row(flash).status, 'archived');
  assert.equal(f.row(ota).notes, notes);
  assert.equal(f.row(flash).notes, 'Flash-specific detail');
  assert.equal(f.row(pending).status, 'pending');
  assert.equal(f.row(otherLabel).status, 'ready');
  assert.equal(f.row(otherProject).status, 'ready');
  assert.deepEqual(await f.current(), ['v2']);
  assert.deepEqual(await f.current(2), ['v1']);
  const restored = await f.group('v1', { status: 'ready' });
  assert.ok(restored.every((v) => !v.isCurrent));
  assert.equal(f.row(pending).status, 'pending');
  assert.equal(f.row(ota).notes, notes);
  assert.deepEqual(await f.current(), ['v2']);
});

test('archive all changes only ready artifacts in the requested project and clears its selections', async (t) => {
  const f = await fixture(t);
  const one = f.version('v1', 'ota', { notes: 'Keep these release notes' });
  const two = f.version('v2', 'flash');
  const pending = f.version('v3', 'ota', { status: 'pending' });
  const previouslyArchived = f.version('v0', 'ota', { status: 'archived' });
  const other = f.version('v1', 'ota', { projectId: 2 });
  await f.group('v1', { isCurrent: true });
  await f.group('v2', { isCurrent: true });
  await f.group('v1', { isCurrent: true }, 2);
  const untouchedPending = f.row(pending);
  const untouchedArchive = f.row(previouslyArchived);
  const result = await f.request('/api/versions/archive-all', { method: 'POST', body: { projectId: 1 } });
  assert.equal(result.ok, true);
  assert.equal(f.row(one).status, 'archived');
  assert.equal(f.row(two).status, 'archived');
  assert.equal(f.row(one).notes, 'Keep these release notes');
  assert.deepEqual(f.row(pending), untouchedPending);
  assert.deepEqual(f.row(previouslyArchived), untouchedArchive);
  assert.equal(f.row(other).status, 'ready');
  assert.deepEqual(await f.current(), []);
  assert.deepEqual(await f.current(2), ['v1']);
  await f.request('/api/versions/archive-all', { method: 'POST', body: { projectId: 1 } });
  assert.deepEqual(await f.current(), []);
});

test('full multiline notes round-trip through detail, lists, updates, archive and restore', async (t) => {
  const f = await fixture(t);
  const id = f.version('v1', 'ota');
  f.version('v1', 'flash');
  const notes = '发布说明\n\n' + '包含修复、安全更新、兼容性和设备说明。'.repeat(500);
  await f.group('v1', { notes });
  const detail = await f.request(`/api/versions/${id}`);
  assert.equal(detail.notes, notes);
  const list = await f.request('/api/versions?projectId=1');
  assert.ok(list.every((v) => v.notes === notes));
  const accessible = await f.request('/api/versions/accessible');
  assert.equal(accessible.find((v) => v.id === id).notes, notes);
  await f.group('v1', { status: 'archived' });
  const archived = await f.request('/api/versions/accessible?includeArchived=1');
  assert.equal(archived.find((v) => v.id === id).notes, notes);
  await f.group('v1', { status: 'ready' });
  assert.equal((await f.request(`/api/versions/${id}`)).notes, notes);
  await f.request(`/api/versions/${id}`, { method: 'PATCH', body: { notes: null } });
  assert.equal((await f.request(`/api/versions/${id}`)).notes, null);
});

test('device latest prioritizes all current labels within the requested channel with deterministic ties', async (t) => {
  const f = await fixture(t);
  const first = f.version('v1', 'ota', { createdAt: 100 });
  const second = f.version('v2', 'ota', { createdAt: 100 });
  const newer = f.version('v3', 'ota', { createdAt: 300 });
  const flash = f.version('v1', 'flash', { createdAt: 400 });
  const stable = f.version('v4', 'stable', { createdAt: 500 });
  f.version('v1', 'retired', { status: 'archived', createdAt: 900 });
  f.version('v9', 'ota', { status: 'pending', createdAt: 1000 });
  f.version('v9', 'ota', { projectId: 2, createdAt: 1100 });
  await f.group('v1', { isCurrent: true });
  await f.group('v2', { isCurrent: true });
  const token = await f.deviceToken();
  const latest = (channel) => f.request(`/api/download/device/latest?channel=${channel}&format=json`, { token });
  assert.equal((await latest('ota')).versionId, second);
  assert.equal((await latest('flash')).versionId, flash);
  assert.equal((await latest('stable')).versionId, stable);
  const listed = await f.request('/api/download/device/list?channel=ota', { token });
  assert.deepEqual(listed.versions.map((v) => [v.id, v.isCurrent]), [
    [second, true], [first, true], [newer, false],
  ]);
  await f.group('v2', { isCurrent: false });
  assert.equal((await latest('ota')).versionId, first);
  await f.group('v1', { isCurrent: false });
  assert.equal((await latest('ota')).versionId, newer);
  const pinnedToken = await f.deviceToken(1, 'flash');
  await f.request('/api/download/device/latest?channel=ota&format=json', { token: pinnedToken, status: 403 });
  await f.request('/api/download/device/list?channel=ota', { token: pinnedToken, status: 403 });
});

test('new bulk mutations enforce authentication, role permissions, and project boundaries', async (t) => {
  const f = await fixture(t);
  const one = f.version('v1', 'ota');
  const other = f.version('v1', 'ota', { projectId: 2 });
  for (const [userId, status] of [[null, 401], [3, 403], [4, 403]]) {
    await f.group('v1', { isCurrent: true }, 1, { userId, status });
    await f.group('v1', { status: 'archived' }, 1, { userId, status });
    await f.request('/api/versions/archive-all', { method: 'POST', body: { projectId: 1 }, userId, status });
  }
  await f.group('v1', { isCurrent: true }, 2, { userId: 2, status: 403 });
  await f.group('v1', { status: 'archived' }, 2, { userId: 2, status: 403 });
  await f.request('/api/versions/archive-all', { method: 'POST', body: { projectId: 2 }, userId: 2, status: 403 });
  assert.equal(f.row(one).status, 'ready');
  assert.equal(f.row(other).status, 'ready');
  assert.deepEqual(await f.current(), []);
  assert.deepEqual(await f.current(2), []);
  await f.group('v1', { isCurrent: true }, 1, { userId: 2 });
  assert.deepEqual(await f.current(), ['v1']);
  await f.group('v1', { status: 'archived' }, 1, { userId: 2 });
  assert.equal(f.row(one).status, 'archived');
});

test('invalid current selection cannot partially change status or release notes', async (t) => {
  const f = await fixture(t);
  const id = f.version('v1', 'ota', { notes: 'Original notes' });
  f.version('pending', 'ota', { status: 'pending' });
  f.version('archived', 'ota', { status: 'archived' });
  f.version('v2', 'ota');
  await f.group('v2', { isCurrent: true });
  await f.group('v1', { status: 'archived', isCurrent: true, notes: 'Must not be written' }, 1, { status: 400 });
  assert.equal(f.row(id).status, 'ready');
  assert.equal(f.row(id).notes, 'Original notes');
  assert.deepEqual(await f.current(), ['v2']);
  await f.group('pending', { isCurrent: true }, 1, { status: 404 });
  await f.group('archived', { isCurrent: true }, 1, { status: 400 });
  await f.group('missing', { isCurrent: true }, 1, { status: 404 });
  await f.request(`/api/versions/${id}`, {
    method: 'PATCH', body: { status: 'archived', isCurrent: true, notes: 'Must not be written' }, status: 400,
  });
  assert.equal(f.row(id).status, 'ready');
  assert.equal(f.row(id).notes, 'Original notes');
});

test('only the original uploader or administrators can edit notes and capability reflects permissions', async (t) => {
  const f = await fixture(t);
  const owned = f.version('owned', 'ota', { uploadedBy: 2, notes: 'Original' });
  const other = f.version('other', 'ota', { uploadedBy: 7, notes: 'Original' });
  const detail = (id, userId) => f.request(`/api/versions/${id}`, { userId });
  assert.equal((await detail(owned, 2)).canEditNotes, true);
  assert.equal((await detail(other, 2)).canEditNotes, false);
  for (const userId of [3, 4]) assert.equal((await detail(owned, userId)).canEditNotes, false);
  await f.request(`/api/versions/${owned}`, { method: 'PATCH', body: { notes: 'Uploader edit' }, userId: 2 });
  await f.request(`/api/versions/${other}`, { method: 'PATCH', body: { notes: 'Denied' }, userId: 2, status: 403 });
  assert.equal(f.row(other).notes, 'Original');
  for (const userId of [1, 5, 6]) {
    assert.equal((await detail(other, userId)).canEditNotes, true);
    await f.request(`/api/versions/${other}`, { method: 'PATCH', body: { notes: `Administrator ${userId}` }, userId });
    assert.equal(f.row(other).notes, `Administrator ${userId}`);
  }
  const list = await f.request('/api/versions?projectId=1', { userId: 2 });
  assert.equal(list.find((v) => v.id === owned).canEditNotes, true);
  assert.equal(list.find((v) => v.id === other).canEditNotes, false);
  const accessible = await f.request('/api/versions/accessible', { userId: 2 });
  assert.equal(accessible.find((v) => v.id === owned).canEditNotes, true);
  assert.equal(accessible.find((v) => v.id === other).canEditNotes, false);
});

test('group note edits require permission for every affected artifact and cannot partially update', async (t) => {
  const f = await fixture(t);
  const own = f.version('mixed', 'ota', { uploadedBy: 2, notes: 'Own original' });
  const other = f.version('mixed', 'flash', { uploadedBy: 7, notes: 'Other original' });
  f.version('owned', 'ota', { uploadedBy: 2 });
  f.version('owned', 'flash', { uploadedBy: 2 });
  await f.group('mixed', { notes: 'Denied group edit' }, 1, { userId: 2, status: 403 });
  assert.equal(f.row(own).notes, 'Own original');
  assert.equal(f.row(other).notes, 'Other original');
  const updated = await f.group('owned', { notes: 'Both owned' }, 1, { userId: 2 });
  assert.ok(updated.every((v) => v.notes === 'Both owned' && v.canEditNotes));
  const adminEdit = await f.group('mixed', { notes: 'Admin edit' }, 1, { userId: 5 });
  assert.ok(adminEdit.every((v) => v.notes === 'Admin edit' && v.canEditNotes));
});

test('current labels lock notes even for administrators and archived channels until separately deselected', async (t) => {
  const f = await fixture(t);
  const ready = f.version('v1', 'ota', { uploadedBy: 2, notes: 'Ready notes' });
  const archived = f.version('v1', 'flash', { uploadedBy: 2, status: 'archived', notes: 'Archived notes' });
  f.version('v2', 'ota', { uploadedBy: 2 });
  await f.group('v1', { isCurrent: true });
  await f.group('v2', { isCurrent: true });
  for (const userId of [1, 2, 5, 6]) {
    for (const id of [ready, archived]) {
      assert.equal((await f.request(`/api/versions/${id}`, { userId })).canEditNotes, false);
      await f.request(`/api/versions/${id}`, {
        method: 'PATCH', body: { notes: 'Forbidden while current' }, userId, status: 409,
      });
    }
  }
  await f.group('v1', { isCurrent: false, notes: 'Combined bypass' }, 1, { userId: 2, status: 409 });
  await f.request(`/api/versions/${ready}`, {
    method: 'PATCH', body: { isCurrent: false, notes: 'Combined bypass' }, userId: 2, status: 409,
  });
  assert.deepEqual(await f.current(), ['v1', 'v2']);
  assert.equal(f.row(ready).notes, 'Ready notes');
  assert.equal(f.row(archived).notes, 'Archived notes');
  await f.group('v1', { isCurrent: false }, 1, { userId: 2 });
  const result = await f.group('v1', { notes: 'Editable after deselecting' }, 1, { userId: 2 });
  assert.ok(result.every((v) => v.notes === 'Editable after deselecting' && v.canEditNotes));
  assert.deepEqual(await f.current(), ['v2']);
});

test('overwriting an artifact preserves omitted notes and original ownership and rejects unauthorized note changes', async (t) => {
  const f = await fixture(t);
  const id = f.version('v1', 'ota', { uploadedBy: 7, notes: 'Original release notes' });
  const upload = {
    projectId: 1, version: 'v1', releaseChannel: 'ota', filename: 'v1-ota.bin',
    totalSize: 1024, overwriteExisting: true,
  };
  await f.request('/api/upload/init', {
    method: 'POST', body: { ...upload, notes: 'Changed by a different developer' }, userId: 2, status: 403,
  });
  assert.deepEqual(f.storageCalls, []);
  const initialized = await f.request('/api/upload/init', { method: 'POST', body: upload, userId: 2 });
  const result = await f.request('/api/upload/complete', {
    method: 'POST', userId: 2, status: 201,
    body: { sessionId: initialized.sessionId, parts: [{ partNumber: 1, etag: 'test-etag', size: 1024 }] },
  });
  assert.equal(result.id, id);
  assert.equal(result.notes, 'Original release notes');
  assert.equal(result.uploadedBy, 7);
  assert.equal(result.canEditNotes, false);
  await f.request(`/api/versions/${id}`, { method: 'PATCH', body: { notes: 'Take ownership' }, userId: 2, status: 403 });
});

test('upload completion rechecks current-note locks and uploader permissions before writing storage', async (t) => {
  const f = await fixture(t);
  const id = f.version('v1', 'ota', { uploadedBy: 2, notes: 'Original' });
  const upload = {
    projectId: 1, version: 'v1', releaseChannel: 'ota', filename: 'v1-ota.bin',
    totalSize: 1024, overwriteExisting: true, notes: 'Updated notes',
  };
  await f.group('v1', { isCurrent: true });
  await f.request('/api/upload/init', { method: 'POST', body: upload, userId: 2, status: 409 });
  assert.deepEqual(f.storageCalls, []);
  await f.group('v1', { isCurrent: false });
  const initialized = await f.request('/api/upload/init', { method: 'POST', body: upload, userId: 2 });
  const complete = { sessionId: initialized.sessionId, parts: [{ partNumber: 1, etag: 'test-etag', size: 1024 }] };
  await f.group('v1', { isCurrent: true });
  await f.request('/api/upload/complete', { method: 'POST', body: complete, userId: 2, status: 409 });
  assert.equal(f.row(id).notes, 'Original');
  assert.deepEqual(f.storageCalls, ['create']);
  await f.group('v1', { isCurrent: false });
  await f.request('/api/upload/complete', { method: 'POST', body: complete, userId: 7, status: 403 });
  assert.deepEqual(f.storageCalls, ['create']);
  const completed = await f.request('/api/upload/complete', { method: 'POST', body: complete, userId: 2, status: 201 });
  assert.equal(completed.notes, 'Updated notes');
  assert.equal(completed.canEditNotes, true);
});

for (const scope of ['artifact', 'group']) {
  test(`${scope} note mutation cannot clear or archive a concurrently selected current label`, async (t) => {
    const f = await fixture(t);
    const ota = f.version('v1', 'ota', { uploadedBy: 2, notes: 'Original OTA notes' });
    const flash = f.version('v1', 'flash', { uploadedBy: 2, notes: 'Original flash notes' });
    f.version('v2', 'ota');
    await f.group('v2', { isCurrent: true });
    const originalRows = [f.row(ota), f.row(flash)];
    const batch = f.db.batch.bind(f.db);
    let interleaved = false;
    f.db.batch = async (statements) => {
      // Another request selects the label after the permission read but
      // immediately before this request's transaction acquires the DB.
      f.db.batch = batch;
      f.db._db.prepare('INSERT INTO project_current_versions (project_id, version) VALUES (1, ?)').run('v1');
      interleaved = true;
      return batch(statements);
    };
    const body = { notes: 'Must remain unwritten', isCurrent: false, status: 'archived' };
    if (scope === 'group') await f.group('v1', body, 1, { userId: 2, status: 409 });
    else await f.request(`/api/versions/${ota}`, { method: 'PATCH', body, userId: 2, status: 409 });
    assert.equal(interleaved, true);
    assert.deepEqual([f.row(ota), f.row(flash)], originalRows);
    assert.deepEqual(await f.current(), ['v1', 'v2']);
  });
}

test('upload note changes are rejected if current is selected while storage completes', async (t) => {
  const f = await fixture(t);
  const id = f.version('v1', 'ota', { uploadedBy: 2, notes: 'Published notes' });
  const original = f.row(id);
  const initialized = await f.request('/api/upload/init', {
    method: 'POST', userId: 2,
    body: {
      projectId: 1, version: 'v1', releaseChannel: 'ota', filename: 'v1-ota.bin',
      totalSize: 1024, overwriteExisting: true, notes: 'Changed notes',
    },
  });
  const complete = f.storage.completeMultipartUpload;
  f.storage.completeMultipartUpload = async (...args) => {
    const result = await complete(...args);
    f.db._db.prepare('INSERT INTO project_current_versions (project_id, version) VALUES (1, ?)').run('v1');
    return result;
  };
  await f.request('/api/upload/complete', {
    method: 'POST', userId: 2, status: 409,
    body: { sessionId: initialized.sessionId, parts: [{ partNumber: 1, etag: 'test-etag', size: 1024 }] },
  });
  assert.deepEqual(f.storageCalls, ['create', 'complete']);
  assert.deepEqual(f.row(id), original);
  assert.deepEqual(await f.current(), ['v1']);
});

test('upload SQL guard preserves metadata if current is selected after its final permission check', async (t) => {
  const f = await fixture(t);
  const id = f.version('v1', 'ota', { uploadedBy: 2, notes: 'Published notes' });
  const original = f.row(id);
  const initialized = await f.request('/api/upload/init', {
    method: 'POST', userId: 2,
    body: {
      projectId: 1, version: 'v1', releaseChannel: 'ota', filename: 'v1-ota.bin',
      totalSize: 1024, overwriteExisting: true, notes: 'Changed notes',
    },
  });
  const prepare = f.db.prepare.bind(f.db);
  let interleaved = false;
  f.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (/UPDATE versions\s+SET status = 'ready'/.test(sql)) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...args) => {
        const bound = bind(...args);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          f.db._db.prepare('INSERT INTO project_current_versions (project_id, version) VALUES (1, ?)').run('v1');
          interleaved = true;
          return run();
        };
        return bound;
      };
    }
    return statement;
  };
  await f.request('/api/upload/complete', {
    method: 'POST', userId: 2, status: 409,
    body: { sessionId: initialized.sessionId, parts: [{ partNumber: 1, etag: 'test-etag', size: 1024 }] },
  });
  assert.equal(interleaved, true);
  assert.deepEqual(f.row(id), original);
  assert.deepEqual(await f.current(), ['v1']);
});

test('legacy project currentVersion requests add to the current set and null clears it', async (t) => {
  const f = await fixture(t);
  f.version('v1', 'ota');
  f.version('v2', 'ota');
  await f.group('v1', { isCurrent: true });
  await f.request('/api/projects/1', { method: 'PATCH', body: { currentVersion: 'v2' } });
  assert.deepEqual(await f.current(), ['v1', 'v2']);
  await f.request('/api/projects/1', { method: 'PATCH', body: { currentVersion: null } });
  assert.deepEqual(await f.current(), []);
  const versions = await f.request('/api/versions?projectId=1');
  assert.ok(versions.every((v) => !v.isCurrent));
});

test('deleting the last ready artifact clears only its current label', async (t) => {
  const f = await fixture(t);
  const ota = f.version('v1', 'ota');
  const flash = f.version('v1', 'flash');
  f.version('v2', 'ota');
  await f.group('v1', { isCurrent: true });
  await f.group('v2', { isCurrent: true });
  await f.request(`/api/versions/${ota}`, { method: 'DELETE' });
  assert.deepEqual(await f.current(), ['v1', 'v2']);
  await f.request(`/api/versions/${flash}`, { method: 'DELETE' });
  assert.deepEqual(await f.current(), ['v2']);
});

function trackStoredObjects(f) {
  const objects = new Map();
  const deleted = [];
  f.storage.completeMultipartUpload = async (key, uploadId) => {
    objects.set(key, uploadId);
    return { etag: `etag-${uploadId}` };
  };
  f.storage.headObject = async (key) => objects.has(key) ? { size: 1024, etag: 'etag' } : null;
  f.storage.deleteObject = async (key) => { deleted.push(key); objects.delete(key); };
  return { objects, deleted };
}

function initFile(f, filename, options = {}) {
  const { userId = 2, status = 200, ...fields } = options;
  return f.request('/api/upload/init', {
    method: 'POST', userId, status,
    body: { projectId: 1, version: 'v1', releaseChannel: 'ota', totalSize: 1024, filename, ...fields },
  });
}

function completeFile(f, initialized, options = {}) {
  return f.request('/api/upload/complete', {
    method: 'POST', userId: 2, status: 201,
    body: { sessionId: initialized.sessionId, parts: [{ partNumber: 1, etag: 'etag', size: 1024 }] },
    ...options,
  });
}

test('multi-file migration preserves old version metadata, live upload references, and ID allocation', async (t) => {
  const f = await fixture(t, { beforeMultiFileMigration: true });
  const ready = f.version('v1', 'ota', { filename: 'original.bin', uploadedBy: 2, notes: '旧版本完整备注\n第二行' });
  const archived = f.version('v0', 'ota', { status: 'archived', notes: 'Archived history' });
  const deletedId = f.version('deleted', 'ota');
  f.db._db.prepare('DELETE FROM versions WHERE id = ?').run(deletedId);
  f.db._db.exec(`INSERT INTO device_groups (id, project_id, code, name, created_at) VALUES (42, 1, 'test', 'Test devices', 1)`);
  f.db._db.prepare(`
    UPDATE versions SET public_slug = 'shared-public-link', download_count = 37, sha256 = ?,
      is_mandatory = 1, min_version = 'v0', max_version = 'v9', rollout_percentage = 75, device_group_id = 42
    WHERE id = ?
  `).run('a'.repeat(64), ready);
  await f.group('v1', { isCurrent: true });
  f.db._db.prepare(`
    INSERT INTO upload_sessions (id, project_id, version_id, r2_key, filename, total_size, part_size,
      upload_id, target_version, release_channel, notes, status, initiated_by, created_at)
    VALUES (71, 1, ?, 'old/session/key', 'original.bin', 1024, 1024, 'old-upload', 'v1', 'ota', 'Upload notes', 'in_progress', 2, 777)
  `).run(ready);
  f.db._db.prepare(`
    INSERT INTO upload_sessions (id, project_id, version_id, r2_key, filename, total_size, part_size,
      upload_id, target_version, release_channel, status, initiated_by, created_at)
    VALUES (72, 1, ?, 'archived/session/key', 'v0-ota.bin', 1024, 1024, 'completed-upload', 'v0', 'ota', 'completed', 1, 777)
  `).run(archived);
  f.db._db.exec(`INSERT INTO upload_parts (session_id, part_number, etag, size, uploaded_at) VALUES (71, 1, 'saved-etag', 1024, 777)`);
  const versionsBefore = f.db._db.prepare('SELECT * FROM versions ORDER BY id').all();
  const sessionsBefore = f.db._db.prepare('SELECT * FROM upload_sessions ORDER BY id').all();
  const partsBefore = f.db._db.prepare('SELECT * FROM upload_parts').all();
  f.db._db.exec('CREATE TABLE _node_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const migration of migrations.filter((name) => name < '0008_')) {
    f.db._db.prepare('INSERT INTO _node_migrations (name, applied_at) VALUES (?, 1)').run(migration);
  }
  const pendingMigrations = migrations.filter((name) => name >= '0008_');
  assert.ok(pendingMigrations.length > 0, 'the multi-file migration must exist');
  assert.equal(runMigrations(f.db, fileURLToPath(migrationsDir)), pendingMigrations.length);
  assert.deepEqual(f.db._db.prepare('SELECT * FROM versions ORDER BY id').all(), versionsBefore);
  assert.deepEqual(f.db._db.prepare('SELECT * FROM upload_sessions ORDER BY id').all(), sessionsBefore);
  assert.deepEqual(f.db._db.prepare('SELECT * FROM upload_parts').all(), partsBefore);
  assert.deepEqual(f.db._db.pragma('foreign_key_check'), []);
  assert.deepEqual(await f.current(), ['v1']);
  assert.equal((await f.request(`/api/projects/1`)).currentVersion, 'v1');
  const secondFile = f.version('v1', 'ota', { filename: 'second.bin' });
  assert.ok(secondFile > deletedId, 'migration must preserve the deleted-ID high-water mark');
  assert.throws(() => f.version('v1', 'ota', { filename: 'original.bin', r2Key: 'unique-duplicate-key' }),
    /UNIQUE constraint failed: versions.project_id, versions.version, versions.release_channel, versions.filename/);
  assert.equal(runMigrations(f.db, fileURLToPath(migrationsDir)), 0);
});

test('different filenames coexist under one version and channel and group actions include every file', async (t) => {
  const f = await fixture(t);
  trackStoredObjects(f);
  const first = await completeFile(f, await initFile(f, 'firmware.bin', { notes: 'Firmware notes' }));
  const second = await completeFile(f, await initFile(f, 'resources.bin', { notes: 'Resource notes', overwriteExisting: true }));
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.r2Key, first.r2Key);
  const listed = await f.request('/api/versions?projectId=1&channel=ota');
  assert.deepEqual(listed.map((v) => v.filename).sort(), ['firmware.bin', 'resources.bin']);
  assert.equal(f.row(first.id).notes, 'Firmware notes');
  assert.equal(f.row(second.id).notes, 'Resource notes');
  await f.group('v1', { isCurrent: true });
  const currentFiles = await f.request('/api/versions?projectId=1&channel=ota');
  assert.ok(currentFiles.every((v) => v.isCurrent && !v.canEditNotes));
  await f.group('v1', { status: 'archived' });
  assert.equal(f.row(first.id).status, 'archived');
  assert.equal(f.row(second.id).status, 'archived');
  assert.deepEqual(await f.current(), []);
  await f.group('v1', { status: 'ready' });
  assert.deepEqual(await f.current(), []);
});

test('same filename requires explicit overwrite and only that file is replaced', async (t) => {
  const f = await fixture(t);
  const stored = trackStoredObjects(f);
  const original = await completeFile(f, await initFile(f, 'firmware.bin', { notes: 'Original notes' }));
  const sibling = await completeFile(f, await initFile(f, 'resources.bin', { notes: 'Sibling notes' }));
  const siblingBefore = f.row(sibling.id);
  await initFile(f, 'firmware.bin', { status: 409 });
  const replacement = await initFile(f, 'firmware.bin', { overwriteExisting: true });
  assert.notEqual(replacement.key, original.r2Key);
  const replaced = await completeFile(f, replacement);
  assert.equal(replaced.id, original.id);
  assert.equal(replaced.notes, 'Original notes');
  assert.equal(replaced.uploadedBy, 2);
  assert.deepEqual(f.row(sibling.id), siblingBefore);
  assert.ok(stored.objects.has(replaced.r2Key));
  assert.ok(stored.objects.has(sibling.r2Key));
  assert.ok(!stored.objects.has(original.r2Key));
  assert.deepEqual(stored.deleted, [original.r2Key]);
});

test('distinct Chinese filenames get separate storage keys and remain independently downloadable', async (t) => {
  const f = await fixture(t);
  const stored = trackStoredObjects(f);
  const firstSession = await initFile(f, '固件一.bin');
  const secondSession = await initFile(f, '固件二.bin');
  assert.notEqual(firstSession.key, secondSession.key);
  const first = await completeFile(f, firstSession);
  const second = await completeFile(f, secondSession);
  assert.equal(stored.objects.size, 2);
  const firstGrant = await f.request('/api/download/grant', { method: 'POST', body: { versionId: first.id }, userId: 2 });
  const secondGrant = await f.request('/api/download/grant', { method: 'POST', body: { versionId: second.id }, userId: 2 });
  assert.notEqual(firstGrant.url, secondGrant.url);
  assert.equal(firstGrant.filename, '固件一.bin');
  assert.equal(secondGrant.filename, '固件二.bin');
});

test('overlapping uploads of the same new filename conflict without overwriting the winner object', async (t) => {
  const f = await fixture(t);
  const stored = trackStoredObjects(f);
  const first = await initFile(f, 'firmware.bin', { notes: 'First session' });
  const second = await initFile(f, 'firmware.bin', { notes: 'Second session' });
  assert.notEqual(first.key, second.key);
  // Both requests must pass their initial existence checks before either
  // finishes storage. This exercises the final UNIQUE conflict, not just a
  // sequential duplicate caught by the preflight query.
  const complete = f.storage.completeMultipartUpload;
  let release;
  const bothInStorage = new Promise((resolve) => { release = resolve; });
  let arrivals = 0;
  f.storage.completeMultipartUpload = async (...args) => {
    const result = await complete(...args);
    if (++arrivals === 2) release();
    await bothInStorage;
    return result;
  };
  const results = await Promise.all([
    completeFile(f, first, { status: [201, 409] }),
    completeFile(f, second, { status: [201, 409] }),
  ]);
  const winners = results.filter((result) => typeof result.id === 'number');
  assert.equal(winners.length, 1);
  assert.equal(results.filter((result) => result.error).length, 1);
  const winner = winners[0];
  const winnerSession = winner.r2Key === first.key ? first : second;
  const loser = winner.r2Key === first.key ? second : first;
  assert.equal(f.row(winner.id).r2_key, winnerSession.key);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM versions').first('count'), 1);
  assert.ok(stored.objects.has(winnerSession.key));
  assert.ok(!stored.objects.has(loser.key));
  assert.deepEqual(stored.deleted, [loser.key]);
  const loserSession = await f.db.prepare('SELECT status FROM upload_sessions WHERE id = ?').bind(loser.sessionId).first();
  assert.notEqual(loserSession.status, 'completed');
});

test('device list and latest can select an exact filename within a shared version and channel', async (t) => {
  const f = await fixture(t);
  const firmwareOld = f.version('v1', 'ota', { filename: 'firmware.bin', createdAt: 100 });
  const firmwareCurrent = f.version('v2', 'ota', { filename: 'firmware.bin', createdAt: 200 });
  f.version('v2', 'ota', { filename: 'resources.bin', createdAt: 300 });
  f.version('v3', 'ota', { filename: 'firmware.bin', createdAt: 400 });
  await f.group('v2', { isCurrent: true });
  const token = await f.deviceToken(1, 'ota');
  const list = await f.request('/api/download/device/list?filename=firmware.bin', { token });
  assert.ok(list.versions.every((v) => v.filename === 'firmware.bin'));
  assert.equal(list.versions.length, 3);
  const latest = await f.request('/api/download/device/latest?format=json&filename=firmware.bin', { token });
  assert.equal(latest.versionId, firmwareCurrent);
  assert.notEqual(latest.versionId, firmwareOld);
  await f.request('/api/download/device/latest?format=json&filename=missing.bin', { token, status: 404 });
});
