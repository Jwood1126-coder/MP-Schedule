// Syntax-check every JavaScript file (node --check).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['src', 'public', 'scripts', 'test', 'test-api', 'e2e'];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
for (const r of roots) {
  try {
    walk(r);
  } catch {
    /* missing dir */
  }
}
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${f}\n${err.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files passed node --check`);
process.exit(failed ? 1 : 0);
