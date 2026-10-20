// Groceries: one list per shopping trip. Build the cart by hand in the store's
// app, tick items as you go, then lock the list. After locking, the list is a
// record of what was bought; later plan changes show up as "Changes since shopping".
// This app never places orders, fills a retailer cart, or handles payment.
import { h, sheet, closeSheet, choose, prompt, toast } from '../ui.js';
import { mutate } from '../api.js';
import { store, tripList, mealsInTrip, recipesById, defaultTrip } from '../store.js';
import { listAsText } from '../core/grocery.js';
import { afterShopping } from '../core/diff.js';
import { addDays, prettyDate, localToday, isDate, shortDay } from '../core/dates.js';

const markPath = (trip, key) => `/api/trips/${trip.id}/marks/${encodeURIComponent(key)}`;

// Marks keep three choices: have (true), need to buy (false), or no choice
// (null, the default: staples count as "probably have").
function setMark(trip, item, patch, label = 'list') {
  const body = { have: item.mark_have, have_reason: item.mark_reason, in_cart: item.in_cart, ...patch, expected_version: item.mark_version };
  if (body.have !== true) body.have_reason = null;
  return mutate('PUT', markPath(trip, item.key), body, { label });
}

function sourceText(item) {
  const names = [...new Map(item.sources.map((s) => [`${s.recipe}|${s.date}`, `${s.recipe} (${shortDay(s.date)})`])).values()];
  return `for ${names.join(', ')}`;
}

export function render(root, ctx) {
  const trips = [...store.data.trips].sort((a, b) => b.start_date.localeCompare(a.start_date));
  const wanted = ctx.route.query.get('trip');
  const trip = trips.find((t) => t.id === wanted) || defaultTrip();

  root.append(h('div', { class: 'header-line' }, h('h1', {}, 'Groceries'),
    h('button', { onclick: () => newTrip(ctx) }, '+ New trip')));

  if (trips.length > 1) {
    root.append(h('div', { class: 'filters', role: 'tablist', 'aria-label': 'Trips' }, trips.slice(0, 8).map((t) => h('button', {
      class: t === trip ? 'on' : '',
      role: 'tab',
      'aria-selected': t === trip ? 'true' : 'false',
      onclick: () => ctx.navigate(`#/groceries?trip=${t.id}`),
    }, `${t.store} · ${prettyDate(t.pickup_date).slice(4)}${t.status === 'locked' ? ' ✓' : ''}`))));
  }

  if (!trip) {
    root.append(h('div', { class: 'empty' },
      h('p', {}, 'No grocery trip yet.'),
      h('p', { class: 'small' }, 'A trip covers the dinners between two pickups. Its list merges their ingredients.'),
      h('button', { class: 'primary', onclick: () => newTrip(ctx) }, 'Plan a grocery trip')));
    return;
  }

  const items = tripList(trip);
  const meals = mealsInTrip(trip).filter((m) => m.status !== 'skipped');
  const byId = recipesById();

  root.append(h('div', { class: 'card' },
    h('div', { class: 'row spread' },
      h('div', {},
        h('div', { class: 'name' }, `${trip.store} · pickup ${prettyDate(trip.pickup_date)}`),
        h('div', { class: 'muted small' }, `Covers ${prettyDate(trip.start_date)} to ${prettyDate(trip.end_date)}`)),
      trip.status === 'locked' ? h('span', { class: 'chip planned' }, 'Shopped') : h('button', { class: 'small-btn', onclick: () => editTrip(trip) }, 'Edit')),
    h('div', { class: 'muted small' }, meals.length ? `Dinners: ${meals.map((m) => `${byId[m.recipe_id]?.name || '?'} (${shortDay(m.date)})`).join(', ')}` : 'No dinners planned in these dates yet.')));

  if (trip.status === 'locked') renderLocked(root, trip, items);
  else renderOpen(root, trip, items, ctx);
}

