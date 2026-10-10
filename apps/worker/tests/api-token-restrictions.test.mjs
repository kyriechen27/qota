import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import app from '../src/index.ts';
import { signJwt } from '../src/utils/jwt.ts';
import { sha256Hex } from '../src/utils/sha.ts';
import { createSqliteD1 } from '../node/d1-sqlite.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const migrationDir = new URL('../migrations/', import.meta.url);

// Production handlers and migrations with synthetic credentials and in-memory
// SQLite only. Downloads use an inert signing stub, never real object storage.
async function fixture(t, { beforeRestrictions = false } = {}) {
  const db = createSqliteD1(':memory:');
  t.after(() => db._db.close());
  const migrations = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    if (beforeRestrictions && name >= '0014_') continue;
    db._db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  }
  db._db.exec(`
    INSERT INTO users(id,email,display_name,password_hash,role,created_at,updated_at) VALUES
      (1,'admin@example.test','Admin','unused','super_admin',1,1),
      (2,'developer@example.test','Developer','unused','developer',1,1),
      (3,'viewer@example.test','Viewer','unused','developer',1,1),
      (4,'other@example.test','Other developer','unused','developer',1,1);
    INSERT INTO customers(id,code,name,created_at,updated_at) VALUES
      (1,'first','First customer',1,1),(2,'second','Second customer',1,1);
    INSERT INTO projects(id,customer_id,code,name,created_at,updated_at) VALUES
      (1,1,'main','Main project',1,1),(2,2,'other','Other project',1,1);
    INSERT INTO memberships(user_id,customer_id,role,created_at) VALUES
      (2,1,'developer',1),(3,1,'viewer',1),(4,2,'developer',1);
  `);
  const signed = [];
  const env = {
    DB: db, JWT_SECRET: 'isolated-token-restrictions-test', ALLOWED_ORIGINS: '', DOWNLOAD_URL_TTL_SECONDS: '300',
    STORAGE: {
      signGetUrl: async (key) => { signed.push(key); return `https://storage.example.test/${key}`; },
      deleteObject: async () => {},
    },
  };
  const jwt = new Map();
  async function request(path, { method = 'GET', body, userId = 2, token, status = 200 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    else if (userId !== null) {
      if (!jwt.has(userId)) {
        const user = db._db.prepare('SELECT email,role FROM users WHERE id=?').get(userId);
        jwt.set(userId, await signJwt({ sub: userId, ...user }, env.JWT_SECRET, 3600));
      }
      headers.authorization = `Bearer ${jwt.get(userId)}`;
    }
    const pending = [];
    const response = await app.fetch(new Request(`https://qota.example.test${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} });
    await Promise.all(pending);
    const result = await response.json();
    assert.equal(response.status, status, `${method} ${path}: expected ${status}, received ${response.status} (${result.error?.message ?? result.message ?? ''})`);
    return result;
  }
  function version(label, channel, { projectId = 1, specialVersion = 'HW-A', status = 'ready', filename = 'firmware.bin', createdAt = 100 } = {}) {
    const result = db._db.prepare(`INSERT INTO versions
      (project_id,version,release_channel,status,r2_key,filename,size,uploaded_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1024,2,?,?)`)
      .run(projectId, label, channel, status, randomUUID(), filename, createdAt, createdAt);
    db._db.prepare(`INSERT OR IGNORE INTO version_metadata
      (project_id,version,notes,special_version,created_by,created_at,updated_at)
      VALUES (?,?,NULL,?,2,?,?)`).run(projectId, label, specialVersion, createdAt, createdAt);
    return Number(result.lastInsertRowid);
  }
  const issue = (fields = {}, options = {}) => request('/api/api-tokens', {
    method: 'POST', body: { projectId: 1, name: 'Synthetic restricted token', kind: 'device', scope: 'download', ...fields }, status: 201, ...options,
  });
  const list = (issued, query = '', options = {}) => request(`/api/download/device/list${query ? `?${query}` : ''}`, { token: issued.token, ...options });
  const latest = (issued, query = '', options = {}) => request(`/api/download/device/latest?format=json${query ? `&${query}` : ''}`, { token: issued.token, ...options });
  const getFile = (issued, id, query = '', options = {}) => request(`/api/download/device/version/${id}?format=json${query ? `&${query}` : ''}`, { token: issued.token, ...options });
  function catalog() {
    const firmware = version('v1', 'ota');
    const resources = version('v1', 'ota', { filename: 'resources.bin', createdAt: 101 });
    const flash = version('v1', 'flash', { createdAt: 102 });
    const stable = version('v2', 'stable', { specialVersion: 'HW-B', createdAt: 200 });
    const newest = version('v3', 'ota', { createdAt: 300 });
    const archived = version('v0', 'flash', { status: 'archived', createdAt: 400 });
    const pending = version('v4', 'ota', { status: 'pending', createdAt: 500 });
    const foreign = version('v1', 'ota', { projectId: 2, createdAt: 600 });
    db._db.prepare("INSERT INTO project_current_versions(project_id,version) VALUES(1,'v1')").run();
    return { firmware, resources, flash, stable, newest, archived, pending, foreign };
  }
  return { db, request, version, issue, list, latest, getFile, catalog, signed, migrations };
}

test('token restriction migration preserves old secrets and channel behavior with nullable new fields', async (t) => {
  const f = await fixture(t, { beforeRestrictions: true });
  const raw = `isolated-legacy-${randomUUID()}`;
  const hash = await sha256Hex(raw);
  f.db._db.prepare(`INSERT INTO api_tokens
    (id,project_id,name,token_hash,token_prefix,kind,scope,channel,created_by,created_at)
    VALUES(81,1,'Legacy token',?,'synthetic','device','download','ota',2,1)`).run(hash);
  for (const name of f.migrations.filter((entry) => entry >= '0014_')) {
    f.db._db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  }
  const row = f.db._db.prepare('SELECT token_hash,special_version,version,version_id FROM api_tokens WHERE id=81').get();
  assert.equal(row.token_hash, hash);
  assert.deepEqual({ ...row, token_hash: undefined }, { token_hash: undefined, special_version: null, version: null, version_id: null });
  const rows = await f.request('/api/api-tokens?projectId=1');
  assert.equal(rows[0].specialVersion, null);
  assert.equal(rows[0].version, null);
  assert.equal(rows[0].versionId, null);
  assert.equal(rows[0].hasSecret, false);
  assert.ok(!('token' in rows[0]) && !('token_hash' in rows[0]) && !('token_enc' in rows[0]));
  const ota = f.version('legacy', 'ota');
  f.version('legacy', 'flash');
  assert.deepEqual((await f.list({ token: raw })).versions.map((v) => v.id), [ota]);
  assert.equal((await f.latest({ token: raw })).versionId, ota);
  const future = await f.issue({ channel: 'future' });
  assert.deepEqual((await f.list(future)).versions, []);
  await f.latest(future, '', { status: 404 });
  const unrestricted = await f.issue();
  await f.latest(unrestricted, '', { status: 404 });
  const stable = f.version('stable-release', 'stable');
  assert.equal((await f.latest(unrestricted)).versionId, stable, 'old unrestricted token keeps default stable channel');
});

test('special edition, label, file and channel restrictions intersect across every device endpoint', async (t) => {
  const f = await fixture(t);
  const v = f.catalog();
  const cases = [
    [{ specialVersion: 'HW-A' }, [v.flash, v.resources, v.firmware, v.newest]],
    [{ version: 'v1' }, [v.flash, v.resources, v.firmware]],
    [{ versionId: v.firmware }, [v.firmware]],
    [{ channel: 'ota', specialVersion: 'HW-A' }, [v.resources, v.firmware, v.newest]],
    [{ channel: 'ota', version: 'v1' }, [v.resources, v.firmware]],
    [{ specialVersion: 'HW-A', version: 'v1' }, [v.flash, v.resources, v.firmware]],
    [{ channel: 'ota', specialVersion: 'HW-A', version: 'v1', versionId: v.firmware }, [v.firmware]],
    [{ versionId: v.flash }, [v.flash]],
  ];
  for (const [fields, expected] of cases) {
    const issued = await f.issue(fields);
    assert.equal(issued.specialVersion, fields.specialVersion ?? null);
    assert.equal(issued.version, fields.version ?? null);
    assert.equal(issued.versionId, fields.versionId ?? null);
    assert.deepEqual((await f.list(issued)).versions.map((item) => item.id), expected);
    assert.equal((await f.latest(issued)).versionId, expected[0]);
    for (const id of expected) assert.equal((await f.getFile(issued, id)).versionId, id);
    await f.getFile(issued, v.stable, '', { status: 403 });
    await f.getFile(issued, v.foreign, '', { status: 403 });
    await f.getFile(issued, 999999, '', { status: 404 });
  }
});

test('request filters can narrow authorized tokens but cannot override their restrictions', async (t) => {
  const f = await fixture(t);
  const v = f.catalog();
  const edition = await f.issue({ specialVersion: 'HW-A' });
  assert.deepEqual((await f.list(edition, 'version=v1&channel=ota')).versions.map((item) => item.id), [v.resources, v.firmware]);
  assert.equal((await f.latest(edition, `versionId=${v.firmware}`)).versionId, v.firmware);
  assert.equal((await f.latest(edition, 'version=v1&filename=resources.bin')).versionId, v.resources);
  assert.equal((await f.getFile(edition, v.resources, 'version=v1&channel=ota&filename=resources.bin')).versionId, v.resources);
  assert.deepEqual((await f.list(edition, 'version=v2')).versions, []);
  await f.latest(edition, 'version=v2', { status: 404 });
  await f.getFile(edition, v.firmware, 'version=v2', { status: 403 });
  const pins = [
    [edition, 'specialVersion=HW-B'],
    [await f.issue({ version: 'v1' }), 'version=v3'],
    [await f.issue({ versionId: v.firmware }), `versionId=${v.newest}`],
    [await f.issue({ channel: 'ota', version: 'v1' }), 'channel=flash'],
  ];
  for (const [issued, query] of pins) {
    await f.list(issued, query, { status: 403 });
    await f.latest(issued, query, { status: 403 });
    await f.getFile(issued, v.firmware, query, { status: 403 });
  }
  for (const query of ['version=bad%20label', 'versionId=not-an-id', 'versionId=-1', 'specialVersion=bad%0Avalue', 'channel=Bad%20Channel']) {
    await f.list(edition, query, { status: 400 });
    await f.latest(edition, query, { status: 400 });
    await f.getFile(edition, v.firmware, query, { status: 400 });
  }
  await f.latest(edition, 'project=other', { status: 403 });
  await f.latest(edition, 'customer=second', { status: 403 });
  assert.equal((await f.list(edition, 'projectId=2')).project.id, 1);
  await f.getFile(edition, v.foreign, 'projectId=2', { status: 403 });
});

test('issuance rejects malformed restrictions and combinations with no matching project artifact', async (t) => {
  const f = await fixture(t);
  const v = f.catalog();
  const invalid = [
    { specialVersion: false }, { specialVersion: 'x'.repeat(129) }, { specialVersion: 'HW\nA' },
    { version: 123 }, { version: ' v1 ' }, { version: 'x'.repeat(65) },
    { channel: 'Bad Channel' }, { channel: false },
    { versionId: 0 }, { versionId: -1 }, { versionId: 1.5 }, { versionId: String(v.firmware) }, { versionId: true },
  ];
  for (const fields of invalid) await f.issue(fields, { status: 400 });
  const noIntersection = [
    { specialVersion: 'missing' }, { version: 'missing' }, { versionId: 999999 },
    { version: 'v4' }, { versionId: v.pending }, { versionId: v.foreign },
    { specialVersion: 'HW-A', version: 'v2' },
    { version: 'v1', versionId: v.newest },
    { channel: 'flash', versionId: v.firmware },
    { specialVersion: 'HW-B', versionId: v.firmware },
    { channel: 'flash', version: 'v3', specialVersion: 'HW-A' },
  ];
  for (const fields of noIntersection) await f.issue(fields, { status: 400 });
  await f.issue({ projectId: 2, versionId: v.firmware }, { userId: 1, status: 400 });
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM api_tokens').first('count'), 0);
  const empty = await f.issue({ specialVersion: '   ', version: '', channel: '', versionId: null });
  assert.equal(empty.specialVersion, null);
  assert.equal(empty.version, null);
  assert.equal(empty.channel, null);
  assert.equal(empty.versionId, null);
  const normalized = await f.issue({ specialVersion: '  HW-A  ', version: 'v1' });
  assert.equal(normalized.specialVersion, 'HW-A');
});

test('archived targets can be authorized without becoming downloadable until restored', async (t) => {
  const f = await fixture(t);
  const v = f.catalog();
  const issued = await f.issue({ versionId: v.archived, version: 'v0', specialVersion: 'HW-A', channel: 'flash' });
  assert.deepEqual((await f.list(issued)).versions, []);
  await f.latest(issued, '', { status: 404 });
  await f.getFile(issued, v.archived, '', { status: 400 });
  await f.getFile(issued, v.pending, '', { status: 403 });
  await f.request(`/api/versions/${v.archived}`, { method: 'PATCH', body: { status: 'ready' } });
  assert.equal((await f.latest(issued)).versionId, v.archived);
  assert.equal((await f.getFile(issued, v.archived)).versionId, v.archived);
});

test('issuance rechecks its artifact intersection at the final write and leaves no token after a race', async (t) => {
  for (const change of ['delete', 'edition']) {
    const f = await fixture(t);
    const id = f.version('v1', 'ota');
    const prepare = f.db.prepare.bind(f.db);
    let interleaved = false;
    f.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/INSERT INTO api_tokens/.test(sql)) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            if (change === 'delete') f.db._db.prepare('DELETE FROM versions WHERE id=?').run(id);
            else f.db._db.prepare("UPDATE version_metadata SET special_version='HW-B' WHERE project_id=1 AND version='v1'").run();
            interleaved = true;
            return run();
          };
          return bound;
        };
      }
      return statement;
    };
    await f.issue({ versionId: id, specialVersion: 'HW-A' }, { status: 409 });
    assert.equal(interleaved, true);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS count FROM api_tokens').first('count'), 0);
  }
});

test('metadata changes and deleting a pinned file cannot silently widen an existing token', async (t) => {
  const f = await fixture(t);
  const v = f.catalog();
  const edition = await f.issue({ specialVersion: 'HW-A', version: 'v1' });
  const file = await f.issue({ versionId: v.firmware });
  const label = await f.issue({ version: 'v1' });
  await f.request('/api/versions/group', { method: 'PATCH', body: { projectId: 1, version: 'v1', isCurrent: false } });
  await f.request('/api/versions/group', { method: 'PATCH', body: { projectId: 1, version: 'v1', specialVersion: 'HW-B' } });
  assert.deepEqual((await f.list(edition)).versions, []);
  await f.latest(edition, '', { status: 404 });
  await f.getFile(edition, v.firmware, '', { status: 403 });
  assert.equal((await f.getFile(file, v.firmware)).versionId, v.firmware, 'file-only restriction does not acquire an implicit edition pin');
  await f.request(`/api/versions/${v.firmware}`, { method: 'DELETE' });
  const replacement = f.version('v1', 'ota', { specialVersion: 'HW-B' });
  assert.notEqual(replacement, v.firmware);
  assert.equal(f.db._db.prepare('SELECT version_id FROM api_tokens WHERE id=?').get(file.id).version_id, v.firmware);
  assert.deepEqual((await f.list(file)).versions, []);
  await f.latest(file, '', { status: 404 });
  await f.getFile(file, v.firmware, '', { status: 404 });
  await f.getFile(file, replacement, '', { status: 403 });
  assert.ok((await f.list(label)).versions.some((entry) => entry.id === replacement), 'label grant intentionally includes replacement files');
});

test('token restrictions do not bypass project management, expiry, revocation or JWT-only operations', async (t) => {
  const f = await fixture(t);
  const v = f.catalog();
  await f.issue({ versionId: v.firmware }, { userId: 3, status: 403 });
  await f.issue({ versionId: v.firmware }, { userId: null, status: 401 });
  await f.issue({ projectId: 2, versionId: v.foreign }, { status: 403 });
  const admin = await f.issue({ projectId: 2, versionId: v.foreign }, { userId: 1 });
  assert.equal((await f.latest(admin)).versionId, v.foreign);
  const ci = await f.issue({ kind: 'ci', scope: 'full', versionId: v.firmware });
  for (const [path, body] of [
    ['/api/upload/init', { projectId: 1, filename: 'injected.bin', totalSize: 1024, version: 'v9' }],
    ['/api/download/grant', { versionId: v.foreign }],
    ['/api/api-tokens', { projectId: 1, name: 'Expansion attempt' }],
  ]) await f.request(path, { method: 'POST', token: ci.token, body, status: 401 });
  await f.request('/api/versions?projectId=1', { token: ci.token, status: 401 });
  assert.equal((await f.getFile(ci, v.firmware)).versionId, v.firmware);
  const uploadOnly = await f.issue({ kind: 'ci', scope: 'upload', versionId: v.firmware });
  await f.list(uploadOnly, '', { status: 403 });
  await f.latest(uploadOnly, '', { status: 403 });
  await f.getFile(uploadOnly, v.firmware, '', { status: 403 });
  const expired = await f.issue({ versionId: v.firmware, expiresAt: Date.now() - 1000 });
  for (const issued of [expired, ci]) {
    if (issued === ci) await f.request(`/api/api-tokens/${ci.id}/revoke`, { method: 'POST' });
    await f.list(issued, '', { status: 401 });
    await f.latest(issued, '', { status: 401 });
    await f.getFile(issued, v.firmware, '', { status: 401 });
  }
});
