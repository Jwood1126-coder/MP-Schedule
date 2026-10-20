// Alfred's weekly proposals: parse, validate and resolve against the library.
// The same code runs in the browser (preview) and the Worker (decide), and
// the Worker always re-reads the proposal itself before applying it.
//
// Format (docs/ALFRED_FORMAT.md): a JSON object, either raw, inside a
// ```json fenced block, or as the first {...} in the text.
import { isDate, addDays, daysBetween, weekStart } from './dates.js';
import { parseIngredientLines } from './ingredients.js';
import { SECTIONS, TAGS } from './defaults.js';

const MAX_TEXT = 60000;

export function nameKey(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Find the JSON object in pasted or Notion text.
export function extractJson(text) {
  const s = String(text ?? '');
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fence && fence[1].trim().startsWith('{')) return fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function cleanStr(v, max) {
  if (v == null) return '';
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > max ? null : s;
}

function cleanInt(v, min, max) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function cleanUrl(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > 500) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseRecipe(r, i, errors, warnings, sections) {
  const where = `New recipe ${i + 1}`;
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    errors.push(`${where} is malformed.`);
    return null;
  }
  const name = cleanStr(r.name, 100);
  if (!name) {
    errors.push(`${where}: a name is required (max 100 characters).`);
    return null;
  }
  const label = `New recipe "${name}"`;
  const out = { name };
  const base = cleanInt(r.base_servings, 1, 20);
  if (base === undefined) errors.push(`${label}: base_servings must be a whole number from 1 to 20.`);
  out.base_servings = base ?? 2;
  for (const [field, max] of [['active_min', 600], ['total_min', 1440], ['pans', 10]]) {
    const v = cleanInt(r[field], 0, max);
    if (v === undefined) errors.push(`${label}: ${field} must be a whole number from 0 to ${max}.`);
    out[field] = v ?? null;
  }
  const url = cleanUrl(r.source_url);
  if (url === undefined) {
    warnings.push(`${label}: source_url isn't a web address, so it was left out.`);
    out.source_url = null;
  } else out.source_url = url;
  const prep = cleanStr(r.prep_note, 500);
  if (prep === null) errors.push(`${label}: prep_note is too long (max 500).`);
  out.prep_note = prep || null;
  let steps = r.steps;
  if (Array.isArray(steps)) steps = steps.filter((s) => typeof s === 'string').join('\n');
  steps = cleanStr(steps, 5000);
  if (steps === null) errors.push(`${label}: steps are too long (max 5000).`);
  out.steps = steps || null;
  const tags = [];
  for (const t of Array.isArray(r.tags) ? r.tags : []) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().toLowerCase();
    if (TAGS.includes(tag)) {
      if (!tags.includes(tag)) tags.push(tag);
    } else warnings.push(`${label}: unknown tag "${t.slice(0, 30)}" was dropped.`);
  }
  out.tags = tags.slice(0, 10);
  let lines = r.ingredients;
  if (Array.isArray(lines)) lines = lines.filter((l) => typeof l === 'string').join('\n');
  if (typeof lines !== 'string' || !lines.trim()) {
    errors.push(`${label}: ingredients are required, one "qty | unit | name | section | optional" line each.`);
    out.ingredients = [];
  } else {
    const parsed = parseIngredientLines(lines, sections);
    for (const e of parsed.errors) errors.push(`${label}: ${e}`);
    if (parsed.items.length > 60) errors.push(`${label}: at most 60 ingredients.`);
    out.ingredients = parsed.items;
  }
  return out;
}

