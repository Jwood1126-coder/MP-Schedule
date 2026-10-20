// A small D1-compatible database for local development and tests, built on
// Node's built-in SQLite (node:sqlite). It implements the parts of the D1 API
// this app uses: prepare/bind/first/all/run and transactional batch().
// Production uses real Cloudflare D1; this only stands in when workerd and
// wrangler aren't available (for example in offline CI containers).
import { DatabaseSync } from 'node:sqlite';

function normalize(args) {
  return args.map((v, i) => {
    if (v === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound at position ${i + 1}`);
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

const plain = (row) => (row ? { ...row } : null);
const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, normalize(args));
  }

  #prepared() {
    return this.db.sqlite.prepare(this.sql);
  }

  async first(column) {
    const row = plain(this.#prepared().get(...this.params));
    if (column) return row ? row[column] : null;
    return row;
  }

  async all() {
    return this._allSync();
  }

  _allSync() {
    const results = this.#prepared().all(...this.params).map(plain);
    return { success: true, results, meta: { changes: 0, rows_read: results.length } };
  }

  async run() {
    return this._runSync();
  }

  _runSync() {
    if (returnsRows(this.sql)) return this._allSync();
    const r = this.#prepared().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class LocalD1 {
  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA journal_mode = WAL');
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  // Like D1: statements run in order inside one transaction; any error rolls
  // the whole batch back and rejects.
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s._runSync());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 1 };
  }

  close() {
    this.sqlite.close();
  }
}
