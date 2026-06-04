#!/usr/bin/env node
// Seed the first admin user into the D1 database.
// Usage:
//   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='changeit123' \
//   npm run -w apps/worker seed -- --local
// Or for production:
//   ... npm run -w apps/worker seed -- --remote
//
// The script computes the PBKDF2 hash in the SAME format as the Worker's
// src/utils/password.ts (`pbkdf2$<iters>$<salt-b64url>$<hash-b64url>`) and
// shells out to `wrangler d1 execute` to insert the row.

import { execFileSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { argv, exit } from 'node:process';

const ITERATIONS = 100_000;
const KEYLEN = 32;
const SALT_LEN = 16;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, 'sha256');
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

function sqlEscape(s) {
  return s.replace(/'/g, "''");
}

const flag = argv.slice(2).find((a) => a === '--local' || a === '--remote');
if (!flag) {
  console.error('Pass --local or --remote');
  exit(2);
}

const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
const displayName = process.env.ADMIN_NAME ?? null;

if (!email || !password) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD env vars are required');
  exit(2);
}
if (password.length < 8) {
  console.error('ADMIN_PASSWORD must be at least 8 chars');
  exit(2);
}

const now = Date.now();
const hash = hashPassword(password);
const sql = `INSERT INTO users (email, password_hash, display_name, role, is_active, created_at, updated_at)
VALUES ('${sqlEscape(email)}', '${sqlEscape(hash)}', ${displayName ? `'${sqlEscape(displayName)}'` : 'NULL'}, 'super_admin', 1, ${now}, ${now})
ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'super_admin', is_active = 1, updated_at = ${now};`;

console.log(`[seed] inserting/updating super_admin user ${email} (${flag.slice(2)})`);

try {
  execFileSync(
    'npx',
    ['--yes', 'wrangler', 'd1', 'execute', 'qota-db', flag, '--command', sql],
    { stdio: 'inherit' },
  );
  console.log('[seed] done');
} catch (e) {
  console.error('[seed] failed:', e?.message ?? e);
  exit(1);
}
