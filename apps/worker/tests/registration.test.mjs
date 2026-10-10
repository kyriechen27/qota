import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import app from '../src/index.ts';
import { createSqliteD1 } from '../node/d1-sqlite.mjs';
import { hashPassword, verifyPassword } from '../src/utils/password.ts';
import { signJwt } from '../src/utils/jwt.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const seedPassword = 'Synthetic-original-password-123';
const signupPassword = 'Synthetic-signup-password-456';
const seedHash = hashPassword(seedPassword);
const migrationDir = new URL('../migrations/', import.meta.url);

// Actual HTTP handlers and production migrations, with isolated synthetic data.
async function fixture(t, { beforeRegistration = false } = {}) {
  const db = createSqliteD1(':memory:');
  t.after(() => db._db.close());
  const migrations = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    if (beforeRegistration && name >= '0016_') continue;
    db._db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  }
  const insert = db._db.prepare(`INSERT INTO users(id,email,display_name,password_hash,role,created_at,updated_at)
    VALUES(?,?,?,?,?,1,1)`);
  for (const [id, name, role] of [[1, 'Super', 'super_admin'], [2, 'Admin', 'developer'], [3, 'Developer', 'developer'], [4, 'Customer admin', 'developer'], [5, 'Observer', 'developer']]) {
    insert.run(id, `existing-${id}@example.test`, name, await seedHash, role);
  }
  db._db.exec(`
    INSERT INTO user_global_roles(user_id,role,updated_at) VALUES(2,'admin',1),(5,'observer',1);
    INSERT INTO customers(id,code,name,created_at,updated_at) VALUES(1,'private','Private customer',1,1);
    INSERT INTO projects(id,customer_id,code,name,created_at,updated_at) VALUES(1,1,'private','Private project',1,1);
    INSERT INTO memberships(user_id,customer_id,role,created_at) VALUES(4,1,'customer_admin',1);
  `);
  const env = { DB: db, JWT_SECRET: 'isolated-registration-regression-tests', ALLOWED_ORIGINS: '' };
  const jwt = new Map();
  async function request(path, { method = 'GET', body, userId = null, token, status = 200 } = {}) {
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
    assert.equal(response.status, status, `${method} ${path}: expected ${status}, got ${response.status}; error=${result?.error ?? 'none'}`);
    return result;
  }
  const toggle = (enabled, options = {}) => request('/api/users/registration', { method: 'PUT', userId: 1, body: { enabled }, ...options });
  const signup = (fields = {}, options = {}) => request('/api/auth/register', { method: 'POST', status: 201,
    body: { email: 'new@example.test', password: signupPassword, confirmPassword: signupPassword, ...fields }, ...options });
  const login = (email, password, options = {}) => request('/api/auth/login', { method: 'POST', body: { email, password }, ...options });
  const count = () => db._db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const auditHasNoCredentials = (...passwords) => {
    const serialized = JSON.stringify(db._db.prepare('SELECT * FROM audit_logs').all());
    for (const password of passwords) assert.ok(!serialized.includes(password), 'audit must not contain plaintext passwords');
    for (const row of db._db.prepare('SELECT password_hash FROM users').all()) {
      assert.ok(!serialized.includes(row.password_hash), 'audit must not contain password hashes');
    }
  };
  return { db, env, migrations, request, toggle, signup, login, count, auditHasNoCredentials };
}

