// API route handlers. Each returns a plain object (sent as JSON) or throws
// an HttpError. All SQL uses bound parameters.
import { ENTITIES, HttpError, decode, getRaw, insertRow, updateRow, deleteRow, upsertRow, undo, allCols } from './db.js';
import { str, int, flag, date, oneOf, expectedVersion, url as urlField, stringList } from './validate.js';
import { STARTER_RECIPES } from './starter-recipes.js';
import { MIGRATION_IDS } from './schema.js';
import { getInbox, previewInbox, decideInbox } from './inbox.js';
import { DEFAULT_SETTINGS, SETTING_KEYS, TAGS, mergeSettings } from '../public/js/core/defaults.js';
import { addDays, daysBetween, isDate } from '../public/js/core/dates.js';
import { buildList, toSnapshotRows } from '../public/js/core/grocery.js';
import { suggestMeals } from '../public/js/core/suggest.js';

const ID = '([A-Za-z0-9-]{1,64})';
const KEY = '([^/]{1,300})';
const MEAL_STATUS = ['tentative', 'planned', 'cooked', 'skipped'];
const PURCHASE = ['bought', 'out', 'substituted'];

const newId = () => crypto.randomUUID();

async function all(db, sql, ...args) {
  const { results } = await db.prepare(sql).bind(...args).all();
  return results;
}

async function loadSettings(db) {
  const rows = (await all(db, 'SELECT * FROM settings')).map((r) => decode(ENTITIES.setting, r));
  return { settings: mergeSettings(rows), versions: Object.fromEntries(rows.map((r) => [r.key, r.version])) };
}

async function loadRecipes(db) {
  return (await all(db, 'SELECT * FROM recipes ORDER BY name COLLATE NOCASE')).map((r) => decode(ENTITIES.recipe, r));
}

function inList(n) {
  return Array.from({ length: n }, () => '?').join(', ');
}

// ---------- recipes ----------

function validateIngredients(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'invalid', { field: 'ingredients', message: 'must be a list' });
  if (list.length > 60) throw new HttpError(400, 'invalid', { field: 'ingredients', message: 'at most 60 ingredients' });
  return list.map((ing, i) => {
    const where = `ingredient ${i + 1}`;
    if (!ing || typeof ing !== 'object') throw new HttpError(400, 'invalid', { field: 'ingredients', message: `${where} is malformed` });
    const qty = ing.qty == null || ing.qty === '' ? null : Number(ing.qty);
    if (qty != null && (!Number.isFinite(qty) || qty <= 0 || qty > 10000)) throw new HttpError(400, 'invalid', { field: 'ingredients', message: `${where}: bad quantity` });
    const name = typeof ing.name === 'string' ? ing.name.trim() : '';
    if (!name || name.length > 100) throw new HttpError(400, 'invalid', { field: 'ingredients', message: `${where}: name is required (max 100 characters)` });
    const unit = typeof ing.unit === 'string' ? ing.unit.trim().slice(0, 30) : '';
    const section = typeof ing.section === 'string' && ing.section.trim() ? ing.section.trim().slice(0, 40) : 'Other';
    const note = typeof ing.note === 'string' ? ing.note.trim().slice(0, 200) : '';
    return { qty, unit, name, section, optional: !!ing.optional, note };
  });
}

function validateRecipe(body, partial) {
  const out = {};
  const has = (f) => !partial || Object.prototype.hasOwnProperty.call(body, f);
  if (has('name')) out.name = str(body, 'name', { max: 100, required: true });
  if (has('source_url')) out.source_url = urlField(body, 'source_url');
  if (has('base_servings')) out.base_servings = int(body, 'base_servings', { min: 1, max: 20, required: true });
  if (has('active_min')) out.active_min = int(body, 'active_min', { min: 0, max: 600 });
  if (has('total_min')) out.total_min = int(body, 'total_min', { min: 0, max: 1440 });
  if (has('pans')) out.pans = int(body, 'pans', { min: 0, max: 10 });
  if (has('tags')) {
    const tags = body.tags == null ? [] : stringList(body.tags, 'tags', { maxItems: 10 });
    for (const t of tags) if (!TAGS.includes(t)) throw new HttpError(400, 'invalid', { field: 'tags', message: `unknown tag ${t}` });
    out.tags = tags;
  }
  if (has('prep_note')) out.prep_note = str(body, 'prep_note', { max: 500 });
  if (has('steps')) out.steps = str(body, 'steps', { max: 5000 });
  if (has('ingredients')) out.ingredients = validateIngredients(body.ingredients ?? []);
  if (has('rating')) out.rating = int(body, 'rating', { min: 1, max: 5 });
  if (has('archived')) out.archived = flag(body, 'archived');
  return out;
}

