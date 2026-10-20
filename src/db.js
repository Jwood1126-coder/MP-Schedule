// Versioned writes with a change log.
//
// Every write checks the version the client last saw ("expected_version").
// If someone else changed the row first, nothing is written and the caller
// gets the current row back as a conflict. Each successful write records its
// before/after row in change_log in the same D1 batch, which powers History
// and Undo.

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const ENTITIES = {
  recipe: {
    table: 'recipes',
    pk: ['id'],
    cols: ['name', 'source_url', 'base_servings', 'active_min', 'total_min', 'pans', 'tags', 'prep_note', 'steps', 'ingredients', 'rating', 'archived'],
    json: ['tags', 'ingredients'],
  },
  meal: { table: 'meals', pk: ['id'], cols: ['date', 'recipe_id', 'servings', 'status', 'note'], json: [] },
  day_flag: { table: 'day_flags', pk: ['date'], cols: ['preferred'], json: [] },
  trip: { table: 'trips', pk: ['id'], cols: ['store', 'pickup_date', 'start_date', 'end_date', 'status', 'locked_at', 'lock_id'], json: [] },
  trip_mark: { table: 'trip_marks', pk: ['trip_id', 'item_key'], cols: ['have', 'have_reason', 'in_cart'], json: [] },
  extra: { table: 'extras', pk: ['id'], cols: ['trip_id', 'text', 'section', 'in_cart'], json: [] },
  snapshot_item: {
    table: 'snapshot_items',
    pk: ['trip_id', 'item_key'],
    cols: ['name', 'qty', 'unit', 'dim', 'metric', 'display', 'section', 'sources', 'purchase', 'sub_note'],
    json: ['sources'],
  },
  setting: { table: 'settings', pk: ['key'], cols: ['value'], json: ['value'] },
};

export const META = ['version', 'updated_at', 'updated_by'];

export function allCols(ent) {
  return [...ent.pk, ...ent.cols, ...META];
}

// DB rows store JSON columns as text; API rows carry parsed values.
export function decode(ent, raw) {
  if (!raw) return raw;
  const row = { ...raw };
  for (const c of ent.json) {
    if (typeof row[c] === 'string') {
      try {
        row[c] = JSON.parse(row[c]);
      } catch {
        row[c] = null;
      }
    }
  }
  return row;
}

export function encodeValue(ent, col, value) {
  if (ent.json.includes(col)) return JSON.stringify(value ?? null);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value === undefined ? null : value;
}

function pkWhere(ent) {
  return ent.pk.map((c) => `${c} = ?`).join(' AND ');
}

function pkValues(ent, row) {
  return ent.pk.map((c) => row[c]);
}

export function entityId(ent, row) {
  return pkValues(ent, row).join('|');
}

export async function getRaw(db, ent, pk) {
  return db.prepare(`SELECT * FROM ${ent.table} WHERE ${pkWhere(ent)}`).bind(...pk).first();
}

function logStmt(db, { user, entityName, ent, row, action, op, before, after, conditional }) {
  const sql = `INSERT INTO change_log (at, by, entity, entity_id, action, op, before, after)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?${conditional ? ' WHERE changes() = 1' : ''}`;
  return db.prepare(sql).bind(
    new Date().toISOString(),
    user,
    entityName,
    entityId(ent, row),
    action,
    op,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
  );
}

function conflict(current, ent) {
  return new HttpError(409, 'conflict', {
    current: current ? decode(ent, current) : null,
    changed_by: current?.updated_by || null,
    changed_at: current?.updated_at || null,
  });
}

