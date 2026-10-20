// Alfred's inbox: list proposals (from Notion), preview a pasted plan, and
// apply a decision. The proposal is always re-read on the server; the client
// only sends which dinners to keep.
//
// Applying is one D1 batch (one transaction): the decision row goes first, so
// a second "Accept" of the same proposal fails as a whole instead of adding
// dinners twice. Rows are inserted set-wise with json_each to stay well under
// D1's per-request query limit, and every row gets a change_log entry so
// History and Undo cover what Alfred added.
//
// A decision is bound to the revision the person reviewed (a hash of the
// proposal text): if Alfred edits the page in between, nothing is applied and
// the app asks for a fresh review. The decision row stores the exact Notion
// write-back payload; a failed write-back is retried later from that stored
// payload, and repeating the same decision returns the recorded result.
import { ENTITIES, HttpError, decode } from './db.js';
import { str, oneOf } from './validate.js';
import { isDate, addDays } from '../public/js/core/dates.js';
import { notionConfigured, listProposals, getProposal, markDecided, cleanId } from './notion.js';
import { parseProposal, resolveProposal, chosenDinners, proposalWeekEnd, nameKey } from '../public/js/core/proposal.js';
import { mergeSettings } from '../public/js/core/defaults.js';
import { prettyDate, shortDay } from '../public/js/core/dates.js';

const newId = () => crypto.randomUUID();
const OUTCOMES = ['accept', 'send_back', 'decline'];
const CHOICES = ['main', 'alternate', 'skip'];
const FINAL = ['accept', 'partial', 'decline'];

async function all(db, sql, ...args) {
  const { results } = await db.prepare(sql).bind(...args).all();
  return results;
}

async function loadContext(db) {
  const [recipes, settingRows] = await Promise.all([
    all(db, 'SELECT * FROM recipes ORDER BY name COLLATE NOCASE'),
    all(db, 'SELECT * FROM settings'),
  ]);
  return {
    recipes: recipes.map((r) => decode(ENTITIES.recipe, r)),
    settings: mergeSettings(settingRows.map((r) => decode(ENTITIES.setting, r))),
  };
}