// Returns { data, errors, warnings }. data is null when the text can't be read at all.
export function parseProposal(text, { sections = SECTIONS } = {}) {
  const errors = [];
  const warnings = [];
  if (typeof text !== 'string' || !text.trim()) return { data: null, errors: ['The plan is empty.'], warnings };
  if (text.length > MAX_TEXT) return { data: null, errors: ['The plan is too long.'], warnings };
  const json = extractJson(text);
  if (!json) return { data: null, errors: ['No plan found: expected a JSON object like {"week_of": …}.'], warnings };
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { data: null, errors: [`The plan isn't valid JSON (${String(err.message).slice(0, 120)}).`], warnings };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: null, errors: ['The plan must be a JSON object.'], warnings };

  const data = { week_of: null, message: '', busy_days: [], dinners: [], new_recipes: [], extras: [] };

  if (!isDate(raw.week_of)) errors.push('week_of must be a date like 2026-10-26.');
  else {
    data.week_of = raw.week_of;
    if (weekStart(raw.week_of) !== raw.week_of) warnings.push(`week_of ${raw.week_of} isn't a Monday.`);
  }
  const inWeek = (d) => data.week_of && daysBetween(data.week_of, d) >= 0 && daysBetween(data.week_of, d) <= 6;

  const message = cleanStr(raw.message, 500);
  if (message === null) errors.push('message must be text, at most 500 characters.');
  else data.message = message;

  if (raw.busy_days != null) {
    if (!Array.isArray(raw.busy_days) || raw.busy_days.length > 7) errors.push('busy_days must be a list of up to 7 dates.');
    else {
      for (const d of raw.busy_days) {
        if (!isDate(d)) errors.push(`busy_days: "${String(d).slice(0, 20)}" isn't a date like 2026-10-27.`);
        else if (data.week_of && !inWeek(d)) errors.push(`busy_days: ${d} is outside the week of ${data.week_of}.`);
        else if (!data.busy_days.includes(d)) data.busy_days.push(d);
      }
      data.busy_days.sort();
    }
  }

  if (raw.new_recipes != null) {
    if (!Array.isArray(raw.new_recipes) || raw.new_recipes.length > 14) errors.push('new_recipes must be a list of up to 14 recipes.');
    else {
      raw.new_recipes.forEach((r, i) => {
        const rec = parseRecipe(r, i, errors, warnings, sections);
        if (!rec) return;
        if (data.new_recipes.some((x) => nameKey(x.name) === nameKey(rec.name))) warnings.push(`New recipe "${rec.name}" is listed twice; the first is used.`);
        else data.new_recipes.push(rec);
      });
    }
  }

  if (!Array.isArray(raw.dinners) || raw.dinners.length < 1 || raw.dinners.length > 7) errors.push('dinners must be a list of 1 to 7 dinners.');
  else {
    raw.dinners.forEach((d, i) => {
      const where = `Dinner ${i + 1}`;
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        errors.push(`${where} is malformed.`);
        return;
      }
      const out = {};
      if (!isDate(d.date)) errors.push(`${where}: date must be like 2026-10-27.`);
      else if (data.week_of && !inWeek(d.date)) errors.push(`${where}: ${d.date} is outside the week of ${data.week_of}.`);
      out.date = isDate(d.date) ? d.date : null;
      const recipe = cleanStr(d.recipe, 100);
      if (!recipe) errors.push(`${where}: recipe name is required.`);
      out.recipe = recipe || '';
      const servings = cleanInt(d.servings, 1, 20);
      if (servings === undefined) errors.push(`${where}: servings must be a whole number from 1 to 20.`);
      out.servings = servings ?? null;
      const note = cleanStr(d.note, 300);
      if (note === null) errors.push(`${where}: note is too long (max 300).`);
      out.note = note || '';
      const alt = cleanStr(d.alternate, 100);
      if (alt === null) errors.push(`${where}: alternate is too long.`);
      out.alternate = alt || '';
      if (out.alternate && nameKey(out.alternate) === nameKey(out.recipe)) out.alternate = '';
      data.dinners.push(out);
    });
    const dates = data.dinners.map((d) => d.date).filter(Boolean);
    if (new Set(dates).size !== dates.length) warnings.push('Two dinners are on the same date.');
  }

  if (raw.extras != null) {
    if (!Array.isArray(raw.extras) || raw.extras.length > 40) errors.push('extras must be a list of up to 40 items.');
    else {
      for (const x of raw.extras) {
        const s = cleanStr(x, 120);
        if (!s) {
          if (s === null) errors.push('extras: each item must be text, at most 120 characters.');
          continue;
        }
        if (!data.extras.some((e) => nameKey(e) === nameKey(s))) data.extras.push(s);
      }
    }
  }

  return { data, errors, warnings };
}

// Match dinner and alternate names against the library and new_recipes.
// match: { id } for an existing recipe, { new: index } for a new one, or null.
export function resolveProposal(data, library) {
  const errors = [];
  const warnings = [];
  if (!data) return { dinners: [], errors, warnings, newRecipeNames: [] };
  const byName = new Map();
  for (const r of library || []) {
    const k = nameKey(r.name);
    const prev = byName.get(k);
    if (!prev || (prev.archived && !r.archived)) byName.set(k, r);
  }
  const lookup = (name) => {
    if (!name) return null;
    const lib = byName.get(nameKey(name));
    if (lib) return { id: lib.id, name: lib.name, archived: !!lib.archived };
    const idx = data.new_recipes.findIndex((r) => nameKey(r.name) === nameKey(name));
    return idx === -1 ? null : { new: idx, name: data.new_recipes[idx].name };
  };
  const dinners = data.dinners.map((d, i) => {
    const main = lookup(d.recipe);
    if (d.recipe && !main) errors.push(`Dinner ${i + 1}: "${d.recipe}" isn't in the recipe library or new_recipes.`);
    let alternate = null;
    if (d.alternate) {
      alternate = lookup(d.alternate);
      if (!alternate) warnings.push(`Dinner ${i + 1}: alternate "${d.alternate}" isn't in the library or new_recipes, so it can't be chosen.`);
    }
    return { main, alternate };
  });
  for (const r of data.new_recipes) {
    if (byName.has(nameKey(r.name))) warnings.push(`"${r.name}" is already in the library; the library version is used.`);
  }
  return { dinners, errors, warnings, newRecipeNames: data.new_recipes.map((r) => r.name) };
}

// Which dinners a set of choices actually adds. choices[i] is 'main' | 'alternate' | 'skip'.
export function chosenDinners(data, resolution, choices) {
  const out = [];
  data.dinners.forEach((d, i) => {
    const choice = choices?.[i] || 'main';
    if (choice === 'skip') return;
    const r = resolution.dinners[i];
    const pick = choice === 'alternate' && r.alternate ? r.alternate : r.main;
    if (!pick) return;
    out.push({ index: i, date: d.date, servings: d.servings, note: d.note, pick, alternate: choice === 'alternate' && !!r.alternate });
  });
  return out;
}

export function proposalWeekEnd(data) {
  return data?.week_of ? addDays(data.week_of, 6) : null;
}
