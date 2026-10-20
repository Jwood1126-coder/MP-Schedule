// Local development server: serves ./public with the same _headers rules as
// Cloudflare static assets, and sends /api/* to the real Worker code with a
// local SQLite-backed D1. Auth is bypassed only on localhost via DEV_AUTH_EMAIL.
//
//   npm run dev                      # http://127.0.0.1:8787
//   PORT=9000 DB_PATH=/tmp/x.sqlite npm run dev
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { LocalD1 } from './d1-shim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function readDevVars() {
  const file = path.join(ROOT, '.dev.vars');
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

// Parse Cloudflare's _headers file (path line, then indented "Name: value").
function loadHeaderRules() {
  const file = path.join(PUBLIC, '_headers');
  if (!existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(':');
      if (i > 0) current.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}

function matches(pattern, pathname) {
  if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1));
  return pattern === pathname;
}

function makeAssets(rules) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      let file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC + path.sep) || rel.includes('_headers')) file = path.join(PUBLIC, 'index.html');
      let body;
      try {
        if (!(await stat(file)).isFile()) throw new Error('dir');
        body = await readFile(file);
      } catch {
        file = path.join(PUBLIC, 'index.html'); // single-page-application fallback
        body = await readFile(file);
      }
      const headers = new Headers({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      for (const r of rules) if (matches(r.pattern, url.pathname)) for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
      return new Response(body, { status: 200, headers });
    },
  };
}

export function createLocalServer({ dbPath = ':memory:', env: extraEnv = {} } = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new LocalD1(dbPath);
  const env = { ...readDevVars(), ...extraEnv, DB: db, ASSETS: makeAssets(loadHeaderRules()) };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const host = req.headers.host || '127.0.0.1';
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const request = new Request(`http://${host}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const response = await worker.fetch(request, env);
      const outHeaders = {};
      response.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(response.status, outHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('local server error');
    }
  });
  return { server, db, env };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 8787);
  const dbPath = process.env.DB_PATH || path.join(ROOT, '.local-data', 'dev.sqlite');
  const { server, env } = createLocalServer({ dbPath });
  if (!env.DEV_AUTH_EMAIL) console.warn('DEV_AUTH_EMAIL is not set: copy .dev.vars.example to .dev.vars for local sign-in.');
  server.listen(port, '127.0.0.1', () => console.log(`Meal planner running at http://127.0.0.1:${port} (data: ${dbPath})`));
}
