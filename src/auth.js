// Who is calling? Cloudflare Access sits in front of the whole Worker; this
// module also verifies the Access token on every API request (defense in
// depth), and fails closed if anything is missing or misconfigured.
//
// Configuration:
//   TEAM_DOMAIN     e.g. https://your-team.cloudflareaccess.com; public, so it is
//                   a plain var in wrangler.jsonc (https:// is optional)
// Worker secrets (set in the Cloudflare dashboard, never in the repo):
//   POLICY_AUD      the Access application's "Application Audience (AUD) Tag"
//   ALLOWED_EMAILS  comma-separated list of the two allowed emails

export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const KEY_TTL_MS = 60 * 60 * 1000;
const LEEWAY_S = 30;
const keyCache = new Map(); // teamDomain -> { at, keys: Map(kid -> CryptoKey) }

export function normalizeTeamDomain(value) {
  let d = String(value || '').trim().replace(/\/+$/, '');
  if (!d) return '';
  if (!/^https:\/\//.test(d)) d = `https://${d.replace(/^http:\/\//, '')}`;
  return d;
}

function allowedList(env) {
  return String(env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

// Returns { email, dev } or throws AuthError.
export async function authenticate(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const url = new URL(request.url);
  if (isLocalHost(url.hostname) && env.DEV_AUTH_EMAIL) {
    const override = request.headers.get('X-Dev-User');
    return { email: String(override || env.DEV_AUTH_EMAIL).trim().toLowerCase(), dev: true };
  }

  const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
  const aud = String(env.POLICY_AUD || '').trim();
  const allowed = allowedList(env);
  if (!teamDomain || !aud || allowed.length === 0) throw new AuthError(503, 'not_configured');

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new AuthError(401, 'missing_token');

  const claims = await verifyJwt(token, { teamDomain, aud, fetchImpl, now });
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || !allowed.includes(email)) throw new AuthError(401, 'not_allowed');
  return { email, dev: false };
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(s) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
  } catch {
    throw new AuthError(401, 'bad_token');
  }
}

async function loadKeys(teamDomain, fetchImpl, now, force) {
  const cached = keyCache.get(teamDomain);
  if (cached && !force && now - cached.at < KEY_TTL_MS) return cached.keys;
  let res;
  try {
    res = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`);
  } catch {
    throw new AuthError(503, 'certs_unavailable');
  }
  if (!res.ok) throw new AuthError(503, 'certs_unavailable');
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  keyCache.set(teamDomain, { at: now, keys });
  return keys;
}

export async function verifyJwt(token, { teamDomain, aud, fetchImpl = fetch, now = Date.now() }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new AuthError(401, 'bad_token');
  const [h, p, s] = parts;
  const header = decodePart(h);
  if (header.alg !== 'RS256' || !header.kid) throw new AuthError(401, 'bad_token');

  let keys = await loadKeys(teamDomain, fetchImpl, now, false);
  let key = keys.get(header.kid);
  if (!key) {
    // Keys rotate; refetch once before giving up.
    keys = await loadKeys(teamDomain, fetchImpl, now, true);
    key = keys.get(header.kid);
  }
  if (!key) throw new AuthError(401, 'unknown_key');

  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  } catch {
    ok = false;
  }
  if (!ok) throw new AuthError(401, 'bad_signature');

  const claims = decodePart(p);
  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < nowS) throw new AuthError(401, 'expired');
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > nowS) throw new AuthError(401, 'not_yet_valid');
  if (claims.iss !== teamDomain) throw new AuthError(401, 'bad_issuer');
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new AuthError(401, 'bad_audience');
  return claims;
}

// Test hook: forget cached keys.
export function _resetKeyCache() {
  keyCache.clear();
}
