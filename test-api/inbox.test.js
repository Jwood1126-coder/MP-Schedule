// Alfred inbox: preview and decide (paste and Notion), against the real
// Worker code with a local SQLite-backed D1. Notion is mocked by wrapping
// global fetch for api.notion.com only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalServer } from '../scripts/local-server.js';

const A = 'person-a@example.com';
const DB_ID = '9fc2e5b1516f4212852510241783c0ad';
const PAGE_ID = '11111111222233334444555555555555';
let base;
let server;
let dir;
const realFetch = globalThis.fetch;
const notion = { pages: {}, patches: [], fail: false, failPatch: false };
const rev = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'meal-inbox-'));
  ({ server } = createLocalServer({
    dbPath: path.join(dir, 'test.sqlite'),
    env: { DEV_AUTH_EMAIL: A, NOTION_TOKEN: 'secret_x', NOTION_INBOX_DB: DB_ID },
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.notion.com/')) return realFetch(url, opts);
    if (notion.fail) throw new Error('down');
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/query')) return reply({ results: Object.values(notion.pages).filter((p) => p.status === 'Proposed').map(pageJson) });
    const m = u.match(/\/(pages|blocks)\/([0-9a-f]{32})/);
    const p = m && notion.pages[m[2]];
    if (!p) return reply({ code: 'object_not_found' }, 404);
    if (m[1] === 'blocks') return reply({ results: [{ type: 'code', code: { rich_text: [{ plain_text: p.text }] } }] });
    if (opts.method === 'PATCH') {
      if (notion.failPatch) throw new Error('down');
      const body = JSON.parse(opts.body);
      notion.patches.push(body);
      p.status = body.properties.Status.select.name;
      return reply(pageJson(p));
    }
    return reply(pageJson(p));
  };
});