async function sha16(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The revision of a proposal: a hash of its text exactly as read.
export const revisionOf = (text) => sha16(String(text ?? ''));

const MAX_WRITEBACK_ATTEMPTS = 20;
const PENDING_GRACE_MS = 20000;
const NOTION_STATUS = { accept: 'Accepted', partial: 'Partly accepted', decline: 'Declined', send_back: 'Changes requested' };

function analyse(text, ctx) {
  const parsed = parseProposal(text, { sections: ctx.settings.sections });
  const resolution = resolveProposal(parsed.data, ctx.recipes);
  return {
    data: parsed.data,
    errors: [...parsed.errors, ...resolution.errors],
    warnings: [...parsed.warnings, ...resolution.warnings],
    resolution,
  };
}

// ---------- GET /api/inbox ----------

export async function getInbox({ db, env }) {
  if (!notionConfigured(env)) return { configured: false, proposals: [], recent_decisions: await recentDecisions(db) };
  await retryWritebacks(db, env);
  let pages;
  try {
    pages = await listProposals(env);
  } catch (err) {
    if (err instanceof HttpError) {
      // Logged so setup problems are visible in Workers logs; the message never contains the token.
      console.warn('inbox: notion error', err.code, err.extra?.notion_status ?? '', err.extra?.message ?? '');
      return { configured: true, error: err.extra?.message || err.code, proposals: [], recent_decisions: await recentDecisions(db) };
    }
    throw err;
  }
  const decided = new Set(
    (await all(db, `SELECT proposal_id FROM inbox_decisions WHERE outcome IN (${FINAL.map(() => '?').join(', ')})`, ...FINAL)).map((r) => r.proposal_id),
  );
  const ctx = await loadContext(db);
  const proposals = [];
  for (const p of pages.filter((x) => !decided.has(x.id))) {
    proposals.push({ id: p.id, source: 'notion', url: p.url, title: p.title, week_of: p.week_of, revision: await revisionOf(p.text), ...analyse(p.text, ctx) });
  }
  return { configured: true, proposals, recent_decisions: await recentDecisions(db) };
}

async function recentDecisions(db) {
  return all(db, `SELECT proposal_id, title, week_of, outcome, writeback_status, writeback_error, decided_at
    FROM inbox_decisions ORDER BY decided_at DESC LIMIT 5`);
}

// Re-send stored write-backs that failed (or never finished). Uses the payload
// saved with the decision, never a re-derived one. At most two per request.
export async function retryWritebacks(db, env, { now = Date.now() } = {}) {
  if (!notionConfigured(env)) return 0;
  const rows = await all(db, `SELECT * FROM inbox_decisions
    WHERE source = 'notion' AND writeback_status IN ('pending', 'failed') AND writeback_attempts < ?
    ORDER BY decided_at LIMIT 5`, MAX_WRITEBACK_ATTEMPTS);
  let done = 0;
  for (const row of rows) {
    if (done >= 2) break;
    // A pending row this new probably still has its original request running.
    if (row.writeback_status === 'pending' && now - Date.parse(row.decided_at) < PENDING_GRACE_MS) continue;
    await writeback(db, env, row);
    done++;
  }
  return done;
}

async function writeback(db, env, row) {
  try {
    await markDecided(env, row.proposal_id, { status: row.notion_status, reply: row.reply || '', decidedBy: row.decided_by_text || '' });
    await db.prepare("UPDATE inbox_decisions SET writeback_status = 'done', writeback_attempts = writeback_attempts + 1, writeback_error = NULL WHERE proposal_id = ?")
      .bind(row.proposal_id).run();
    return 'done';
  } catch (err) {
    const msg = String(err?.extra?.message || err?.code || 'failed').slice(0, 200);
    await db.prepare("UPDATE inbox_decisions SET writeback_status = 'failed', writeback_attempts = writeback_attempts + 1, writeback_error = ? WHERE proposal_id = ?")
      .bind(msg, row.proposal_id).run();
    return 'failed';
  }
}

// ---------- POST /api/inbox/preview ----------

export async function previewInbox({ db, body }) {
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) throw new HttpError(400, 'invalid', { field: 'text', message: 'Paste the plan first.' });
  if (text.length > 60000) throw new HttpError(400, 'invalid', { field: 'text', message: 'The plan is too long.' });
  const ctx = await loadContext(db);
  const revision = await revisionOf(text);
  const id = `paste-${revision}`;
  return { proposal: { id, source: 'paste', title: 'Pasted plan', revision, ...analyse(text, ctx) } };
}

// ---------- POST /api/inbox/decide ----------

// Insert many rows of one entity with a single statement.
function bulkInsert(db, ent, rows) {
  const cols = [...ent.pk, ...ent.cols, 'version', 'updated_at', 'updated_by'];
  const select = cols.map((c) => `json_extract(j.value, '$.${c}')`).join(', ');
  return db.prepare(`INSERT INTO ${ent.table} (${cols.join(', ')}) SELECT ${select} FROM json_each(?) AS j`).bind(JSON.stringify(rows));
}

// One change_log entry per element: { id, before, after } (before/after as JSON text).
function bulkLog(db, { at, user, entity, action, op, entries }) {
  return db.prepare(`INSERT INTO change_log (at, by, entity, entity_id, action, op, before, after)
    SELECT ?, ?, ?, json_extract(j.value, '$.id'), ?, ?, json_extract(j.value, '$.before'), json_extract(j.value, '$.after')
    FROM json_each(?) AS j`).bind(at, user, entity, action, op, JSON.stringify(entries));
}

function stamp(row, user, at, version = 1) {
  return { ...row, version, updated_at: at, updated_by: user };
}

