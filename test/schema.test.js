import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, ensureSchema, MIGRATIONS } from '../src/schema.js';
import { LocalD1 } from '../scripts/d1-shim.js';

const tables = async (db) => (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).results.map((r) => r.name);

test('a fresh database migrates itself; a second run is a no-op', async () => {
  const db = new LocalD1();
  const first = await migrate(db);
  assert.deepEqual(first, MIGRATIONS.map((m) => m.id));
  const names = await tables(db);
  for (const t of ['recipes', 'meals', 'day_flags', 'trips', 'trip_marks', 'extras', 'snapshot_items', 'settings', 'change_log', 'schema_migrations']) {
    assert.ok(names.includes(t), `has ${t}`);
  }
  await db.prepare("INSERT INTO settings (key, value) VALUES ('stores', '[]')").run();
  const second = await migrate(db);
  assert.deepEqual(second, []);
  const kept = await db.prepare('SELECT COUNT(*) AS n FROM settings').first();
  assert.equal(kept.n, 1, 'existing data untouched');
});

test('migrations are idempotent even if re-run without the bookkeeping row', async () => {
  const db = new LocalD1();
  await migrate(db);
  await db.prepare('DELETE FROM schema_migrations').run(); // simulate a concurrent first request
  const again = await migrate(db);
  assert.deepEqual(again, MIGRATIONS.map((m) => m.id));
  const rows = await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').first();
  assert.equal(rows.n, MIGRATIONS.length);
});

test('ensureSchema caches success and retries after a failure', async () => {
  let calls = 0;
  const real = new LocalD1();
  const flaky = {
    prepare: (sql) => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return real.prepare(sql);
    },
    batch: (s) => real.batch(s),
  };
  await assert.rejects(ensureSchema(flaky), /transient/);
  await ensureSchema(flaky);
  const before = calls;
  await ensureSchema(flaky);
  assert.equal(calls, before, 'second success call is cached');
});

test('0003 moves an untouched old staples list to olive oil + butter, keeps custom lists, and re-runs safely', async () => {
  const { OLD_DEFAULT_STAPLES } = await import('../src/schema.js');
  const staplesOf = async (db) => JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'staples'").first()).value);
  const rerun0003 = async (db) => {
    await db.prepare("DELETE FROM schema_migrations WHERE id = '0003_decision_receipts'").run();
    return migrate(db);
  };

  const old = new LocalD1();
  await migrate(old);
  // Stored in a different order and case: still the untouched old default.
  const shuffled = [...OLD_DEFAULT_STAPLES].reverse().map((s, i) => (i % 2 ? s.toUpperCase() : s));
  await old.prepare("INSERT INTO settings (key, value) VALUES ('staples', ?)").bind(JSON.stringify(shuffled)).run();
  assert.deepEqual(await rerun0003(old), ['0003_decision_receipts']);
  assert.deepEqual(await staplesOf(old), ['olive oil', 'butter']);

  const custom = new LocalD1();
  await migrate(custom);
  const mine = ['salt', 'olive oil', 'butter', 'rice'];
  await custom.prepare("INSERT INTO settings (key, value) VALUES ('staples', ?)").bind(JSON.stringify(mine)).run();
  await rerun0003(custom);
  assert.deepEqual(await staplesOf(custom), mine, 'customised list untouched');

  // Columns already exist on a re-run; that must not fail.
  await rerun0003(custom);
  const cols = (await custom.prepare('PRAGMA table_info(inbox_decisions)').all()).results.map((c) => c.name);
  for (const c of ['revision', 'writeback_status', 'writeback_attempts', 'reply', 'decided_by_text', 'result']) assert.ok(cols.includes(c), `has ${c}`);
});
