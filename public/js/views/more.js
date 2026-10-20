// More: settings, history with undo, backup and restore.
import { h, choose, toast, dateTimeOf, personName } from '../ui.js';
import { mutate, get } from '../api.js';
import { store, recipesById } from '../store.js';
import { prettyDate } from '../core/dates.js';

export function render(root, ctx) {
  if (ctx.route.parts[0] === 'history') return history(root, ctx);
  const { settings, settings_versions: versions = {}, me } = store.data;
  ctx.preserve();

  const save = (key, value) => mutate('PUT', `/api/settings/${key}`, { value, expected_version: versions[key] || 0 }, { label: 'setting' }).then((r) => {
    if (r) toast('Saved');
  }).catch(() => {});
  const lines = (s) => s.split(/\n/).map((x) => x.trim()).filter(Boolean);

  const label = h('input', { type: 'text', value: settings.preferred_label, maxlength: '30' });
  const perWeek = h('input', { type: 'number', min: '1', max: '7', value: settings.dinners_per_week, inputmode: 'numeric' });
  const servings = h('input', { type: 'number', min: '1', max: '20', value: settings.default_servings, inputmode: 'numeric' });
  const stores = h('textarea', { rows: '4' }, settings.stores.join('\n'));
  const defStore = h('select', {}, settings.stores.map((s) => h('option', { value: s, selected: s === settings.default_store }, s)));
  const sections = h('textarea', { rows: '9' }, settings.sections.join('\n'));
  const staples = h('textarea', { rows: '8' }, settings.staples.join('\n'));
  const field = (title, input, onSave, hint) => h('div', { class: 'card' },
    h('label', {}, title), input, hint ? h('p', { class: 'field-hint' }, hint) : null,
    h('div', { class: 'actions' }, h('button', { class: 'small-btn', onclick: onSave }, 'Save')));

  root.append(
    h('h1', {}, 'More'),
    h('p', { class: 'muted' }, `Signed in as ${me.email}${me.dev ? ' (local development)' : ''}`),
    h('div', { class: 'actions' }, h('button', { onclick: () => ctx.navigate('#/more/history') }, 'History and undo')),
    h('h2', {}, 'Settings'),
    field('Name for preferred days', label, () => save('preferred_label', label.value.trim()), 'Shown on each day, e.g. “Busy day”. Preferred, never required.'),
    field('Dinners per week', perWeek, () => save('dinners_per_week', Number(perWeek.value))),
    field('Default servings', servings, () => save('default_servings', Number(servings.value))),
    field('Stores (one per line)', stores, () => save('stores', lines(stores.value))),
    field('Default store', defStore, () => save('default_store', defStore.value)),
    field('Store sections, in shopping order (one per line)', sections, () => save('sections', lines(sections.value))),
    field('Pantry staples (one per line)', staples, () => save('staples', lines(staples.value)), 'These show as “probably have” instead of on the buy list.'),
    h('h2', {}, 'Backup'),
    h('div', { class: 'card' },
      h('p', {}, 'Download everything as a file. Keep it private: it contains your plans.'),
      h('div', { class: 'actions' },
        h('button', { onclick: download }, 'Download backup'),
        h('label', { class: 'btn', style: null }, 'Restore from backup…', h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: (e) => restore(e.target.files[0], e.target) })))),
    h('p', { class: 'muted small' }, 'Dinners never places orders or handles payment. Build your cart in the store’s own app.'),
  );
  return null;
}

async function download() {
  try {
    const data = await get('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dinners-backup-${data.exported_at.slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    toast('Couldn’t download the backup. Try again when online.');
  }
}

async function restore(file, input) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('That file isn’t a backup.');
    input.value = '';
    return;
  }
  const ok = await choose('Replace everything?', `This replaces all recipes, plans and lists with the backup from ${data.exported_at ? dateTimeOf(data.exported_at) : 'that file'}. Download a backup first if unsure.`, [
    { label: 'Cancel', value: false },
    { label: 'Replace everything', value: true, danger: true },
  ]);
  input.value = '';
  if (!ok) return;
  try {
    const r = await mutate('POST', '/api/import', { confirm: 'REPLACE', data }, { label: 'restore' });
    if (r) toast('Backup restored');
  } catch {
    /* toast shown */
  }
}