test('registration migration preserves existing accounts and grants and defaults the public setting to disabled', async (t) => {
  const f = await fixture(t, { beforeRegistration: true });
  const users = f.db._db.prepare('SELECT * FROM users ORDER BY id').all();
  const grants = f.db._db.prepare('SELECT * FROM memberships ORDER BY id').all();
  for (const name of f.migrations.filter((entry) => entry >= '0016_')) f.db._db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  assert.deepEqual(f.db._db.prepare('SELECT * FROM users ORDER BY id').all(), users);
  assert.deepEqual(f.db._db.prepare('SELECT * FROM memberships ORDER BY id').all(), grants);
  assert.deepEqual(f.db._db.prepare('SELECT id,enabled,updated_by FROM registration_settings').all(), [{ id: 1, enabled: 0, updated_by: null }]);
  assert.deepEqual(await f.request('/api/auth/registration'), { enabled: false });
  const denied = await f.signup({}, { status: 403 });
  assert.equal(denied.error, 'registration_disabled');
  assert.equal(f.count(), 5);
  assert.equal((await f.login('existing-3@example.test', seedPassword)).user.id, 3);
  assert.deepEqual(f.db._db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('only global administrators can persist the registration switch and closing it leaves existing login working', async (t) => {
  const f = await fixture(t);
  await f.toggle(true, { userId: null, status: 401 });
  for (const userId of [3, 4, 5]) await f.toggle(true, { userId, status: 403 });
  for (const enabled of [null, 'true', 1, {}, []]) await f.toggle(enabled, { status: 400 });
  await f.request('/api/users/registration', { method: 'PUT', userId: 1, body: {}, status: 400 });
  assert.deepEqual(await f.request('/api/auth/registration'), { enabled: false });
  await f.toggle(true, { userId: 2 });
  assert.deepEqual(await f.request('/api/auth/registration'), { enabled: true });
  const saved = f.db._db.prepare('SELECT enabled,updated_by,updated_at FROM registration_settings WHERE id=1').get();
  assert.equal(saved.enabled, 1);
  assert.equal(saved.updated_by, 2);
  assert.ok(saved.updated_at > 1);
  assert.equal(f.db._db.prepare('SELECT COUNT(*) AS n FROM registration_settings').get().n, 1);
  // Reapplying the idempotent migration must not silently close an enabled site.
  f.db._db.exec(readFileSync(new URL('0016_registration.sql', migrationDir), 'utf8'));
  assert.deepEqual(f.db._db.prepare('SELECT enabled,updated_by,updated_at FROM registration_settings WHERE id=1').get(), saved);
  await f.signup();
  await f.toggle(false);
  assert.deepEqual(await f.request('/api/auth/registration'), { enabled: false });
  assert.equal((await f.signup({ email: 'later@example.test' }, { status: 403 })).error, 'registration_disabled');
  assert.equal(f.count(), 6);
  const login = await f.login('new@example.test', signupPassword);
  assert.equal((await f.request('/api/auth/me', { token: login.token })).email, 'new@example.test');
  f.auditHasNoCredentials(seedPassword, signupPassword);
});

test('public signup normalizes email, hashes credentials and cannot inject global or project privileges', async (t) => {
  const f = await fixture(t);
  await f.toggle(true);
  const response = await f.signup({ email: '  NEW@EXAMPLE.TEST  ', displayName: 'New person',
    role: 'super_admin', globalRole: 'admin', isActive: false, customerId: 1, projectId: 1,
    memberships: [{ customerId: 1, role: 'customer_admin' }] });
  assert.deepEqual(response, { ok: true }, 'signup must not expose a password hash or issue privileges');
  const user = f.db._db.prepare("SELECT * FROM users WHERE email='new@example.test'").get();
  assert.deepEqual(f.db._db.prepare("SELECT actor_type,actor_id,target_type,target_id FROM audit_logs WHERE action='auth.register'").all(), [
    { actor_type: 'user', actor_id: user.id, target_type: 'user', target_id: user.id },
  ]);
  assert.equal(user.display_name, 'New person');
  assert.equal(user.role, 'developer');
  assert.equal(user.is_active, 1);
  assert.notEqual(user.password_hash, signupPassword);
  assert.ok(await verifyPassword(signupPassword, user.password_hash));
  for (const table of ['user_global_roles', 'memberships', 'project_memberships']) {
    assert.equal(f.db._db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(user.id).n, 0);
  }
  const login = await f.login(' NEW@EXAMPLE.TEST ', signupPassword);
  assert.equal(login.user.role, 'developer');
  assert.equal(login.user.email, 'new@example.test');
  const auth = { token: login.token };
  assert.deepEqual(await f.request('/api/auth/me', auth), login.user);
  for (const path of ['/api/customers', '/api/projects', '/api/versions/accessible', '/api/memberships']) {
    assert.deepEqual(await f.request(path, auth), []);
  }
  const announcements = await f.request('/api/announcements', auth);
  assert.deepEqual(announcements.items, []);
  assert.deepEqual(announcements.publishableProjects, []);
  await f.request('/api/users', { ...auth, status: 403 });
  await f.request('/api/projects/1', { ...auth, status: 403 });
  await f.toggle(true, { ...auth, status: 403 });
  assert.equal((await f.login('New person', signupPassword)).user.id, user.id);
  f.auditHasNoCredentials(seedPassword, signupPassword);
});

test('signup rejects invalid credentials and missing confirmation without creating users and accepts the password boundaries', async (t) => {
  const f = await fixture(t);
  await f.toggle(true);
  for (const fields of [
    { email: '' }, { email: null }, { email: 123 }, { email: 'missing-at' }, { email: 'user@example' },
    { email: 'a@@example.test' }, { email: 'a b@example.test' }, { email: `${'a'.repeat(250)}@example.test` },
    { password: '' }, { password: 12345678 }, { password: null }, { password: '1234567', confirmPassword: '1234567' },
    { password: 'x'.repeat(129), confirmPassword: 'x'.repeat(129) },
    { confirmPassword: undefined }, { confirmPassword: null }, { confirmPassword: '' }, { confirmPassword: 'different-password' },
  ]) await f.signup(fields, { status: 400 });
  assert.equal(f.count(), 5);
  for (const length of [8, 128]) {
    const password = 'a'.repeat(length);
    const email = `boundary-${length}@example.test`;
    assert.deepEqual(await f.signup({ email, password, confirmPassword: password }), { ok: true });
    assert.equal((await f.login(email, password)).user.email, email);
  }
  assert.equal(f.count(), 7);
  f.auditHasNoCredentials(signupPassword, 'a'.repeat(8), 'a'.repeat(128));
});

test('signup treats normalized duplicate emails as conflicts and never changes an existing account', async (t) => {
  const f = await fixture(t);
  await f.toggle(true);
  await f.signup();
  const before = f.db._db.prepare("SELECT * FROM users WHERE email='new@example.test'").get();
  await f.signup({ email: '  NEW@EXAMPLE.TEST ', displayName: 'Overwrite attempt', role: 'admin' }, { status: 409 });
  await f.signup({ email: ' EXISTING-1@EXAMPLE.TEST ' }, { status: 409 });
  assert.equal(f.count(), 6);
  assert.deepEqual(f.db._db.prepare("SELECT * FROM users WHERE email='new@example.test'").get(), before);
  assert.equal((await f.login('existing-1@example.test', seedPassword)).user.role, 'super_admin');
});

test('the final signup write rechecks a switch closed during registration and handles concurrent duplicate accounts', async (t) => {
  for (const change of ['close', 'duplicate']) {
    const f = await fixture(t);
    await f.toggle(true);
    const prepare = f.db.prepare.bind(f.db);
    let interleaved = false;
    f.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/INSERT INTO users/.test(sql)) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            if (change === 'close') f.db._db.prepare('UPDATE registration_settings SET enabled=0 WHERE id=1').run();
            else f.db._db.prepare(`INSERT INTO users(email,password_hash,display_name,role,created_at,updated_at)
              VALUES('new@example.test',?,'Concurrent winner','developer',1,1)`).run(await seedHash);
            interleaved = true;
            return run();
          };
          return bound;
        };
      }
      return statement;
    };
    const result = await f.signup({}, { status: change === 'close' ? 403 : 409 });
    assert.equal(interleaved, true);
    if (change === 'close') {
      assert.equal(result.error, 'registration_disabled');
      assert.equal(f.count(), 5);
    } else {
      assert.equal(f.count(), 6);
      const winner = f.db._db.prepare("SELECT display_name,password_hash FROM users WHERE email='new@example.test'").get();
      assert.equal(winner.display_name, 'Concurrent winner');
      assert.equal(winner.password_hash, await seedHash);
    }
    f.auditHasNoCredentials(signupPassword, seedPassword);
  }
});

