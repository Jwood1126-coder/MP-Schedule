// Suggest dinners for a week. Proposals are tentative and never saved here.
// Rules: preferred days first (but never forced), otherwise spread the days;
// workday-easy recipes on preferred days; skip recipes used in the last 21
// days; prefer overlapping ingredients with meals already planned that week.
import { normName } from './units.js';
import { daysBetween } from './dates.js';

// Small deterministic PRNG so the same seed gives the same suggestions.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function suggestMeals({
  weekDates,
  existingMeals = [],
  recipes = [],
  dayFlags = {},
  recentMeals = [],
  target = 2,
  staples = [],
  defaultServings = 2,
  seed = 1,
  notBefore = null, // don't propose days before this date (e.g. today)
}) {
  const rand = mulberry32(seed);
  const active = existingMeals.filter((m) => m.status !== 'skipped' && weekDates.includes(m.date));
  let need = target - active.length;
  if (need <= 0) return [];

  const takenIdx = new Set(active.map((m) => weekDates.indexOf(m.date)));
  const open = weekDates.map((d, i) => i).filter((i) => !takenIdx.has(i) && (!notBefore || weekDates[i] >= notBefore));
  const preferredOpen = open.filter((i) => dayFlags[weekDates[i]]);
  const chosen = [];
  for (const i of preferredOpen) {
    if (chosen.length >= need) break;
    chosen.push(i);
  }
  // Spread remaining picks: maximize distance to other dinners (capped at 3).
  while (chosen.length < need) {
    const taken = [...takenIdx, ...chosen];
    const left = open.filter((i) => !chosen.includes(i));
    if (!left.length) break;
    let best = null;
    let bestScore = -1;
    for (const i of left) {
      const score = taken.length ? Math.min(3, ...taken.map((t) => Math.abs(t - i))) : (i === 1 ? 4 : 0);
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    chosen.push(best);
  }
  chosen.sort((a, b) => a - b);
  need = chosen.length;

  // Recipes not used in the last 21 days (or already this week).
  const firstDay = weekDates[0];
  const lastUsed = new Map();
  for (const m of [...recentMeals, ...active]) {
    if (m.status === 'skipped') continue;
    if (daysBetween(m.date, firstDay) <= 21) {
      const prev = lastUsed.get(m.recipe_id);
      if (!prev || prev < m.date) lastUsed.set(m.recipe_id, m.date);
    }
  }
  const pool = recipes.filter((r) => !r.archived);
  let candidates = pool.filter((r) => !lastUsed.has(r.id));
  if (candidates.length < need) {
    // Not enough fresh recipes: fall back to the least recently used ones.
    const rest = pool.filter((r) => lastUsed.has(r.id)).sort((a, b) => lastUsed.get(a.id).localeCompare(lastUsed.get(b.id)));
    candidates = [...candidates, ...rest];
  }

  const stapleSet = new Set(staples.map(normName));
  const ingNames = (r) => new Set((r.ingredients || []).map((i) => normName(i.name)).filter((n) => !stapleSet.has(n)));
  const byId = Object.fromEntries(recipes.map((r) => [r.id, r]));
  const planned = new Set();
  for (const m of active) for (const n of ingNames(byId[m.recipe_id] || {})) planned.add(n);

  const used = new Set();
  const out = [];
  for (const idx of chosen) {
    const date = weekDates[idx];
    const preferred = !!dayFlags[date];
    let best = null;
    let bestScore = -Infinity;
    for (const r of candidates) {
      if (used.has(r.id)) continue;
      const names = ingNames(r);
      let overlap = 0;
      for (const n of names) if (planned.has(n)) overlap++;
      const easy = (r.tags || []).includes('workday-easy');
      const score = overlap * 2 + (preferred && easy ? 3 : 0) + (Number(r.rating) || 0) * 0.5 + rand();
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (!best) break;
    used.add(best.id);
    for (const n of ingNames(best)) planned.add(n);
    const reasons = [];
    if (preferred) reasons.push('preferred day');
    if (preferred && (best.tags || []).includes('workday-easy')) reasons.push('workday-easy');
    out.push({
      date,
      recipe_id: best.id,
      servings: defaultServings,
      status: 'tentative',
      reasons,
    });
  }
  return out;
}
