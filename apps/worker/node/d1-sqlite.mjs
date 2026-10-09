// D1Database-compatible adapter over Node's built-in SQLite when available,
// with optional better-sqlite3 support for Node 18/20.
//
// The qota worker only uses this slice of the D1 API:
//   db.prepare(sql).bind(...args).first<T>() | .all<T>() | .run()
// plus reads `.meta.last_row_id` / `.meta.changes` off `.run()` results.
// We implement exactly that surface (batch/exec included for completeness)
// so the same worker code runs unchanged on Cloudflare D1 and on Node/SQLite.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let NativeDatabase;
try {
  // Lazy loading keeps this module usable on Node versions without node:sqlite.
  const sqlite = require('node:sqlite');
  NativeDatabase = sqlite.DatabaseSync ?? sqlite.Database;
} catch (error) {
  if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
}

class NativeStatement {
  constructor(statement) {
    this.statement = statement;
    this.returnArrays = false;
  }

  raw(enabled = true) {
    this.returnArrays = enabled;
    // Older built-in SQLite releases do not yet have setReturnArrays.
    this.statement.setReturnArrays?.(enabled);
    return this;
  }

  row(value) {
    if (value === undefined || Array.isArray(value)) return value;
    // node:sqlite returns null-prototype objects; keep the existing adapter's
    // plain-object contract for API consumers and direct migration/test access.
    return this.returnArrays ? Object.values(value) : { ...value };
  }

  get(...args) {
    return this.row(this.statement.get(...args));
  }

  all(...args) {
    return this.statement.all(...args).map((row) => this.row(row));
  }

  run(...args) {
    return this.statement.run(...args);
  }
}

class BuiltinDatabase {
  constructor(filename) {
    this.database = new NativeDatabase(filename);
    this.nextSavepoint = 0;
  }

  prepare(sql) {
    return new NativeStatement(this.database.prepare(sql));
  }

  exec(sql) {
    return this.database.exec(sql);
  }

  pragma(sql) {
    return this.prepare(`PRAGMA ${sql}`).all();
  }

  transaction(fn) {
    return (...args) => {
      // Savepoints also preserve atomicity for nested synchronous operations.
      const name = `qota_transaction_${++this.nextSavepoint}`;
      this.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn(...args);
        this.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        this.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    };
  }

  close() {
    return this.database.close();
  }
}

function openDatabase(filename) {
  if (NativeDatabase) return new BuiltinDatabase(filename);
  // No native addon is loaded on modern Node, avoiding ABI mismatches after
  // switching Node versions. Older supported versions retain the same driver.
  const Database = require('better-sqlite3');
  return new Database(filename);
}

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
  const db = openDatabase(filename);
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