async function createRecipe({ db, user, body }) {
  const v = validateRecipe(body, false);
  return { recipe: await insertRow(db, user, 'recipe', { id: newId(), archived: 0, ...v }) };
}

async function updateRecipe({ db, user, body, params }) {
  const v = validateRecipe(body, true);
  return { recipe: await updateRow(db, user, 'recipe', [params[0]], v, expectedVersion(body)) };
}

async function deleteRecipe({ db, user, body, params }) {
  const used = await db.prepare('SELECT COUNT(*) AS n FROM meals WHERE recipe_id = ?').bind(params[0]).first();
  if (used.n > 0) throw new HttpError(409, 'in_use', { message: 'This recipe is on the plan. Archive it instead.' });
  return deleteRow(db, user, 'recipe', [params[0]], expectedVersion(body));
}

// ---------- meals ----------

async function requireRecipe(db, id) {
  const r = await getRaw(db, ENTITIES.recipe, [id]);
  if (!r) throw new HttpError(400, 'invalid', { field: 'recipe_id', message: 'unknown recipe' });
}

async function createMeal({ db, user, body }) {
  const values = {
    id: newId(),
    date: date(body, 'date'),
    recipe_id: str(body, 'recipe_id', { max: 64, required: true }),
    servings: int(body, 'servings', { min: 1, max: 20 }) ?? (await loadSettings(db)).settings.default_servings,
    status: oneOf(body, 'status', MEAL_STATUS, { fallback: 'planned' }),
    note: str(body, 'note', { max: 500 }),
  };
  await requireRecipe(db, values.recipe_id);
  return { meal: await insertRow(db, user, 'meal', values) };
}

async function updateMeal({ db, user, body, params }) {
  const patch = {};
  if ('date' in body) patch.date = date(body, 'date');
  if ('recipe_id' in body) {
    patch.recipe_id = str(body, 'recipe_id', { max: 64, required: true });
    await requireRecipe(db, patch.recipe_id);
  }
  if ('servings' in body) patch.servings = int(body, 'servings', { min: 1, max: 20, required: true });
  if ('status' in body) patch.status = oneOf(body, 'status', MEAL_STATUS);
  if ('note' in body) patch.note = str(body, 'note', { max: 500 });
  const action = typeof body.action === 'string' && /^[a-z]{1,20}$/.test(body.action) ? body.action : 'update';
  return { meal: await updateRow(db, user, 'meal', [params[0]], patch, expectedVersion(body), { action }) };
}

async function deleteMeal({ db, user, body, params }) {
  return deleteRow(db, user, 'meal', [params[0]], expectedVersion(body));
}

// ---------- day flags ----------

async function putDayFlag({ db, user, body, params }) {
  if (!isDate(params[0])) throw new HttpError(400, 'invalid', { field: 'date' });
  const row = await upsertRow(db, user, 'day_flag', { date: params[0], preferred: flag(body, 'preferred') }, expectedVersion(body));
  return { day_flag: row };
}

// ---------- trips ----------

async function checkOverlap(db, id, start, end) {
  const clash = await db
    .prepare('SELECT id, store, start_date, end_date FROM trips WHERE id != ? AND start_date <= ? AND end_date >= ?')
    .bind(id, end, start)
    .first();
  if (clash) throw new HttpError(409, 'overlap', { message: `Overlaps the ${clash.store} trip (${clash.start_date} to ${clash.end_date}).`, trip: clash });
}

function tripRange(body, fallback = {}) {
  const pickup = 'pickup_date' in body ? date(body, 'pickup_date') : fallback.pickup_date;
  const start = 'start_date' in body ? date(body, 'start_date') : fallback.start_date ?? pickup;
  const end = 'end_date' in body ? date(body, 'end_date') : fallback.end_date ?? addDays(start, 6);
  if (daysBetween(start, end) < 0) throw new HttpError(400, 'invalid', { field: 'end_date', message: 'must be on or after the start date' });
  if (daysBetween(start, end) > 30) throw new HttpError(400, 'invalid', { field: 'end_date', message: 'a trip can cover at most 31 days' });
  return { pickup_date: pickup, start_date: start, end_date: end };
}

