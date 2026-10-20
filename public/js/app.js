// App shell: hash routing, refresh on focus and every 30 s, offline copy.
import { banner, clear, h, isSheetOpen } from './ui.js';
import { configure, startRetryWatchers, pendingCount, SignedOut, showSignedOut } from './api.js';
import { store, refresh } from './store.js';
import { dateTimeOf } from './ui.js';
import { isDate, weekStart } from './core/dates.js';
import * as plan from './views/plan.js';
import * as month from './views/month.js';
import * as groceries from './views/groceries.js';
import * as recipes from './views/recipes.js';
import * as more from './views/more.js';

const VIEWS = { plan, month, groceries, recipes, more };
const view = document.getElementById('view');
let current = { name: 'plan', parts: [], query: new URLSearchParams(), preserve: false };

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'plan';
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const name = VIEWS[parts[0]] ? parts[0] : 'plan';
  return { name, parts: parts.slice(1), query: new URLSearchParams(qs) };
}

function setActiveTab(name) {
  for (const a of document.querySelectorAll('.tabs a')) {
    const on = a.dataset.tab === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function showStaleBanner() {
  if (pendingCount()) return; // the save banner is more important
  const el = document.getElementById('banner');
  if (store.stale) banner('offline', `Offline: showing the last saved copy from ${dateTimeOf(store.stale)}`);
  else if (el.dataset.kind === 'offline') banner(null);
}

export function render() {
  const route = parseHash();
  setActiveTab(route.name);
  const scrollY = route.name === current.name ? window.scrollY : 0;
  current = { ...route, preserve: false };
  if (!store.data) {
    clear(view).append(h('p', { class: 'loading' }, 'Loading…'));
    return;
  }
  const ctx = { navigate, rerender: render, reload, route, preserve: () => { current.preserve = true; } };
  clear(view);
  try {
    VIEWS[route.name].render(view, ctx);
  } catch (err) {
    console.error(err);
    view.append(h('div', { class: 'errors' }, 'Something went wrong showing this page. Try reloading.'));
  }
  window.scrollTo(0, scrollY);
  showStaleBanner();
}

// Refresh data; re-render unless the person is in the middle of typing.
export async function reload({ force = false } = {}) {
  try {
    await refresh();
  } catch (err) {
    if (err instanceof SignedOut) {
      showSignedOut();
      return;
    }
    if (err.status === 503 && err.data && err.data.error === 'not_configured') {
      clear(view).append(h('div', { class: 'card' }, h('h1', {}, 'Almost ready'), h('p', {}, 'Sign-in isn’t configured yet. See the README: set TEAM_DOMAIN, POLICY_AUD and ALLOWED_EMAILS.')));
      return;
    }
    if (!store.data) {
      clear(view).append(h('div', { class: 'card' }, h('p', {}, 'Couldn’t load your plan.'), h('button', { onclick: () => reload({ force: true }) }, 'Try again')));
      return;
    }
  }
  const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && view.contains(document.activeElement);
  if (!force && (current.preserve || isSheetOpen() || typing)) {
    showStaleBanner();
    return;
  }
  render();
}

// ?w=YYYY-MM-DD picks the week, ?m=YYYY-MM the month; anything else is ignored.
function applyRouteParams(route) {
  const w = route.query.get('w');
  const m = route.query.get('m');
  if (route.name === 'plan' && isDate(w)) store.weekStart = weekStart(w);
  if (route.name === 'month' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '')) store.month = m;
}

configure({ onSaved: () => reload({ force: true }), me: () => store.data?.me?.email });

window.addEventListener('hashchange', () => {
  // Week/month changes need a different data range.
  applyRouteParams(parseHash());
  reload({ force: true });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reload();
});
window.addEventListener('focus', () => reload());
setInterval(() => {
  if (document.visibilityState === 'visible') reload();
}, 30000);

startRetryWatchers();
applyRouteParams(parseHash());
reload({ force: true });

// For tests and debugging.
window.__mealPlanner = { store, reload };
