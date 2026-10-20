import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildList, toSnapshotRows, listAsText } from '../public/js/core/grocery.js';
import { recipes, settings } from './fixtures.js';

const meal = (id, recipe_id, date, servings, status = 'planned') => ({ id, recipe_id, date, servings, status });
const find = (items, name, dim) => items.filter((i) => i.norm === name && (!dim || i.dim === dim));

test('merges compatible units across meals and scales by servings', () => {
  // Tacos for 2 (base 2) + chili for 2 (base 4, so half).
  const items = buildList([meal('m1', 'tacos', '2026-10-20', 2), meal('m2', 'chili', '2026-10-22', 2)], recipes, [], settings);
  const turkey = find(items, 'ground turkey');
  assert.equal(turkey.length, 1, 'case-insensitive names merge');
  assert.equal(turkey[0].text, '1½ lb');
  assert.equal(turkey[0].sources.length, 2);
  const beans = find(items, 'black beans');
  assert.equal(beans.length, 1, '"can (15 oz)" and "cans (15 oz)" are the same count unit');
  assert.equal(beans[0].buy, 2);
  assert.equal(beans[0].text, '2 can (15 oz)');
  const cumin = find(items, 'cumin')[0];
  assert.equal(cumin.text, '2 tsp'); // 1 tsp + half of 2 tsp
});

test('never merges across dimensions', () => {
  const items = buildList([meal('m2', 'chili', '2026-10-22', 4)], recipes, [], settings);
  const salsa = find(items, 'salsa');
  assert.equal(salsa.length, 2, 'volume salsa and weight salsa stay separate');
  assert.deepEqual(salsa.map((s) => s.dim).sort(), ['mass', 'volume']);
  const idx = items.findIndex((i) => i.norm === 'salsa');
  assert.equal(items[idx + 1].norm, 'salsa', 'same-name lines are adjacent');
});

test('changing servings updates quantities', () => {
  const two = buildList([meal('m1', 'tacos', '2026-10-20', 2)], recipes, [], settings);
  const four = buildList([meal('m1', 'tacos', '2026-10-20', 4)], recipes, [], settings);
  assert.equal(find(two, 'ground turkey')[0].text, '1 lb');
  assert.equal(find(four, 'ground turkey')[0].text, '2 lb');
  assert.equal(find(four, 'salsa')[0].text, '1 cup');
});

test('count rounding is visible', () => {
  // Soup base 2 -> 3 servings = 3 carrots, 1.5 garlic cloves.
  const items = buildList([meal('m1', 'soup', '2026-10-20', 3)], recipes, [], settings);
  const garlic = find(items, 'garlic')[0];
  assert.equal(garlic.buy, 2);
  assert.equal(garlic.text, '2 clove (1½ needed)');
  assert.equal(find(items, 'carrot')[0].text, '3');
});

test('skipping or removing a meal removes only its lines', () => {
  const both = buildList([meal('m1', 'tacos', '2026-10-20', 2), meal('m3', 'soup', '2026-10-21', 2)], recipes, [], settings);
  const skipped = buildList([meal('m1', 'tacos', '2026-10-20', 2), meal('m3', 'soup', '2026-10-21', 2, 'skipped')], recipes, [], settings);
  const removed = buildList([meal('m1', 'tacos', '2026-10-20', 2)], recipes, [], settings);
  assert.ok(find(both, 'lentils').length);
  assert.equal(find(skipped, 'lentils').length, 0);
  assert.deepEqual(skipped.map((i) => i.key), removed.map((i) => i.key));
  assert.ok(find(skipped, 'ground turkey').length, 'other meal untouched');
});

test('"have" excludes from buying but keeps the reason and recipe refs, and is reversible', () => {
  const meals = [meal('m1', 'tacos', '2026-10-20', 2)];
  const base = buildList(meals, recipes, [], settings);
  const turkeyKey = find(base, 'ground turkey')[0].key;
  const marked = buildList(meals, recipes, [{ item_key: turkeyKey, have: 1, have_reason: 'in freezer', in_cart: 0, version: 1 }], settings);
  const t = find(marked, 'ground turkey')[0];
  assert.equal(t.have, true);
  assert.equal(t.have_reason, 'in freezer');
  assert.equal(t.sources[0].recipe, 'Tacos');
  assert.equal(toSnapshotRows(marked).some((r) => r.item_key === turkeyKey), false);
  const undone = buildList(meals, recipes, [{ item_key: turkeyKey, have: 0, have_reason: null, in_cart: 0, version: 2 }], settings);
  assert.equal(find(undone, 'ground turkey')[0].have, false);
});

test('staples default to "probably have" and can be switched to buy', () => {
  const meals = [meal('m1', 'tacos', '2026-10-20', 2)];
  const items = buildList(meals, recipes, [], settings);
  const salt = find(items, 'salt')[0];
  assert.equal(salt.have, true);
  assert.equal(salt.have_reason, 'staple');
  const buy = buildList(meals, recipes, [{ item_key: salt.key, have: 0, in_cart: 0, version: 1 }], settings);
  assert.equal(find(buy, 'salt')[0].have, false);
});

test('optional only when optional in every source', () => {
  const onlyTacos = buildList([meal('m1', 'tacos', '2026-10-20', 2)], recipes, [], settings);
  assert.equal(find(onlyTacos, 'avocado')[0].optional, true);
  const withBowls = buildList([meal('m1', 'tacos', '2026-10-20', 2), meal('m4', 'bowls', '2026-10-21', 2)], recipes, [], settings);
  assert.equal(find(withBowls, 'avocado')[0].optional, false);
  assert.equal(find(withBowls, 'avocado')[0].text, '2');
});

test('sorted by section order then name; text export groups sections', () => {
  const items = buildList([meal('m1', 'tacos', '2026-10-20', 2), meal('m3', 'soup', '2026-10-21', 2)], recipes, [], settings);
  const order = items.map((i) => settings.sections.indexOf(i.section));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  const text = listAsText(items, [{ text: 'paper towels', section: 'Other' }]);
  assert.match(text, /PRODUCE\n- avocado \(1\) \[optional\]/);
  assert.match(text, /OTHER\n- paper towels/);
  assert.doesNotMatch(text, /salt/, 'staples marked "have" are not in the text');
});