async function createTrip({ db, user, body }) {
  const id = newId();
  const store = str(body, 'store', { max: 60, required: true });
  const range = tripRange(body);
  await checkOverlap(db, id, range.start_date, range.end_date);
  return { trip: await insertRow(db, user, 'trip', { id, store, ...range, status: 'open', locked_at: null, lock_id: null }) };
}

async function updateTrip({ db, user, body, params }) {
  const current = await getRaw(db, ENTITIES.trip, [params[0]]);
  if (!current) throw new HttpError(404, 'not_found');
  const patch = {};
  if ('store' in body) patch.store = str(body, 'store', { max: 60, required: true });
  if ('pickup_date' in body || 'start_date' in body || 'end_date' in body) {
    if (current.status === 'locked') throw new HttpError(409, 'locked', { message: 'This trip is already shopped; its dates are fixed.' });
    Object.assign(patch, tripRange(body, current));
    await checkOverlap(db, current.id, patch.start_date, patch.end_date);
  }
  return { trip: await updateRow(db, user, 'trip', [params[0]], patch, expectedVersion(body)) };
}

async function deleteTrip({ db, user, body, params }) {
  const current = await getRaw(db, ENTITIES.trip, [params[0]]);
  if (current && current.status === 'locked') throw new HttpError(409, 'locked', { message: 'A shopped trip is kept as a record.' });
  return deleteRow(db, user, 'trip', [params[0]], expectedVersion(body));
}

async function computeTripList(db, trip) {
  const [meals, recipes, marks, { settings }] = await Promise.all([
    all(db, 'SELECT * FROM meals WHERE date >= ? AND date <= ?', trip.start_date, trip.end_date),
    loadRecipes(db),
    all(db, 'SELECT * FROM trip_marks WHERE trip_id = ?', trip.id),
    loadSettings(db),
  ]);
  const byId = Object.fromEntries(recipes.map((r) => [r.id, r]));
  return buildList(meals, byId, marks, settings);
}

// Lock = "I built the cart". Writes the shopping snapshot exactly once.
async function lockTrip({ db, user, body, params }) {
  const expected = expectedVersion(body);
  const trip = await getRaw(db, ENTITIES.trip, [params[0]]);
  if (!trip) throw new HttpError(404, 'not_found');
  if (trip.status === 'locked') return { trip: decode(ENTITIES.trip, trip), already_locked: true };
  if (trip.version !== expected) throw new HttpError(409, 'conflict', { current: trip, changed_by: trip.updated_by, changed_at: trip.updated_at });

  const rows = toSnapshotRows(await computeTripList(db, trip));
  const now = new Date().toISOString();
  const lockId = newId();
  const after = { ...trip, status: 'locked', locked_at: now, lock_id: lockId, version: trip.version + 1, updated_at: now, updated_by: user };
  const stmts = [
    db.prepare(`UPDATE trips SET status = 'locked', locked_at = ?, lock_id = ?, version = version + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND status = 'open' AND version = ?`).bind(now, lockId, now, user, trip.id, expected),
    db.prepare(`INSERT INTO change_log (at, by, entity, entity_id, action, op, before, after)
      SELECT ?, ?, 'trip', ?, 'lock', 'update', ?, ? WHERE changes() = 1`).bind(now, user, trip.id, JSON.stringify(trip), JSON.stringify(after)),
    // One statement for all items (D1 limits queries per request). It only
    // inserts if this request's lock won, and OR IGNORE blocks duplicates.
    db.prepare(`INSERT OR IGNORE INTO snapshot_items
      (trip_id, item_key, name, qty, unit, dim, metric, display, section, sources, purchase, sub_note, version, updated_at, updated_by)
      SELECT ?, json_extract(j.value, '$.item_key'), json_extract(j.value, '$.name'), json_extract(j.value, '$.qty'),
        json_extract(j.value, '$.unit'), json_extract(j.value, '$.dim'), json_extract(j.value, '$.metric'),
        json_extract(j.value, '$.display'), json_extract(j.value, '$.section'), json_extract(j.value, '$.sources'),
        'bought', NULL, 1, ?, ?
      FROM json_each(?) AS j
      WHERE (SELECT lock_id FROM trips WHERE id = ?) = ?`).bind(trip.id, now, user, JSON.stringify(rows), trip.id, lockId),
  ];
  const results = await db.batch(stmts);
  if (!results[0].meta.changes) {
    const latest = await getRaw(db, ENTITIES.trip, [trip.id]);
    if (latest && latest.status === 'locked') return { trip: decode(ENTITIES.trip, latest), already_locked: true };
    throw new HttpError(409, 'conflict', { current: latest, changed_by: latest?.updated_by, changed_at: latest?.updated_at });
  }
  return { trip: decode(ENTITIES.trip, after), items: rows.length };
}

