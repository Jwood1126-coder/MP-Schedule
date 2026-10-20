import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildList, toSnapshotRows } from '../public/js/core/grocery.js';
import { afterShopping } from '../public/js/core/diff.js';
import { recipes, settings } from './fixtures.js';

const meal = (id, recipe_id, date, servings, status = 'planned') => ({ id, recipe_id, date, servings, status });
const snapshot = (items) => toSnapshotRows(items).map((r) => ({ ...r, purchase: 'bought', sub_note: null }));

test('swap after shopping: still need vs bought but unused', () => {
  const before = buildList([meal('m1', 'tacos', '2026-10-20', 2), meal('m3', 'soup', '2026-10-22', 2)], recipes, [], settings);
  const snap = snapshot(before);
  // Swap soup -> bowls.
  const after = buildList([meal('m1', 'tacos', '2026-10-20', 2), meal('m3', 'bowls', '2026-10-22', 2)], recipes, [], settings);
  const d = afterShopping(snap, after);
  const need = d.stillNeed.map((i) => i.norm).sort();
  assert.deepEqual(need, ['avocado', 'rice', 'salsa'].sort());
  const salsa = d.stillNeed.find((i) => i.norm === 'salsa');
  assert.equal(salsa.partial, true);
  assert.equal(salsa.missingText, '½ cup');
  const unused = d.boughtUnused.map((i) => i.name).sort();
  assert.deepEqual(unused, ['carrot', 'garlic', 'lentils']);
  assert.equal(d.boughtUnused.find((i) => i.name === 'lentils').sources[0].recipe, 'Soup');
  assert.ok(d.covered.some((i) => i.norm === 'ground turkey'));
});

test('servings reduced after shopping shows leftover quantity', () => {
  const before = buildList([meal('m1', 'tacos', '2026-10-20', 4)], recipes, [], settings);
  const after = buildList([meal('m1', 'tacos', '2026-10-20', 2)], recipes, [], settings);
  const d = afterShopping(snapshot(before), after);
  assert.equal(d.stillNeed.length, 0);
  const turkey = d.boughtUnused.find((i) => i.name === 'Ground turkey');
  assert.equal(turkey.leftoverText, '1 lb');
  assert.equal(turkey.wholeItem, false);
});

test('out of stock counts as not bought; substituted counts as bought', () => {
  const items = buildList([meal('m1', 'tacos', '2026-10-20', 2)], recipes, [], settings);
  const snap = snapshot(items).map((r) => (r.name === 'Ground turkey' ? { ...r, purchase: 'out' } : r.name === 'salsa' ? { ...r, purchase: 'substituted', sub_note: 'pico' } : r));
  const d = afterShopping(snap, items);
  assert.ok(d.stillNeed.some((i) => i.norm === 'ground turkey'));
  const salsa = d.covered.find((i) => i.norm === 'salsa');
  assert.equal(salsa.substituted, true);
  assert.equal(salsa.sub_note, 'pico');
});

test('no changes means nothing to report', () => {
  const items = buildList([meal('m1', 'tacos', '2026-10-20', 2)], recipes, [], settings);
  const d = afterShopping(snapshot(items), items);
  assert.equal(d.stillNeed.length, 0);
  assert.equal(d.boughtUnused.length, 0);
});
