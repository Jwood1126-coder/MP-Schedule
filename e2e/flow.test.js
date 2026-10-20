// End-to-end: the real UI at iPhone size against the local server.
// Covers planning, the merged list, "have", extras, lock, a swap after
// shopping, a two-person conflict, and a failed save that recovers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalServer } from '../scripts/local-server.js';
import { loadPlaywright } from './playwright.js';
import { addDays, localToday, weekStart } from '../public/js/core/dates.js';

const A = 'person-a@example.com';
const B = 'person-b@example.com';
let server;
let base;
let dir;
let browser;
let pw;
const consoleErrors = [];

const today = localToday();
const d1 = addDays(today, 1);
const d2 = addDays(today, 3);

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'meal-e2e-'));
  ({ server } = createLocalServer({ dbPath: path.join(dir, 'e2e.sqlite'), env: { DEV_AUTH_EMAIL: A } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  pw = await loadPlaywright();
  browser = await pw.chromium.launch(pw.launchOptions);
});

after(async () => {
  await browser?.close();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function phone(user = A) {
  const { defaultBrowserType, ...device } = pw.devices['iPhone 13'];
  const context = await browser.newContext({ ...device, extraHTTPHeaders: { 'X-Dev-User': user } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  return { context, page };
}

async function api(p) {
  const res = await fetch(base + p, { headers: { 'X-Dev-User': A } });
  return res.json();
}

const day = (page, date) => page.locator(`section.day[data-date="${date}"]`);

async function openWeek(page, date) {
  await page.goto(`${base}/#/plan?w=${weekStart(date)}`);
  await day(page, date).waitFor();
}

async function addDinner(page, date, recipe) {
  await openWeek(page, date);
  await day(page, date).getByRole('button', { name: '+ Add dinner' }).click();
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(recipe) }).click();
  await day(page, date).getByText(recipe).waitFor();
}

let phoneA;

test('plan two dinners, one on a preferred day', async () => {
  phoneA = await phone(A);
  const { page } = phoneA;
  await page.goto(`${base}/#/recipes`);
  await page.getByRole('button', { name: 'Load starter recipes' }).click();
  await page.getByText('Turkey taco bowls').waitFor();

  await openWeek(page, d1);
  await day(page, d1).getByRole('button', { name: 'Busy day' }).click();
  await day(page, d1).getByRole('button', { name: '✓ Busy day' }).waitFor();
  await addDinner(page, d1, 'Turkey taco bowls');
  await addDinner(page, d2, 'Turkey and bean chili');
  const state = await api(`/api/state?from=${today}&to=${addDays(today, 7)}`);
  assert.equal(state.meals.length, 2);
  assert.equal(state.day_flags.find((f) => f.date === d1).preferred, 1);
});

test('grocery list merges ingredients; "have" and extras work', async () => {
  const { page } = phoneA;
  await page.goto(`${base}/#/groceries`);
  await page.getByRole('button', { name: 'Plan a grocery trip' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  const list = page.getByTestId('buy-list');
  const turkey = list.locator('.item', { hasText: 'ground turkey' });
  await turkey.waitFor();
  assert.match(await turkey.innerText(), /2 lb/);
  assert.match(await turkey.innerText(), /2 dinners/);
  // Mark black beans as "have".
  const beans = list.locator('.item', { hasText: 'black beans' });
  await beans.getByRole('button', { name: /dinners ▾/ }).click();
  await beans.getByRole('button', { name: 'Have it' }).click();
  await page.getByTestId('have-list').getByText('black beans').waitFor();
  assert.equal(await list.locator('.item', { hasText: 'black beans' }).count(), 0);
  // Staples are in their own group.
  await page.getByTestId('staples').getByText('chili powder').waitFor();
  // Tick one into the cart.
  await turkey.getByRole('checkbox').check();
  await page.getByTestId('cart-progress').getByText(/^1 of/).waitFor();
  // Extra item.
  await page.getByPlaceholder('Add item: paper towels, milk…').fill('paper towels');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('extras').getByText('paper towels').waitFor();
});

test('lock the list, swap a dinner, and see changes since shopping', async () => {
  const { page } = phoneA;
  await page.getByRole('button', { name: 'I built the cart: lock list' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lock list' }).click();
  await page.getByTestId('snapshot').waitFor();
  const snap = await page.getByTestId('snapshot').innerText();
  assert.match(snap, /ground turkey/);
  assert.doesNotMatch(snap, /black beans/, '"have" items were not bought');

  await openWeek(page, d2);
  const chili = day(page, d2).locator('.meal-card');
  await chili.getByRole('button', { name: 'Swap' }).click();
  const guard = page.getByRole('dialog');
  await guard.getByText('Groceries already bought').waitFor();
  assert.match(await guard.innerText(), /kidney beans/);
  await guard.getByRole('button', { name: 'Swap anyway' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Lentil vegetable soup/ }).click();
  await day(page, d2).getByText('Lentil vegetable soup').waitFor();

  await page.goto(`${base}/#/groceries`);
  const changes = page.getByTestId('changes');
  await changes.waitFor();
  const text = await changes.innerText();
  assert.match(text, /Still need/);
  assert.match(text, /dry brown lentils/);
  assert.match(text, /Bought but no longer planned/);
  assert.match(text, /kidney beans/);
  assert.match(text, /was for Turkey and bean chili/);
});

test('two phones edit the same dinner: the second gets a conflict prompt', async () => {
  const phoneB = await phone(B);
  const a = phoneA.page;
  const b = phoneB.page;
  await openWeek(a, d1);
  await openWeek(b, d1);
  const servings = (page) => day(page, d1).locator('.stepper .val');
  assert.equal(await servings(b).innerText(), '2');
  await day(a, d1).getByRole('button', { name: 'More servings' }).click();
  await servings(a).getByText('3').waitFor();
  // Phone B still shows 2 (stale) and taps "+".
  await day(b, d1).getByRole('button', { name: 'More servings' }).click();
  const dialog = b.getByRole('dialog');
  await dialog.getByText('Changed by someone else').waitFor();
  assert.match(await dialog.innerText(), /Person-a changed this/);
  await dialog.getByRole('button', { name: 'Keep theirs' }).click();
  await servings(b).getByText('3').waitFor();
  const state = await api(`/api/state?from=${today}&to=${addDays(today, 7)}`);
  assert.equal(state.meals.find((m) => m.date === d1).servings, 3, 'nothing was silently overwritten');
  await phoneB.context.close();
});

test('a failed save shows a banner, keeps the change and recovers', async () => {
  const { page } = phoneA;
  await openWeek(page, d1);
  await page.route('**/api/meals/*', (route) => route.abort('internetdisconnected'));
  await day(page, d1).getByRole('button', { name: 'More servings' }).click();
  const bannerEl = page.locator('#banner');
  await bannerEl.getByText(/Not saved: retrying/).waitFor();
  let state = await api(`/api/state?from=${today}&to=${addDays(today, 7)}`);
  assert.equal(state.meals.find((m) => m.date === d1).servings, 3, 'not saved yet');
  await page.unroute('**/api/meals/*');
  await bannerEl.getByRole('button', { name: 'Retry now' }).click();
  await page.locator('#banner[hidden]').waitFor({ state: 'attached' });
  state = await api(`/api/state?from=${today}&to=${addDays(today, 7)}`);
  assert.equal(state.meals.find((m) => m.date === d1).servings, 4, 'saved after recovery');
  await day(page, d1).locator('.stepper .val').getByText('4').waitFor();
});

test('history shows changes and undo works', async () => {
  const { page } = phoneA;
  await page.goto(`${base}/#/more/history`);
  const first = page.locator('.history-entry').first();
  await first.waitFor();
  assert.match(await first.innerText(), /servings 3 → 4/);
  await first.getByRole('button', { name: 'Undo' }).click();
  await page.locator('.history-entry').first().getByText(/undo/).waitFor();
  const state = await api(`/api/state?from=${today}&to=${addDays(today, 7)}`);
  assert.equal(state.meals.find((m) => m.date === d1).servings, 3);
});

test('month view and recipe cook view render', async () => {
  const { page } = phoneA;
  await page.goto(`${base}/#/month?m=${d1.slice(0, 7)}`);
  await page.locator('.mday .m', { hasText: 'Turkey taco bowls' }).first().waitFor();
  await page.goto(`${base}/#/recipes`);
  await page.getByRole('button', { name: /Sheet-pan chicken/ }).click();
  await page.getByRole('heading', { name: 'Sheet-pan chicken and vegetables' }).waitFor();
  await page.getByRole('button', { name: 'More servings' }).click();
  await page.getByText(/scaled ×1½/).waitFor();
  assert.match(await page.locator('.ing-list').innerText(), /1½ lb boneless chicken thighs/);
});

test('no console errors (including CSP violations)', () => {
  const real = consoleErrors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(e));
  assert.deepEqual(real, []);
});