async function requireTrip(db, id) {
  const t = await getRaw(db, ENTITIES.trip, [id]);
  if (!t) throw new HttpError(404, 'not_found', { message: 'unknown trip' });
  return t;
}

async function putMark({ db, user, body, params }) {
  await requireTrip(db, params[0]);
  const key = params[1];
  if (key.length > 300) throw new HttpError(400, 'invalid', { field: 'item_key' });
  let have = null;
  if (body.have === true || body.have === 1) have = 1;
  else if (body.have === false || body.have === 0) have = 0;
  else if (body.have != null) throw new HttpError(400, 'invalid', { field: 'have' });
  const values = {
    trip_id: params[0],
    item_key: key,
    have,
    have_reason: have ? str(body, 'have_reason', { max: 60 }) || 'have' : null,
    in_cart: flag(body, 'in_cart'),
  };
  return { mark: await upsertRow(db, user, 'trip_mark', values, expectedVersion(body)) };
}

async function createExtra({ db, user, body, params }) {
  await requireTrip(db, params[0]);
  const values = {
    id: newId(),
    trip_id: params[0],
    text: str(body, 'text', { max: 120, required: true }),
    section: str(body, 'section', { max: 40 }) || 'Other',
    in_cart: 0,
  };
  return { extra: await insertRow(db, user, 'extra', values) };
}

async function updateExtra({ db, user, body, params }) {
  const patch = {};
  if ('text' in body) patch.text = str(body, 'text', { max: 120, required: true });
  if ('section' in body) patch.section = str(body, 'section', { max: 40 }) || 'Other';
  if ('in_cart' in body) patch.in_cart = flag(body, 'in_cart');
  return { extra: await updateRow(db, user, 'extra', [params[0]], patch, expectedVersion(body)) };
}

async function deleteExtra({ db, user, body, params }) {
  return deleteRow(db, user, 'extra', [params[0]], expectedVersion(body));
}

// Only purchase status and the substitution note change after lock.
async function patchSnapshot({ db, user, body, params }) {
  const patch = { purchase: oneOf(body, 'purchase', PURCHASE) };
  if ('sub_note' in body) patch.sub_note = str(body, 'sub_note', { max: 200 });
  return { item: await updateRow(db, user, 'snapshot_item', [params[0], params[1]], patch, expectedVersion(body)) };
}

// ---------- state ----------

async function getState({ db, me, url }) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!isDate(from) || !isDate(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > 120) {
    throw new HttpError(400, 'invalid', { message: 'from/to must be dates at most 120 days apart' });
  }
  const trips = (await all(db, 'SELECT * FROM trips WHERE end_date >= ? OR status = ? ORDER BY pickup_date DESC LIMIT 12', addDays(from, -45), 'open'))
    .map((t) => decode(ENTITIES.trip, t));
  let lo = from;
  let hi = to;
  for (const t of trips) {
    if (t.start_date < lo) lo = t.start_date;
    if (t.end_date > hi) hi = t.end_date;
  }
  const ids = trips.map((t) => t.id);
  const tripRows = async (table, ent) => (ids.length ? (await all(db, `SELECT * FROM ${table} WHERE trip_id IN (${inList(ids.length)})`, ...ids)).map((r) => decode(ent, r)) : []);
  const [recipes, meals, dayFlags, { settings, versions }, marks, extras, snapshot] = await Promise.all([
    loadRecipes(db),
    all(db, 'SELECT * FROM meals WHERE date >= ? AND date <= ? ORDER BY date', lo, hi),
    all(db, 'SELECT * FROM day_flags WHERE date >= ? AND date <= ?', lo, hi),
    loadSettings(db),
    tripRows('trip_marks', ENTITIES.trip_mark),
    tripRows('extras', ENTITIES.extra),
    tripRows('snapshot_items', ENTITIES.snapshot_item),
  ]);
  for (const t of trips) {
    t.marks = marks.filter((m) => m.trip_id === t.id);
    t.extras = extras.filter((e) => e.trip_id === t.id);
    t.snapshot = snapshot.filter((s) => s.trip_id === t.id);
  }
  return {
    me: { email: me.email, dev: !!me.dev },
    server_time: new Date().toISOString(),
    range: { from: lo, to: hi },
    settings,
    settings_versions: versions,
    recipes,
    meals,
    day_flags: dayFlags,
    trips,
  };
}