after(() => {
  globalThis.fetch = realFetch;
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function pageJson(p) {
  return {
    id: p.id,
    url: 'https://www.notion.so/p',
    parent: { type: 'database_id', database_id: DB_ID },
    properties: { Name: { title: [{ plain_text: 'Week of Nov 9' }] }, 'Week of': { date: { start: p.week } }, Status: { select: { name: p.status } } },
  };
}

async function call(method, p, body) {
  const h = { 'X-Dev-User': A };
  if (method !== 'GET') Object.assign(h, { 'Content-Type': 'application/json', 'X-Requested-With': 'meal-planner' });
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const state = (from, to) => call('GET', `/api/state?from=${from}&to=${to}`);

const PLAN = {
  week_of: '2026-11-09',
  message: 'Two easy dinners.',
  busy_days: ['2026-11-10', '2026-11-12'],
  dinners: [
    { date: '2026-11-10', recipe: 'turkey and bean chili', servings: 4, note: 'lunch tomorrow', alternate: 'Sheet-pan salmon' },
    { date: '2026-11-12', recipe: 'Sheet-pan salmon', servings: 2 },
    { date: '2026-11-14', recipe: 'Black bean quesadillas' },
  ],
  new_recipes: [{
    name: 'Sheet-pan salmon', base_servings: 2, active_min: 10, total_min: 25, pans: 1, tags: ['workday-easy'],
    ingredients: ['1 | lb | salmon fillets | Meat & Seafood', '1 | | lemon | Produce | optional'],
  }],
  extras: ['milk', 'bananas'],
};
const text = 'From Alfred:\n```json\n' + JSON.stringify(PLAN, null, 2) + '\n```';

test('setup: starter recipes', async () => {
  assert.equal((await call('POST', '/api/seed-starter', {})).status, 200);
});

test('preview parses and resolves without saving', async () => {
  const r = await call('POST', '/api/inbox/preview', { text });
  assert.equal(r.status, 200);
  const p = r.data.proposal;
  assert.match(p.id, /^paste-[0-9a-f]{16}$/);
  assert.equal(p.revision, rev(text), 'revision is the hash of the text as read');
  assert.deepEqual(p.errors, []);
  assert.ok(p.resolution.dinners[0].main.id, 'chili is in the library');
  assert.equal(p.resolution.dinners[1].main.new, 0);
  assert.equal((await state('2026-11-09', '2026-11-15')).data.meals.length, 0);
});

test('send back applies nothing and can still be accepted later', async () => {
  const r = await call('POST', '/api/inbox/decide', { source: 'paste', text, revision: rev(text), outcome: 'send_back', note: 'more fish' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.applied, { meals: 0, recipes: 0, busy_days: 0, extras: 0 });
  assert.equal((await state('2026-11-09', '2026-11-15')).data.meals.length, 0);
});

test('accept applies chosen dinners, new recipes, busy days and extras; second accept is refused', async () => {
  const r = await call('POST', '/api/inbox/decide', {
    source: 'paste', text, revision: rev(text), outcome: 'accept', id: 'ignored-client-id',
    dinners: [{ index: 0, choice: 'main' }, { index: 1, choice: 'main' }, { index: 2, choice: 'skip' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outcome, 'partial');
  assert.deepEqual(r.data.applied, { meals: 2, recipes: 1, busy_days: 2, extras: 2 });
  assert.match(r.data.summary, /Skipped: Sat Nov 14/);
  assert.match(r.data.summary, /Library: .*Sheet-pan salmon/);

  const s = (await state('2026-11-09', '2026-11-15')).data;
  assert.equal(s.meals.length, 2);
  assert.ok(s.meals.every((m) => m.status === 'planned'));
  assert.equal(s.meals.find((m) => m.date === '2026-11-10').servings, 4);
  assert.deepEqual(s.day_flags.filter((f) => f.preferred).map((f) => f.date).sort(), ['2026-11-10', '2026-11-12']);
  assert.equal(s.recipes.filter((x) => x.name === 'Sheet-pan salmon').length, 1);
  const trip = s.trips.find((t) => t.start_date === '2026-11-09');
  assert.ok(trip, 'a trip was created for the week');
  assert.deepEqual(trip.extras.map((e) => e.text).sort(), ['bananas', 'milk']);

  const again = await call('POST', '/api/inbox/decide', {
    source: 'paste', text, revision: rev(text), outcome: 'accept',
    dinners: [{ index: 0, choice: 'main' }, { index: 1, choice: 'main' }, { index: 2, choice: 'skip' }],
  });
  assert.equal(again.status, 200, 'a repeat of the same decision returns the recorded result');
  assert.equal(again.data.already, true);
  assert.equal(again.data.outcome, 'partial');
  assert.equal((await state('2026-11-09', '2026-11-15')).data.meals.length, 2, 'nothing added twice');
  const other = await call('POST', '/api/inbox/decide', { source: 'paste', text, revision: rev(text), outcome: 'decline' });
  assert.equal(other.status, 409, 'a different outcome after a final decision is refused');
  assert.equal(other.data.error, 'already_decided');
  assert.equal(other.data.outcome, 'partial');

  const hist = (await call('GET', '/api/history?limit=20')).data.entries;
  assert.ok(hist.filter((e) => e.action === 'alfred' && e.entity === 'meal').length === 2, 'meals are in History');
});

test('undo removes a dinner Alfred added', async () => {
  const hist = (await call('GET', '/api/history?limit=20')).data.entries;
  const entry = hist.find((e) => e.action === 'alfred' && e.entity === 'meal' && e.after.date === '2026-11-10');
  assert.equal((await call('POST', `/api/undo/${entry.id}`, {})).status, 200);
  assert.equal((await state('2026-11-09', '2026-11-15')).data.meals.length, 1);
});

test('a different plan reuses library recipes and does not duplicate an existing dinner', async () => {
  const plan2 = {
    week_of: '2026-11-09',
    dinners: [
      { date: '2026-11-12', recipe: 'SHEET-PAN SALMON', servings: 2 },
      { date: '2026-11-13', recipe: 'Sheet-pan salmon' },
    ],
    new_recipes: [{ ...PLAN.new_recipes[0] }],
    extras: ['Milk', 'eggs'],
  };
  const r = await call('POST', '/api/inbox/decide', { source: 'paste', text: JSON.stringify(plan2), revision: rev(JSON.stringify(plan2)), outcome: 'accept' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.applied.recipes, 0, 'library recipe reused');
  assert.equal(r.data.applied.meals, 1, 'existing Thu dinner not duplicated');
  assert.equal(r.data.applied.extras, 1, 'milk already on the trip');
  assert.ok(r.data.warnings.some((w) => /already on the plan/.test(w)));
  const s = (await state('2026-11-09', '2026-11-15')).data;
  assert.equal(s.recipes.filter((x) => x.name === 'Sheet-pan salmon').length, 1);
});

test('accept with an unknown recipe is refused with a readable error', async () => {
  const bad = { week_of: '2026-11-16', dinners: [{ date: '2026-11-17', recipe: 'Mystery stew' }] };
  const r = await call('POST', '/api/inbox/decide', { source: 'paste', text: JSON.stringify(bad), revision: rev(JSON.stringify(bad)), outcome: 'accept' });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /Mystery stew/);
});

test('Notion: inbox lists Proposed pages; accept writes the status and reply back', async () => {
  const notionPlan = { week_of: '2026-11-23', busy_days: ['2026-11-24'], dinners: [{ date: '2026-11-24', recipe: 'Lentil vegetable soup', servings: 4 }] };
  notion.pages[PAGE_ID] = { id: PAGE_ID, week: '2026-11-23', status: 'Proposed', text: JSON.stringify(notionPlan) };
  const inbox = await call('GET', '/api/inbox');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.configured, true);
  assert.equal(inbox.data.proposals.length, 1);
  assert.deepEqual(inbox.data.proposals[0].errors, []);

  const r = await call('POST', '/api/inbox/decide', { source: 'notion', id: PAGE_ID, revision: inbox.data.proposals[0].revision, outcome: 'accept', note: 'Thanks!' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outcome, 'accept');
  const patch = notion.patches.at(-1);
  assert.equal(patch.properties.Status.select.name, 'Accepted');
  assert.match(patch.properties.Reply.rich_text.map((t) => t.text.content).join(''), /Accepted: Tue Nov 24 · Lentil vegetable soup \(4\)[\s\S]*Note: Thanks!/);
  assert.equal((await call('GET', '/api/inbox')).data.proposals.length, 0, 'decided plans leave the inbox');

  assert.equal(r.data.writeback_status, 'done');
  const again = await call('POST', '/api/inbox/decide', { source: 'notion', id: PAGE_ID, revision: inbox.data.proposals[0].revision, outcome: 'accept' });
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
  assert.equal(notion.patches.length, 1, 'a repeat does not write to Notion again');
});

test('Notion down: inbox reports an error; a failed write-back is stored and retried from the stored payload', async () => {
  notion.fail = true;
  const inbox = await call('GET', '/api/inbox');
  assert.equal(inbox.status, 200);
  assert.ok(inbox.data.error);
  notion.fail = false;
  const id2 = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
  const t2 = JSON.stringify({ week_of: '2026-11-30', dinners: [{ date: '2026-12-01', recipe: 'Lentil vegetable soup' }] });
  notion.pages[id2] = { id: id2, week: '2026-11-30', status: 'Proposed', text: t2 };
  notion.failPatch = true;
  const before = notion.patches.length;
  const r = await call('POST', '/api/inbox/decide', { source: 'notion', id: id2, revision: rev(t2), outcome: 'decline', note: 'not this week' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.warnings.includes('notion_writeback_failed'));
  assert.equal(r.data.writeback_status, 'failed');
  assert.equal(notion.patches.length, before);
  const stillDown = await call('GET', '/api/inbox');
  const rd = stillDown.data.recent_decisions.find((d) => d.proposal_id === id2);
  assert.equal(rd.writeback_status, 'failed', 'still failing while Notion rejects writes');

  notion.failPatch = false;
  const recovered = await call('GET', '/api/inbox');
  assert.equal(recovered.data.recent_decisions.find((d) => d.proposal_id === id2).writeback_status, 'done');
  const patch = notion.patches.at(-1);
  assert.equal(patch.properties.Status.select.name, 'Declined');
  const reply = patch.properties.Reply.rich_text.map((x) => x.text.content).join('');
  assert.match(reply, /Declined \(week of 2026-11-30\)[\s\S]*Note: not this week/, 'the stored payload is re-sent');
  assert.match(patch.properties['Decided by'].rich_text[0].text.content, /person-a@example\.com · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
});

test('Notion: an edited plan after review is refused with plan_changed and nothing is written', async () => {
  const id3 = 'bbbbbbbbccccddddeeeeffffffffffff';
  const v1 = JSON.stringify({ week_of: '2026-12-07', dinners: [{ date: '2026-12-08', recipe: 'Lentil vegetable soup' }] });
  notion.pages[id3] = { id: id3, week: '2026-12-07', status: 'Proposed', text: v1 };
  const seen = (await call('GET', '/api/inbox')).data.proposals.find((p) => p.id === id3);
  assert.equal(seen.revision, rev(v1));
  notion.pages[id3].text = JSON.stringify({ week_of: '2026-12-07', dinners: [{ date: '2026-12-09', recipe: 'Turkey taco bowls' }] });
  const patches = notion.patches.length;
  const r = await call('POST', '/api/inbox/decide', { source: 'notion', id: id3, revision: seen.revision, outcome: 'accept' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'plan_changed');
  assert.equal((await state('2026-12-07', '2026-12-13')).data.meals.filter((m) => m.date >= '2026-12-07' && m.date <= '2026-12-13').length, 0, 'no dinners added');
  assert.equal(notion.patches.length, patches, 'Notion untouched');
  const fresh = (await call('GET', '/api/inbox')).data.proposals.find((p) => p.id === id3);
  assert.notEqual(fresh.revision, seen.revision, 'the new version is offered for review');
  const missing = await call('POST', '/api/inbox/decide', { source: 'notion', id: id3, outcome: 'accept' });
  assert.equal(missing.data.error, 'plan_changed', 'a decision without a reviewed revision is refused too');
});

test('two simultaneous accepts of the same revision add one set of dinners', async () => {
  const t4 = JSON.stringify({ week_of: '2027-01-18', dinners: [{ date: '2027-01-19', recipe: 'Turkey taco bowls' }, { date: '2027-01-21', recipe: 'Lentil vegetable soup' }] });
  const body = { source: 'paste', text: t4, revision: rev(t4), outcome: 'accept' };
  const [x, y] = await Promise.all([call('POST', '/api/inbox/decide', body), call('POST', '/api/inbox/decide', body)]);
  assert.equal(x.status, 200, JSON.stringify(x.data));
  assert.equal(y.status, 200, JSON.stringify(y.data));
  assert.equal([x, y].filter((r) => r.data.already).length, 1, 'one applied, one reported as already accepted');
  assert.equal((await state('2027-01-18', '2027-01-24')).data.meals.filter((m) => m.date >= '2027-01-18' && m.date <= '2027-01-24').length, 2);
});

test('accepting a plan with no extras still creates a grocery trip covering the dinners', async () => {
  const t5 = JSON.stringify({ week_of: '2027-01-04', dinners: [{ date: '2027-01-06', recipe: 'Turkey taco bowls' }], extras: [] });
  const r = await call('POST', '/api/inbox/decide', { source: 'paste', text: t5, revision: rev(t5), outcome: 'accept', today: '2026-10-20' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.trip_id, 'trip_id returned');
  const trip = (await state('2027-01-04', '2027-01-10')).data.trips.find((t) => t.id === r.data.trip_id);
  assert.ok(trip);
  assert.equal(trip.start_date, '2027-01-04');
  assert.equal(trip.end_date, '2027-01-10');
  assert.equal(trip.pickup_date, '2027-01-04');
  assert.equal(trip.status, 'open');
});

test('a plan for an already-shopped week warns and leaves that trip alone', async () => {
  const trip = (await call('POST', '/api/trips', { store: 'Giant Eagle', pickup_date: '2027-01-11', start_date: '2027-01-11', end_date: '2027-01-17' })).data.trip;
  assert.ok(trip, 'trip created');
  assert.equal((await call('POST', `/api/trips/${trip.id}/lock`, { expected_version: trip.version })).status, 200);
  const t6 = JSON.stringify({ week_of: '2027-01-11', dinners: [{ date: '2027-01-12', recipe: 'Turkey taco bowls' }], extras: ['milk'] });
  const r = await call('POST', '/api/inbox/decide', { source: 'paste', text: t6, revision: rev(t6), outcome: 'accept', today: '2026-10-20' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.trip_id, null);
  assert.ok(r.data.warnings.some((w) => /already shopped/.test(w)), JSON.stringify(r.data.warnings));
  const after = (await state('2027-01-11', '2027-01-17')).data.trips.find((t) => t.id === trip.id);
  assert.equal(after.status, 'locked');
  assert.equal(after.extras.length, 0);
});
