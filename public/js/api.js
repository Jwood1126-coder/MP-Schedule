// API client: JSON requests, a retrying queue for failed saves, conflict
// prompts, and signed-out detection.
import { h, banner, choose, toast, personName, timeOf } from './ui.js';

const PENDING_KEY = 'mp.pending.v1';
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'meal-planner' };

let pending = loadPending();
let retryTimer = null;
let retryDelay = 2000;
let hooks = { onSaved: () => {}, me: () => null };

export function configure(h) {
  hooks = { ...hooks, ...h };
}

function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function savePending() {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* storage unavailable: memory copy still retries */
  }
}

export function pendingCount() {
  return pending.length;
}

class NetworkError extends Error {}
export class SignedOut extends Error {}

// Low-level fetch. Access redirects an expired session to its login page;
// with redirect: 'manual' that shows up as an opaque redirect.
async function send(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: method === 'GET' ? { 'X-Requested-With': 'meal-planner' } : HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    throw new NetworkError('network');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) throw new SignedOut();
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

export function showSignedOut() {
  banner('signedout', 'Your sign-in expired.', { label: 'Sign in again', onClick: () => location.reload() });
}

export async function get(path) {
  const r = await send('GET', path);
  if (r.status >= 500 || r.status === 0) throw new NetworkError(String(r.status));
  if (r.status !== 200) {
    const err = new Error((r.data && (r.data.message || r.data.error)) || `HTTP ${r.status}`);
    err.status = r.status;
    err.data = r.data;
    throw err;
  }
  return r.data;
}

export function isNetworkError(err) {
  return err instanceof NetworkError;
}

function messageFor(data, status) {
  if (!data) return `Something went wrong (${status}).`;
  if (data.message) return data.field ? `${data.field.replace(/_/g, ' ')} ${data.message}` : data.message;
  const known = {
    changed_since: 'That changed since, so it can’t be undone safely.',
    not_undoable: 'That change can’t be undone.',
    not_configured: 'The app isn’t set up yet (sign-in settings missing).',
    csrf: 'Request blocked for safety. Reload the page.',
  };
  return known[data.error] || `Couldn’t save (${data.error || status}).`;
}

// Ask the user how to resolve a version conflict. Returns true if resent.
async function resolveConflict(op, data) {
  const who = personName(data.changed_by, hooks.me());
  const when = timeOf(data.changed_at);
  const choice = await choose('Changed by someone else', h('p', {}, `${who} changed this${when ? ` at ${when}` : ''}. Keep their version, or use yours?`), [
    { label: 'Keep theirs', value: 'theirs' },
    { label: 'Use mine', value: 'mine', primary: true },
  ]);
  if (choice === 'mine' && data.current) {
    const body = { ...op.body, expected_version: data.current.version };
    return mutate(op.method, op.path, body, { label: op.label });
  }
  hooks.onSaved();
  return null;
}

// Mutations. Resolves with response data, or null if it was queued or the
// user kept the other person's version.
export async function mutate(method, path, body = {}, { label = 'change', quiet = false } = {}) {
  const op = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, method, path, body, label };
  let r;
  try {
    r = await send(method, path, body);
  } catch (err) {
    if (err instanceof SignedOut) {
      showSignedOut();
      return null;
    }
    enqueue(op);
    return null;
  }
  if (r.status >= 500) {
    enqueue(op);
    return null;
  }
  if (r.status === 409 && r.data && r.data.error === 'conflict' && body && 'expected_version' in body) {
    return resolveConflict(op, r.data);
  }
  if (r.status >= 400) {
    if (!quiet) toast(messageFor(r.data, r.status), 5000);
    hooks.onSaved();
    const err = new Error(messageFor(r.data, r.status));
    err.status = r.status;
    err.data = r.data;
    throw err;
  }
  hooks.onSaved();
  return r.data;
}

// ---------- failed-save queue ----------

function enqueue(op) {
  pending.push(op);
  savePending();
  showPendingBanner();
  scheduleRetry();
}

function showPendingBanner() {
  if (!pending.length) return;
  const n = pending.length;
  banner('error', `Not saved: retrying${n > 1 ? ` (${n} changes)` : ''}…`, { label: 'Retry now', onClick: () => retryNow() });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(retryNow, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

let retrying = false;
export async function retryNow() {
  if (retrying || !pending.length) return;
  retrying = true;
  clearTimeout(retryTimer);
  try {
    while (pending.length) {
      const op = pending[0];
      let r;
      try {
        r = await send(op.method, op.path, op.body);
      } catch (err) {
        if (err instanceof SignedOut) {
          showSignedOut();
          return;
        }
        showPendingBanner();
        scheduleRetry();
        return;
      }
      if (r.status >= 500) {
        showPendingBanner();
        scheduleRetry();
        return;
      }
      pending.shift();
      savePending();
      if (r.status === 409 && r.data && r.data.error === 'conflict') {
        banner(null);
        await resolveConflict(op, r.data);
      } else if (r.status >= 400) {
        toast(`Couldn’t save your ${op.label}: ${messageFor(r.data, r.status)}`, 6000);
      }
    }
    retryDelay = 2000;
    banner(null);
    toast('Saved');
    hooks.onSaved();
  } finally {
    retrying = false;
  }
}

export function startRetryWatchers() {
  window.addEventListener('online', () => retryNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryNow();
  });
  if (pending.length) {
    showPendingBanner();
    scheduleRetry();
  }
}