test('administrator creation and password reset reject mismatched confirmations without partial edits and retain legacy omission support', async (t) => {
  const f = await fixture(t);
  const confirmed = 'Synthetic-confirmed-admin-password';
  const legacy = 'Synthetic-legacy-admin-password';
  const mismatch = 'Synthetic-different-confirmation';
  const create = (fields, options = {}) => f.request('/api/users', { method: 'POST', userId: 1, status: 201, body: fields, ...options });
  const rejected = await create({ email: 'manual@example.test', password: confirmed, confirmPassword: mismatch }, { status: 400 });
  assert.equal(rejected.error, 'password_confirmation_mismatch');
  assert.equal(f.count(), 5);
  const created = await create({ email: 'manual@example.test', password: confirmed, confirmPassword: confirmed });
  const oldClient = await create({ email: 'legacy@example.test', password: legacy });
  for (const [user, password] of [[created, confirmed], [oldClient, legacy]]) {
    assert.equal(Object.hasOwn(user, 'password_hash'), false);
    assert.equal((await f.login(user.email, password)).user.id, user.id);
  }
  const before = f.db._db.prepare('SELECT * FROM users WHERE id=3').get();
  const reset = (fields, options = {}) => f.request('/api/users/3', { method: 'PATCH', userId: 2, body: fields, ...options });
  await reset({ password: confirmed, confirmPassword: mismatch, displayName: 'Must not change', role: 'observer', isActive: false }, { status: 400 });
  assert.deepEqual(f.db._db.prepare('SELECT * FROM users WHERE id=3').get(), before);
  assert.equal(f.db._db.prepare('SELECT COUNT(*) AS n FROM user_global_roles WHERE user_id=3').get().n, 0);
  await reset({ password: confirmed, confirmPassword: confirmed });
  assert.equal((await f.login('existing-3@example.test', confirmed)).user.id, 3);
  await reset({ password: legacy });
  assert.equal((await f.login('existing-3@example.test', legacy)).user.id, 3);
  f.auditHasNoCredentials(seedPassword, confirmed, legacy, mismatch);
});

