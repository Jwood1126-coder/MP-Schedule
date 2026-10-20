// Plan: one week, Monday to Sunday. Two dinners is the goal; busy days are
// preferred but never required.
import { h, sheet, closeSheet, choose, stepper, toast } from '../ui.js';
import { mutate } from '../api.js';
import { store, recipesById, mealsOn, isPreferred, boughtForMeal } from '../store.js';
import { addDays, weekDates, prettyDate, localToday, weekStart } from '../core/dates.js';
import { proposalCard, loadInbox, inboxKey } from './proposal-card.js';

const STATUS_LABEL = { tentative: 'Idea', planned: 'Planned', cooked: 'Cooked', skipped: 'Skipped' };

export function render(root, ctx) {
  const { settings } = store.data;
  const start = store.weekStart;
  const dates = weekDates(start);
  const byId = recipesById();
  const weekMeals = dates.flatMap((d) => mealsOn(d));
  const active = weekMeals.filter((m) => m.status !== 'skipped').length;
  const target = settings.dinners_per_week;
  const today = localToday();

  const goWeek = (s) => ctx.navigate(`#/plan?w=${s}`);
  root.append(
    h('div', { class: 'header-line' },
      h('h1', {}, 'This week'),
      h('div', { class: 'week-nav' },
        h('button', { 'aria-label': 'Previous week', onclick: () => goWeek(addDays(start, -7)) }, '‹'),
        h('span', { class: 'label' }, prettyDate(start).slice(4)),
        h('button', { 'aria-label': 'Next week', onclick: () => goWeek(addDays(start, 7)) }, '›'),
        start !== weekStart(today) ? h('button', { class: 'link', onclick: () => goWeek(weekStart(today)) }, 'Today') : null)),
    h('div', { class: 'header-line' },
      h('span', { class: `progress ${active >= target ? 'done' : ''}`, 'data-testid': 'progress' }, `${active} of ${target} dinners planned`),
      h('button', { class: 'primary', onclick: () => suggest(ctx, start) }, 'Suggest dinners')),
  );

  // Alfred's proposals come first: reviewing them is the main job here.
  const inbox = store.inbox?.data;
  const waiting = inbox?.proposals || [];
  if (waiting.length) {
    root.append(proposalCard(waiting[0], {
      onDecided: (r) => {
        if (r.week_of && (r.outcome === 'accept' || r.outcome === 'partial')) ctx.navigate(`#/plan?w=${weekStart(r.week_of)}`);
        ctx.reload({ force: true });
      },
    }));
    if (waiting.length > 1) root.append(h('p', { class: 'muted small' }, `${waiting.length - 1} more plan${waiting.length > 2 ? 's' : ''} from Alfred after this one.`));
  }
  const seen = inboxKey(inbox);
  loadInbox().then((d) => {
    const onPlan = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'plan') === 'plan';
    if (inboxKey(d) !== seen && onPlan) ctx.rerender();
  });

  if (!store.data.recipes.length) {
    root.append(h('div', { class: 'panel info' },
      h('p', {}, 'No recipes yet. Add your own or load a few starter recipes to try it out.'),
      h('button', { onclick: () => ctx.navigate('#/recipes') }, 'Go to recipes')));
  }

  for (const date of dates) {
    const pref = isPreferred(date);
    const meals = mealsOn(date);
    root.append(h('section', { class: `day ${date === today ? 'today' : ''}`, 'data-date': date },
      h('div', { class: 'day-head' },
        h('span', { class: 'day-name' }, prettyDate(date)),
        h('button', {
          class: `pref-toggle ${pref.on ? 'on' : ''}`,
          'aria-pressed': pref.on ? 'true' : 'false',
          onclick: () => mutate('PUT', `/api/day-flags/${date}`, { preferred: !pref.on, expected_version: pref.version }, { label: 'day' }),
        }, pref.on ? `✓ ${settings.preferred_label}` : settings.preferred_label)),
      meals.map((m) => mealCard(m, byId[m.recipe_id], ctx)),
      h('button', { class: 'add-meal', onclick: () => pickRecipe(`Dinner for ${prettyDate(date)}`, pref.on, (r) => addMeal(date, r)) }, '+ Add dinner'),
    ));
  }
}

