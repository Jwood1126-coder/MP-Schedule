// Units: classify, convert to a base unit, and format quantities for people.
// Shared by the browser and the Worker. Pure functions only.
//
// Volume is stored in ml, mass in g. Everything else is a "count" unit
// ("clove", "can (15 oz)", "" for plain items) that only merges with the
// exact same normalized unit. We never add across dimensions.

const VOLUME = { tsp: 4.92892, tbsp: 14.7868, cup: 236.588, floz: 29.5735, ml: 1, l: 1000 };
const MASS = { oz: 28.3495, lb: 453.592, g: 1, kg: 1000 };
const METRIC = new Set(['ml', 'l', 'g', 'kg']);

const ALIASES = {
  t: 'tsp', tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  c: 'cup', cup: 'cup', cups: 'cup',
  'fl oz': 'floz', 'fl. oz': 'floz', 'fl. oz.': 'floz', floz: 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
};

// Plural count units fold to singular so "2 cloves" and "1 clove" merge.
const COUNT_ALIASES = {
  each: '', whole: '', ea: '', item: '', items: '',
  cloves: 'clove', cans: 'can', slices: 'slice', pieces: 'piece', bunches: 'bunch',
  heads: 'head', stalks: 'stalk', sprigs: 'sprig', packages: 'package', pkg: 'package',
  pkgs: 'package', jars: 'jar', bags: 'bag', boxes: 'box', bottles: 'bottle',
  fillets: 'fillet', breasts: 'breast', thighs: 'thigh', links: 'link', leaves: 'leaf',
  tortillas: 'tortilla', pinches: 'pinch', dashes: 'dash', handfuls: 'handful',
};

// "cans (15 oz)" -> "can (15 oz)", "each" -> "".
function countUnit(u) {
  if (Object.prototype.hasOwnProperty.call(COUNT_ALIASES, u)) return COUNT_ALIASES[u];
  const m = u.match(/^([a-z]+)(\s.*)$/);
  if (m && COUNT_ALIASES[m[1]]) return COUNT_ALIASES[m[1]] + m[2];
  return u;
}

export function collapse(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

export function normName(name) {
  return collapse(name).toLowerCase();
}

// Returns { dim: 'volume'|'mass'|'count', unit, toBase, metric }.
// For count, unit is the normalized count unit and toBase is 1.
export function classify(rawUnit) {
  const raw = collapse(rawUnit);
  if (raw === 'T') return { dim: 'volume', unit: 'tbsp', toBase: VOLUME.tbsp, metric: false };
  const u = raw.toLowerCase().replace(/\.$/, '');
  const alias = ALIASES[u] ?? ALIASES[raw.toLowerCase()];
  if (alias && VOLUME[alias]) return { dim: 'volume', unit: alias, toBase: VOLUME[alias], metric: METRIC.has(alias) };
  if (alias && MASS[alias]) return { dim: 'mass', unit: alias, toBase: MASS[alias], metric: METRIC.has(alias) };
  return { dim: 'count', unit: countUnit(u), toBase: 1, metric: false };
}

// Parse "1", "1.5", "1/2", "1 1/2", "½", "1½". Empty -> null. Invalid -> NaN.
const UNICODE_FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };

export function parseQty(text) {
  let s = collapse(text);
  if (s === '') return null;
  let total = 0;
  const uni = s.match(/[½¼¾⅓⅔⅛⅜⅝⅞]$/);
  if (uni) {
    total += UNICODE_FRACTIONS[uni[0]];
    s = s.slice(0, -1).trim();
    if (s === '') return total;
  }
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const d = Number(mixed[3]);
    return d ? total + Number(mixed[1]) + Number(mixed[2]) / d : NaN;
  }
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const d = Number(frac[2]);
    return d ? total + Number(frac[1]) / d : NaN;
  }
  if (/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return total + Number(s);
  return NaN;
}

// Friendly fractions: whole number plus one of ⅛ ¼ ⅓ ½ ⅔ ¾.
const STEPS = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾'], [1, '']];

export function formatNumber(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n <= 0) return '0';
  let whole = Math.floor(n);
  const rest = n - whole;
  let best = STEPS[0];
  for (const step of STEPS) if (Math.abs(rest - step[0]) < Math.abs(rest - best[0])) best = step;
  if (best[0] === 1) { whole += 1; best = STEPS[0]; }
  if (whole === 0 && best[1] === '') return '⅛'; // tiny but nonzero
  return `${whole || ''}${best[1]}` || '0';
}

function plural(unit, n) {
  if (unit === '' || n <= 1) return unit;
  if (unit === 'cup') return 'cups';
  return unit;
}

// Format a base quantity for display. Returns { qty, unit, text }.
export function formatBase(dim, baseQty, { metric = false, countUnit = '' } = {}) {
  if (baseQty == null) return { qty: null, unit: dim === 'count' ? countUnit : '', text: '' };
  if (dim === 'volume') {
    if (metric) {
      if (baseQty >= 1000) return out(round(baseQty / 1000, 2), 'l');
      return out(Math.round(baseQty), 'ml');
    }
    if (baseQty >= VOLUME.cup / 4 - 0.5) return frac(baseQty / VOLUME.cup, 'cup');
    if (baseQty >= VOLUME.tbsp - 0.05) return frac(baseQty / VOLUME.tbsp, 'tbsp');
    return frac(baseQty / VOLUME.tsp, 'tsp');
  }
  if (dim === 'mass') {
    if (metric) {
      if (baseQty >= 1000) return out(round(baseQty / 1000, 2), 'kg');
      return out(Math.round(baseQty), 'g');
    }
    if (baseQty >= MASS.lb - 0.5) return frac(baseQty / MASS.lb, 'lb');
    return frac(baseQty / MASS.oz, 'oz');
  }
  return frac(baseQty, countUnit);
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
function out(qty, unit) {
  return { qty, unit, text: `${qty} ${unit}` };
}
function frac(qty, unit) {
  const num = formatNumber(qty);
  const u = plural(unit, qty);
  return { qty, unit: u, text: u ? `${num} ${u}` : num };
}

export function toBase(qty, rawUnit) {
  if (qty == null) return null;
  return qty * classify(rawUnit).toBase;
}
