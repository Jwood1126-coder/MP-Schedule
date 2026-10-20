// Month: a calendar of dinners. Dashed = idea (tentative). Tap a day to plan that week.
import { h } from '../ui.js';
import { store, recipesById, mealsOn, isPreferred } from '../store.js';
import { addDays, weekStart, monthName, localToday } from '../core/dates.js';

function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function render(root, ctx) {
  const month = store.month;
  const byId = recipesById();
  const start = weekStart(`${month}-01`);
  const today = localToday();
  const go = (m) => ctx.navigate(`#/month?m=${m}`);

  root.append(h('div', { class: 'header-line' },
    h('h1', {}, monthName(`${month}-01`)),
    h('div', { class: 'week-nav' },
      h('button', { 'aria-label': 'Previous month', onclick: () => go(shiftMonth(month, -1)) }, '‹'),
      h('button', { 'aria-label': 'Next month', onclick: () => go(shiftMonth(month, 1)) }, '›'),
      month !== today.slice(0, 7) ? h('button', { class: 'link', onclick: () => go(today.slice(0, 7)) }, 'Today') : null)));

  const grid = h('div', { class: 'month-grid' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', { class: 'dow' }, d)));
  for (let i = 0; i < 42; i++) {
    const date = addDays(start, i);
    if (i >= 35 && date.slice(0, 7) !== month) break;
    const meals = mealsOn(date);
    grid.append(h('button', {
      class: `mday ${date.slice(0, 7) !== month ? 'out' : ''} ${isPreferred(date).on ? 'pref' : ''}`,
      'aria-label': `${date}${meals.length ? `: ${meals.map((m) => byId[m.recipe_id]?.name || 'dinner').join(', ')}` : ''}`,
      onclick: () => {
        store.weekStart = weekStart(date);
        ctx.navigate(`#/plan?w=${weekStart(date)}`);
      },
    },
    h('span', { class: 'num' }, String(Number(date.slice(8)))),
    meals.map((m) => h('span', { class: `m ${m.status}`, title: byId[m.recipe_id]?.name || 'Dinner' }, byId[m.recipe_id]?.name || 'Dinner'))));
  }
  root.append(grid, h('p', { class: 'muted small' }, `Shaded days are marked “${store.data.settings.preferred_label}”. Dashed dinners are ideas, not plans yet.`));
}