function mealCard(meal, recipe, ctx) {
  const name = recipe ? recipe.name : 'Recipe removed';
  const status = meal.status;
  return h('div', { class: `card meal-card ${status}`, 'data-meal': meal.id },
    h('div', { class: 'row spread' },
      h('button', { class: 'meal-title', onclick: () => ctx.navigate(`#/recipes/${meal.recipe_id}?servings=${meal.servings}`) }, name),
      h('span', { class: `chip ${status}` }, STATUS_LABEL[status])),
    h('div', { class: 'row wrap spread' },
      h('span', { class: 'row' }, h('span', { class: 'muted small' }, 'Servings'),
        stepper(meal.servings, { onChange: (v) => update(meal, { servings: v }, 'servings') })),
      recipe && recipe.active_min ? h('span', { class: 'muted small' }, `${recipe.active_min} min active`) : null),
    h('div', { class: 'actions' },
      status === 'tentative' ? h('button', { class: 'small-btn primary', onclick: () => update(meal, { status: 'planned' }, 'plan') }, 'Plan it') : null,
      status !== 'skipped'
        ? h('button', { class: 'small-btn', onclick: () => guarded(meal, 'swap', () => pickRecipe(`Swap ${name}`, false, (r) => update(meal, { recipe_id: r.id, action: 'swap' }, 'swap'))) }, 'Swap')
        : null,
      h('button', { class: 'small-btn', onclick: () => moveMeal(meal) }, 'Move'),
      status === 'skipped'
        ? h('button', { class: 'small-btn', onclick: () => update(meal, { status: 'planned' }, 'unskip') }, 'Unskip')
        : h('button', { class: 'small-btn', onclick: () => guarded(meal, 'skip', () => update(meal, { status: 'skipped', action: 'skip' }, 'skip')) }, 'Skip'),
      status === 'planned' ? h('button', { class: 'small-btn', onclick: () => update(meal, { status: 'cooked' }, 'cooked') }, 'Cooked ✓') : null,
      h('button', { class: 'small-btn danger', onclick: () => guarded(meal, 'remove', () => removeMeal(meal, name)) }, 'Remove')),
  );
}

function update(meal, patch, label) {
  return mutate('PUT', `/api/meals/${meal.id}`, { ...patch, expected_version: meal.version }, { label });
}

// After groceries for this meal were bought, explain before changing it.
async function guarded(meal, what, proceed) {
  const bought = boughtForMeal(meal);
  if (!bought || !bought.items.length || meal.status === 'skipped') return proceed();
  const list = h('ul', {}, bought.items.slice(0, 12).map((i) => h('li', {}, `${i.name}${i.display ? ` (${i.display})` : ''}`)));
  const more = bought.items.length > 12 ? h('p', { class: 'muted small' }, `…and ${bought.items.length - 12} more`) : null;
  const choice = await choose('Groceries already bought', h('div', {},
    h('p', {}, `These were bought for this dinner on the ${bought.trip.store} trip:`), list, more,
    h('p', { class: 'muted small' }, 'Moving it to another day keeps them in use. If you change it anyway, the Groceries tab shows what is left over and what you still need.')), [
    { label: 'Cancel', value: null },
    { label: 'Move it instead', value: 'move', primary: true },
    { label: `${what[0].toUpperCase()}${what.slice(1)} anyway`, value: 'go' },
  ]);
  if (choice === 'move') return moveMeal(meal);
  if (choice === 'go') {
    await proceed();
    toast('Check Groceries for what changed since shopping', 4500);
  }
  return null;
}

function moveMeal(meal) {
  const start = weekStart(meal.date);
  const days = Array.from({ length: 21 }, (_, i) => addDays(start, i - 7)).filter((d) => d !== meal.date && d >= addDays(localToday(), -7));
  sheet('Move to which day?', (close) => h('div', { class: 'option-list' },
    days.map((d) => h('button', { onclick: () => { close(); update(meal, { date: d, action: 'move' }, 'move'); } }, `${prettyDate(d)}${isPreferred(d).on ? ` · ${store.data.settings.preferred_label}` : ''}`))));
}