// Insert a new row. `values` holds API-level values (JSON columns not encoded).
export async function insertRow(db, user, entityName, values, { action = 'create', version = 1, extra = [] } = {}) {
  const ent = ENTITIES[entityName];
  const raw = {};
  for (const c of [...ent.pk, ...ent.cols]) raw[c] = encodeValue(ent, c, values[c]);
  raw.version = version;
  raw.updated_at = new Date().toISOString();
  raw.updated_by = user;
  const cols = allCols(ent);
  const stmt = db.prepare(`INSERT INTO ${ent.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => raw[c]));
  try {
    await db.batch([stmt, logStmt(db, { user, entityName, ent, row: raw, action, op: 'create', before: null, after: raw }), ...extra]);
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err && err.message))) {
      throw conflict(await getRaw(db, ent, pkValues(ent, raw)), ent);
    }
    throw err;
  }
  return decode(ent, raw);
}

// Update an existing row if its version still matches.
export async function updateRow(db, user, entityName, pk, patch, expectedVersion, { action = 'update' } = {}) {
  const ent = ENTITIES[entityName];
  const before = await getRaw(db, ent, pk);
  if (!before) throw new HttpError(404, 'not_found');
  if (before.version !== expectedVersion) throw conflict(before, ent);
  const after = { ...before };
  for (const c of ent.cols) if (Object.prototype.hasOwnProperty.call(patch, c)) after[c] = encodeValue(ent, c, patch[c]);
  after.version = before.version + 1;
  after.updated_at = new Date().toISOString();
  after.updated_by = user;
  const sets = [...ent.cols, ...META].map((c) => `${c} = ?`).join(', ');
  const stmt = db
    .prepare(`UPDATE ${ent.table} SET ${sets} WHERE ${pkWhere(ent)} AND version = ?`)
    .bind(...[...ent.cols, ...META].map((c) => after[c]), ...pk, expectedVersion);
  const results = await db.batch([stmt, logStmt(db, { user, entityName, ent, row: after, action, op: 'update', before, after, conditional: true })]);
  if (!results[0].meta.changes) throw conflict(await getRaw(db, ent, pk), ent);
  return decode(ent, after);
}

export async function deleteRow(db, user, entityName, pk, expectedVersion, { action = 'delete' } = {}) {
  const ent = ENTITIES[entityName];
  const before = await getRaw(db, ent, pk);
  if (!before) throw new HttpError(404, 'not_found');
  if (before.version !== expectedVersion) throw conflict(before, ent);
  const stmt = db.prepare(`DELETE FROM ${ent.table} WHERE ${pkWhere(ent)} AND version = ?`).bind(...pk, expectedVersion);
  const results = await db.batch([stmt, logStmt(db, { user, entityName, ent, row: before, action, op: 'delete', before, after: null, conditional: true })]);
  if (!results[0].meta.changes) throw conflict(await getRaw(db, ent, pk), ent);
  return { deleted: true };
}

// For keyed rows (day flags, marks, settings): expected_version 0 = "it didn't exist".
export async function upsertRow(db, user, entityName, values, expectedVersion, opts = {}) {
  const ent = ENTITIES[entityName];
  const pk = pkValues(ent, values);
  if (expectedVersion === 0) {
    const existing = await getRaw(db, ent, pk);
    if (existing) throw conflict(existing, ent);
    return insertRow(db, user, entityName, values, opts);
  }
  return updateRow(db, user, entityName, pk, values, expectedVersion, opts);
}

const NOT_UNDOABLE = new Set(['lock', 'import']);

// Revert one change_log entry if the row hasn't changed since.
export async function undo(db, user, logId) {
  const entry = await db.prepare('SELECT * FROM change_log WHERE id = ?').bind(logId).first();
  if (!entry) throw new HttpError(404, 'not_found');
  if (NOT_UNDOABLE.has(entry.action)) throw new HttpError(409, 'not_undoable');
  const ent = ENTITIES[entry.entity];
  if (!ent) throw new HttpError(409, 'not_undoable');
  const before = entry.before ? JSON.parse(entry.before) : null;
  const after = entry.after ? JSON.parse(entry.after) : null;
  const pk = pkValues(ent, after || before);
  const current = await getRaw(db, ent, pk);
  const stale = () => new HttpError(409, 'changed_since', { current: current ? decode(ent, current) : null, changed_by: current?.updated_by || null, changed_at: current?.updated_at || null });

  if (entry.op === 'create') {
    if (!current || current.version !== after.version) throw stale();
    if (entry.entity === 'recipe') {
      const used = await db.prepare('SELECT COUNT(*) AS n FROM meals WHERE recipe_id = ?').bind(current.id).first();
      if (used.n > 0) throw new HttpError(409, 'in_use', { message: 'This recipe is on the plan. Archive it instead.' });
    }
    return deleteRow(db, user, entry.entity, pk, current.version, { action: 'undo' });
  }
  if (entry.op === 'update') {
    if (!current || current.version !== after.version) throw stale();
    const patch = decode(ent, before);
    return updateRow(db, user, entry.entity, pk, patch, current.version, { action: 'undo' });
  }
  if (entry.op === 'delete') {
    if (current) throw stale();
    return insertRow(db, user, entry.entity, decode(ent, before), { action: 'undo', version: (before.version || 0) + 1 });
  }
  throw new HttpError(409, 'not_undoable');
}
