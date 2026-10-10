import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import app from '../src/index.ts';
import { signJwt } from '../src/utils/jwt.ts';
import { createSqliteD1 } from '../node/d1-sqlite.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const migrationDir = new URL('../migrations/', import.meta.url);

// All data and credentials are synthetic; each test applies the actual schema
// to its own isolated database and invokes the production HTTP handlers.
async function fixture(t, { beforeHierarchy = false } = {}) {
  const db = createSqliteD1(':memory:');
  t.after(() => db._db.close());
  const migrations = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    if (beforeHierarchy && name >= '0015_') continue;
    db._db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  }
  db._db.exec(`
    INSERT INTO users(id,email,display_name,password_hash,role,created_at,updated_at) VALUES
      (1,'super@example.test','Super admin','unused','super_admin',1,1),
      (2,'parent@example.test','Parent admin','unused','developer',1,1),
      (3,'child@example.test','Child admin','unused','developer',1,1),
      (4,'target@example.test','Target user','unused','developer',1,1),
      (5,'sibling@example.test','Sibling viewer','unused','developer',1,1),
      (6,'admin@example.test','Global admin','unused','developer',1,1),
      (7,'observer@example.test','Observer','unused','developer',1,1);
    INSERT INTO user_global_roles(user_id,role,updated_at) VALUES(6,'admin',1),(7,'observer',1);
    INSERT INTO customers(id,code,name,description,created_at,updated_at) VALUES
      (1,'parent','Parent','Parent description',10,20),
      (2,'child','Child','Child description',11,21),
      (3,'sibling','Sibling',NULL,12,22),
      (4,'grandchild','Grandchild',NULL,13,23);
    INSERT INTO projects(id,customer_id,code,name,created_at,updated_at) VALUES
      (1,1,'root-a','Root A',1,1),(2,2,'child-a','Child A',1,1),
      (3,2,'child-b','Child B',1,1),(4,4,'grandchild-a','Grandchild A',1,1),
      (5,3,'sibling-a','Sibling A',1,1),(6,1,'root-b','Root B',1,1);
    INSERT INTO memberships(user_id,customer_id,role,created_by,created_at) VALUES
      (2,1,'customer_admin',1,1),(3,2,'customer_admin',1,1),(5,3,'viewer',1,1);
  `);
  if (!beforeHierarchy) {
    db._db.exec('UPDATE customers SET parent_id=1 WHERE id IN(2,3); UPDATE customers SET parent_id=2 WHERE id=4');
  }
  for (let projectId = 1; projectId <= 6; projectId++) {
    db._db.prepare(`INSERT INTO versions
      (id,project_id,version,release_channel,status,r2_key,filename,size,uploaded_by,created_at,updated_at)
      VALUES(?,?,'v1','ota','ready',?,'firmware.bin',1024,1,1,1)`)
      .run(projectId, projectId, `isolated-project-${projectId}`);
    db._db.prepare(`INSERT INTO version_metadata(project_id,version,created_by,created_at,updated_at)
      VALUES(?,'v1',1,1,1)`).run(projectId);
    db._db.prepare(`INSERT INTO announcements(project_id,content,author_id,created_at,updated_at)
      VALUES(?,?,1,1,1)`).run(projectId, `Notice for project ${projectId}`);
  }
  const env = { DB: db, JWT_SECRET: 'isolated-hierarchy-memberships-test', ALLOWED_ORIGINS: '' };
  const jwt = new Map();
  async function request(path, { method = 'GET', body, userId = 1, status = 200 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (userId !== null) {
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
    const expected = Array.isArray(status) ? status : [status];
    assert.ok(expected.includes(response.status), `${method} ${path}: expected ${expected.join('/')} got ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  const create = (fields, options = {}) => request('/api/customers', { method: 'POST', body: fields, status: 201, ...options });
  const patch = (id, fields, options = {}) => request(`/api/customers/${id}`, { method: 'PATCH', body: fields, ...options });
  const grant = (projectIds, options = {}) => {
    const { fields, ...requestOptions } = options;
    return request('/api/memberships/batch', { method: 'POST', body: { userId: 4, projectIds, role: 'developer', ...fields }, status: 201, ...requestOptions });
  };
  const grants = (userId = 4) => db._db.prepare('SELECT project_id,role FROM project_memberships WHERE user_id=? ORDER BY project_id').all(userId);
  return { db, request, create, patch, grant, grants, migrations };
}

test('customer hierarchy migration preserves legacy roots and existing project membership data', async (t) => {
  const f = await fixture(t, { beforeHierarchy: true });
  const customers = f.db._db.prepare('SELECT * FROM customers ORDER BY id').all();
  const projects = f.db._db.prepare('SELECT * FROM projects ORDER BY id').all();
  const memberships = f.db._db.prepare('SELECT * FROM memberships ORDER BY id').all();
  for (const name of f.migrations.filter((entry) => entry >= '0015_')) f.db._db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  const migrated = f.db._db.prepare('SELECT * FROM customers ORDER BY id').all();
  assert.deepEqual(migrated.map(({ parent_id, ...row }) => row), customers);
  assert.ok(migrated.every((row) => row.parent_id === null));
  assert.deepEqual(f.db._db.prepare('SELECT * FROM projects ORDER BY id').all(), projects);
  assert.deepEqual(f.db._db.prepare('SELECT * FROM memberships ORDER BY id').all(), memberships);
  assert.ok((await f.request('/api/customers')).every((row) => row.parentId === null));
  assert.deepEqual(f.db._db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('global admins create multiple customer levels, move subtrees and detach a customer to a root', async (t) => {
  const f = await fixture(t);
  const root = await f.create({ name: 'New root', code: 'new-root' });
  const child = await f.create({ name: 'New child', code: 'new-child', parentId: root.id }, { userId: 6 });
  const grandchild = await f.create({ name: 'New grandchild', code: 'new-grandchild', parentId: child.id });
  assert.equal(root.parentId, null);
  assert.equal(child.parentId, root.id);
  assert.equal(grandchild.parentId, child.id);
  assert.equal((await f.request(`/api/customers/${grandchild.id}`)).parentId, child.id);
  assert.equal((await f.patch(child.id, { parentId: 3 }, { userId: 6 })).parentId, 3);
  assert.equal((await f.request(`/api/customers/${grandchild.id}`)).parentId, child.id, 'moving a subtree retains its children');
  const detached = await f.patch(child.id, { parentId: null, name: 'Independent root' });
  assert.equal(detached.parentId, null);
  assert.equal(detached.name, 'Independent root');
  assert.equal((await f.request('/api/customers')).find((row) => row.id === grandchild.id).parentId, child.id);
});

test('invalid parents, self parenting and descendant cycles are rejected by both API and database', async (t) => {
  const f = await fixture(t);
  const before = f.db._db.prepare('SELECT id,parent_id FROM customers ORDER BY id').all();
  for (const parentId of [0, -1, 1.5, '1', false, {}, []]) {
    await f.create({ name: 'Invalid parent', parentId }, { status: 400 });
    await f.patch(2, { parentId }, { status: 400 });
  }
  await f.create({ name: 'Missing parent', parentId: 999 }, { status: 404 });
  await f.patch(2, { parentId: 999 }, { status: 404 });
  await f.patch(2, { parentId: 2 }, { status: 400 });
  await f.patch(1, { parentId: 4 }, { status: 400 });
  await f.patch(2, { parentId: 4 }, { status: 400 });
  assert.throws(() => f.db._db.prepare('UPDATE customers SET parent_id=4 WHERE id=1').run());
  assert.throws(() => f.db._db.prepare('UPDATE customers SET parent_id=id WHERE id=3').run());
  assert.throws(() => f.db._db.prepare(`INSERT INTO customers(id,code,name,parent_id,created_at,updated_at)
    VALUES(99,'self-cycle','Self cycle',99,1,1)`).run());
  assert.throws(() => f.db._db.prepare('UPDATE customers SET parent_id=999 WHERE id=3').run());
  assert.deepEqual(f.db._db.prepare('SELECT id,parent_id FROM customers ORDER BY id').all(), before);
});

test('customer administrators retain ordinary editing but cannot change customer hierarchy', async (t) => {
  const f = await fixture(t);
  const edited = await f.patch(2, { name: 'Child renamed', description: 'Independent permission' }, { userId: 3 });
  assert.equal(edited.name, 'Child renamed');
  assert.equal(edited.parentId, 1);
  for (const userId of [2, 3, 5, 7]) await f.create({ name: 'Forbidden new customer', parentId: 1 }, { userId, status: 403 });
  await f.patch(2, { parentId: null, name: 'Must not partially rename' }, { userId: 3, status: 403 });
  await f.patch(1, { parentId: null }, { userId: 2, status: 403 });
  await f.patch(2, { parentId: 3 }, { userId: 2, status: 403 });
  const unchanged = await f.request('/api/customers/2');
  assert.equal(unchanged.name, 'Child renamed');
  assert.equal(unchanged.parentId, 1);
});

test('deleting customers with children is blocked before any descendant or project is removed', async (t) => {
  const f = await fixture(t);
  const before = f.db._db.prepare('SELECT id,parent_id FROM customers ORDER BY id').all();
  for (const id of [1, 2]) await f.request(`/api/customers/${id}`, { method: 'DELETE', status: 409 });
  assert.throws(() => f.db._db.prepare('DELETE FROM customers WHERE id=1').run());
  assert.deepEqual(f.db._db.prepare('SELECT id,parent_id FROM customers ORDER BY id').all(), before);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM projects').first('n'), 6);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM versions').first('n'), 6);
  await f.request('/api/customers/4', { method: 'DELETE', userId: 3, status: 403 });
  await f.request('/api/customers/4', { method: 'DELETE' });
  assert.equal((await f.request('/api/customers/2')).parentId, 1);
  assert.equal(f.db._db.prepare('SELECT id FROM projects WHERE id=4').get(), undefined);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM projects').first('n'), 5);
});

test('parent, child and sibling customer memberships remain independently scoped on every visibility surface', async (t) => {
  const f = await fixture(t);
  for (const [userId, customerId, projectIds] of [[2, 1, [1, 6]], [3, 2, [2, 3]], [5, 3, [5]]]) {
    const options = { userId };
    assert.deepEqual((await f.request('/api/customers', options)).map((row) => row.id), [customerId]);
    assert.deepEqual((await f.request('/api/projects', options)).map((row) => row.id).sort(), projectIds);
    assert.deepEqual((await f.request('/api/versions/accessible', options)).map((row) => row.projectId).sort(), projectIds);
    assert.deepEqual((await f.request('/api/announcements', options)).items.map((row) => row.projectId).sort(), projectIds);
    for (const hiddenId of [1, 2, 3, 4, 5, 6].filter((id) => !projectIds.includes(id))) {
      await f.request(`/api/projects/${hiddenId}`, { userId, status: 403 });
      await f.request(`/api/versions?projectId=${hiddenId}`, { userId, status: 403 });
      await f.request(`/api/announcements?projectId=${hiddenId}`, { userId, status: 403 });
      await f.request(`/api/announcements/recipients?projectId=${hiddenId}`, { userId, status: 403 });
    }
    for (const projectId of [1, 2, 3, 4, 5, 6]) {
      const recipients = await f.request(`/api/announcements/recipients?projectId=${projectId}`);
      assert.equal(recipients.items.some((row) => row.id === userId), projectIds.includes(projectId));
    }
  }
  await f.patch(2, { parentId: 3 });
  assert.deepEqual((await f.request('/api/projects', { userId: 2 })).map((row) => row.id).sort(), [1, 6]);
  assert.deepEqual((await f.request('/api/projects', { userId: 3 })).map((row) => row.id).sort(), [2, 3]);
  assert.deepEqual((await f.request('/api/projects', { userId: 5 })).map((row) => row.id).sort(), [5]);
});

test('batch grants authorize exactly the selected projects without customer, sibling or future project grants', async (t) => {
  const f = await fixture(t);
  const result = await f.grant([2, 5]);
  assert.deepEqual(result.items.map((row) => row.projectId).sort(), [2, 5]);
  assert.ok(result.items.every((row) => row.userId === 4 && row.role === 'developer' && row.createdBy === 1));
  const audit = await f.request('/api/audit?action=membership.create');
  assert.equal(audit.length, 2);
  assert.equal(new Set(audit.map((row) => row.meta.batchKey)).size, 1);
  for (const item of result.items) {
    const event = audit.find((row) => row.projectId === item.projectId);
    assert.equal(event.customerId, item.projectId === 2 ? 2 : 3);
    assert.equal(event.actorId, 1);
    assert.equal(event.targetType, 'membership');
    assert.equal(event.targetId, item.id);
    assert.equal(event.meta.userId, 4);
    assert.equal(event.meta.role, 'developer');
    assert.equal(event.meta.scope, 'project');
    assert.equal(event.meta.batchSize, 2);
    assert.match(event.meta.batchKey, /^[0-9a-f-]{36}$/i);
    assert.ok(!('projectIds' in event.meta), 'project-scoped logs must not expose other batch scopes');
  }
  const scopedAudit = await f.request('/api/audit?projectId=2&action=membership.create', { userId: 3 });
  assert.deepEqual(scopedAudit.map((row) => row.projectId), [2]);
  assert.deepEqual(f.grants(), [{ project_id: 2, role: 'developer' }, { project_id: 5, role: 'developer' }]);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id=4').first('n'), 0);
  const ownMemberships = await f.request('/api/memberships', { userId: 4 });
  assert.ok(ownMemberships.every((row) => row.scope === 'project'));
  assert.deepEqual((await f.request('/api/customers', { userId: 4 })).map((row) => row.id).sort(), [2, 3]);
  assert.deepEqual((await f.request('/api/projects', { userId: 4 })).map((row) => row.id).sort(), [2, 5]);
  assert.deepEqual((await f.request('/api/versions/accessible', { userId: 4 })).map((row) => row.projectId).sort(), [2, 5]);
  const notices = await f.request('/api/announcements', { userId: 4 });
  assert.deepEqual(notices.items.map((row) => row.projectId).sort(), [2, 5]);
  assert.deepEqual(notices.publishableProjects.map((row) => row.id).sort(), [2, 5]);
  for (const projectId of [1, 3, 4, 6]) {
    await f.request(`/api/versions?projectId=${projectId}`, { userId: 4, status: 403 });
    await f.request(`/api/announcements/recipients?projectId=${projectId}`, { userId: 4, status: 403 });
  }
  for (const projectId of [1, 2, 3, 4, 5, 6]) {
    assert.equal((await f.request(`/api/announcements/recipients?projectId=${projectId}`)).items.some((row) => row.id === 4), [2, 5].includes(projectId));
  }
  const later = await f.request('/api/projects', { method: 'POST', body: { customerId: 2, name: 'Created later', code: 'future-project' }, status: 201 });
  await f.request(`/api/projects/${later.id}`, { userId: 4, status: 403 });
  await f.request('/api/projects', { method: 'POST', body: { customerId: 2, name: 'Implicit customer escalation' }, userId: 4, status: 403 });
  assert.deepEqual((await f.request('/api/projects', { userId: 4 })).map((row) => row.id).sort(), [2, 5]);
});

test('project-only audit access excludes sibling, ancestor, descendant and customer-wide records', async (t) => {
  const f = await fixture(t);
  await f.grant([2, 5]);
  const insert = f.db._db.prepare(`INSERT INTO audit_logs(ts,actor_type,actor_id,customer_id,project_id,action)
    VALUES(1,?,?,?,?, 'hierarchy.visibility')`);
  const projects = f.db._db.prepare('SELECT id,customer_id FROM projects ORDER BY id').all();
  const projectEvents = new Map();
  for (const project of projects) {
    projectEvents.set(project.id, Number(insert.run('user', 1, project.customer_id, project.id).lastInsertRowid));
  }
  const customerEvents = new Map();
  for (const customerId of [1, 2, 3, 4]) {
    customerEvents.set(customerId, Number(insert.run('user', 1, customerId, null).lastInsertRowid));
  }
  const unrelated = Number(insert.run('user', 1, null, null).lastInsertRowid);
  const ownGlobal = Number(insert.run('user', 4, null, null).lastInsertRowid);
  const ownHistorical = Number(insert.run('user', 4, 1, 1).lastInsertRowid);
  const tokenIdCollision = Number(insert.run('api_token', 4, 1, 1).lastInsertRowid);
  const ids = async (userId, query = '') => (await f.request(`/api/audit?action=hierarchy.visibility${query}`, { userId })).map((row) => row.id).sort((a, b) => a - b);
  assert.deepEqual(await ids(4), [projectEvents.get(2), projectEvents.get(5), ownGlobal, ownHistorical].sort((a, b) => a - b));
  assert.ok(!(await ids(4)).includes(tokenIdCollision));
  assert.ok(!(await ids(4)).includes(unrelated));
  assert.deepEqual(await ids(4, '&projectId=3'), []);
  assert.deepEqual(await ids(4, '&customerId=2'), [], 'project grants must not unlock customer-wide audit filtering');
  assert.deepEqual(await ids(3), [projectEvents.get(2), projectEvents.get(3), customerEvents.get(2)].sort((a, b) => a - b));
  assert.deepEqual(await ids(3, '&customerId=1'), []);
  assert.deepEqual(await ids(3, '&projectId=4'), []);
  assert.deepEqual(await ids(2), [projectEvents.get(1), projectEvents.get(6), customerEvents.get(1), ownHistorical, tokenIdCollision].sort((a, b) => a - b));
  assert.equal((await ids(6)).length, 14, 'global administrators retain visibility of every event');
});

test('batch project grants reject mixed unauthorized scopes and preserve existing overrides', async (t) => {
  const f = await fixture(t);
  await f.grant([1, 2], { userId: 2, status: 403 });
  await f.grant([2, 4], { userId: 3, status: 403 });
  await f.grant([5], { userId: 5, status: 403 });
  await f.grant([1], { userId: 7, status: 403 });
  await f.grant([1], { userId: null, status: 401 });
  assert.deepEqual(f.grants(), []);
  const granted = await f.grant([2, 3], { userId: 3, fields: { role: 'viewer' } });
  assert.equal(granted.items.length, 2);
  await f.grant([1, 2], { fields: { role: 'customer_admin' }, status: 409 });
  assert.deepEqual(f.grants(), [{ project_id: 2, role: 'viewer' }, { project_id: 3, role: 'viewer' }]);
  f.db._db.prepare("INSERT INTO project_memberships(user_id,project_id,role,created_at) VALUES(2,6,'viewer',1)").run();
  await f.grant([1, 6], { userId: 2, status: 403 });
  assert.deepEqual(f.grants(), [{ project_id: 2, role: 'viewer' }, { project_id: 3, role: 'viewer' }]);
});

test('batch grant validation and missing targets never leave a partial grant', async (t) => {
  const f = await fixture(t);
  for (const projectIds of [[], [1, 1], [0], [-1], [1.5], ['1'], [false], Array.from({ length: 201 }, (_, i) => i + 1), null, '1']) {
    await f.grant(projectIds, { status: 400 });
  }
  for (const fields of [{ userId: 0 }, { userId: '4' }, { userId: 1.5 }, { role: 'admin' }, { role: '' }]) {
    await f.grant([1], { fields, status: 400 });
  }
  await f.grant([1, 999], { status: 404 });
  await f.grant([1], { fields: { userId: 999 }, status: 404 });
  assert.deepEqual(f.grants(), []);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM project_memberships').first('n'), 0);
  const maximum = Array.from({ length: 200 }, (_, index) => 101 + index);
  const insert = f.db._db.prepare(`INSERT INTO projects(id,customer_id,code,name,created_at,updated_at)
    VALUES(?,1,?,?,1,1)`);
  for (const id of maximum) insert.run(id, `batch-${id}`, `Batch project ${id}`);
  const accepted = await f.grant(maximum, { userId: 2, fields: { role: 'viewer' } });
  assert.equal(accepted.items.length, 200);
  assert.deepEqual(f.grants().map((row) => row.project_id), maximum);
  assert.deepEqual((await f.request('/api/projects', { userId: 4 })).map((row) => row.id).sort((a, b) => a - b), maximum);
  assert.equal((await f.request('/api/audit?action=membership.create&limit=500', { userId: 4 })).length, 200);
});

test('batch grant final-write races cannot partially grant projects or overwrite a concurrent membership', async (t) => {
  for (const change of ['duplicate', 'permission']) {
    const f = await fixture(t);
    const prepare = f.db.prepare.bind(f.db);
    let interleaved = false;
    f.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/INSERT INTO project_memberships/.test(sql)) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            if (change === 'duplicate') {
              f.db._db.prepare("INSERT INTO project_memberships(user_id,project_id,role,created_at) VALUES(4,1,'viewer',1)").run();
            } else {
              f.db._db.prepare("UPDATE memberships SET role='viewer' WHERE user_id=2 AND customer_id=1").run();
            }
            interleaved = true;
            return run();
          };
          return bound;
        };
      }
      return statement;
    };
    await f.grant([1, 6], { userId: 2, status: 409 });
    assert.equal(interleaved, true);
    assert.deepEqual(f.grants(), change === 'duplicate' ? [{ project_id: 1, role: 'viewer' }] : []);
    assert.deepEqual(await f.request('/api/audit?action=membership.create'), []);
  }
});
