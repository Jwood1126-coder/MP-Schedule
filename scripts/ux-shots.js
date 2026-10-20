// Dev helper: walk the main flow at iPhone size and save screenshots + visible text.
//   node scripts/ux-shots.js <outDir>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalServer } from './local-server.js';
import { loadPlaywright } from '../e2e/playwright.js';

const out = process.argv[2];
const dir = mkdtempSync(path.join(tmpdir(), 'ux-'));
const { server } = createLocalServer({ dbPath: path.join(dir, 'ux.sqlite'), env: { DEV_AUTH_EMAIL: 'person-a@example.com' } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const pw = await loadPlaywright();
const browser = await pw.chromium.launch(pw.launchOptions);
const { defaultBrowserType, ...device } = pw.devices['iPhone 13'];
const ctx = await browser.newContext({ ...device });
const page = await ctx.newPage();
const log = [];
let n = 0;
async function shot(name) {
  await page.waitForTimeout(400);
  const file = path.join(out, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  log.push(`### ${n} ${name}\n` + (await page.locator('body').innerText()).slice(0, 1500));
}
async function tryClick(locator, label) {
  try { await locator.first().click({ timeout: 2500 }); return true; } catch { log.push(`(could not click: ${label})`); return false; }
}
await page.goto(`${base}/#/plan`); await shot('plan-empty');
await page.goto(`${base}/#/recipes`); await shot('recipes-empty');
await tryClick(page.getByRole('button', { name: /starter/i }), 'load starter');
await shot('recipes-loaded');
await tryClick(page.getByRole('button', { name: /Sheet-pan/i }), 'open recipe'); await shot('recipe-cook');
await page.goto(`${base}/#/plan`); await shot('plan-with-recipes');
await tryClick(page.getByRole('button', { name: /Suggest/i }), 'suggest'); await shot('suggest');
await tryClick(page.getByRole('button', { name: /^Add/ }), 'accept suggestion 1');
await tryClick(page.getByRole('button', { name: /^Add/ }), 'accept suggestion 2');
await page.keyboard.press('Escape').catch(() => {});
await page.goto(`${base}/#/plan`); await shot('plan-planned');
await page.goto(`${base}/#/groceries`); await shot('groceries-start');
await tryClick(page.getByRole('button', { name: /start|new|create/i }), 'start trip'); await shot('groceries-trip-dialog');
await tryClick(page.getByRole('button', { name: /^(Start|Create|Save|OK)/i }), 'confirm trip'); await shot('groceries-list');
await page.goto(`${base}/#/month`); await shot('month');
await page.goto(`${base}/#/more`); await shot('more');
writeFileSync(path.join(out, 'text.md'), log.join('\n\n'));
await browser.close(); server.close();
