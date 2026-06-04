// Apply the same migrations/*.sql files D1 uses, but to the local SQLite file.
// Tracks applied files in a private _node_migrations table (independent of D1's
// own bookkeeping so the two deploy targets never collide).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function runMigrations(d1, migrationsDir) {
  const db = d1._db;
  db.exec('CREATE TABLE IF NOT EXISTS _node_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM _node_migrations').all().map((r) => r.name));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _node_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
    });
    apply();
    count += 1;
    console.log(`[migrate] applied ${file}`);
  }
  if (count === 0) console.log('[migrate] database up to date');
  return count;
}
