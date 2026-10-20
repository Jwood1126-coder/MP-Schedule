// Find Playwright: a local install if present, otherwise the global one,
// and the preinstalled Chromium if the bundled browser isn't downloaded.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  let pw;
  const candidates = ['playwright', '@playwright/test', '/opt/node22/lib/node_modules/playwright'];
  for (const c of candidates) {
    try {
      pw = require(c);
      break;
    } catch {
      /* try next */
    }
  }
  if (!pw) throw new Error('Playwright not found. Install it (npm i -D playwright) to run e2e tests.');
  const launchOptions = {};
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    // Use the preinstalled build if the version Playwright wants is missing.
    try {
      const expected = pw.chromium.executablePath();
      if (!existsSync(expected)) {
        const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
        if (dir) launchOptions.executablePath = path.join(root, dir, 'chrome-linux', 'chrome');
      }
    } catch {
      /* ignore */
    }
  }
  return { chromium: pw.chromium, devices: pw.devices, launchOptions };
}
