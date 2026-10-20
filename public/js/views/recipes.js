// Recipes: library, cook view (scaled), and editor.
import { h, stepper, toast, choose } from '../ui.js';
import { mutate } from '../api.js';
import { store } from '../store.js';
import { TAGS } from '../core/defaults.js';
import { classify, formatBase, formatNumber } from '../core/units.js';
import { parseIngredientLines, formatIngredientLine } from '../core/ingredients.js';

const filters = { tag: null, quick: false, archived: false, q: '' };

export function render(root, ctx) {
  const [id, mode] = ctx.route.parts;
  if (id === 'new') return editor(root, ctx, null);
  if (id) {
    const recipe = store.data.recipes.find((r) => r.id === id);
    if (!recipe) {
      root.append(h('p', {}, 'Recipe not found. '), h('a', { href: '#/recipes' }, 'Back to recipes'));
      return null;
    }
    return mode === 'edit' ? editor(root, ctx, recipe) : cookView(root, ctx, recipe);
  }
  return library(root, ctx);
}

function meta(r) {
  return [
    r.active_min != null ? `${r.active_min} min active` : null,
    r.total_min != null ? `${r.total_min} total` : null,
    r.pans != null ? `${r.pans} pan${r.pans === 1 ? '' : 's'}` : null,
    r.rating ? '★'.repeat(r.rating) : null,
  ].filter(Boolean).join(' · ');
}

function library(root, ctx) {
  const all = store.data.recipes;
  root.append(h('div', { class: 'header-line' }, h('h1', {}, 'Recipes'), h('button', { class: 'primary', onclick: () => ctx.navigate('#/recipes/new') }, '+ New')));
  if (!all.length) {
    root.append(h('div', { class: 'empty' },
      h('p', {}, 'Your recipe library is empty.'),
      h('p', { class: 'small' }, 'Start with eight simple weeknight dinners you can edit, or add your own.'),
      h('button', { class: 'primary', onclick: async () => {
        const r = await mutate('POST', '/api/seed-starter', {}, { label: 'starter recipes' });
        if (r) toast(`Added ${r.recipes} starter recipes`);
      } }, 'Load starter recipes')));
    return;
  }
  const search = h('input', { type: 'search', placeholder: 'Search', value: filters.q, 'aria-label': 'Search recipes' });
  const list = h('div', {});
  const chip = (label, on, onClick) => h('button', { class: on ? 'on' : '', 'aria-pressed': on ? 'true' : 'false', onclick: onClick }, label);
  const chips = h('div', { class: 'filters' });
  const draw = () => {
    chips.replaceChildren(
      chip('≤ 30 min active', filters.quick, () => { filters.quick = !filters.quick; draw(); }),
      ...TAGS.map((t) => chip(t, filters.tag === t, () => { filters.tag = filters.tag === t ? null : t; draw(); })),
      chip('Archived', filters.archived, () => { filters.archived = !filters.archived; draw(); }),
    );
    const q = filters.q.trim().toLowerCase();
    const shown = all.filter((r) => !!r.archived === filters.archived
      && (!filters.tag || (r.tags || []).includes(filters.tag))
      && (!filters.quick || (r.active_min != null && r.active_min <= 30))
      && (!q || r.name.toLowerCase().includes(q) || (r.ingredients || []).some((i) => i.name.toLowerCase().includes(q))));
    list.replaceChildren(...(shown.length ? shown.map((r) => h('button', { class: 'card recipe-row', onclick: () => ctx.navigate(`#/recipes/${r.id}`) },
      h('div', { class: 'name' }, r.name),
      h('div', { class: 'meta' }, meta(r)),
      h('div', { class: 'tags' }, (r.tags || []).map((t) => h('span', { class: 'chip' }, t))))) : [h('p', { class: 'empty' }, 'No recipes match.')]));
  };
  search.addEventListener('input', () => {
    filters.q = search.value;
    draw();
  });
  draw();
  root.append(search, chips, list);
}

function scaledText(ing, factor) {
  if (ing.qty == null) return ing.unit || '';
  const c = classify(ing.unit);
  const qty = ing.qty * factor;
  if (c.dim === 'count') return `${formatNumber(qty)}${c.unit ? ` ${ing.unit}` : ''}`;
  return formatBase(c.dim, qty * c.toBase, { metric: c.metric }).text;
}

// The cook view's scale is a preview, kept across the 30-second refresh (and
// reloads in this tab) per recipe + dinner. Saving it to the dinner is a
// separate, explicit action.
const SCALE_KEY = 'mp.cookScale.v1';
const cookScale = loadScales();