// ---------- settings ----------

function validateSetting(key, value) {
  switch (key) {
    case 'sections': {
      const list = stringList(value, key, { maxItems: 20, maxLen: 40 });
      if (!list.length) throw new HttpError(400, 'invalid', { field: key, message: 'need at least one section' });
      return list;
    }
    case 'staples':
      return stringList(value, key, { maxItems: 100, maxLen: 60 });
    case 'stores': {
      const list = stringList(value, key, { maxItems: 10, maxLen: 60 });
      if (!list.length) throw new HttpError(400, 'invalid', { field: key, message: 'need at least one store' });
      return list;
    }
    case 'default_servings':
      return int({ v: value }, 'v', { min: 1, max: 20, required: true });
    case 'dinners_per_week':
      return int({ v: value }, 'v', { min: 1, max: 7, required: true });
    case 'preferred_label':
      return str({ v: value }, 'v', { max: 30, required: true });
    case 'default_store':
      return str({ v: value }, 'v', { max: 60, required: true });
    default:
      throw new HttpError(400, 'invalid', { field: 'key', message: 'unknown setting' });
  }
}

async function putSetting({ db, user, body, params }) {
  const key = params[0];
  if (!SETTING_KEYS.includes(key)) throw new HttpError(404, 'not_found');
  const value = validateSetting(key, body.value);
  return { setting: await upsertRow(db, user, 'setting', { key, value }, expectedVersion(body)) };
}

// ---------- suggestions, history, undo ----------

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

async function suggest({ db, body }) {
  const start = date(body, 'week_start');
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = weekDates[6];
  const [meals, recipes, flags, { settings }] = await Promise.all([
    all(db, 'SELECT * FROM meals WHERE date >= ? AND date <= ?', addDays(start, -21), end),
    loadRecipes(db),
    all(db, 'SELECT * FROM day_flags WHERE date >= ? AND date <= ?', start, end),
    loadSettings(db),
  ]);
  const seed = Number.isInteger(body.seed) ? body.seed : hashSeed(start);
  const notBefore = date(body, 'today', { required: false });
  const proposals = suggestMeals({
    weekDates,
    existingMeals: meals.filter((m) => m.date >= start),
    recentMeals: meals.filter((m) => m.date < start),
    recipes,
    dayFlags: Object.fromEntries(flags.map((f) => [f.date, !!f.preferred])),
    target: settings.dinners_per_week,
    staples: settings.staples,
    defaultServings: settings.default_servings,
    seed,
    notBefore,
  });
  return { proposals };
}

async function history({ db, url }) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const rows = await all(db, 'SELECT * FROM change_log ORDER BY id DESC LIMIT ?', limit);
  return {
    entries: rows.map((r) => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null })),
  };
}

async function undoChange({ db, user, params }) {
  const id = Number(params[0]);
  if (!Number.isInteger(id)) throw new HttpError(400, 'invalid');
  return { result: await undo(db, user, id) };
}

// ---------- export / import / starter ----------

const DATA_ENTITIES = ['recipe', 'meal', 'day_flag', 'trip', 'trip_mark', 'extra', 'snapshot_item', 'setting'];

async function exportAll({ db, schemaVersion }) {
  const tables = {};
  for (const name of DATA_ENTITIES) {
    const ent = ENTITIES[name];
    tables[ent.table] = await all(db, `SELECT * FROM ${ent.table}`);
  }
  tables.change_log = await all(db, 'SELECT * FROM change_log ORDER BY id DESC LIMIT 500');
  return { app: 'meal-planner', schema_version: schemaVersion, exported_at: new Date().toISOString(), tables };
}