function renderOpen(root, trip, items, ctx) {
  const buy = items.filter((i) => !i.have);
  const staples = items.filter((i) => i.have && i.have_reason === 'staple');
  const have = items.filter((i) => i.have && i.have_reason !== 'staple');
  const inCart = buy.filter((i) => i.in_cart).length + trip.extras.filter((e) => e.in_cart).length;
  const total = buy.length + trip.extras.length;

  root.append(h('div', { class: 'row wrap spread' },
    h('span', { class: 'progress', 'data-testid': 'cart-progress' }, `${inCart} of ${total} in cart`),
    h('div', { class: 'row' },
      h('button', { class: 'small-btn', onclick: () => copyList(trip, items) }, 'Copy list as text'))));

  let section = null;
  const list = h('div', { class: 'card', 'data-testid': 'buy-list' });
  if (!buy.length) list.append(h('p', { class: 'muted' }, 'Nothing to buy for these dinners yet.'));
  for (const item of buy) {
    if (item.section !== section) {
      section = item.section;
      list.append(h('div', { class: 'section-title' }, section));
    }
    list.append(itemRow(trip, item));
  }
  root.append(list);

  // Extras: anything else for this trip.
  const extraInput = h('input', { type: 'text', placeholder: 'Add item: paper towels, milk…', 'aria-label': 'Add another item', maxlength: '120' });
  root.append(h('h2', {}, 'Other items'), h('div', { class: 'card', 'data-testid': 'extras' },
    trip.extras.map((e) => h('div', { class: `item ${e.in_cart ? 'in-cart' : ''}` },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!e.in_cart, 'aria-label': `${e.text} in cart`, onchange: (ev) => mutate('PUT', `/api/extras/${e.id}`, { in_cart: ev.target.checked, expected_version: e.version }, { label: 'item' }) })),
      h('div', { class: 'body' }, h('div', { class: 'name' }, e.text)),
      h('button', { class: 'small-btn', 'aria-label': `Remove ${e.text}`, onclick: () => mutate('DELETE', `/api/extras/${e.id}`, { expected_version: e.version }, { label: 'item' }) }, '✕'))),
    h('form', { class: 'row', onsubmit: async (ev) => {
      ev.preventDefault();
      const text = extraInput.value.trim();
      if (!text) return;
      extraInput.value = '';
      await mutate('POST', `/api/trips/${trip.id}/extras`, { text }, { label: 'item' });
    } }, extraInput, h('button', { type: 'submit' }, 'Add'))));

  if (staples.length) {
    root.append(h('h2', {}, 'Probably have: check the pantry'), h('div', { class: 'card', 'data-testid': 'staples' }, staples.map((i) => h('div', { class: 'item' },
      h('div', { class: 'body' }, h('div', { class: 'name' }, i.name), h('div', { class: 'sources' }, `${i.text ? `${i.text} · ` : ''}${sourceText(i)}`)),
      h('button', { class: 'small-btn', onclick: () => setMark(trip, i, { have: false, have_reason: null }) }, 'Need to buy')))));
  }
  if (have.length) {
    root.append(h('h2', {}, 'Have / skipping'), h('div', { class: 'card', 'data-testid': 'have-list' }, have.map((i) => h('div', { class: 'item' },
      h('div', { class: 'body' }, h('div', { class: 'name' }, i.name),
        h('div', { class: 'sources' }, `${i.have_reason === 'skip' ? 'Skipping' : i.have_reason === 'have' ? 'Already have' : i.have_reason} · ${i.text ? `${i.text} · ` : ''}${sourceText(i)}`)),
      h('button', { class: 'small-btn', onclick: () => setMark(trip, i, { have: null, have_reason: null }) }, 'Undo')))));
  }

  root.append(h('div', { class: 'panel info' },
    h('p', {}, 'Add these to your cart in the store’s app or website yourself, then lock the list. Locking keeps a record of what you bought.'),
    h('button', { class: 'primary', disabled: !buy.length && !trip.extras.length, onclick: () => lock(trip, buy.length) }, 'I built the cart: lock list')));
}

function itemRow(trip, item) {
  const details = h('div', { class: 'sources', hidden: true },
    h('div', {}, sourceText(item)),
    item.sources.some((s) => s.note) ? h('div', {}, item.sources.filter((s) => s.note).map((s) => s.note).join('; ')) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'small-btn', onclick: () => setMark(trip, item, { have: true, have_reason: 'have', in_cart: false }) }, 'Have it'),
      h('button', { class: 'small-btn', onclick: () => setMark(trip, item, { have: true, have_reason: 'skip', in_cart: false }) }, 'Skip it')));
  return h('div', { class: `item ${item.in_cart ? 'in-cart' : ''}`, 'data-key': item.key },
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox',
      checked: item.in_cart,
      'aria-label': `${item.name} in cart`,
      onchange: (e) => setMark(trip, item, { in_cart: e.target.checked }, 'cart'),
    })),
    h('div', { class: 'body' },
      h('div', {}, h('span', { class: 'name' }, item.name), item.text ? h('span', { class: 'qty' }, ` · ${item.text}`) : null, item.optional ? h('span', { class: 'chip' }, ' optional') : null),
      h('button', { class: 'more', 'aria-expanded': 'false', onclick: (e) => {
        details.hidden = !details.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!details.hidden));
      } }, `${item.sources.length > 1 ? `${item.sources.length} dinners` : item.sources[0].recipe} ▾`),
      details));
}

