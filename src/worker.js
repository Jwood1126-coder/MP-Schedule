// Cloudflare Worker entry point. Static files come from ./public (assets);
// this Worker only handles /api/*.
import { authenticate, AuthError } from './auth.js';
import { ensureSchema, SCHEMA_VERSION } from './schema.js';
import { HttpError } from './db.js';
import { routes } from './api.js';

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY = 2 * 1024 * 1024;

// Basic CSRF defense on top of Access: custom header + JSON + same origin.
function checkMutation(request, url) {
  if (request.headers.get('X-Requested-With') !== 'meal-planner') throw new HttpError(403, 'csrf');
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new HttpError(415, 'json_required');
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'bad_origin');
}

async function readBody(request) {
  if (!MUTATING.has(request.method)) return {};
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) throw new HttpError(413, 'too_large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large');
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  try {
    let user;
    try {
      user = await authenticate(request, env);
    } catch (err) {
      if (err instanceof AuthError) {
        console.warn('auth rejected:', err.code); // reason only, never the email
        return json(err.status, { error: err.code, ...err.extra });
      }
      throw err;
    }
    if (MUTATING.has(request.method)) checkMutation(request, url);
    if (!env.DB) return json(503, { error: 'no_database' });
    try {
      await ensureSchema(env.DB);
    } catch (err) {
      console.error('schema migration failed', err);
      return json(503, { error: 'migration_failed' });
    }

    const path = url.pathname.replace(/\/+$/, '');
    for (const [method, pattern, handler] of routes) {
      if (method !== request.method) continue;
      const m = path.match(pattern);
      if (!m) continue;
      const body = await readBody(request);
      const params = m.slice(1).map((p) => decodeURIComponent(p));
      const result = await handler({ db: env.DB, env, user: user.email, me: user, body, params, url, schemaVersion: SCHEMA_VERSION });
      return result instanceof Response ? result : json(200, result);
    }
    return json(404, { error: 'not_found' });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.code, ...err.extra });
    console.error('api error', err);
    return json(500, { error: 'server_error' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
