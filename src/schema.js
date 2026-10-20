// Database schema, applied by the Worker itself on the first API request.
//
// Why not `wrangler d1 migrations apply`? Running migrations from code keeps
// the deploy command to a single `npx wrangler deploy`, with no extra step.
//
// Rules for adding a migration: append to MIGRATIONS with a new id, and keep
// every statement idempotent (IF NOT EXISTS, INSERT OR IGNORE). Two isolates
// may run the same migration at the same moment on a fresh database.

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
];

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