async function lock(trip, count) {
  const ok = await choose('Lock the list?', `This saves a record of the ${count} item${count === 1 ? '' : 's'} you bought for these dinners. You can still mark items out of stock or substituted afterward.`, [
    { label: 'Cancel', value: false },
    { label: 'Lock list', value: true, primary: true },
  ]);
  if (ok) {
    const r = await mutate('POST', `/api/trips/${trip.id}/lock`, { expected_version: trip.version }, { label: 'lock' });
    if (r) toast('List locked. Enjoy your dinners!');
  }
}

function renderLocked(root, trip, items) {
  const diff = afterShopping(trip.snapshot, items);
  if (diff.stillNeed.length || diff.boughtUnused.length) {
    root.append(h('div', { class: 'panel changes', 'data-testid': 'changes' },
      h('h3', {}, 'Changes since shopping'),
      diff.stillNeed.length ? h('div', {},
        h('strong', {}, 'Still need'),
        h('ul', {}, diff.stillNeed.map((i) => h('li', {}, `${i.name}${i.missingText ? ` (${i.missingText}${i.partial ? ' more' : ''})` : ''} · ${sourceText(i)}`)))) : null,
      diff.boughtUnused.length ? h('div', {},
        h('strong', {}, 'Bought but no longer planned'),
        h('ul', {}, diff.boughtUnused.map((i) => h('li', {}, `${i.name}${i.leftoverText ? ` (${i.leftoverText}${i.wholeItem ? '' : ' extra'})` : ''}${i.sources.length ? ` · was for ${[...new Set(i.sources.map((s) => s.recipe))].join(', ')}` : ''}`))),
        h('p', { class: 'small muted' }, 'Use it in another dinner, move a dinner back, or freeze it if it keeps.')) : null));
  }
  const ext = trip.extras;
  root.append(h('div', { class: 'row wrap spread' },
    h('span', { class: 'muted small' }, `Locked ${prettyDate(localToday(new Date(trip.locked_at)))}. Mark anything that was out of stock or substituted.`),
    h('button', { class: 'small-btn', onclick: () => copyList(trip, items) }, 'Copy list as text')));
  const card = h('div', { class: 'card', 'data-testid': 'snapshot' });
  let section = null;
  for (const s of trip.snapshot.slice().sort((a, b) => sectionOrder(a.section) - sectionOrder(b.section) || a.name.localeCompare(b.name))) {
    if (s.section !== section) {
      section = s.section;
      card.append(h('div', { class: 'section-title' }, section));
    }
    card.append(h('div', { class: 'item' },
      h('div', { class: 'body' },
        h('div', {}, h('span', { class: 'name' }, s.name), s.display ? h('span', { class: 'qty' }, ` · ${s.display}`) : null),
        s.purchase === 'substituted' && s.sub_note ? h('div', { class: 'sources' }, `Substituted: ${s.sub_note}`) : null),
      h('div', { class: 'purchase', role: 'group', 'aria-label': `${s.name} purchase` },
        ['bought', 'out', 'substituted'].map((p) => h('button', {
          class: s.purchase === p ? 'on' : '',
          'aria-pressed': s.purchase === p ? 'true' : 'false',
          onclick: () => setPurchase(trip, s, p),
        }, { bought: 'Got', out: 'Out', substituted: 'Sub' }[p])))));
  }
  if (!trip.snapshot.length) card.append(h('p', { class: 'muted' }, 'No dinner ingredients were on this list.'));
  root.append(card);
  if (ext.length) {
    root.append(h('h2', {}, 'Other items'), h('div', { class: 'card' }, ext.map((e) => h('div', { class: 'item' }, h('div', { class: 'body' }, h('div', { class: 'name' }, e.text))))));
  }
}

function sectionOrder(section) {
  const i = store.data.settings.sections.indexOf(section);
  return i === -1 ? 99 : i;
}

