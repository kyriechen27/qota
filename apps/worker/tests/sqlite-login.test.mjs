import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSqliteD1 } from '../node/d1-sqlite.mjs';
import { runMigrations } from '../node/migrate.mjs';
import app from '../src/index.ts';
import { hashPassword } from '../src/utils/password.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

function database(t) {
  const db = createSqliteD1(':memory:');
  t.after(() => db._db.close());
  return db;
}

test('SQLite adapter applies production migrations exactly once on the active Node runtime', async (t) => {
  const db = database(t);
  const migrationCount = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).length;
  assert.equal(runMigrations(db, migrationsDir), migrationCount);
  assert.equal(runMigrations(db, migrationsDir), 0);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM _node_migrations').first('count'), migrationCount);
  assert.deepEqual(await db.prepare('SELECT project_id, version FROM project_current_versions').all(), {
    results: [], success: true, meta: { changes: 0, last_row_id: 0 },
  });
});

test('SQLite adapter preserves D1 row, raw-array, binding and result metadata semantics', async (t) => {
  const db = database(t);
  await db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, title TEXT, enabled INTEGER, optional TEXT)');
  const inserted = await db.prepare('INSERT INTO records (title, enabled, optional) VALUES (?, ?, ?)')
    .bind('Example', true, undefined).run();
  assert.equal(inserted.meta.last_row_id, 1);
  assert.equal(inserted.meta.changes, 1);
  assert.deepEqual(await db.prepare('SELECT * FROM records WHERE id = ?').bind(1).first(), {
    id: 1, title: 'Example', enabled: 1, optional: null,
  });
  assert.equal(await db.prepare('SELECT ? AS value').bind(false).first('value'), 0);
  assert.equal(await db.prepare('SELECT * FROM records WHERE id = ?').bind(999).first(), null);
  assert.deepEqual(await db.prepare('SELECT title, enabled, optional FROM records').raw(), [['Example', 1, null]]);
  assert.equal((await db.prepare('UPDATE records SET enabled = ? WHERE id = ?').bind(false, 1).run()).meta.changes, 1);
  assert.equal((await db.prepare('DELETE FROM records WHERE id = ?').bind(999).run()).meta.changes, 0);
});

test('SQLite batch rolls back earlier writes on failure and remains usable afterward', async (t) => {
  const db = database(t);
  await db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, title TEXT UNIQUE NOT NULL)');
  await assert.rejects(db.batch([
    db.prepare('INSERT INTO records (title) VALUES (?)').bind('duplicate'),
    db.prepare('INSERT INTO records (title) VALUES (?)').bind('duplicate'),
  ]));
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM records').first('count'), 0);
  const results = await db.batch([
    db.prepare('INSERT INTO records (title) VALUES (?)').bind('first'),
    db.prepare('INSERT INTO records (title) VALUES (?)').bind('second'),
  ]);
  assert.deepEqual(results.map((result) => result.meta.changes), [1, 1]);
  assert.deepEqual(await db.prepare('SELECT title FROM records ORDER BY id').raw(), [['first'], ['second']]);
});

test('real login accepts email and display name and its issued token authenticates /me', async (t) => {
  const db = database(t);
  runMigrations(db, migrationsDir);
  const password = 'synthetic-password-for-login-tests';
  await db.prepare(`
    INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
    VALUES (1, 'tester@example.test', 'Runtime Tester', ?, 'developer', 1, 1)
  `).bind(await hashPassword(password)).run();
  await db.prepare(`INSERT INTO user_global_roles (user_id, role, updated_at) VALUES (1, 'admin', 1)`).run();
  const env = { DB: db, JWT_SECRET: 'isolated-login-regression-test-secret', JWT_TTL_SECONDS: '3600', ALLOWED_ORIGINS: '' };
  async function request(path, { body, token, status = 200 } = {}) {
    const response = await app.fetch(new Request(`https://qota.example.test${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);
    const result = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
    return result;
  }
  for (const identifier of ['  TESTER@EXAMPLE.TEST  ', 'runtime tester']) {
    const login = await request('/api/auth/login', { body: { email: identifier, password } });
    assert.equal(typeof login.token, 'string');
    assert.equal(login.user.role, 'admin');
    assert.equal(login.user.displayName, 'Runtime Tester');
    assert.equal(login.user.email, 'tester@example.test');
    assert.deepEqual(await request('/api/auth/me', { token: login.token }), login.user);
  }
  await request('/api/auth/login', { body: { email: 'tester@example.test', password: 'incorrect' }, status: 401 });
  await db.prepare('UPDATE users SET is_active = 0 WHERE id = 1').run();
  await request('/api/auth/login', { body: { email: 'Runtime Tester', password }, status: 401 });
});
