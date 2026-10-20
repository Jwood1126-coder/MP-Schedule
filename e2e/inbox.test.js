// End-to-end: paste a plan from Alfred on an iPhone-sized screen, accept it,
// and see the dinners, busy days and extra grocery items appear.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalServer } from '../scripts/local-server.js';
import { loadPlaywright } from './playwright.js';
import { addDays, localToday, weekStart, prettyDate } from '../public/js/core/dates.js';

const A = 'person-a@example.com';
let server;
let base;
let dir;
let browser;
let pw;
const consoleErrors = [];

const monday = addDays(weekStart(localToday()), 7);
const tue = addDays(monday, 1);
const thu = addDays(monday, 3);

const PLAN = {
  week_of: monday,
  message: 'Two easy dinners for the busy days.',
  busy_days: [tue, thu],
  dinners: [
    { date: tue, recipe: 'Turkey and bean chili', servings: 4, note: 'lunch tomorrow' },
    { date: thu, recipe: 'Lemon herb salmon', servings: 2, alternate: 'Salmon rice bowls' },
  ],
  new_recipes: [{
    name: 'Lemon herb salmon', base_servings: 2, active_min: 10, total_min: 20, pans: 1, tags: ['workday-easy', 'healthy'],
    steps: 'Season salmon.\nRoast 12 minutes.',
    ingredients: ['1 | lb | salmon fillets | Meat & Seafood', '1 | | lemon | Produce'],
  }],
  extras: ['milk', 'bananas'],
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'meal-e2e-inbox-'));
  ({ server } = createLocalServer({ dbPath: path.join(dir, 'e2e.sqlite'), env: { DEV_AUTH_EMAIL: A } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  pw = await loadPlaywright();
  browser = await pw.chromium.launch(pw.launchOptions);
  await fetch(`${base}/api/seed-starter`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meal-planner', 'X-Dev-User': A }, body: '{}' });
});

after(async () => {
  await browser?.close();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('paste a plan in More, accept it, and it lands on Plan and Groceries', async () => {
  const { defaultBrowserType, ...device } = pw.devices['iPhone 13'];
  const context = await browser.newContext({ ...device, extraHTTPHeaders: { 'X-Dev-User': A } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await page.goto(`${base}/#/more`);
  await page.getByTestId('inbox-status').getByText(/not connected/).waitFor();
  await page.getByLabel('Plan from Alfred').fill(`Here you go:\n\`\`\`json\n${JSON.stringify(PLAN, null, 2)}\n\`\`\``);
  await page.getByRole('button', { name: 'Preview' }).click();

  const card = page.locator('.proposal');
  await card.getByText(`Alfred’s plan · week of ${prettyDate(monday)}`).waitFor();
  await card.getByText('new recipe').waitFor();
  assert.doesNotMatch(await card.innerText(), /\bnull\b|\[object/);
  // Swap Thursday to the alternate, then accept.
  await card.getByRole('button', { name: 'Use Salmon rice bowls instead' }).click();
  await card.getByText('instead of Lemon herb salmon').waitFor();
  await card.getByLabel('Note for Alfred').fill('Looks great');
  await card.getByRole('button', { name: 'Accept plan' }).click();

  // Lands on Plan for that week.
  await page.waitForURL(new RegExp(`#/plan\\?w=${monday}`));
  const day = (d) => page.locator(`section.day[data-date="${d}"]`);
  await day(tue).getByText('Turkey and bean chili').waitFor();
  await day(thu).getByText('Salmon rice bowls').waitFor();
  assert.equal(await day(tue).locator('.pref-toggle[aria-pressed="true"]').count(), 1, 'Tuesday marked busy');
  assert.equal(await day(thu).locator('.pref-toggle[aria-pressed="true"]').count(), 1, 'Thursday marked busy');

  // The alternate was chosen, so the new recipe wasn't needed.
  await page.goto(`${base}/#/recipes`);
  await page.getByRole('button', { name: /Black bean quesadillas/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Lemon herb salmon/ }).count(), 0);

  // Extras are on that week's grocery trip.
  await page.goto(`${base}/#/groceries`);
  await page.locator('.filters button', { hasText: prettyDate(monday).slice(4) }).first().click().catch(() => {});
  await page.getByTestId('extras').getByText('milk').waitFor();
  await page.getByTestId('extras').getByText('bananas').waitFor();
  await context.close();
});

test('the cook view never prints "null"', async () => {
  const { defaultBrowserType, ...device } = pw.devices['iPhone 13'];
  const context = await browser.newContext({ ...device, extraHTTPHeaders: { 'X-Dev-User': A } });
  const page = await context.newPage();
  await page.goto(`${base}/#/recipes`);
  await page.getByRole('button', { name: /Sheet-pan chicken/ }).click();
  await page.getByRole('heading', { name: 'Sheet-pan chicken and vegetables' }).waitFor();
  assert.doesNotMatch(await page.locator('#view').innerText(), /\bnull\b/);
  await context.close();
});

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meal-planner', 'X-Dev-User': A },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function phone(viewport) {
  const { defaultBrowserType, ...device } = pw.devices['iPhone 13'];
  const context = await browser.newContext({ ...device, ...(viewport ? { viewport } : {}), extraHTTPHeaders: { 'X-Dev-User': A } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  return { context, page };
}

test('accepting a plan with no extras offers "Shop these dinners", which opens that trip', async () => {
  const wk = addDays(monday, 14);
  const wed = addDays(wk, 2);
  const plan = { week_of: wk, dinners: [{ date: wed, recipe: 'Turkey taco bowls', servings: 2 }], extras: [] };
  const { context, page } = await phone();
  await page.goto(`${base}/#/more`);
  await page.getByLabel('Plan from Alfred').fill(JSON.stringify(plan));
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.locator('.proposal').getByRole('button', { name: 'Accept plan' }).click();
  await page.waitForURL(new RegExp(`#/plan\\?w=${wk}`));
  const notice = page.getByTestId('accepted-notice');
  await notice.getByRole('button', { name: 'Shop these dinners' }).click();
  await page.waitForURL(/#\/groceries\?trip=[0-9a-f-]{36}$/);
  await page.getByText(`Covers ${prettyDate(wk)} to ${prettyDate(addDays(wk, 6))}`).waitFor();
  await page.getByText(/Dinners: Turkey taco bowls/).waitFor();
  await page.getByTestId('buy-list').getByText('ground turkey').waitFor();
  await context.close();
});

test('the cook view keeps its scale across a refresh and can save it to the dinner', async () => {
  const wk = addDays(monday, 21);
  const meal = (await api('POST', '/api/meals', { date: addDays(wk, 1), recipe_id: (await api('GET', `/api/state?from=${wk}&to=${addDays(wk, 6)}`)).recipes.find((r) => r.name === 'Lentil vegetable soup').id, servings: 4 })).meal;
  const { context, page } = await phone();
  await page.goto(`${base}/#/plan?w=${wk}`);
  await page.locator(`section.day[data-date="${meal.date}"]`).getByRole('button', { name: 'Lentil vegetable soup' }).click();
  const label = page.getByTestId('cook-scale');
  await label.getByText('Scaled to 4 (dinner saved for 4)').waitFor();
  await page.getByRole('button', { name: 'More servings' }).click();
  await label.getByText('Scaled to 5 (dinner saved for 4)').waitFor();
  // The app's own refresh (on focus) re-renders the view…
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(700);
  await label.getByText('Scaled to 5 (dinner saved for 4)').waitFor();
  // …and so does a full reload in the same tab.
  await page.reload();
  await page.getByTestId('cook-scale').getByText('Scaled to 5 (dinner saved for 4)').waitFor();
  await page.getByRole('button', { name: 'Save 5 servings to this dinner' }).click();
  await page.getByTestId('cook-scale').getByText('Scaled to 5 (dinner saved for 5)').waitFor();
  const saved = (await api('GET', `/api/state?from=${wk}&to=${addDays(wk, 6)}`)).meals.find((m) => m.id === meal.id);
  assert.equal(saved.servings, 5);
  await context.close();
});

test('the month view fits a 390px screen with long dinner names', async () => {
  const wk = addDays(monday, 28);
  const st = await api('GET', `/api/state?from=${wk}&to=${addDays(wk, 6)}`);
  const long = ['Sheet-pan chicken and vegetables', 'Chicken and broccoli stir-fry'].map((n) => st.recipes.find((r) => r.name === n));
  assert.ok(long.every((r) => r && r.name.length >= 25));
  await api('POST', '/api/meals', { date: addDays(wk, 1), recipe_id: long[0].id });
  await api('POST', '/api/meals', { date: addDays(wk, 2), recipe_id: long[1].id });
  const { context, page } = await phone({ width: 390, height: 844 });
  await page.goto(`${base}/#/month?m=${addDays(wk, 1).slice(0, 7)}`);
  await page.locator('.mday .m', { hasText: 'Sheet-pan chicken' }).first().waitFor();
  const m = await page.evaluate(() => {
    const grid = document.querySelector('.month-grid');
    const sun = [...grid.querySelectorAll('.dow')].at(-1).getBoundingClientRect();
    return { scroll: grid.scrollWidth, client: grid.clientWidth, sunRight: sun.right, page: document.documentElement.scrollWidth, vw: window.innerWidth };
  });
  assert.ok(m.scroll <= m.client, `grid doesn't overflow (${m.scroll} > ${m.client})`);
  assert.ok(m.sunRight <= m.vw, `Sunday column is on screen (${m.sunRight} > ${m.vw})`);
  assert.ok(m.page <= m.vw, 'no horizontal page scroll');
  await context.close();
});

test('no console errors (including CSP violations)', () => {
  const real = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
  assert.deepEqual(real, []);
});
