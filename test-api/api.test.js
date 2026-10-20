// API integration tests: real Worker code, local SQLite-backed D1, real HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalServer } from '../scripts/local-server.js';
import { SCHEMA_VERSION } from '../src/schema.js';

const A = 'person-a@example.com';
const B = 'person-b@example.com';
let base;
let server;
let dir;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'meal-api-'));
  ({ server } = createLocalServer({ dbPath: path.join(dir, 'test.sqlite'), env: { DEV_AUTH_EMAIL: A } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method, p, body, { user = A, headers = {} } = {}) {
  const h = { 'X-Dev-User': user, ...headers };
  if (method !== 'GET') {
    h['Content-Type'] ??= 'application/json';
    h['X-Requested-With'] ??= 'meal-planner';
  }
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const state = (from = '2026-10-19', to = '2026-11-01') => call('GET', `/api/state?from=${from}&to=${to}`);

test('fresh database self-migrates on first request and starts empty', async () => {
  const r = await state();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.data.me.email, A);
  assert.deepEqual(r.data.recipes, []);
  assert.deepEqual(r.data.settings.stores, ['Giant Eagle', "Lucky's"]);
});

test('CSRF and content-type protections reject bad mutations', async () => {
  assert.equal((await call('POST', '/api/seed-starter', {}, { headers: { 'X-Requested-With': '' } })).status, 403);
  assert.equal((await call('POST', '/api/seed-starter', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('POST', '/api/seed-starter', {}, { headers: { Origin: 'https://evil.example.com' } })).status, 403);
  assert.equal((await state()).data.recipes.length, 0, 'nothing was written');
});

test('seed starter recipes once', async () => {
  assert.equal((await call('POST', '/api/seed-starter', {})).status, 200);
  assert.equal((await call('POST', '/api/seed-starter', {})).status, 409);
  assert.equal((await state()).data.recipes.length, 8);
});

let recipes;
let mealTue;
let mealThu;

test('recipe CRUD with validation', async () => {
  const bad = await call('POST', '/api/recipes', { name: '', base_servings: 2 });
  assert.equal(bad.status, 400);
  const created = await call('POST', '/api/recipes', {
    name: 'Test omelet', base_servings: 1, tags: ['workday-easy'],
    ingredients: [{ qty: 3, unit: '', name: 'eggs', section: 'Dairy & Eggs' }],
  });
  assert.equal(created.status, 200);
  const id = created.data.recipe.id;
  const upd = await call('PUT', `/api/recipes/${id}`, { rating: 4, expected_version: 1 });
  assert.equal(upd.data.recipe.version, 2);
  assert.equal(upd.data.recipe.rating, 4);
  const badTag = await call('PUT', `/api/recipes/${id}`, { tags: ['spicy'], expected_version: 2 });
  assert.equal(badTag.status, 400);
  const del = await call('DELETE', `/api/recipes/${id}`, { expected_version: 2 });
  assert.equal(del.status, 200);
  recipes = (await state()).data.recipes;
});

test('plan meals and preferred days', async () => {
  const taco = recipes.find((r) => r.name === 'Turkey taco bowls');
  const chili = recipes.find((r) => r.name === 'Turkey and bean chili');
  const flag = await call('PUT', '/api/day-flags/2026-10-21', { preferred: true, expected_version: 0 });
  assert.equal(flag.status, 200);
  const again = await call('PUT', '/api/day-flags/2026-10-21', { preferred: false, expected_version: 0 });
  assert.equal(again.status, 409, 'creating an existing flag is a conflict');
  mealTue = (await call('POST', '/api/meals', { date: '2026-10-21', recipe_id: taco.id, servings: 2 })).data.meal;
  mealThu = (await call('POST', '/api/meals', { date: '2026-10-23', recipe_id: chili.id })).data.meal;
  assert.equal(mealThu.servings, 2, 'default servings');
  assert.equal((await call('POST', '/api/meals', { date: '2026-13-01', recipe_id: taco.id })).status, 400);
  assert.equal((await call('POST', '/api/meals', { date: '2026-10-22', recipe_id: 'nope' })).status, 400);
  const s = await state();
  assert.equal(s.data.meals.length, 2);
  assert.equal(s.data.day_flags[0].preferred, 1);
});

test('undoing a starter recipe that is on the plan is refused', async () => {
  const hist = (await call('GET', '/api/history?limit=200')).data.entries;
  const taco = recipes.find((r) => r.name === 'Turkey taco bowls');
  const seedEntry = hist.find((e) => e.entity === 'recipe' && e.action === 'seed' && e.entity_id === taco.id);
  const r = await call('POST', `/api/undo/${seedEntry.id}`, {});
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'in_use');
});

test('two people editing the same meal: second save gets a conflict, nothing lost', async () => {
  const a = await call('PUT', `/api/meals/${mealTue.id}`, { servings: 4, expected_version: 1 }, { user: A });
  assert.equal(a.status, 200);
  const b = await call('PUT', `/api/meals/${mealTue.id}`, { servings: 3, expected_version: 1 }, { user: B });
  assert.equal(b.status, 409);
  assert.equal(b.data.error, 'conflict');
  assert.equal(b.data.current.servings, 4);
  assert.equal(b.data.changed_by, A);
  // "Use mine": resend with the current version.
  const b2 = await call('PUT', `/api/meals/${mealTue.id}`, { servings: 3, expected_version: b.data.current.version }, { user: B });
  assert.equal(b2.status, 200);
  assert.equal(b2.data.meal.servings, 3);
  mealTue = b2.data.meal;
});

test('undo reverts the latest change, and refuses when the row changed since', async () => {
  const hist = (await call('GET', '/api/history?limit=5')).data.entries;
  const last = hist[0];
  assert.equal(last.entity, 'meal');
  assert.equal(last.by, B);
  const u = await call('POST', `/api/undo/${last.id}`, {});
  assert.equal(u.status, 200);
  let meal = (await state()).data.meals.find((m) => m.id === mealTue.id);
  assert.equal(meal.servings, 4, 'back to A\'s value');
  // The older change (A's 2->4) can't be undone now: the row has moved on.
  const older = hist.find((e) => e.entity === 'meal' && e.by === A && e.action === 'update');
  const refused = await call('POST', `/api/undo/${older.id}`, {});
  assert.equal(refused.status, 409);
  // Undo the undo restores 3.
  const undoEntry = (await call('GET', '/api/history?limit=1')).data.entries[0];
  assert.equal(undoEntry.action, 'undo');
  assert.equal((await call('POST', `/api/undo/${undoEntry.id}`, {})).status, 200);
  meal = (await state()).data.meals.find((m) => m.id === mealTue.id);
  assert.equal(meal.servings, 3);
  mealTue = meal;
});

test('undo of a delete restores the row', async () => {
  const m = (await call('POST', '/api/meals', { date: '2026-10-25', recipe_id: recipes[0].id })).data.meal;
  assert.equal((await call('DELETE', `/api/meals/${m.id}`, { expected_version: 1 })).status, 200);
  const del = (await call('GET', '/api/history?limit=1')).data.entries[0];
  assert.equal(del.op, 'delete');
  assert.equal((await call('POST', `/api/undo/${del.id}`, {})).status, 200);
  const back = (await state()).data.meals.find((x) => x.id === m.id);
  assert.ok(back);
  assert.equal(back.version, 2);
  await call('DELETE', `/api/meals/${m.id}`, { expected_version: 2 });
});

let trip;

test('trips: create, overlap rejected, marks, extras', async () => {
  const t = await call('POST', '/api/trips', { store: 'Giant Eagle', pickup_date: '2026-10-20' });
  assert.equal(t.status, 200);
  trip = t.data.trip;
  assert.equal(trip.end_date, '2026-10-26');
  const overlap = await call('POST', '/api/trips', { store: "Lucky's", pickup_date: '2026-10-24' });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.data.error, 'overlap');
  const key = 'ground turkey|mass|';
  const mark = await call('PUT', `/api/trips/${trip.id}/marks/${encodeURIComponent(key)}`, { have: true, have_reason: 'in freezer', expected_version: 0 });
  assert.equal(mark.status, 200);
  const extra = await call('POST', `/api/trips/${trip.id}/extras`, { text: 'paper towels' });
  assert.equal(extra.status, 200);
  const s = await state();
  const st = s.data.trips.find((x) => x.id === trip.id);
  assert.equal(st.marks[0].have_reason, 'in freezer');
  assert.equal(st.extras[0].text, 'paper towels');
});

test('lock writes the snapshot once; locking again does not duplicate', async () => {
  const lock = await call('POST', `/api/trips/${trip.id}/lock`, { expected_version: 1 });
  assert.equal(lock.status, 200);
  assert.ok(lock.data.items > 5);
  let st = (await state()).data.trips.find((x) => x.id === trip.id);
  const count = st.snapshot.length;
  assert.equal(count, lock.data.items);
  assert.equal(st.status, 'locked');
  assert.ok(!st.snapshot.some((i) => i.item_key === 'ground turkey|mass|'), '"have" items are not in the snapshot');
  assert.ok(!st.snapshot.some((i) => i.name === 'olive oil'), 'staples (olive oil, butter) default to have');
  const again = await call('POST', `/api/trips/${trip.id}/lock`, { expected_version: 1 });
  assert.equal(again.status, 200);
  assert.equal(again.data.already_locked, true);
  // Parallel double-tap.
  await Promise.all([call('POST', `/api/trips/${trip.id}/lock`, { expected_version: 2 }), call('POST', `/api/trips/${trip.id}/lock`, { expected_version: 2 })]);
  st = (await state()).data.trips.find((x) => x.id === trip.id);
  assert.equal(st.snapshot.length, count);
  assert.equal((await call('PUT', `/api/trips/${trip.id}`, { end_date: '2026-10-30', expected_version: st.version })).status, 409, 'locked dates are fixed');
  const lockLog = (await call('GET', '/api/history?limit=20')).data.entries.find((e) => e.action === 'lock');
  assert.equal((await call('POST', `/api/undo/${lockLog.id}`, {})).status, 409, 'lock is not undoable');
});

test('snapshot purchase status can change; quantities cannot', async () => {
  const st = (await state()).data.trips.find((x) => x.id === trip.id);
  const item = st.snapshot[0];
  const r = await call('PATCH', `/api/trips/${trip.id}/snapshot/${encodeURIComponent(item.item_key)}`, { purchase: 'substituted', sub_note: 'store brand', qty: 999, expected_version: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.item.purchase, 'substituted');
  assert.equal(r.data.item.qty, item.qty);
  assert.equal((await call('PATCH', `/api/trips/${trip.id}/snapshot/${encodeURIComponent(item.item_key)}`, { purchase: 'stolen', expected_version: 2 })).status, 400);
});

test('suggest returns tentative proposals without saving', async () => {
  const before = (await state('2026-10-26', '2026-11-01')).data.meals.filter((m) => m.date >= '2026-10-26');
  const r = await call('POST', '/api/suggest', { week_start: '2026-10-26' });
  assert.equal(r.status, 200);
  assert.equal(r.data.proposals.length, 2);
  assert.ok(r.data.proposals.every((p) => p.status === 'tentative'));
  const afterMeals = (await state('2026-10-26', '2026-11-01')).data.meals.filter((m) => m.date >= '2026-10-26');
  assert.equal(afterMeals.length, before.length);
});

test('settings validation and versioning', async () => {
  assert.equal((await call('PUT', '/api/settings/stores', { value: ['Giant Eagle', "Lucky's", 'Costco'], expected_version: 0 })).status, 200);
  assert.equal((await call('PUT', '/api/settings/stores', { value: [], expected_version: 1 })).status, 400);
  assert.equal((await call('PUT', '/api/settings/default_servings', { value: 99, expected_version: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/settings/bogus', { value: 1, expected_version: 0 })).status, 404);
  assert.deepEqual((await state()).data.settings.stores, ['Giant Eagle', "Lucky's", 'Costco']);
});

test('export then import round-trips all data', async () => {
  const exp = await call('GET', '/api/export');
  assert.equal(exp.status, 200);
  assert.equal(exp.data.schema_version, SCHEMA_VERSION);
  const snapshotBefore = await state();
  // Change something, then restore from the export.
  await call('POST', '/api/meals', { date: '2026-10-22', recipe_id: recipes[1].id });
  assert.equal((await call('POST', '/api/import', { data: exp.data })).status, 400, 'confirm required');
  const imp = await call('POST', '/api/import', { confirm: 'REPLACE', data: exp.data });
  assert.equal(imp.status, 200);
  const after = await state();
  const strip = (s) => JSON.stringify({ r: s.recipes, m: s.meals, d: s.day_flags, t: s.trips, st: s.settings });
  assert.equal(strip(after.data), strip(snapshotBefore.data));
  const bad = await call('POST', '/api/import', { confirm: 'REPLACE', data: { tables: { meals: [{ date: 'x' }] } } });
  assert.equal(bad.status, 400, 'row without id is rejected');
  assert.equal(strip((await state()).data), strip(snapshotBefore.data), 'failed import changes nothing');
});

test('unknown routes 404; bad JSON 400', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const res = await fetch(`${base}/api/meals`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meal-planner', 'X-Dev-User': A }, body: '{oops' });
  assert.equal(res.status, 400);
});

test('static assets get security headers; SPA fallback serves index.html', async () => {
  const res = await fetch(`${base}/some/deep/link`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(await res.text(), /<title>Dinners<\/title>/);
});