test('changing an account password checks optional confirmation and current credentials before replacing its hash', async (t) => {
  const f = await fixture(t);
  const confirmed = 'Synthetic-confirmed-self-password';
  const legacy = 'Synthetic-legacy-self-password';
  const change = (fields, options = {}) => f.request('/api/auth/change-password', { method: 'POST', userId: 3, body: fields, ...options });
  const original = f.db._db.prepare('SELECT password_hash FROM users WHERE id=3').get().password_hash;
  const mismatch = await change({ oldPassword: seedPassword, newPassword: confirmed, confirmPassword: 'Mismatch-value' }, { status: 400 });
  assert.equal(mismatch.error, 'password_confirmation_mismatch');
  assert.equal(f.db._db.prepare('SELECT password_hash FROM users WHERE id=3').get().password_hash, original);
  await change({ oldPassword: 'Incorrect-original-password', newPassword: confirmed, confirmPassword: confirmed }, { status: 401 });
  assert.equal(f.db._db.prepare('SELECT password_hash FROM users WHERE id=3').get().password_hash, original);
  assert.deepEqual(await change({ oldPassword: seedPassword, newPassword: confirmed, confirmPassword: confirmed }), { ok: true });
  await f.login('existing-3@example.test', seedPassword, { status: 401 });
  assert.equal((await f.login('existing-3@example.test', confirmed)).user.id, 3);
  assert.deepEqual(await change({ oldPassword: confirmed, newPassword: legacy }), { ok: true });
  assert.equal((await f.login('existing-3@example.test', legacy)).user.id, 3);
  f.auditHasNoCredentials(seedPassword, confirmed, legacy, 'Mismatch-value', 'Incorrect-original-password');
});
