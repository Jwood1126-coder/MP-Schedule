import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredientLines, formatIngredientLine } from '../public/js/core/ingredients.js';
import { settings } from './fixtures.js';

test('parses lines with optional columns', () => {
  const { items, errors } = parseIngredientLines('1 1/2 | lb | chicken thighs | meat & seafood\n\nsalt\n1 | | avocado | Produce | optional | ripe', settings.sections);
  assert.deepEqual(errors, []);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { qty: 1.5, unit: 'lb', name: 'chicken thighs', section: 'Meat & Seafood', optional: false, note: '' });
  assert.deepEqual(items[1], { qty: null, unit: '', name: 'salt', section: 'Other', optional: false, note: '' });
  assert.equal(items[2].optional, true);
  assert.equal(items[2].note, 'ripe');
});

test('reports helpful errors with line numbers', () => {
  const { errors } = parseIngredientLines('lots | cup | rice\n1 | cup | | Pantry\n1 | cup | rice | Aisle 9\n1 | cup | rice | Pantry | maybe', settings.sections);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /Line 1: "lots" isn't a quantity/);
  assert.match(errors[1], /Line 2: the ingredient name/);
  assert.match(errors[2], /Line 3: unknown section "Aisle 9"/);
  assert.match(errors[3], /Line 4: 5th column/);
});

test('format and parse round-trip', () => {
  const ing = { qty: 0.5, unit: 'cup', name: 'salsa', section: 'Canned & Jarred', optional: true, note: 'mild' };
  const { items } = parseIngredientLines(formatIngredientLine(ing), settings.sections);
  assert.deepEqual(items[0], ing);
});
