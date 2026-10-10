import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import app from '../src/index.ts';
import { createSqliteD1 } from '../node/d1-sqlite.mjs';
import { signJwt } from '../src/utils/jwt.ts';
import { decryptSecret } from '../src/utils/crypto.ts';
import { getMailConfig } from '../src/lib/mail-config.ts';
import { SMTPError } from '../src/lib/smtp.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const configured = {
  enabled: true, host: 'smtp.example.test', port: 465, security: 'tls',
  username: 'smtp-account', password: 'synthetic-smtp-password',
  fromEmail: 'sender@example.test', fromName: 'QOTA 测试',
};

async function fixture(t) {
  const db = createSqliteD1(':memory:');
  t.after(() => db._db.close());
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    db._db.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  db._db.exec(`
    INSERT INTO users (id,email,password_hash,role,created_at,updated_at) VALUES
      (1,'super@example.test','unused','super_admin',1,1),
      (2,'developer@example.test','unused','developer',1,1),
      (3,'scoped@example.test','unused','developer',1,1),
      (4,'observer@example.test','unused','developer',1,1),
      (6,'admin@example.test','unused','developer',1,1);
    INSERT INTO user_global_roles (user_id,role,updated_at) VALUES (4,'observer',1),(6,'admin',1);
    INSERT INTO customers (id,code,name,created_at,updated_at) VALUES (1,'test','Test',1,1);
    INSERT INTO memberships (user_id,customer_id,role,created_at) VALUES (3,1,'customer_admin',1);
  `);
  const sent = [];
  const env = {
    DB: db, JWT_SECRET: 'isolated-mail-settings-key', ALLOWED_ORIGINS: '',
    MAILER: { send: async (config, message) => { sent.push({ config, message }); } },
  };
  const tokens = new Map();
  async function request(path, { method = 'GET', body, userId = 1, status = 200 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (userId !== null) {
      if (!tokens.has(userId)) {
        const user = db._db.prepare('SELECT email,role FROM users WHERE id=?').get(userId);
        tokens.set(userId, await signJwt({ sub: userId, ...user }, env.JWT_SECRET, 3600));
      }
      headers.authorization = `Bearer ${tokens.get(userId)}`;
    }
    const response = await app.fetch(new Request(`https://qota.example.test/api/mail/${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { waitUntil() {}, passThroughOnException() {} });
    const result = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  }
  const save = (body = configured, options = {}) => request('settings', { method: 'PUT', body, ...options });
  const row = () => db._db.prepare('SELECT * FROM mail_settings WHERE id=1').get();
  return { db, env, sent, request, save, row };
}

test('only global administrators manage SMTP or send tests while authenticated users see readiness only', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.request('settings'), {
    enabled: false, host: '', port: 465, security: 'tls', username: '', fromEmail: '', fromName: '', hasPassword: false,
  });
  for (const userId of [2, 3, 4]) {
    await f.request('settings', { userId, status: 403 });
    await f.save(configured, { userId, status: 403 });
    await f.request('test', { userId, method: 'POST', body: { to: 'recipient@example.test' }, status: 403 });
    assert.deepEqual(await f.request('status', { userId }), { enabled: false, configured: false });
  }
  await f.request('status', { userId: null, status: 401 });
  await f.request('settings', { userId: null, status: 401 });
  await f.save(configured, { userId: 6 });
  assert.deepEqual(await f.request('status', { userId: 2 }), { enabled: true, configured: true });
  assert.equal(f.sent.length, 0, 'configuration never sends mail');
});

test('SMTP passwords are encrypted, omitted updates preserve them, and no secret appears in responses or audit metadata', async (t) => {
  const f = await fixture(t);
  const result = await f.save({ ...configured, host: ' SMTP.EXAMPLE.TEST ' });
  assert.equal(result.host, 'smtp.example.test');
  assert.equal(result.hasPassword, true);
  assert.ok(!Object.hasOwn(result, 'password') && !Object.hasOwn(result, 'password_enc'));
  const cipher = f.row().password_enc;
  assert.notEqual(cipher, configured.password);
  assert.equal(await decryptSecret(cipher, f.env.JWT_SECRET), configured.password);
  const { password, ...withoutPassword } = configured;
  await f.save({ ...withoutPassword, fromName: 'Renamed sender', security: 'starttls', port: 587 });
  assert.equal(f.row().password_enc, cipher);
  assert.equal((await getMailConfig(f.env)).password, configured.password);
  await f.save({ ...configured, password: 'rotated-synthetic-secret' });
  assert.equal((await getMailConfig(f.env)).password, 'rotated-synthetic-secret');
  const publicOutput = JSON.stringify({ settings: await f.request('settings'), status: await f.request('status'),
    audits: f.db._db.prepare('SELECT meta FROM audit_logs').all() });
  for (const secret of [password, cipher, 'rotated-synthetic-secret']) assert.ok(!publicOutput.includes(secret));
  assert.ok(f.db._db.prepare('SELECT meta FROM audit_logs').all().every(({ meta }) => !meta.includes(configured.host)));
});

test('disabled but complete saved SMTP configuration can send a test to a chosen address without enabling notifications', async (t) => {
  const f = await fixture(t);
  await f.save({ ...configured, enabled: false, port: 2525, security: 'starttls' });
  assert.deepEqual(await f.request('status'), { enabled: false, configured: true });
  await assert.rejects(getMailConfig(f.env), (error) => error.code === 'mail_disabled');
  assert.equal((await getMailConfig(f.env, { requireEnabled: false })).password, configured.password);
  assert.deepEqual(await f.request('test', { method: 'POST', body: {
    to: 'other-mailbox@example.test', host: 'ignored.example.test', password: 'ignored',
  } }), { ok: true });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.to, 'other-mailbox@example.test');
  assert.equal(f.sent[0].config.host, configured.host);
  assert.equal(f.sent[0].config.password, configured.password);
  assert.equal(f.row().enabled, 0);
});

test('SMTP settings reject invalid hosts, unsafe ports and header or credential control characters without changing saved settings', async (t) => {
  const f = await fixture(t);
  await f.save();
  const before = f.row();
  const invalid = [
    { host: 'https://smtp.example.test' }, { host: 'smtp.example.test:587' }, { host: 'smtp.example.test/path' },
    { host: 'smtp.example.test\r\nInjected' }, { host: 'bad host' }, { host: '-bad.example.test' },
    { port: 25 }, { port: 0 }, { port: 65536 }, { port: '587' }, { port: 465.5 },
    { security: 'none' }, { enabled: 'true' }, { username: 'name\nInjected' },
    { fromEmail: 'one@example.test,other@example.test' }, { fromEmail: 'sender@example.test\r\nBcc: hidden@example.test' },
    { fromName: 'Name\r\nBcc: hidden@example.test' }, { password: 'secret\0suffix' }, { password: 'secret\nmore' },
    { password: null }, { password: 'x'.repeat(4097) }, { username: '' }, { fromEmail: '' }, { host: '' },
  ];
  for (const fields of invalid) {
    await f.save({ ...configured, ...fields }, { status: 400 });
    assert.deepEqual(f.row(), before);
  }
  assert.equal(f.sent.length, 0);
});

test('test emails reject injected recipients and expose only safe failure codes without server details', async (t) => {
  const f = await fixture(t);
  await f.save();
  for (const to of ['', null, 'invalid', 'a@example.test,b@example.test', 'Name <a@example.test>', 'a@example.test\r\nBcc:b@example.test']) {
    await f.request('test', { method: 'POST', body: { to }, status: 400 });
  }
  assert.equal(f.sent.length, 0);
  const privateReply = `server ${configured.host} rejected secret ${configured.password}`;
  f.env.MAILER.send = async () => { throw new Error(privateReply); };
  const result = await f.request('test', { method: 'POST', body: { to: 'recipient@example.test' }, status: 502 });
  assert.equal(result.error, 'mail_test_failed');
  assert.ok(!JSON.stringify(result).includes(privateReply));
  for (const code of ['smtp_auth', 'smtp_connect', 'smtp_tls', 'smtp_timeout', 'smtp_recipient']) {
    f.env.MAILER.send = async () => { throw new SMTPError(code); };
    const failure = await f.request('test', { method: 'POST', body: { to: 'recipient@example.test' }, status: 502 });
    assert.equal(failure.error, code);
    assert.ok(!failure.message.includes(configured.password) && !failure.message.includes(configured.host));
  }
  assert.ok(!JSON.stringify(f.db._db.prepare('SELECT meta FROM audit_logs').all()).includes(privateReply));
});

test('password clearing and corrupt or differently keyed ciphertext prevent sending instead of claiming readiness', async (t) => {
  const f = await fixture(t);
  await f.save();
  await f.save({ ...configured, password: '' }, { status: 400 });
  assert.equal((await getMailConfig(f.env)).password, configured.password);
  await f.save({ ...configured, enabled: false, password: '' });
  assert.equal((await f.request('settings')).hasPassword, false);
  assert.deepEqual(await f.request('status'), { enabled: false, configured: false });
  await f.request('test', { method: 'POST', body: { to: 'recipient@example.test' }, status: 400 });
  await f.save();
  await assert.rejects(getMailConfig({ ...f.env, JWT_SECRET: 'different-key' }), (error) => error.code === 'mail_not_configured');
  f.db._db.prepare('UPDATE mail_settings SET password_enc=? WHERE id=1').run('corrupt-ciphertext');
  assert.deepEqual(await f.request('status'), { enabled: true, configured: false });
  const failed = await f.request('test', { method: 'POST', body: { to: 'recipient@example.test' }, status: 400 });
  assert.equal(failed.error, 'mail_not_configured');
  assert.equal(f.sent.length, 0);
});
