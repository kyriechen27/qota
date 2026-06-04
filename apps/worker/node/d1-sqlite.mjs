// Minimal D1Database-compatible adapter over better-sqlite3.
//
// The qota worker only uses this slice of the D1 API:
//   db.prepare(sql).bind(...args).first<T>() | .all<T>() | .run()
// plus reads `.meta.last_row_id` / `.meta.changes` off `.run()` results.
// We implement exactly that surface (batch/exec included for completeness)
// so the same worker code runs unchanged on Cloudflare D1 and on Node/SQLite.

import Database from 'better-sqlite3';

// better-sqlite3 only accepts numbers, bigints, strings, Buffers and null as
// bound params. D1 callers pass undefined (→ null) and booleans (→ 0/1).
function sanitize(args) {
  return args.map((a) => {
    if (a === undefined || a === null) return null;
    if (typeof a === 'boolean') return a ? 1 : 0;
    return a;
  });
}

class PreparedStatement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new PreparedStatement(this.db, this.sql, sanitize(args));
  }

  async first(colName) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (row === undefined) return null;
    if (colName != null) return row[colName] ?? null;
    return row;
  }

  async all() {
    const results = this.db.prepare(this.sql).all(...this.args);
    return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        rows_read: 0,
        rows_written: info.changes,
        duration: 0,
      },
    };
  }

  async raw() {
    return this.db.prepare(this.sql).raw().all(...this.args);
  }
}

export function createSqliteD1(filename) {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return {
    // exposed for migrations / seeding that need raw synchronous access
    _db: db,
    prepare(sql) {
      return new PreparedStatement(db, sql);
    },
    async batch(statements) {
      // D1 batches run atomically; mirror that with a transaction.
      const run = db.transaction((stmts) =>
        stmts.map((s) => {
          const info = db.prepare(s.sql).run(...s.args);
          return {
            success: true,
            meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
          };
        }),
      );
      return run(statements);
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}