function describe(e, byId) {
  const row = e.after || e.before || {};
  switch (e.entity) {
    case 'meal': {
      const name = byId[row.recipe_id]?.name || 'dinner';
      if (e.op === 'update' && e.before && e.after) {
        const changes = [];
        if (e.before.recipe_id !== e.after.recipe_id) changes.push(`swapped from ${byId[e.before.recipe_id]?.name || 'another recipe'}`);
        if (e.before.date !== e.after.date) changes.push(`moved from ${prettyDate(e.before.date)}`);
        if (e.before.servings !== e.after.servings) changes.push(`servings ${e.before.servings} → ${e.after.servings}`);
        if (e.before.status !== e.after.status) changes.push(`${e.before.status} → ${e.after.status}`);
        return `${name} on ${prettyDate(row.date)}: ${changes.join(', ') || 'edited'}`;
      }
      return `${e.op === 'create' ? 'Added' : 'Removed'} ${name} on ${prettyDate(row.date)}`;
    }
    case 'recipe':
      return `${e.op === 'create' ? 'Added' : e.op === 'delete' ? 'Deleted' : 'Edited'} recipe ${row.name}`;
    case 'day_flag':
      return `${prettyDate(row.date)} ${row.preferred ? 'marked' : 'unmarked'} as preferred`;
    case 'trip':
      return e.action === 'lock' ? `Locked the ${row.store} list` : `${e.op === 'create' ? 'Planned' : e.op === 'delete' ? 'Deleted' : 'Edited'} ${row.store} trip (${prettyDate(row.pickup_date)})`;
    case 'trip_mark':
      return `${row.item_key.split('|')[0]}: ${row.have ? (row.have_reason === 'skip' ? 'skipping' : 'have it') : row.have === 0 ? 'need to buy' : row.in_cart ? 'in cart' : 'not in cart'}`;
    case 'extra':
      return `${e.op === 'delete' ? 'Removed' : e.op === 'create' ? 'Added' : 'Updated'} ${row.text}`;
    case 'snapshot_item':
      return `${row.name}: ${row.purchase}`;
    case 'setting':
      return `Changed setting ${row.key}`;
    case 'all':
      return 'Restored from backup';
    default:
      return `${e.entity} ${e.action}`;
  }
}

async function history(root, ctx) {
  root.append(h('p', {}, h('a', { href: '#/more' }, '‹ More')), h('h1', {}, 'History'));
  const box = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading…'));
  root.append(box);
  let data;
  try {
    data = await get('/api/history?limit=50');
  } catch {
    box.replaceChildren(h('p', {}, 'Couldn’t load history.'));
    return;
  }
  const byId = recipesById();
  const me = store.data.me.email;
  if (!data.entries.length) {
    box.replaceChildren(h('p', { class: 'muted' }, 'No changes yet.'));
    return;
  }
  box.replaceChildren(...data.entries.map((e) => h('div', { class: 'history-entry row spread' },
    h('div', { class: 'grow' }, h('div', {}, describe(e, byId)), h('div', { class: 'muted small' }, `${e.by === me ? 'You' : personName(e.by)} · ${dateTimeOf(e.at)}${e.action === 'undo' ? ' · undo' : ''}`)),
    ['lock', 'import'].includes(e.action) || e.entity === 'all' ? null : h('button', { class: 'small-btn', onclick: async () => {
      try {
        const r = await mutate('POST', `/api/undo/${e.id}`, {}, { label: 'undo' });
        if (r) {
          toast('Undone');
          ctx.navigate('#/more/history');
        }
      } catch {
        /* toast shown */
      }
    } }, 'Undo'))));
}
