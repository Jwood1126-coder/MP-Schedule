// Database schema, applied by the Worker itself on the first API request.
//
// Why not `wrangler d1 migrations apply`? Running migrations from code keeps
// the deploy command to a single `npx wrangler deploy`, with no extra step.
//
// Rules for adding a migration: append to MIGRATIONS with a new id, and keep
// every statement idempotent (IF NOT EXISTS, INSERT OR IGNORE). Two isolates
// may run the same migration at the same moment on a fresh database. A
// migration may also have run(db) for steps that need code (it must be
// idempotent too); it runs before the statements.
import { DEFAULT_SETTINGS } from '../public/js/core/defaults.js';

export const MIGRATIONS = [
  {
    id: '0001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_url TEXT,
        base_servings INTEGER NOT NULL DEFAULT 2,
        active_min INTEGER,
        total_min INTEGER,
        pans INTEGER,
        tags TEXT NOT NULL DEFAULT '[]',
        prep_note TEXT,
        steps TEXT,
        ingredients TEXT NOT NULL DEFAULT '[]',
        rating INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS meals (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        servings INTEGER NOT NULL DEFAULT 2,
        status TEXT NOT NULL DEFAULT 'planned',
        note TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS meals_date ON meals (date)`,
      `CREATE TABLE IF NOT EXISTS day_flags (
        date TEXT PRIMARY KEY,
        preferred INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY,
        store TEXT NOT NULL,
        pickup_date TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        locked_at TEXT,
        lock_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS trip_marks (
        trip_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        have INTEGER,
        have_reason TEXT,
        in_cart INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by TEXT,
        PRIMARY KEY (trip_id, item_key)
      )`,
      `CREATE TABLE IF NOT EXISTS extras (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL,
        text TEXT NOT NULL,
        section TEXT NOT NULL DEFAULT 'Other',
        in_cart INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS extras_trip ON extras (trip_id)`,
      `CREATE TABLE IF NOT EXISTS snapshot_items (
        trip_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        name TEXT NOT NULL,
        qty REAL,
        unit TEXT,
        dim TEXT,
        metric INTEGER NOT NULL DEFAULT 0,
        display TEXT,
        section TEXT,
        sources TEXT NOT NULL DEFAULT '[]',
        purchase TEXT NOT NULL DEFAULT 'bought',
        sub_note TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by TEXT,
        PRIMARY KEY (trip_id, item_key)
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        by TEXT,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        op TEXT NOT NULL,
        before TEXT,
        after TEXT
      )`,
    ],
  },
  {
    // Which Alfred proposals were already decided, so accepting twice can't
    // add the same dinners twice.
    id: '0002_inbox',
    statements: [
      `CREATE TABLE IF NOT EXISTS inbox_decisions (
        proposal_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        week_of TEXT,
        outcome TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        decided_by TEXT,
        summary TEXT
      )`,
    ],
  },
  {
    // Bind decisions to the reviewed revision and make the Notion write-back
    // durable (stored payload, retried later). Also narrows the default pantry
    // staples to olive oil and butter for households still on the old default.
    id: '0003_decision_receipts',
    statements: [
      "UPDATE inbox_decisions SET writeback_status = CASE WHEN source = 'notion' THEN 'done' ELSE 'n/a' END WHERE writeback_status IS NULL",
    ],
    run: async (db) => {
      const cols = [
        'revision TEXT', 'title TEXT', 'writeback_status TEXT', 'writeback_attempts INTEGER NOT NULL DEFAULT 0',
        'writeback_error TEXT', 'notion_status TEXT', 'reply TEXT', 'decided_by_text TEXT', 'result TEXT',
      ];
      for (const col of cols) {
        try {
          await db.prepare(`ALTER TABLE inbox_decisions ADD COLUMN ${col}`).run();
        } catch (err) {
          // Re-runs (or two first requests at once) find the column already there.
          if (!/duplicate column/i.test(String(err && err.message))) throw err;
        }
      }
      const row = await db.prepare("SELECT value FROM settings WHERE key = 'staples'").first();
      if (row && sameList(row.value, OLD_DEFAULT_STAPLES)) {
        await db.prepare("UPDATE settings SET value = ?, version = version + 1, updated_at = ?, updated_by = 'system' WHERE key = 'staples' AND value = ?")
          .bind(JSON.stringify(DEFAULT_SETTINGS.staples), new Date().toISOString(), row.value).run();
      }
    },
  },
];

// The staples list shipped before 0003. A stored list equal to it (in any
// order or case) was never customised, so it moves to the new default.
export const OLD_DEFAULT_STAPLES = [
  'salt', 'black pepper', 'pepper', 'olive oil', 'vegetable oil', 'butter', 'flour',
  'sugar', 'garlic powder', 'onion powder', 'chili powder', 'cumin', 'paprika',
  'dried oregano', 'soy sauce', 'rice vinegar', 'honey', 'cooking spray',
];

function sameList(json, list) {
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    return false;
  }
  if (!Array.isArray(v) || v.length !== list.length) return false;
  const norm = (a) => a.map((x) => String(x).trim().toLowerCase()).sort().join('\n');
  return norm(v) === norm(list);
}

export const MIGRATION_IDS = MIGRATIONS.map((m) => m.id);

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

// Apply any migrations this database hasn't seen. Returns the ids applied.
export async function migrate(db) {
  await db.prepare(BOOTSTRAP).run();
  const { results } = await db.prepare('SELECT id FROM schema_migrations').all();
  const done = new Set(results.map((r) => r.id));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    if (m.run) await m.run(db); // idempotent steps that can't be plain statements
    const stmts = m.statements.map((sql) => db.prepare(sql));
    stmts.push(db.prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)').bind(m.id, new Date().toISOString()));
    await db.batch(stmts); // one transaction per migration
    applied.push(m.id);
  }
  return applied;
}

// One migration attempt per database binding per isolate. A failure clears
// the cache so the next request tries again.
const cache = new WeakMap();

export function ensureSchema(db) {
  let p = cache.get(db);
  if (!p) {
    p = migrate(db).catch((err) => {
      cache.delete(db);
      throw err;
    });
    cache.set(db, p);
  }
  return p;
}