function summarise({ outcome, data, chosen, skipped, busyAdded, extrasAdded, note, recipes, warnings }) {
  const fmt = (c) => `${prettyDate(c.date)} · ${c.pick.name}${c.alternate ? ' (alternate)' : ''}${c.servings ? ` (${c.servings})` : ''}`;
  const parts = [];
  if (outcome === 'accept') {
    parts.push(`Accepted: ${chosen.map(fmt).join('; ') || 'none'}.`);
    if (skipped.length) parts.push(`Skipped: ${skipped.map((d) => `${prettyDate(d.date)} · ${d.recipe}`).join('; ')}.`);
    if (busyAdded.length) parts.push(`Busy days marked: ${busyAdded.map(shortDay).join(', ')}.`);
    if (extrasAdded.length) parts.push(`Extras added: ${extrasAdded.join(', ')}.`);
    for (const w of warnings) parts.push(w);
  } else if (outcome === 'send_back') {
    parts.push(`Sent back for changes (week of ${data?.week_of || '?'}). Nothing was added to the plan.`);
  } else {
    parts.push(`Declined (week of ${data?.week_of || '?'}). Nothing was added to the plan.`);
  }
  if (note) parts.push(`Note: ${note}`);
  let text = parts.join('\n');
  const names = recipes.filter((r) => !r.archived).map((r) => r.name);
  if (names.length) {
    let lib = `\nLibrary: ${names.join(', ')}`;
    const room = 1900 - text.length;
    if (lib.length > room) lib = room > 20 ? `${lib.slice(0, room - 1)}…` : '';
    text += lib;
  }
  return text;
}

const sameKind = (recorded, requested) => (requested === 'accept' ? recorded === 'accept' || recorded === 'partial' : recorded === requested);

function recorded(prior) {
  let result = {};
  try {
    result = JSON.parse(prior.result || '{}') || {};
  } catch {
    result = {};
  }
  return { outcome: prior.outcome, applied: { meals: 0, recipes: 0, busy_days: 0, extras: 0 }, warnings: [], week_of: prior.week_of, summary: prior.summary, ...result, writeback_status: prior.writeback_status, already: true };
}

function alreadyDecided(prior) {
  const word = { accept: 'accepted', partial: 'accepted', decline: 'declined', send_back: 'sent back' }[prior.outcome] || prior.outcome;
  return new HttpError(409, 'already_decided', {
    message: `This plan was already ${word}.`, outcome: prior.outcome, decided_by: prior.decided_by, decided_at: prior.decided_at,
  });
}

const getPrior = (db, id) => db.prepare('SELECT * FROM inbox_decisions WHERE proposal_id = ?').bind(id).first();

// The open trip the accepted dinners should be shopped on: an open trip
// overlapping the week, or a new one from max(week start, today) to the end
// of the week that doesn't overlap any existing (e.g. already-shopped) trip.
function tripForDinners({ trips, weekStart, weekEnd, today, dates, settings, user, at, warnings }) {
  const open = trips.filter((t) => t.status === 'open');
  const first = dates[0];
  const target = open.find((t) => t.start_date <= first && first <= t.end_date) || open[0];
  if (target) {
    const outside = dates.filter((d) => d < target.start_date || d > target.end_date);
    if (outside.length) warnings.push(`Some dinners fall outside the ${target.store} trip dates; adjust the trip if you’ll shop for them then.`);
    return { tripId: target.id, tripRow: null };
  }
  let start = weekStart > today ? weekStart : today;
  let end = weekEnd;
  const others = [...trips].sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (const t of others) if (t.start_date <= start && t.end_date >= start) start = addDays(t.end_date, 1);
  for (const t of others) if (t.start_date > start && t.start_date <= end) end = addDays(t.start_date, -1);
  const covered = dates.filter((d) => d >= start && d <= end);
  if (start > end || !covered.length) {
    if (trips.length) warnings.push('The grocery trip for those dinners is already shopped, so nothing was added to a list.');
    return { tripId: null, tripRow: null };
  }
  const tripId = newId();
  const tripRow = stamp({
    id: tripId, store: settings.default_store, pickup_date: start, start_date: start,
    end_date: end, status: 'open', locked_at: null, lock_id: null,
  }, user, at);
  return { tripId, tripRow };
}

