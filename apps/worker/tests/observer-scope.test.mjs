import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import app from '../src/index.ts';
import { createSqliteD1 } from '../node/d1-sqlite.mjs';
import { signJwt } from '../src/utils/jwt.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function fixture(t) {
  const db = createSqliteD1(':memory:');
  t.after(() => db._db.close());
  const migrationDir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrationDir).filter((entry) => entry.endsWith('.sql')).sort()) {
    db._db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  }
  db._db.exec(`
    INSERT INTO users(id,email,display_name,password_hash,role,created_at,updated_at) VALUES
      (1,'admin@example.test','Super admin','unused','super_admin',1,1),
      (2,'observer@example.test','Observer','unused','developer',1,1),
      (3,'author@example.test','Author','unused','developer',1,1),
      (4,'global-admin@example.test','Global admin','unused','developer',1,1);
    INSERT INTO user_global_roles(user_id,role,updated_at) VALUES(2,'observer',1),(4,'admin',1);
    INSERT INTO customers(id,code,name,parent_id,created_at,updated_at) VALUES
      (1,'parent','Parent',NULL,1,1),(2,'child','Child',1,1,1),
      (3,'private','Private root',NULL,1,1),(4,'grandchild','Grandchild',2,1,1);
    INSERT INTO projects(id,customer_id,code,name,created_at,updated_at) VALUES
      (1,1,'parent','Parent project',1,1),(2,2,'child-a','Child project',1,1),
      (3,2,'child-b','Child sibling project',1,1),(4,4,'grandchild','Grandchild project',1,1),
      (5,3,'private','Private project',1,1);
    INSERT INTO memberships(user_id,customer_id,role,created_at) VALUES(3,1,'developer',1);
  `);
  for (let projectId = 1; projectId <= 5; projectId++) {
    const ownerId = projectId === 2 ? 2 : 3;
    db._db.prepare(`INSERT INTO versions(id,project_id,version,release_channel,status,r2_key,filename,size,notes,uploaded_by,created_at,updated_at)
      VALUES(?,?,'v1','ota','ready',?,'firmware.bin',1024,'Original file note',?,1,1)`).run(projectId, projectId, `test-object-${projectId}`, ownerId);
    db._db.prepare(`INSERT INTO version_metadata(project_id,version,notes,created_by,created_at,updated_at)
      VALUES(?,'v1','Original version note',?,1,1)`).run(projectId, ownerId);
    db._db.prepare(`INSERT INTO announcements(id,project_id,content,author_id,created_at,updated_at)
      VALUES(?,?,?, ?,1,1)`).run(projectId, projectId, `Project ${projectId} announcement`, ownerId);
    const customerId = db._db.prepare('SELECT customer_id FROM projects WHERE id=?').get(projectId).customer_id;
    db._db.prepare(`INSERT INTO audit_logs(ts,actor_type,actor_id,project_id,customer_id,action)
      VALUES(1,'user',3,?,?,'observer.scope')`).run(projectId, customerId);
  }
  for (const customerId of [1, 2, 3, 4]) {
    db._db.prepare(`INSERT INTO audit_logs(ts,actor_type,actor_id,customer_id,action)
      VALUES(1,'user',3,?,'observer.scope')`).run(customerId);
  }
  const sent = [];
  const signed = [];
  const env = { DB: db, JWT_SECRET: 'isolated-observer-scope-regression', ALLOWED_ORIGINS: '',
    STORAGE: { signGetUrl: async (key) => { signed.push(key); return `https://storage.example.test/${key}`; } },
    MAILER: { send: async (_config, message) => { sent.push(message); } },
  };
  const tokens = new Map();
  async function request(path, { method = 'GET', body, userId = 2, status = 200 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (!tokens.has(userId)) {
      const user = db._db.prepare('SELECT email,role FROM users WHERE id=?').get(userId);
      tokens.set(userId, await signJwt({ sub: userId, ...user }, env.JWT_SECRET, 3600));
    }
    headers.authorization = `Bearer ${tokens.get(userId)}`;
    const pending = [];
    const response = await app.fetch(new Request(`https://qota.example.test${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} });
    await Promise.all(pending);
    const result = await response.json();
    assert.equal(response.status, status, `${method} ${path}: expected ${status}, got ${response.status}; error=${result?.error ?? 'none'}`);
    return result;
  }
  const grant = (fields, options = {}) => request('/api/memberships', { method: 'POST', userId: 1, status: 201,
    body: { userId: 2, role: 'viewer', ...fields }, ...options });
  const recipientIds = async (projectId) => (await request(`/api/announcements/recipients?projectId=${projectId}`, { userId: 1 })).items.map((user) => user.id);
  const configureMail = () => request('/api/mail/settings', { method: 'PUT', userId: 1, body: {
    enabled: true, host: 'smtp.example.test', port: 465, security: 'tls', username: 'test', password: 'synthetic-password',
    fromEmail: 'sender@example.test', fromName: 'Test QOTA',
  } });
  const notice = (fields = {}, options = {}) => request('/api/announcements', { method: 'POST', userId: 1, status: 201,
    body: { projectId: 4, content: 'Scope-aware email notice', ...fields }, ...options });
  return { db, request, grant, recipientIds, configureMail, notice, sent, signed };
}

test('an existing observer without scope grants sees no customer, project, file, announcement or unrelated audit data', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/me')).role, 'observer');
  for (const path of ['/api/customers', '/api/projects', '/api/versions/accessible', '/api/memberships', '/api/audit?action=observer.scope']) {
    assert.deepEqual(await f.request(path), []);
  }
  const notices = await f.request('/api/announcements');
  assert.deepEqual(notices.items, []);
  assert.deepEqual(notices.publishableProjects, []);
  for (const path of ['/api/customers/2', '/api/projects/2', '/api/versions/2', '/api/versions?projectId=2', '/api/announcements?projectId=2', '/api/announcements/recipients?projectId=2']) {
    await f.request(path, { status: 403 });
  }
  await f.request('/api/download/grant', { method: 'POST', body: { versionId: 2 }, status: 403 });
  assert.equal(f.signed.length, 0);
  assert.deepEqual(await f.request('/api/audit?action=observer.scope&projectId=5'), []);
  assert.deepEqual(await f.request('/api/audit?action=observer.scope&customerId=3'), []);
  for (const projectId of [1, 2, 3, 4, 5]) assert.ok(!(await f.recipientIds(projectId)).includes(2));
  for (const userId of [1, 4]) {
    assert.equal((await f.request('/api/projects', { userId })).length, 5);
    assert.equal((await f.request('/api/announcements', { userId })).items.length, 5);
    assert.equal((await f.request('/api/audit?action=observer.scope', { userId })).length, 9);
  }
});

test('project grants give observers read and download access only to the exact project without customer or sibling expansion', async (t) => {
  const f = await fixture(t);
  await f.grant({ projectId: 2 });
  assert.deepEqual((await f.request('/api/customers')).map((customer) => customer.id), [2]);
  assert.deepEqual((await f.request('/api/projects')).map((project) => project.id), [2]);
  assert.deepEqual((await f.request('/api/versions/accessible')).map((file) => file.id), [2]);
  assert.deepEqual((await f.request('/api/announcements')).items.map((notice) => notice.id), [2]);
  assert.equal((await f.request('/api/projects/2')).id, 2);
  assert.equal((await f.request('/api/versions/2')).canEditNotes, false);
  assert.equal((await f.request('/api/versions/2')).canEditVersionNotes, false);
  await f.request('/api/download/grant', { method: 'POST', body: { versionId: 2 } });
  assert.deepEqual(f.signed, ['test-object-2']);
  const audit = await f.request('/api/audit?action=observer.scope');
  assert.deepEqual(audit.map((event) => event.projectId), [2]);
  for (const projectId of [1, 3, 4, 5]) {
    await f.request(`/api/projects/${projectId}`, { status: 403 });
    await f.request('/api/download/grant', { method: 'POST', body: { versionId: projectId }, status: 403 });
    assert.ok(!(await f.recipientIds(projectId)).includes(2));
  }
  assert.ok((await f.recipientIds(2)).includes(2));
});

test('customer grants let observers read descendant and future projects while reparenting and revocation immediately remove access', async (t) => {
  const f = await fixture(t);
  const membership = await f.grant({ customerId: 2, role: 'developer' });
  assert.deepEqual((await f.request('/api/customers')).map((row) => row.id).sort(), [2, 4]);
  assert.deepEqual((await f.request('/api/projects')).map((row) => row.id).sort(), [2, 3, 4]);
  assert.deepEqual((await f.request('/api/versions/accessible')).map((row) => row.id).sort(), [2, 3, 4]);
  const audit = await f.request('/api/audit?action=observer.scope');
  assert.deepEqual(audit.filter((event) => event.projectId !== null).map((event) => event.projectId).sort(), [2, 3, 4]);
  assert.deepEqual(audit.filter((event) => event.projectId === null).map((event) => event.customerId).sort(), [2, 4]);
  const futureCustomer = await f.request('/api/customers', { method: 'POST', userId: 1, status: 201, body: { name: 'Future customer', parentId: 4 } });
  const futureProject = await f.request('/api/projects', { method: 'POST', userId: 1, status: 201, body: { name: 'Future project', customerId: futureCustomer.id } });
  assert.equal((await f.request(`/api/projects/${futureProject.id}`)).id, futureProject.id);
  await f.request('/api/download/grant', { method: 'POST', body: { versionId: 4 } });
  await f.request('/api/projects/1', { status: 403 });
  await f.request('/api/projects/5', { status: 403 });
  await f.request('/api/customers/4', { method: 'PATCH', userId: 1, body: { parentId: 3 } });
  await f.request('/api/projects/4', { status: 403 });
  await f.request(`/api/projects/${futureProject.id}`, { status: 403 });
  assert.ok(!(await f.recipientIds(4)).includes(2));
  assert.deepEqual((await f.request('/api/audit?action=observer.scope')).filter((event) => event.projectId !== null).map((event) => event.projectId).sort(), [2, 3]);
  await f.request(`/api/memberships/${membership.id}?scope=customer`, { method: 'DELETE', userId: 1 });
  assert.deepEqual(await f.request('/api/projects'), []);
  assert.deepEqual((await f.request('/api/announcements')).items, []);
  assert.deepEqual(await f.request('/api/audit?action=observer.scope'), []);
  await f.request('/api/download/grant', { method: 'POST', body: { versionId: 2 }, status: 403 });
});

test('even administrator scope grants cannot give an observer mutation privileges or ownership-based editing exceptions', async (t) => {
  for (const scope of ['customer', 'project']) {
    const f = await fixture(t);
    await f.grant(scope === 'customer' ? { customerId: 1, role: 'customer_admin' } : { projectId: 2, role: 'customer_admin' });
    const writes = [
      ['POST', '/api/upload/init', { projectId: 2, version: 'v2', filename: 'new.bin', totalSize: 1024 }],
      ['PATCH', '/api/versions/2', { notes: 'Owner cannot edit while observer' }],
      ['PATCH', '/api/versions/group', { projectId: 2, version: 'v1', versionNotes: 'Denied parent note', specialVersion: 'Denied edition' }],
      ['PATCH', '/api/versions/group', { projectId: 2, version: 'v1', isCurrent: true }],
      ['PATCH', '/api/versions/group', { projectId: 2, version: 'v1', status: 'archived' }],
      ['DELETE', '/api/versions/2', undefined],
      ['POST', '/api/api-tokens', { projectId: 2, name: 'Forbidden token' }],
      ['POST', '/api/memberships/batch', { userId: 3, projectIds: [2], role: 'viewer' }],
      ['POST', '/api/memberships', { userId: 3, customerId: 4, role: 'viewer' }],
      ['POST', '/api/projects', { customerId: 2, name: 'Forbidden project' }],
      ['PATCH', '/api/projects/2', { name: 'Forbidden rename' }],
      ['PATCH', '/api/customers/2', { name: 'Forbidden customer rename' }],
      ['POST', '/api/announcements', { projectId: 2, content: 'Forbidden publication' }],
    ];
    for (const [method, path, body] of writes) await f.request(path, { method, body, status: 403 });
    await f.request('/api/api-tokens?projectId=2', { status: 403 });
    await f.request('/api/memberships?projectId=2', { status: 403 });
    await f.request('/api/announcements/recipients?projectId=2', { status: 403 });
    const file = await f.request('/api/versions/2');
    assert.equal(file.notes, 'Original file note');
    assert.equal(file.versionNotes, 'Original version note');
    assert.equal(file.isCurrent, false);
    assert.equal(file.status, 'ready');
    assert.equal(file.canEditNotes, false);
    assert.equal(file.canEditVersionNotes, false);
    assert.deepEqual((await f.request('/api/announcements')).publishableProjects, []);
  }
});

test('an announcement author downgraded to observer cannot edit, delete or retry emails even with a scoped administrator grant', async (t) => {
  const f = await fixture(t);
  await f.grant({ projectId: 2, role: 'customer_admin' });
  f.db._db.prepare("INSERT INTO announcement_mail_deliveries(announcement_id,user_id,status,created_at,updated_at) VALUES(2,1,'pending',1,1)").run();
  const own = (await f.request('/api/announcements')).items[0];
  assert.equal(own.authorId, 2);
  assert.equal(own.canEdit, false);
  assert.equal(own.canDelete, false);
  await f.request('/api/announcements/2', { method: 'PATCH', body: { content: 'Forbidden author edit' }, status: 403 });
  await f.request('/api/announcements/2', { method: 'DELETE', status: 403 });
  await f.request('/api/announcements/2/mail/retry', { method: 'POST', body: {}, status: 403 });
  assert.deepEqual(f.db._db.prepare('SELECT content,deleted_at FROM announcements WHERE id=2').get(), { content: 'Project 2 announcement', deleted_at: null });
  assert.equal(f.db._db.prepare('SELECT status FROM announcement_mail_deliveries WHERE announcement_id=2').get().status, 'pending');
  await f.request('/api/announcements/2', { method: 'PATCH', userId: 4, body: { content: 'Global admin remains authorized' } });
  assert.equal((await f.request('/api/announcements')).items[0].content, 'Global admin remains authorized');
});

test('announcement email checks an observers scope again after publication and before sending', async (t) => {
  for (const change of ['revoke', 'reparent']) {
    const f = await fixture(t);
    await f.configureMail();
    await f.grant({ customerId: 2 });
    assert.ok((await f.recipientIds(4)).includes(2));
    const batch = f.db.batch.bind(f.db);
    f.db.batch = async (queries) => {
      f.db.batch = batch;
      const results = await batch(queries);
      if (change === 'revoke') f.db._db.prepare('DELETE FROM memberships WHERE user_id=2').run();
      else f.db._db.prepare('UPDATE customers SET parent_id=3 WHERE id=4').run();
      return results;
    };
    const item = await f.notice({ recipientIds: [1, 2] });
    assert.deepEqual(item.mail, { total: 2, sent: 1, failed: 0, pending: 0, skipped: 1 });
    assert.deepEqual(f.sent.map((message) => message.to), ['admin@example.test']);
    await f.request(`/api/announcements/${item.id}/mail/retry`, { method: 'POST', userId: 1, body: {} });
    assert.equal(f.sent.length, 1);
    await f.notice({ recipientIds: [2] }, { status: 400 });
  }
});
