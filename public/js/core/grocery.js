// Build the merged grocery list for a set of meals.
// Shared by the browser (live list) and the Worker (snapshot on lock), so the
// list you see is exactly the list that gets locked.
import { classify, normName, collapse, formatBase, formatNumber } from './units.js';
import { DEFAULT_SETTINGS } from './defaults.js';

const DIM_ORDER = { count: 0, volume: 1, mass: 2 };

export function itemKey(name, dim, countUnit = '') {
  return `${normName(name)}|${dim}|${dim === 'count' ? countUnit : ''}`;
}

// meals: [{id, date, recipe_id, servings, status}]
// recipesById: {id: recipe} where recipe.ingredients is an array
// marks: [{item_key, have, have_reason, in_cart, version}] or a map by key
// settings: merged settings (sections, staples, default_servings)
export function buildList(meals, recipesById, marks = [], settings = DEFAULT_SETTINGS) {
  const markMap = Array.isArray(marks) ? Object.fromEntries(marks.map((m) => [m.item_key, m])) : marks || {};
  const sections = settings.sections || DEFAULT_SETTINGS.sections;
  const staples = new Set((settings.staples || []).map(normName));
  const byKey = new Map();

  for (const meal of meals) {
    if (!meal || meal.status === 'skipped') continue;
    const recipe = recipesById[meal.recipe_id];
    if (!recipe) continue;
    const base = Number(recipe.base_servings) || 1;
    const servings = Number(meal.servings) || base;
    const factor = servings / base;
    for (const ing of recipe.ingredients || []) {
      const name = collapse(ing.name);
      if (!name) continue;
      const c = classify(ing.unit);
      const key = itemKey(name, c.dim, c.unit);
      let item = byKey.get(key);
      if (!item) {
        item = {
          key,
          name,
          norm: normName(name),
          dim: c.dim,
          countUnit: c.dim === 'count' ? c.unit : '',
          section: ing.section || 'Other',
          base: null,
          allMetric: true,
          unquantified: false,
          optional: true,
          sources: [],
        };
        byKey.set(key, item);
      }
      if (item.section === 'Other' && ing.section && ing.section !== 'Other') item.section = ing.section;
      const scaled = ing.qty == null ? null : ing.qty * factor;
      if (scaled == null) item.unquantified = true;
      else item.base = (item.base || 0) + scaled * c.toBase;
      if (!c.metric) item.allMetric = false;
      item.optional = item.optional && !!ing.optional;
      item.sources.push({
        meal_id: meal.id,
        date: meal.date,
        recipe: recipe.name,
        qty: scaled,
        unit: collapse(ing.unit),
        optional: !!ing.optional,
        note: ing.note || '',
      });
    }
  }

  const items = [...byKey.values()].map((item) => finish(item, markMap[item.key], staples));
  const sectionIndex = (s) => {
    const i = sections.indexOf(s);
    return i === -1 ? sections.length : i;
  };
  items.sort((a, b) =>
    sectionIndex(a.section) - sectionIndex(b.section)
    || a.norm.localeCompare(b.norm)
    || DIM_ORDER[a.dim] - DIM_ORDER[b.dim]
    || a.countUnit.localeCompare(b.countUnit));
  return items;
}

function finish(item, mark, staples) {
  const staple = staples.has(item.norm);
  const metric = item.allMetric && item.dim !== 'count';
  const display = formatBase(item.dim, item.base, { metric, countUnit: item.countUnit });
  let buy = null;
  let text = display.text;
  if (item.dim === 'count' && item.base != null) {
    buy = Math.ceil(item.base - 1e-9);
    const unitWord = item.countUnit ? ` ${item.countUnit}` : '';
    text = `${buy}${unitWord}`;
    if (Math.abs(buy - item.base) > 1e-9) text += ` (${formatNumber(item.base)} needed)`;
  }
  if (item.unquantified) text = text ? `${text} + some` : '';

  // "Have" state: explicit mark wins; staples default to "probably have".
  let have = false;
  let haveReason = '';
  if (mark && mark.have != null) {
    have = !!mark.have;
    haveReason = have ? mark.have_reason || 'have' : '';
  } else if (staple) {
    have = true;
    haveReason = 'staple';
  }
  return {
    key: item.key,
    name: item.name,
    norm: item.norm,
    dim: item.dim,
    countUnit: item.countUnit,
    section: item.section,
    base: item.base,
    metric,
    unquantified: item.unquantified,
    buy,
    text,
    optional: item.optional,
    staple,
    have,
    have_reason: haveReason,
    in_cart: !!(mark && mark.in_cart),
    // The stored mark as-is (null = no explicit choice), for saving changes.
    mark_have: mark && mark.have != null ? !!mark.have : null,
    mark_reason: mark ? mark.have_reason || null : null,
    mark_version: mark ? mark.version || 0 : 0,
    sources: item.sources,
  };
}

// Quantity used for "did we buy enough": count units use what you actually buy.
export function purchaseQty(item) {
  return item.dim === 'count' ? item.buy : item.base;
}

// Turn list items into rows for snapshot_items (excludes "have" items).
export function toSnapshotRows(items) {
  return items
    .filter((i) => !i.have)
    .map((i) => ({
      item_key: i.key,
      name: i.name,
      qty: purchaseQty(i),
      unit: i.dim === 'volume' ? 'ml' : i.dim === 'mass' ? 'g' : i.countUnit,
      dim: i.dim,
      metric: i.metric ? 1 : 0,
      display: i.text,
      section: i.section,
      sources: i.sources,
    }));
}

// Plain-text list for pasting into a store app or notes.
export function listAsText(items, extras = [], { title = 'Groceries' } = {}) {
  const lines = [title];
  let section = null;
  const all = [
    ...items.filter((i) => !i.have).map((i) => ({ section: i.section, line: `${i.name}${i.text ? ` (${i.text})` : ''}${i.optional ? ' [optional]' : ''}` })),
    ...extras.map((e) => ({ section: e.section || 'Other', line: e.text })),
  ];
  const order = [...new Set(all.map((a) => a.section))];
  for (const s of order) {
    for (const a of all.filter((x) => x.section === s)) {
      if (a.section !== section) {
        lines.push('', a.section.toUpperCase());
        section = a.section;
      }
      lines.push(`- ${a.line}`);
    }
  }
  return lines.join('\n');
}