export async function decideInbox({ db, env, user, body }) {
  const source = oneOf(body, 'source', ['notion', 'paste']);
  const outcome = oneOf(body, 'outcome', OUTCOMES);
  const note = str(body, 'note', { max: 500 }) || '';
  const reviewed = typeof body.revision === 'string' ? body.revision.slice(0, 64) : '';
  const today = isDate(body.today) ? body.today : new Date().toISOString().slice(0, 10);

  // Re-read the proposal; never trust a client copy.
  let id;
  let text;
  let page = null;
  if (source === 'notion') {
    id = cleanId(body.id);
    if (!id) throw new HttpError(400, 'invalid', { field: 'id', message: 'not a Notion page id' });
    page = await getProposal(env, id);
    text = page.text;
  } else {
    text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim() || text.length > 60000) throw new HttpError(400, 'invalid', { field: 'text', message: 'Paste the plan again.' });
    id = `paste-${await revisionOf(text)}`;
  }
  const revision = await revisionOf(text);

  // Repeats (double taps, lost responses, the retry queue) get the recorded result.
  const prior = await getPrior(db, id);
  if (prior && (FINAL.includes(prior.outcome) || prior.outcome === outcome)) {
    if (prior.revision && prior.revision === reviewed && sameKind(prior.outcome, outcome)) return recorded(prior);
    if (FINAL.includes(prior.outcome)) throw alreadyDecided(prior);
  }
  if (reviewed !== revision) {
    throw new HttpError(409, 'plan_changed', { message: 'This plan changed in Notion. Review the new version.' });
  }
  if (page && page.status && page.status !== 'Proposed' && page.status !== 'Changes requested') {
    throw new HttpError(409, 'already_decided', { message: `This plan is already marked “${page.status}” in Notion.` });
  }

  const ctx = await loadContext(db);
  const a = analyse(text, ctx);
  const data = a.data;
  const at = new Date().toISOString();
  const warnings = [];
  let applied = { meals: 0, recipes: 0, busy_days: 0, extras: 0 };
  let chosen = [];
  let skipped = [];
  let busyAdded = [];
  let extrasAdded = [];
  let finalOutcome = outcome;
  let addedRecipes = [];
  let tripId = null;
  const stmts = [];

  if (outcome === 'accept') {
    if (!data || a.errors.length) throw new HttpError(400, 'invalid', { message: a.errors.slice(0, 5).join(' ') || 'The plan can’t be read.', errors: a.errors });
    const choices = data.dinners.map(() => 'main');
    if (body.dinners != null) {
      if (!Array.isArray(body.dinners) || body.dinners.length > 7) throw new HttpError(400, 'invalid', { field: 'dinners' });
      for (const c of body.dinners) {
        if (!c || !Number.isInteger(c.index) || c.index < 0 || c.index >= data.dinners.length || !CHOICES.includes(c.choice)) {
          throw new HttpError(400, 'invalid', { field: 'dinners', message: 'each choice needs an index and main, alternate or skip' });
        }
        choices[c.index] = c.choice;
      }
    }
    chosen = chosenDinners(data, a.resolution, choices);
    skipped = data.dinners.filter((_, i) => choices[i] === 'skip');
    if (!chosen.length) throw new HttpError(400, 'invalid', { message: 'Choose at least one dinner, or decline the plan.' });
    finalOutcome = skipped.length ? 'partial' : 'accept';

    const weekEnd = proposalWeekEnd(data);
    const [mealsInWeek, flagsInWeek, trips] = await Promise.all([
      all(db, 'SELECT date, recipe_id FROM meals WHERE date >= ? AND date <= ?', data.week_of, weekEnd),
      all(db, 'SELECT * FROM day_flags WHERE date >= ? AND date <= ?', data.week_of, weekEnd),
      all(db, 'SELECT * FROM trips WHERE start_date <= ? AND end_date >= ? ORDER BY start_date', weekEnd, data.week_of),
    ]);

    // New recipes, only those a chosen dinner uses.
    const newIds = new Map();
    const recipeRows = [];
    for (const c of chosen) {
      if (c.pick.new == null || newIds.has(c.pick.new)) continue;
      const r = data.new_recipes[c.pick.new];
      const id2 = newId();
      newIds.set(c.pick.new, id2);
      recipeRows.push(stamp({
        id: id2, name: r.name, source_url: r.source_url, base_servings: r.base_servings, active_min: r.active_min,
        total_min: r.total_min, pans: r.pans, tags: JSON.stringify(r.tags), prep_note: r.prep_note, steps: r.steps,
        ingredients: JSON.stringify(r.ingredients), rating: null, archived: 0,
      }, user, at));
    }

    const have = new Set(mealsInWeek.map((m) => `${m.date}|${m.recipe_id}`));
    const mealRows = [];
    for (const c of chosen) {
      const recipeId = c.pick.id || newIds.get(c.pick.new);
      const key = `${c.date}|${recipeId}`;
      if (have.has(key)) {
        warnings.push(`${prettyDate(c.date)} · ${c.pick.name} was already on the plan.`);
        continue;
      }
      have.add(key);
      mealRows.push(stamp({
        id: newId(), date: c.date, recipe_id: recipeId, servings: c.servings || ctx.settings.default_servings,
        status: 'planned', note: c.note || null,
      }, user, at));
    }

    const flagByDate = Object.fromEntries(flagsInWeek.map((f) => [f.date, f]));
    const flagInserts = [];
    const flagUpdates = [];
    for (const d of data.busy_days) {
      const cur = flagByDate[d];
      if (!cur) flagInserts.push(stamp({ date: d, preferred: 1 }, user, at));
      else if (!cur.preferred) flagUpdates.push({ before: cur, after: { ...cur, preferred: 1, version: cur.version + 1, updated_at: at, updated_by: user } });
    }
    busyAdded = [...flagInserts.map((f) => f.date), ...flagUpdates.map((f) => f.after.date)].sort();

    // A grocery trip covering the chosen dinners, with or without extras.
    const dates = [...new Set(chosen.map((c) => c.date))].sort();
    const picked = tripForDinners({ trips, weekStart: data.week_of, weekEnd, today, dates, settings: ctx.settings, user, at, warnings });
    tripId = picked.tripId;
    const tripRow = picked.tripRow;
    let extraRows = [];
    if (tripId && data.extras.length) {
      const existing = tripRow ? [] : await all(db, 'SELECT text FROM extras WHERE trip_id = ?', tripId);
      const seen = new Set(existing.map((e) => nameKey(e.text)));
      for (const x of data.extras) {
        if (seen.has(nameKey(x))) continue;
        seen.add(nameKey(x));
        extraRows.push(stamp({ id: newId(), trip_id: tripId, text: x, section: 'Other', in_cart: 0 }, user, at));
      }
    } else if (data.extras.length && !tripId && !warnings.some((w) => /already shopped/.test(w))) {
      warnings.push('There was no grocery trip for those dates, so the extra items weren’t added.');
    }
    extrasAdded = extraRows.map((e) => e.text);

    const created = (rows, key = 'id') => rows.map((r) => ({ id: String(r[key]), before: null, after: JSON.stringify(r) }));
    if (recipeRows.length) {
      stmts.push(bulkInsert(db, ENTITIES.recipe, recipeRows));
      stmts.push(bulkLog(db, { at, user, entity: 'recipe', action: 'alfred', op: 'create', entries: created(recipeRows) }));
    }
    if (flagInserts.length) {
      stmts.push(bulkInsert(db, ENTITIES.day_flag, flagInserts));
      stmts.push(bulkLog(db, { at, user, entity: 'day_flag', action: 'alfred', op: 'create', entries: created(flagInserts, 'date') }));
    }
    if (flagUpdates.length) {
      const expected = flagUpdates.map((f) => ({ date: f.before.date, version: f.before.version }));
      stmts.push(db.prepare(`UPDATE day_flags SET preferred = 1, version = version + 1, updated_at = ?, updated_by = ?
        WHERE preferred = 0 AND EXISTS (SELECT 1 FROM json_each(?) AS j
          WHERE json_extract(j.value, '$.date') = day_flags.date AND json_extract(j.value, '$.version') = day_flags.version)`)
        .bind(at, user, JSON.stringify(expected)));
      stmts.push(bulkLog(db, {
        at, user, entity: 'day_flag', action: 'alfred', op: 'update',
        entries: flagUpdates.map((f) => ({ id: f.after.date, before: JSON.stringify(f.before), after: JSON.stringify(f.after) })),
      }));
    }
    if (tripRow) {
      stmts.push(bulkInsert(db, ENTITIES.trip, [tripRow]));
      stmts.push(bulkLog(db, { at, user, entity: 'trip', action: 'alfred', op: 'create', entries: created([tripRow]) }));
    }
    if (mealRows.length) {
      stmts.push(bulkInsert(db, ENTITIES.meal, mealRows));
      stmts.push(bulkLog(db, { at, user, entity: 'meal', action: 'alfred', op: 'create', entries: created(mealRows) }));
    }
    if (extraRows.length) {
      stmts.push(bulkInsert(db, ENTITIES.extra, extraRows));
      stmts.push(bulkLog(db, { at, user, entity: 'extra', action: 'alfred', op: 'create', entries: created(extraRows) }));
    }
    addedRecipes = recipeRows.map((r) => ({ name: r.name, archived: 0 }));
    applied = { meals: mealRows.length, recipes: recipeRows.length, busy_days: busyAdded.length, extras: extraRows.length };
  }

  const summary = summarise({ outcome, data, chosen, skipped, busyAdded, extrasAdded, note, recipes: [...ctx.recipes, ...addedRecipes], warnings }).slice(0, 2000);
  const notionStatus = NOTION_STATUS[finalOutcome];
  const decidedByText = `${user} · ${at.slice(0, 16).replace('T', ' ')} UTC`;
  const result = { outcome: finalOutcome, applied, warnings, week_of: data?.week_of || null, summary, trip_id: tripId };
  const decision = [
    // A sent-back plan can be decided again later; a final decision can't.
    db.prepare("DELETE FROM inbox_decisions WHERE proposal_id = ? AND outcome = 'send_back'").bind(id),
    db.prepare(`INSERT INTO inbox_decisions (proposal_id, source, week_of, outcome, decided_at, decided_by, summary,
        revision, title, writeback_status, writeback_attempts, notion_status, reply, decided_by_text, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
      .bind(id, source, data?.week_of || null, finalOutcome, at, user, summary, revision,
        (page?.title || (source === 'paste' ? 'Pasted plan' : '')).slice(0, 200) || null,
        source === 'notion' ? 'pending' : 'n/a', notionStatus, summary, decidedByText, JSON.stringify(result)),
  ];
  try {
    await db.batch([...decision, ...stmts]);
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err && err.message))) {
      // Another phone decided this at the same moment: report what was recorded.
      const now = await getPrior(db, id);
      if (now && now.revision === revision && sameKind(now.outcome, outcome)) return recorded(now);
      if (now) throw alreadyDecided(now);
      throw new HttpError(409, 'already_decided', { message: 'This plan was just decided on another phone.' });
    }
    throw err;
  }

  let writebackStatus = 'n/a';
  if (source === 'notion') {
    writebackStatus = await writeback(db, env, { proposal_id: id, notion_status: notionStatus, reply: summary, decided_by_text: decidedByText });
    if (writebackStatus === 'failed') warnings.push('notion_writeback_failed');
  }

  return { ...result, warnings, writeback_status: writebackStatus };
}
