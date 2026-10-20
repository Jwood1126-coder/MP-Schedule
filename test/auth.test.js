import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, _resetKeyCache } from '../src/auth.js';

const TEAM = 'https://example-team.cloudflareaccess.com';
const AUD = 'test-aud-123';
const ENV = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ALLOWED_EMAILS: 'person-a@example.com, Person-B@example.com' };
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = await crypto.subtle.exportKey('jwk', publicKey);
const other = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
async function sign(claims, { kid = 'k1', key = privateKey } = {}) {
  const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
  const p = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}
const goodClaims = (over = {}) => ({ aud: [AUD], iss: TEAM, email: 'person-a@example.com', exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10, ...over });
let fetchCount = 0;
const fetchImpl = async (u) => {
  fetchCount++;
  assert.equal(u, `${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] }), { status: 200 });
};
const req = (token, host = 'meal-planner.example.workers.dev') =>
  new Request(`https://${host}/api/state`, { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });

beforeEach(() => {
  _resetKeyCache();
  fetchCount = 0;
});

test('valid token for an allowed email passes (case-insensitive)', async () => {
  const user = await authenticate(req(await sign(goodClaims())), ENV, { fetchImpl, now: NOW });
  assert.equal(user.email, 'person-a@example.com');
  const b = await authenticate(req(await sign(goodClaims({ email: 'person-b@EXAMPLE.com' }))), ENV, { fetchImpl, now: NOW });
  assert.equal(b.email, 'person-b@example.com');
  assert.equal(fetchCount, 1, 'certs are cached');
});

const rejects = async (promise, status, code) => {
  await assert.rejects(promise, (err) => err.status === status && err.code === code);
};

test('wrong audience, issuer, expired, not-yet-valid and unknown email all fail', async () => {
  await rejects(authenticate(req(await sign(goodClaims({ aud: ['other'] }))), ENV, { fetchImpl, now: NOW }), 401, 'bad_audience');
  await rejects(authenticate(req(await sign(goodClaims({ iss: 'https://evil.example.com' }))), ENV, { fetchImpl, now: NOW }), 401, 'bad_issuer');
  await rejects(authenticate(req(await sign(goodClaims({ exp: NOW / 1000 - 120 }))), ENV, { fetchImpl, now: NOW }), 401, 'expired');
  await rejects(authenticate(req(await sign(goodClaims({ nbf: NOW / 1000 + 600 }))), ENV, { fetchImpl, now: NOW }), 401, 'not_yet_valid');
  await rejects(authenticate(req(await sign(goodClaims({ email: 'stranger@example.com' }))), ENV, { fetchImpl, now: NOW }), 401, 'not_allowed');
});

test('bad signature, unknown key and garbage tokens fail', async () => {
  await rejects(authenticate(req(await sign(goodClaims(), { key: other.privateKey })), ENV, { fetchImpl, now: NOW }), 401, 'bad_signature');
  await rejects(authenticate(req(await sign(goodClaims(), { kid: 'nope' })), ENV, { fetchImpl, now: NOW }), 401, 'unknown_key');
  await rejects(authenticate(req('not.a.jwt'), ENV, { fetchImpl, now: NOW }), 401, 'bad_token');
  await rejects(authenticate(req(null), ENV, { fetchImpl, now: NOW }), 401, 'missing_token');
});

test('missing configuration fails closed with 503', async () => {
  const token = await sign(goodClaims());
  await rejects(authenticate(req(token), {}, { fetchImpl, now: NOW }), 503, 'not_configured');
  await rejects(authenticate(req(token), { ...ENV, POLICY_AUD: '' }, { fetchImpl, now: NOW }), 503, 'not_configured');
  await rejects(authenticate(req(token), { ...ENV, ALLOWED_EMAILS: ' , ' }, { fetchImpl, now: NOW }), 503, 'not_configured');
});

test('dev bypass only on localhost and only with DEV_AUTH_EMAIL', async () => {
  const dev = await authenticate(req(null, '127.0.0.1:8787'), { DEV_AUTH_EMAIL: 'person-a@example.com' }, { fetchImpl, now: NOW });
  assert.equal(dev.email, 'person-a@example.com');
  assert.equal(dev.dev, true);
  // Same env on a real hostname: no bypass, and no config -> 503.
  await rejects(authenticate(req(null), { DEV_AUTH_EMAIL: 'person-a@example.com' }, { fetchImpl, now: NOW }), 503, 'not_configured');
  // Localhost without DEV_AUTH_EMAIL: normal checks apply.
  await rejects(authenticate(req(null, 'localhost:8787'), ENV, { fetchImpl, now: NOW }), 401, 'missing_token');
});

test('team domain without scheme is normalized', async () => {
  const env = { ...ENV, TEAM_DOMAIN: 'example-team.cloudflareaccess.com/' };
  const user = await authenticate(req(await sign(goodClaims())), env, { fetchImpl, now: NOW });
  assert.equal(user.email, 'person-a@example.com');
});
