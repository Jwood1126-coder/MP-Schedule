import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestMeals } from '../public/js/core/suggest.js';
import { weekDates } from '../public/js/core/dates.js';
import { recipes } from './fixtures.js';

const week = weekDates('2026-10-19'); // Monday
const all = Object.values(recipes);

test('preferred days come first and get workday-easy recipes', () => {
  const out = suggestMeals({ weekDates: week, recipes: all, dayFlags: { '2026-10-21': true, '2026-10-24': true }, seed: 7 });
  assert.deepEqual(out.map((p) => p.date), ['2026-10-21', '2026-10-24']);
  for (const p of out) assert.ok(recipes[p.recipe_id].tags.includes('workday-easy'));
  assert.ok(out.every((p) => p.status === 'tentative'));
});

test('never forced: with no preferred days it still proposes two spread-out dinners', () => {
  const out = suggestMeals({ weekDates: week, recipes: all, seed: 3 });
  assert.equal(out.length, 2);
  const [a, b] = out.map((p) => week.indexOf(p.date));
  assert.ok(b - a >= 3, `spread days, got ${a} and ${b}`);
  assert.notEqual(out[0].recipe_id, out[1].recipe_id);
});

test('one preferred day plus one spread day', () => {
  const out = suggestMeals({ weekDates: week, recipes: all, dayFlags: { '2026-10-20': true }, seed: 1 });
  assert.equal(out.length, 2);
  assert.equal(out[0].date, '2026-10-20');
});

test('counts existing meals and avoids recently used recipes', () => {
  const existing = [{ id: 'x', date: '2026-10-20', recipe_id: 'tacos', status: 'planned' }];
  const recent = [{ id: 'y', date: '2026-10-05', recipe_id: 'bowls', status: 'cooked' }];
  const out = suggestMeals({ weekDates: week, existingMeals: existing, recentMeals: recent, recipes: all, seed: 5 });
  assert.equal(out.length, 1);
  assert.ok(!['tacos', 'bowls'].includes(out[0].recipe_id));
  assert.notEqual(out[0].date, '2026-10-20');
});

test('prefers ingredient overlap with planned meals', () => {
  // Tacos planned; chili shares turkey, beans, salsa, cumin -> should win.
  const existing = [{ id: 'x', date: '2026-10-20', recipe_id: 'tacos', status: 'planned' }];
  const out = suggestMeals({ weekDates: week, existingMeals: existing, recipes: all, seed: 11 });
  assert.equal(out[0].recipe_id, 'chili');
});

test('deterministic for a seed; full week returns nothing', () => {
  const a = suggestMeals({ weekDates: week, recipes: all, seed: 42 });
  const b = suggestMeals({ weekDates: week, recipes: all, seed: 42 });
  assert.deepEqual(a, b);
  const full = suggestMeals({ weekDates: week, recipes: all, existingMeals: a.map((p, i) => ({ ...p, id: `e${i}` })) });
  assert.deepEqual(full, []);
});

test('never proposes days before notBefore', () => {
  const out = suggestMeals({ weekDates: week, recipes: all, seed: 9, notBefore: '2026-10-23' });
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => p.date >= '2026-10-23'));
  const late = suggestMeals({ weekDates: week, recipes: all, seed: 9, notBefore: '2026-10-25' });
  assert.deepEqual(late.map((p) => p.date), ['2026-10-25'], 'only Sunday is left');
});
