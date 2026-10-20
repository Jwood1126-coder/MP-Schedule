import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseQty, formatNumber, formatBase } from '../public/js/core/units.js';

test('classify maps aliases into dimensions', () => {
  assert.equal(classify('Tablespoons').unit, 'tbsp');
  assert.equal(classify('T').unit, 'tbsp');
  assert.equal(classify('t').unit, 'tsp');
  assert.equal(classify('cups').dim, 'volume');
  assert.equal(classify('lbs').dim, 'mass');
  assert.equal(classify('fl oz').unit, 'floz');
  assert.deepEqual([classify('').dim, classify('').unit], ['count', '']);
  assert.equal(classify('each').unit, '');
  assert.equal(classify('whole').unit, '');
  assert.equal(classify('cloves').unit, 'clove');
  assert.equal(classify('can (15 oz)').unit, 'can (15 oz)');
  assert.equal(classify('can (15 oz)').dim, 'count');
});

test('parseQty handles fractions and rejects junk', () => {
  assert.equal(parseQty('2'), 2);
  assert.equal(parseQty('1.5'), 1.5);
  assert.equal(parseQty('1/2'), 0.5);
  assert.equal(parseQty('1 1/2'), 1.5);
  assert.equal(parseQty('½'), 0.5);
  assert.equal(parseQty('1½'), 1.5);
  assert.equal(parseQty(''), null);
  assert.ok(Number.isNaN(parseQty('a few')));
  assert.ok(Number.isNaN(parseQty('1/0')));
});

test('formatNumber uses friendly fractions', () => {
  assert.equal(formatNumber(1.5), '1½');
  assert.equal(formatNumber(0.25), '¼');
  assert.equal(formatNumber(0.33), '⅓');
  assert.equal(formatNumber(2), '2');
  assert.equal(formatNumber(0.99), '1');
  assert.equal(formatNumber(0.01), '⅛');
});

test('formatBase picks sensible display units', () => {
  assert.equal(formatBase('volume', 236.588 * 1.5).text, '1½ cups');
  assert.equal(formatBase('volume', 14.7868 * 2).text, '2 tbsp');
  assert.equal(formatBase('volume', 4.92892).text, '1 tsp');
  assert.equal(formatBase('mass', 453.592 * 1.5).text, '1½ lb');
  assert.equal(formatBase('mass', 28.3495 * 8).text, '8 oz');
  assert.equal(formatBase('mass', 500, { metric: true }).text, '500 g');
  assert.equal(formatBase('volume', 1500, { metric: true }).text, '1.5 l');
});
