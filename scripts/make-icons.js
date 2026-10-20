// Render PNG app icons from public/icons/icon.svg using Playwright's Chromium.
// Run once after changing the SVG: node scripts/make-icons.js
import { readFileSync } from 'node:fs';
import { loadPlaywright } from '../e2e/playwright.js';

const { chromium, launchOptions } = await loadPlaywright();
const svg = readFileSync('public/icons/icon.svg', 'utf8');
const browser = await chromium.launch(launchOptions);
for (const [size, name] of [[180, 'apple-touch-icon.png'], [192, 'icon-192.png'], [512, 'icon-512.png']]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // Full-bleed square for iOS (it rounds corners itself).
  await page.setContent(`<style>html,body{margin:0;background:#2f6f4f}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `).replace('rx="112"', 'rx="0"')}`);
  await page.screenshot({ path: `public/icons/${name}` });
  await page.close();
}
await browser.close();
console.log('icons written');
