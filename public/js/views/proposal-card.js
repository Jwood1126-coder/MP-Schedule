// One of Alfred's proposals, ready to review: keep, swap to the alternate or
// skip each dinner, add a note, then Accept or Send back. The server re-reads
// the proposal and applies it; this card only sends the choices.
import { h, fill, toast } from '../ui.js';
import { mutate, get } from '../api.js';
import { store } from '../store.js';
import { prettyDate, shortDay } from '../core/dates.js';

// Choices survive re-renders (the plan refreshes every 30 s).
const drafts = new Map();

function draftFor(p) {
  if (!drafts.has(p.id)) drafts.set(p.id, { choices: (p.data?.dinners || []).map(() => 'main'), note: '' });
  return drafts.get(p.id);
}

// Fetch the Notion inbox: on first load, when the app comes back to the
// foreground (at most once a minute), otherwise at most every 5 minutes, so
// the 30-second plan refresh doesn't call Notion each time.
export function markInboxStale() {
  store.inboxStale = true;
}

export async function loadInbox({ force = false } = {}) {
  const age = store.inbox ? Date.now() - store.inbox.at : Infinity;
  const fresh = age < (store.inboxStale ? 60000 : 300000);
  if (fresh && !force) return store.inbox.data;
  store.inboxStale = false;
  if (store.inboxLoading) return store.inbox?.data || null;
  store.inboxLoading = true;
  try {
    const data = await get('/api/inbox');
    store.inbox = { at: Date.now(), data };
    return data;
  } catch {
    store.inbox = { at: Date.now(), data: store.inbox?.data || null };
    return store.inbox.data;
  } finally {
    store.inboxLoading = false;
  }
}

export function inboxKey(data) {
  return (data?.proposals || []).map((p) => p.id).join(',');
}

export function proposalCard(p, { text = null, onDecided } = {}) {
  const draft = draftFor(p);
  const data = p.data;
  const res = p.resolution || { dinners: [] };
  const card = h('div', { class: 'card proposal', 'data-proposal': p.id });

  const pickFor = (i) => {
    const r = res.dinners[i] || {};
    return draft.choices[i] === 'alternate' && r.alternate ? r.alternate : r.main;
  };

  const decide = async (outcome) => {
    const body = {
      id: p.id,
      source: p.source,
      outcome,
      note: draft.note.trim() || undefined,
      dinners: draft.choices.map((choice, index) => ({ index, choice })),
    };
    if (p.source === 'paste') body.text = text;
    let r;
    try {
      r = await mutate('POST', '/api/inbox/decide', body, { label: 'plan decision' });
    } catch {
      return;
    }
    if (!r) return;
    drafts.delete(p.id);
    const shown = (r.warnings || []).filter((w) => w !== 'notion_writeback_failed');
    if (r.outcome === 'accept' || r.outcome === 'partial') {
      const n = r.applied.meals;
      toast(`Added ${n} dinner${n === 1 ? '' : 's'}${r.applied.extras ? ` and ${r.applied.extras} grocery item${r.applied.extras === 1 ? '' : 's'}` : ''}${shown.length ? `. ${shown[0]}` : ''}`, 5000);
    } else toast(r.outcome === 'send_back' ? 'Sent back to Alfred' : 'Declined');
    if ((r.warnings || []).includes('notion_writeback_failed')) toast('Saved, but Notion wasn’t updated. Tell Alfred directly.', 6000);
    if (store.inbox?.data?.proposals) store.inbox.data.proposals = store.inbox.data.proposals.filter((x) => x.id !== p.id);
    if (onDecided) onDecided(r);
  };

  const draw = () => {
    const chosen = draft.choices.filter((c) => c !== 'skip').length;
    const blocked = (p.errors || []).length > 0;
    fill(card,
      h('div', { class: 'row spread wrap' },
        h('h2', { class: 'proposal-title' }, `Alfred’s plan${data?.week_of ? ` · week of ${prettyDate(data.week_of)}` : ''}`),
        p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Notion ↗') : null),
      data?.message ? h('p', {}, data.message) : null,
      blocked ? h('div', { class: 'errors' }, h('strong', {}, 'This plan can’t be accepted yet:'), h('ul', {}, p.errors.slice(0, 6).map((e) => h('li', {}, e)))) : null,
      (data?.dinners || []).map((d, i) => {
        const r = res.dinners[i] || {};
        const pick = pickFor(i);
        const choice = draft.choices[i];
        const set = (c) => { draft.choices[i] = c; draw(); };
        return h('div', { class: `proposal-dinner ${choice === 'skip' ? 'skipped' : ''}`, 'data-index': i },
          h('div', { class: 'body' },
            h('div', { class: 'muted small' }, d.date ? prettyDate(d.date) : '?'),
            h('div', { class: 'name' }, pick ? pick.name : d.recipe,
              pick && pick.new != null ? h('span', { class: 'chip new' }, 'new recipe') : null),
            h('div', { class: 'muted small' }, [d.servings ? `${d.servings} servings` : null, d.note || null, choice === 'alternate' ? `instead of ${d.recipe}` : null].filter(Boolean).join(' · '))),
          h('div', { class: 'choice', role: 'group', 'aria-label': `Dinner ${i + 1}` },
            h('button', { class: 'small-btn', 'aria-pressed': choice === 'main' ? 'true' : 'false', 'aria-label': `Keep ${d.recipe}`, onclick: () => set('main') }, '✓'),
            r.alternate ? h('button', { class: 'small-btn', 'aria-pressed': choice === 'alternate' ? 'true' : 'false', 'aria-label': `Use ${r.alternate.name} instead`, onclick: () => set('alternate') }, '↺') : null,
            h('button', { class: 'small-btn', 'aria-pressed': choice === 'skip' ? 'true' : 'false', 'aria-label': `Skip ${d.recipe}`, onclick: () => set('skip') }, '✕')));
      }),
      data?.busy_days?.length ? h('p', { class: 'small' }, `${store.data.settings.preferred_label}s: ${data.busy_days.map(shortDay).join(', ')}`) : null,
      data?.extras?.length ? h('p', { class: 'small' }, `${data.extras.length} extra item${data.extras.length === 1 ? '' : 's'} for the list: ${data.extras.join(', ')}`) : null,
      (p.warnings || []).length ? h('ul', { class: 'muted small warnings' }, p.warnings.slice(0, 5).map((w) => h('li', {}, w))) : null,
      h('label', { class: 'small' }, 'Note for Alfred (optional)',
        h('textarea', { rows: '2', maxlength: '500', 'aria-label': 'Note for Alfred', oninput: (e) => { draft.note = e.target.value; } }, draft.note)),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', disabled: blocked || !chosen, onclick: () => decide('accept') }, chosen === (data?.dinners || []).length ? 'Accept plan' : `Accept ${chosen} dinner${chosen === 1 ? '' : 's'}`),
        h('button', { onclick: () => decide('send_back') }, 'Send back'),
        h('button', { class: 'link', onclick: () => decide('decline') }, 'Decline')),
    );
  };
  draw();
  return card;
}
