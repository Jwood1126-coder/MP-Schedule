import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProposal, resolveProposal, chosenDinners, extractJson } from '../public/js/core/proposal.js';

const PLAN = {
  week_of: '2026-11-02',
  message: 'Two easy ones for your busy days.',
  busy_days: ['2026-11-03', '2026-11-05', '2026-11-03'],
  dinners: [
    { date: '2026-11-03', recipe: 'turkey and bean chili ', servings: 4, note: 'doubles as lunch', alternate: 'Sheet-pan salmon' },
    { date: '2026-11-05', recipe: 'Sheet-pan salmon', servings: 2 },
  ],
  new_recipes: [
    {
      name: 'Sheet-pan salmon', base_servings: 2, active_min: 10, total_min: 25, pans: 1,
      tags: ['workday-easy', 'Healthy', 'spicy'], source_url: 'https://example.com/salmon',
      steps: ['Heat oven.', 'Roast.'],
      ingredients: ['1 | lb | salmon fillets | Meat & Seafood', '1 | | lemon | Produce | optional', 'salt'],
    },
  ],
  extras: ['milk', 'Milk', 'bananas'],
};
const LIB = [{ id: 'r-chili', name: 'Turkey and bean chili', archived: 0 }, { id: 'r-soup', name: 'Lentil soup', archived: 0 }];

test('parses raw JSON, a fenced block, and text around an object', () => {
  const raw = JSON.stringify(PLAN);
  for (const text of [raw, `Here is the plan:\n\`\`\`json\n${raw}\n\`\`\`\nThanks!`, `Plan: ${raw} (end)`]) {
    const { data, errors } = parseProposal(text);
    assert.deepEqual(errors, []);
    assert.equal(data.week_of, '2026-11-02');
    assert.deepEqual(data.busy_days, ['2026-11-03', '2026-11-05'], 'deduplicated and sorted');
    assert.deepEqual(data.extras, ['milk', 'bananas'], 'case-insensitive dedupe');
    assert.equal(data.dinners.length, 2);
  }
  assert.equal(extractJson('no json here'), null);
});

test('rejects garbage and bad dates readably', () => {
  assert.match(parseProposal('').errors[0], /empty/);
  assert.match(parseProposal('hello').errors[0], /No plan found/);
  assert.match(parseProposal('{ not json }').errors[0], /isn't valid JSON/);
  const bad = parseProposal(JSON.stringify({ ...PLAN, week_of: '2026-13-01' }));
  assert.ok(bad.errors.some((e) => /week_of/.test(e)));
  const outside = parseProposal(JSON.stringify({ ...PLAN, dinners: [{ date: '2026-11-20', recipe: 'Lentil soup' }] }));
  assert.ok(outside.errors.some((e) => /outside the week/.test(e)));
  const servings = parseProposal(JSON.stringify({ ...PLAN, dinners: [{ date: '2026-11-03', recipe: 'Lentil soup', servings: 99 }] }));
  assert.ok(servings.errors.some((e) => /servings/.test(e)));
  assert.ok(parseProposal(JSON.stringify({ ...PLAN, dinners: [] })).errors.some((e) => /1 to 7/.test(e)));
});

test('new recipes: tags filtered with a warning, ingredients parsed, steps joined', () => {
  const { data, errors, warnings } = parseProposal(JSON.stringify(PLAN));
  assert.deepEqual(errors, []);
  const r = data.new_recipes[0];
  assert.deepEqual(r.tags, ['workday-easy', 'healthy']);
  assert.ok(warnings.some((w) => /unknown tag "spicy"/.test(w)));
  assert.equal(r.ingredients.length, 3);
  assert.deepEqual(r.ingredients[1], { qty: 1, unit: '', name: 'lemon', section: 'Produce', optional: true, note: '' });
  assert.equal(r.steps, 'Heat oven.\nRoast.');
  const badLine = parseProposal(JSON.stringify({ ...PLAN, new_recipes: [{ ...PLAN.new_recipes[0], ingredients: ['x | lb | fish | Meat & Seafood'] }] }));
  assert.ok(badLine.errors.some((e) => /isn't a quantity/.test(e)));
});

test('resolve: library match is case-insensitive; unknown recipe is an error; unknown alternate a warning', () => {
  const { data } = parseProposal(JSON.stringify(PLAN));
  const res = resolveProposal(data, LIB);
  assert.deepEqual(res.errors, []);
  assert.equal(res.dinners[0].main.id, 'r-chili');
  assert.equal(res.dinners[0].alternate.new, 0);
  assert.equal(res.dinners[1].main.new, 0);

  const unknown = parseProposal(JSON.stringify({ ...PLAN, new_recipes: [], dinners: [{ date: '2026-11-03', recipe: 'Mystery stew', alternate: 'Nope' }] }));
  const r2 = resolveProposal(unknown.data, LIB);
  assert.ok(r2.errors.some((e) => /Mystery stew/.test(e)));
  assert.ok(r2.warnings.some((w) => /alternate "Nope"/.test(w)));
});

test('resolve: a new recipe that already exists uses the library version', () => {
  const plan = { ...PLAN, new_recipes: [{ ...PLAN.new_recipes[0], name: 'Lentil Soup' }], dinners: [{ date: '2026-11-03', recipe: 'lentil soup' }] };
  const { data } = parseProposal(JSON.stringify(plan));
  const res = resolveProposal(data, LIB);
  assert.equal(res.dinners[0].main.id, 'r-soup');
  assert.ok(res.warnings.some((w) => /already in the library/.test(w)));
});

test('chosenDinners honours main / alternate / skip', () => {
  const { data } = parseProposal(JSON.stringify(PLAN));
  const res = resolveProposal(data, LIB);
  const picks = chosenDinners(data, res, ['alternate', 'skip']);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].pick.name, 'Sheet-pan salmon');
  assert.equal(picks[0].alternate, true);
  assert.equal(chosenDinners(data, res, []).length, 2, 'default is main');
});
