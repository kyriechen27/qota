// First-run bootstrap: seed an initial super_admin when the users table is empty.
// This lets a fresh Cloudflare Pages/Workers deploy be usable immediately (the
// same convenience the Node entrypoint's seedAdmin gives), with no manual seed
// step. Guarded per isolate so the check runs at most once per warm instance;
// the INSERT is idempotent (email is UNIQUE) so concurrent first requests can't
// create duplicates.

import type { Bindings } from '../env';
import { hashPassword } from '../utils/password';

let seeded = false;

export async function ensureAdminSeed(env: Bindings): Promise<void> {
  if (seeded) return;
  try {
    const existing = await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    if (existing) {
      seeded = true;
      return;
    }
    const email = (env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
    const password = env.ADMIN_PASSWORD || 'admin12345';
    const displayName = env.ADMIN_NAME || 'Admin';
    const now = Date.now();
    const hash = await hashPassword(password);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (email, password_hash, display_name, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'super_admin', 1, ?, ?)`,
    )
      .bind(email, hash, displayName, now, now)
      .run();
    seeded = true;
    console.log(`[seed] created initial admin: ${email}`);
  } catch (e) {
    // Most likely the DB hasn't been migrated yet. Leave `seeded` false so a
    // later request retries once `d1 migrations apply` has run.
    console.error('[seed] ensureAdminSeed failed (will retry):', e);
  }
}