async function setPurchase(trip, s, purchase) {
  const body = { purchase, expected_version: s.version };
  if (purchase === 'substituted') {
    const note = await prompt('What did you get instead?', { value: s.sub_note || '', placeholder: 'e.g. store-brand beans' });
    if (note === null) return;
    body.sub_note = note;
  }
  await mutate('PATCH', `/api/trips/${trip.id}/snapshot/${encodeURIComponent(s.item_key)}`, body, { label: 'purchase' });
}

async function copyList(trip, items) {
  const text = listAsText(items, trip.extras, { title: `${trip.store}: pickup ${prettyDate(trip.pickup_date)}` });
  try {
    await navigator.clipboard.writeText(text);
    toast('List copied');
  } catch {
    // Clipboard blocked: show the text so it can be selected by hand.
    sheet('Copy this list', h('textarea', { readonly: true, rows: '14', 'aria-label': 'Grocery list text' }, text));
  }
}

function tripForm(initial, onSubmit) {
  const { stores, default_store: defaultStore } = store.data.settings;
  const known = stores.includes(initial.store);
  const storeSel = h('select', { 'aria-label': 'Store' }, [...stores, 'Other…'].map((s) => h('option', { value: s, selected: known ? s === initial.store : s === 'Other…' }, s)));
  const otherInput = h('input', { type: 'text', placeholder: 'Store name', value: known ? '' : initial.store, hidden: known, 'aria-label': 'Other store' });
  storeSel.addEventListener('change', () => {
    otherInput.hidden = storeSel.value !== 'Other…';
  });
  const pickup = h('input', { type: 'date', value: initial.pickup_date, required: true });
  const startIn = h('input', { type: 'date', value: initial.start_date, required: true });
  const endIn = h('input', { type: 'date', value: initial.end_date, required: true });
  pickup.addEventListener('change', () => {
    if (isDate(pickup.value)) {
      startIn.value = pickup.value;
      endIn.value = addDays(pickup.value, 6);
    }
  });
  if (!initial.store) storeSel.value = defaultStore;
  return h('form', { onsubmit: (e) => {
    e.preventDefault();
    const storeName = storeSel.value === 'Other…' ? otherInput.value.trim() : storeSel.value;
    if (!storeName) return toast('Enter a store name');
    onSubmit({ store: storeName, pickup_date: pickup.value, start_date: startIn.value, end_date: endIn.value });
    return null;
  } },
  h('label', {}, 'Store'), storeSel, otherInput,
  h('label', {}, 'Pickup date'), pickup,
  h('label', {}, 'Dinners from'), startIn,
  h('label', {}, 'through'), endIn,
  h('p', { class: 'field-hint' }, 'The list includes dinners in these dates.'),
  h('div', { class: 'sheet-actions' }, h('button', { type: 'button', onclick: closeSheet }, 'Cancel'), h('button', { type: 'submit', class: 'primary' }, 'Save')));
}

function newTrip(ctx) {
  const trips = store.data.trips;
  const today = localToday();
  const latestEnd = trips.map((t) => t.end_date).sort().pop();
  const pickup = latestEnd && latestEnd >= today ? addDays(latestEnd, 1) : today;
  sheet('New grocery trip', tripForm({ store: '', pickup_date: pickup, start_date: pickup, end_date: addDays(pickup, 6) }, async (values) => {
    try {
      const r = await mutate('POST', '/api/trips', values, { label: 'trip' });
      if (r) {
        closeSheet();
        ctx.navigate(`#/groceries?trip=${r.trip.id}`);
      }
    } catch {
      /* toast shown */
    }
  }));
}

function editTrip(trip) {
  sheet('Edit trip', h('div', {},
    tripForm(trip, async (values) => {
      try {
        const r = await mutate('PUT', `/api/trips/${trip.id}`, { ...values, expected_version: trip.version }, { label: 'trip' });
        if (r) closeSheet();
      } catch {
        /* toast shown */
      }
    }),
    h('hr'),
    h('button', { class: 'danger', onclick: async () => {
      closeSheet();
      const ok = await choose('Delete this trip?', 'Its list and checkmarks go away. Dinners stay on the plan.', [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, danger: true }]);
      if (ok) await mutate('DELETE', `/api/trips/${trip.id}`, { expected_version: trip.version }, { label: 'trip' });
    } }, 'Delete trip')));
}