function loadScales() {
  try {
    const raw = sessionStorage.getItem(SCALE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return new Map(Object.entries(obj && typeof obj === 'object' ? obj : {}));
  } catch {
    return new Map();
  }
}

function rememberScale(key, n) {
  cookScale.set(key, n);
  try {
    sessionStorage.setItem(SCALE_KEY, JSON.stringify(Object.fromEntries(cookScale)));
  } catch {
    /* storage unavailable: the in-memory copy still works */
  }
}

function cookView(root, ctx, recipe) {
  const mealId = ctx.route.query.get('meal');
  const meal = mealId ? (store.data.meals || []).find((m) => m.id === mealId && m.recipe_id === recipe.id) : null;
  const q = Number(ctx.route.query.get('servings'));
  const scaleKey = `${recipe.id}|${meal ? meal.id : ''}`;
  const remembered = Number(cookScale.get(scaleKey));
  let servings = Number.isInteger(remembered) && remembered > 0 && remembered <= 20 ? remembered
    : meal ? meal.servings
      : Number.isInteger(q) && q > 0 && q <= 20 ? q : recipe.base_servings;
  const body = h('div', {});
  const draw = () => {
    const factor = servings / recipe.base_servings;
    const scaleLabel = meal ? `Scaled to ${servings} (dinner saved for ${meal.servings})` : `Scaled to ${servings}`;
    body.replaceChildren(
      h('div', { class: 'row spread wrap' },
        h('span', { class: 'row' }, h('span', { class: 'muted small' }, 'Servings'), stepper(servings, { onChange: (v) => { servings = v; rememberScale(scaleKey, v); draw(); } })),
        h('span', { class: 'muted small', 'data-testid': 'cook-scale' }, scaleLabel)),
      servings !== recipe.base_servings ? h('p', { class: 'muted small' }, `Recipe makes ${recipe.base_servings}; scaled ×${formatNumber(factor)}`) : '',
      meal && servings !== meal.servings ? h('button', {
        class: 'small-btn',
        onclick: () => mutate('PUT', `/api/meals/${meal.id}`, { servings, expected_version: meal.version }, { label: 'servings' }),
      }, `Save ${servings} servings to this dinner`) : '',
      h('h2', {}, 'Ingredients'),
      h('ul', { class: 'ing-list' }, (recipe.ingredients || []).map((i) => h('li', {},
        h('strong', {}, scaledText(i, factor)), ' ', i.name, i.optional ? h('span', { class: 'muted' }, ' (optional)') : null, i.note ? h('span', { class: 'muted' }, ` · ${i.note}`) : null))),
    );
  };
  draw();
  // Native append() would print a null child as the text "null".
  root.append(...[
    h('p', {}, h('a', { href: '#/recipes' }, '‹ Recipes')),
    h('h1', {}, recipe.name),
    h('p', { class: 'muted' }, meta(recipe) || 'No times recorded'),
    h('div', { class: 'tags' }, (recipe.tags || []).map((t) => h('span', { class: 'chip' }, t))),
    recipe.prep_note ? h('div', { class: 'panel info' }, h('strong', {}, 'Ahead of time: '), recipe.prep_note) : null,
    body,
    h('h2', {}, 'Steps'),
    recipe.steps ? h('ol', { class: 'steps' }, recipe.steps.split(/\n+/).filter((s) => s.trim()).map((s) => h('li', {}, s.trim()))) : h('p', { class: 'muted' }, 'No steps written yet.'),
    /^https?:\/\//i.test(recipe.source_url || '') ? h('p', {}, h('a', { href: recipe.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'Original recipe ↗')) : null,
    h('h2', {}, 'How was it?'),
    h('div', { class: 'stars', role: 'group', 'aria-label': 'Rating' }, [1, 2, 3, 4, 5].map((n) => h('button', {
      'aria-label': `${n} star${n === 1 ? '' : 's'}`,
      'aria-pressed': recipe.rating === n ? 'true' : 'false',
      onclick: () => mutate('PUT', `/api/recipes/${recipe.id}`, { rating: recipe.rating === n ? null : n, expected_version: recipe.version }, { label: 'rating' }),
    }, recipe.rating >= n ? '★' : '☆'))),
    h('div', { class: 'actions' },
      h('button', { onclick: () => ctx.navigate(`#/recipes/${recipe.id}/edit`) }, 'Edit'),
      h('button', { onclick: () => mutate('PUT', `/api/recipes/${recipe.id}`, { archived: !recipe.archived, expected_version: recipe.version }, { label: 'recipe' }) }, recipe.archived ? 'Unarchive' : 'Archive')),
  ].filter((c) => c != null));
}

function editor(root, ctx, recipe) {
  ctx.preserve(); // don't redraw while typing
  const r = recipe || { name: '', base_servings: store.data.settings.default_servings, tags: [], ingredients: [], steps: '', prep_note: '', source_url: '' };
  const sections = store.data.settings.sections;
  const f = {
    name: h('input', { type: 'text', value: r.name, required: true, maxlength: '100' }),
    base: h('input', { type: 'number', min: '1', max: '20', value: r.base_servings, inputmode: 'numeric' }),
    active: h('input', { type: 'number', min: '0', max: '600', value: r.active_min ?? '', inputmode: 'numeric' }),
    total: h('input', { type: 'number', min: '0', max: '1440', value: r.total_min ?? '', inputmode: 'numeric' }),
    pans: h('input', { type: 'number', min: '0', max: '10', value: r.pans ?? '', inputmode: 'numeric' }),
    prep: h('input', { type: 'text', value: r.prep_note || '', maxlength: '500', placeholder: 'e.g. Thaw chicken overnight' }),
    ings: h('textarea', { rows: '10', spellcheck: 'false', 'aria-describedby': 'ing-help' }, (r.ingredients || []).map(formatIngredientLine).join('\n')),
    steps: h('textarea', { rows: '8' }, r.steps || ''),
    url: h('input', { type: 'url', value: r.source_url || '', placeholder: 'https://…' }),
  };
  const tagBoxes = TAGS.map((t) => h('label', { class: 'row', style: null }, h('input', { type: 'checkbox', value: t, checked: (r.tags || []).includes(t) }), ` ${t}`));
  const errors = h('div', {});
  const num = (el) => (el.value === '' ? null : Number(el.value));

  const save = async (e) => {
    e.preventDefault();
    const parsed = parseIngredientLines(f.ings.value, sections);
    errors.replaceChildren();
    if (parsed.errors.length) {
      errors.append(h('div', { class: 'errors', role: 'alert' }, h('strong', {}, 'Fix these ingredient lines:'), h('ul', {}, parsed.errors.map((m) => h('li', {}, m)))));
      errors.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const body = {
      name: f.name.value.trim(),
      base_servings: num(f.base),
      active_min: num(f.active),
      total_min: num(f.total),
      pans: num(f.pans),
      prep_note: f.prep.value.trim(),
      ingredients: parsed.items,
      steps: f.steps.value.trim(),
      source_url: f.url.value.trim(),
      tags: tagBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value),
    };
    try {
      const res = recipe
        ? await mutate('PUT', `/api/recipes/${recipe.id}`, { ...body, expected_version: recipe.version }, { label: 'recipe' })
        : await mutate('POST', '/api/recipes', body, { label: 'recipe' });
      if (res) ctx.navigate(`#/recipes/${res.recipe.id}`);
    } catch (err) {
      errors.replaceChildren(h('div', { class: 'errors', role: 'alert' }, err.message));
    }
  };

  root.append(
    h('p', {}, h('a', { href: recipe ? `#/recipes/${recipe.id}` : '#/recipes' }, '‹ Back')),
    h('h1', {}, recipe ? 'Edit recipe' : 'New recipe'),
    h('form', { onsubmit: save },
      h('label', {}, 'Name'), f.name,
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', {}, 'Makes (servings)'), f.base),
        h('div', { class: 'grow' }, h('label', {}, 'Pans'), f.pans)),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', {}, 'Active minutes'), f.active),
        h('div', { class: 'grow' }, h('label', {}, 'Total minutes'), f.total)),
      h('label', {}, 'Tags'), h('div', { class: 'stack' }, tagBoxes),
      h('label', {}, 'Ahead of time (thawing, marinating…)'), f.prep,
      h('label', {}, 'Ingredients'),
      h('p', { class: 'field-hint', id: 'ing-help' }, `One per line: qty | unit | name | section | optional. Example: 1 1/2 | lb | chicken thighs | Meat & Seafood. Sections: ${sections.join(', ')}.`),
      f.ings,
      errors,
      h('label', {}, 'Steps (one per line)'), f.steps,
      h('label', {}, 'Source link (optional)'), f.url,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', onclick: () => ctx.navigate(recipe ? `#/recipes/${recipe.id}` : '#/recipes') }, 'Cancel'),
        h('button', { type: 'submit', class: 'primary' }, 'Save'))),
    recipe ? h('div', {}, h('hr'), h('button', { class: 'danger', onclick: async () => {
      const ok = await choose('Delete recipe?', 'If it’s on the plan, archive it instead.', [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, danger: true }]);
      if (!ok) return;
      try {
        const res = await mutate('DELETE', `/api/recipes/${recipe.id}`, { expected_version: recipe.version }, { label: 'recipe' });
        if (res) ctx.navigate('#/recipes');
      } catch {
        /* toast shown */
      }
    } }, 'Delete recipe')) : null,
  );
}