async function importAll({ db, user, body, schemaVersion }) {
  if (body.confirm !== 'REPLACE') throw new HttpError(400, 'invalid', { message: 'send confirm: "REPLACE"' });
  const data = body.data;
  if (!data || typeof data !== 'object' || !data.tables || typeof data.tables !== 'object') throw new HttpError(400, 'invalid', { message: 'not a meal-planner export' });
  // Exports from any earlier schema import cleanly: later migrations only add tables.
  if (data.schema_version && !MIGRATION_IDS.includes(data.schema_version)) throw new HttpError(400, 'invalid', { message: `export is schema ${data.schema_version}; this app is ${schemaVersion}` });

  const stmts = [];
  for (const name of DATA_ENTITIES) {
    const ent = ENTITIES[name];
    const rows = data.tables[ent.table] ?? [];
    if (!Array.isArray(rows)) throw new HttpError(400, 'invalid', { message: `${ent.table} must be a list` });
    const cols = allCols(ent);
    const clean = rows.map((row, i) => {
      if (!row || typeof row !== 'object') throw new HttpError(400, 'invalid', { message: `${ent.table} row ${i + 1} is malformed` });
      const out = {};
      for (const c of cols) {
        let v = row[c];
        if (ent.json.includes(c) && v != null && typeof v !== 'string') v = JSON.stringify(v);
        out[c] = v === undefined ? null : v;
      }
      for (const c of ent.pk) if (out[c] == null || out[c] === '') throw new HttpError(400, 'invalid', { message: `${ent.table} row ${i + 1} has no ${c}` });
      if (!Number.isInteger(out.version) || out.version < 1) out.version = 1;
      return out;
    });
    stmts.push(db.prepare(`DELETE FROM ${ent.table}`));
    if (clean.length) {
      const select = cols.map((c) => `json_extract(j.value, '$.${c}')`).join(', ');
      stmts.push(db.prepare(`INSERT INTO ${ent.table} (${cols.join(', ')}) SELECT ${select} FROM json_each(?) AS j`).bind(JSON.stringify(clean)));
    }
  }
  stmts.push(db.prepare('DELETE FROM change_log'));
  stmts.push(
    db.prepare("INSERT INTO change_log (at, by, entity, entity_id, action, op, before, after) VALUES (?, ?, 'all', 'all', 'import', 'none', NULL, NULL)")
      .bind(new Date().toISOString(), user),
  );
  try {
    await db.batch(stmts); // all or nothing
  } catch (err) {
    throw new HttpError(400, 'invalid', { message: `import failed and nothing was changed: ${String(err.message || err).slice(0, 200)}` });
  }
  return { imported: true };
}

async function seedStarter({ db, user }) {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM recipes').first();
  if (count.n > 0) throw new HttpError(409, 'not_empty', { message: 'Starter recipes load only into an empty library.' });
  const created = [];
  for (const r of STARTER_RECIPES) created.push(await insertRow(db, user, 'recipe', { id: newId(), ...r }, { action: 'seed' }));
  return { recipes: created.length };
}

export const routes = [
  ['GET', /^\/api\/state$/, getState],
  ['POST', /^\/api\/recipes$/, createRecipe],
  ['PUT', new RegExp(`^/api/recipes/${ID}$`), updateRecipe],
  ['DELETE', new RegExp(`^/api/recipes/${ID}$`), deleteRecipe],
  ['POST', /^\/api\/meals$/, createMeal],
  ['PUT', new RegExp(`^/api/meals/${ID}$`), updateMeal],
  ['DELETE', new RegExp(`^/api/meals/${ID}$`), deleteMeal],
  ['PUT', /^\/api\/day-flags\/(\d{4}-\d{2}-\d{2})$/, putDayFlag],
  ['POST', /^\/api\/trips$/, createTrip],
  ['PUT', new RegExp(`^/api/trips/${ID}$`), updateTrip],
  ['DELETE', new RegExp(`^/api/trips/${ID}$`), deleteTrip],
  ['POST', new RegExp(`^/api/trips/${ID}/lock$`), lockTrip],
  ['PUT', new RegExp(`^/api/trips/${ID}/marks/${KEY}$`), putMark],
  ['POST', new RegExp(`^/api/trips/${ID}/extras$`), createExtra],
  ['PUT', new RegExp(`^/api/extras/${ID}$`), updateExtra],
  ['DELETE', new RegExp(`^/api/extras/${ID}$`), deleteExtra],
  ['PATCH', new RegExp(`^/api/trips/${ID}/snapshot/${KEY}$`), patchSnapshot],
  ['PUT', /^\/api\/settings\/([a-z_]{1,40})$/, putSetting],
  ['POST', /^\/api\/suggest$/, suggest],
  ['GET', /^\/api\/history$/, history],
  ['POST', /^\/api\/undo\/(\d{1,12})$/, undoChange],
  ['GET', /^\/api\/export$/, exportAll],
  ['POST', /^\/api\/import$/, importAll],
  ['POST', /^\/api\/seed-starter$/, seedStarter],
  ['GET', /^\/api\/inbox$/, getInbox],
  ['POST', /^\/api\/inbox\/preview$/, previewInbox],
  ['POST', /^\/api\/inbox\/decide$/, decideInbox],
];

export { DEFAULT_SETTINGS };