async function removeMeal(meal, name) {
  const ok = await choose('Remove dinner?', `${name} on ${prettyDate(meal.date)}`, [
    { label: 'Cancel', value: false },
    { label: 'Remove', value: true, danger: true },
  ]);
  if (ok) await mutate('DELETE', `/api/meals/${meal.id}`, { expected_version: meal.version }, { label: 'remove' });
}

function addMeal(date, recipe) {
  return mutate('POST', '/api/meals', { date, recipe_id: recipe.id, servings: store.data.settings.default_servings, status: 'planned' }, { label: 'dinner' });
}

// Recipe picker with search; workday-easy first on busy days.
export function pickRecipe(title, preferEasy, onPick) {
  const recipes = store.data.recipes.filter((r) => !r.archived);
  if (!recipes.length) {
    toast('Add a recipe first (Recipes tab).');
    return;
  }
  const sorted = [...recipes].sort((a, b) => {
    if (preferEasy) {
      const ea = (a.tags || []).includes('workday-easy') ? 0 : 1;
      const eb = (b.tags || []).includes('workday-easy') ? 0 : 1;
      if (ea !== eb) return ea - eb;
    }
    return a.name.localeCompare(b.name);
  });
  const list = h('div', { class: 'option-list' });
  const input = h('input', { type: 'search', placeholder: 'Search recipes', 'aria-label': 'Search recipes' });
  const draw = () => {
    list.replaceChildren(...sorted
      .filter((r) => r.name.toLowerCase().includes(input.value.trim().toLowerCase()))
      .map((r) => h('button', { onclick: () => { closeSheet(); onPick(r); } },
        h('div', { class: 'name' }, r.name),
        h('div', { class: 'muted small' }, [r.active_min ? `${r.active_min} min active` : null, (r.tags || []).join(', ')].filter(Boolean).join(' · ')))));
  };
  input.addEventListener('input', draw);
  draw();
  sheet(title, h('div', {}, input, list));
}

async function suggest(ctx, start) {
  let data;
  try {
    data = await mutate('POST', '/api/suggest', { week_start: start, today: localToday() }, { label: 'suggestions' });
  } catch {
    return;
  }
  if (!data) return;
  const byId = recipesById();
  if (!data.proposals.length) {
    toast(store.data.recipes.length ? 'Nothing to suggest: this week has enough dinners (or no days left).' : 'Add some recipes first.');
    return;
  }
  const accepted = new Set();
  const body = h('div', {});
  const draw = () => {
    body.replaceChildren(
      h('p', { class: 'muted small' }, 'Ideas only; nothing is saved until you add it.'),
      ...data.proposals.map((p, i) => h('div', { class: 'card', 'data-proposal': i },
        h('div', { class: 'row spread' },
          h('div', {}, h('div', { class: 'name' }, byId[p.recipe_id]?.name || '?'), h('div', { class: 'muted small' }, `${prettyDate(p.date)}${p.reasons.length ? ` · ${p.reasons.join(', ')}` : ''}`)),
          accepted.has(i)
            ? h('span', { class: 'chip planned' }, 'Added')
            : h('div', { class: 'row' },
              h('button', { class: 'small-btn', onclick: () => { data.proposals.splice(i, 1); draw(); } }, 'No'),
              h('button', { class: 'small-btn primary', onclick: async () => {
                const ok = await mutate('POST', '/api/meals', { date: p.date, recipe_id: p.recipe_id, servings: p.servings, status: 'planned' }, { label: 'dinner' });
                if (ok) {
                  accepted.add(i);
                  draw();
                }
              } }, 'Add'))))),
      h('div', { class: 'sheet-actions' }, h('button', { onclick: () => { closeSheet(); ctx.reload({ force: true }); } }, 'Done')),
    );
  };
  draw();
  sheet('Suggested dinners', body, { onClose: () => ctx.reload({ force: true }) });
}
