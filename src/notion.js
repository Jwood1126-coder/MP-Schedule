// Notion "Meal plan inbox": Alfred posts proposals as database pages; the app
// reads them and writes the outcome back. Uses the public REST API with an
// internal-integration token (Worker secret NOTION_TOKEN).
//
// Workers Free allows 50 external subrequests per request: listing makes
// 1 + (one per proposal, at most 5) calls; a decision makes at most 3.
import { HttpError } from './db.js';

const BASE = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const TIMEOUT_MS = 8000;
const RICH_TEXT_CHUNK = 2000;
const REPLY_MAX = 1900;

const ID_RE = /^[0-9a-f]{32}$/;

export function notionConfigured(env) {
  return !!(env && env.NOTION_TOKEN && env.NOTION_INBOX_DB);
}

// Notion ids come with or without dashes; normalise to 32 hex characters.
export function cleanId(id) {
  const s = String(id ?? '').replace(/-/g, '').toLowerCase();
  return ID_RE.test(s) ? s : null;
}

async function call(env, method, path, body, fetchImpl) {
  if (!notionConfigured(env)) throw new HttpError(503, 'notion_not_configured', { message: 'Alfred inbox is not connected (add the NOTION_TOKEN secret).' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new HttpError(502, 'notion_unavailable', { message: 'Couldn’t reach Notion. Try again in a moment.' });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    // Notion's own error codes are safe to show; never echo headers or the token.
    const code = data && typeof data.code === 'string' ? data.code.slice(0, 60) : `http_${res.status}`;
    const hint = res.status === 401 ? ' Check the NOTION_TOKEN secret.'
      : res.status === 404 ? ' Share the Meal plan inbox with the integration (••• → Connections).' : '';
    throw new HttpError(502, 'notion_unavailable', { message: `Notion said ${code}.${hint}`, notion_status: res.status });
  }
  return data;
}

function plain(richText) {
  return (Array.isArray(richText) ? richText : []).map((t) => (t && typeof t.plain_text === 'string' ? t.plain_text : '')).join('');
}

function prop(page, name) {
  return page && page.properties ? page.properties[name] : null;
}

function pageSummary(page) {
  const titleProp = prop(page, 'Name');
  const week = prop(page, 'Week of');
  const status = prop(page, 'Status');
  return {
    id: cleanId(page.id),
    url: typeof page.url === 'string' && page.url.startsWith('https://') ? page.url : null,
    title: plain(titleProp && titleProp.title).slice(0, 200),
    week_of: week && week.date && typeof week.date.start === 'string' ? week.date.start.slice(0, 10) : null,
    status: status && status.select ? status.select.name : null,
  };
}

// Code blocks hold the JSON; fall back to all text when there are none.
export function blocksToText(blocks) {
  const code = [];
  const other = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b.type !== 'string') continue;
    const content = b[b.type];
    const text = plain(content && content.rich_text);
    if (!text) continue;
    if (b.type === 'code') code.push(text);
    else other.push(text);
  }
  return (code.length ? code : other).join('\n');
}

async function pageText(env, id, fetchImpl) {
  const data = await call(env, 'GET', `/blocks/${id}/children?page_size=100`, undefined, fetchImpl);
  return blocksToText(data && data.results);
}

export async function listProposals(env, { fetchImpl = fetch } = {}) {
  const db = cleanId(env.NOTION_INBOX_DB);
  if (!db) throw new HttpError(503, 'notion_not_configured', { message: 'NOTION_INBOX_DB is not a Notion database id.' });
  const data = await call(env, 'POST', `/databases/${db}/query`, {
    filter: { property: 'Status', select: { equals: 'Proposed' } },
    sorts: [{ property: 'Week of', direction: 'ascending' }],
    page_size: 5,
  }, fetchImpl);
  const pages = (data && Array.isArray(data.results) ? data.results : []).slice(0, 5);
  const out = [];
  for (const page of pages) {
    const summary = pageSummary(page);
    if (!summary.id) continue;
    out.push({ ...summary, text: await pageText(env, summary.id, fetchImpl) });
  }
  return out;
}

export async function getProposal(env, id, { fetchImpl = fetch } = {}) {
  const pageId = cleanId(id);
  if (!pageId) throw new HttpError(400, 'invalid', { field: 'id', message: 'not a Notion page id' });
  const page = await call(env, 'GET', `/pages/${pageId}`, undefined, fetchImpl);
  // Only pages in the configured inbox database count as proposals.
  const parent = page && page.parent;
  if (!parent || parent.type !== 'database_id' || cleanId(parent.database_id) !== cleanId(env.NOTION_INBOX_DB)) {
    throw new HttpError(400, 'invalid', { message: 'That page isn’t in the Meal plan inbox.' });
  }
  return { ...pageSummary(page), text: await pageText(env, pageId, fetchImpl) };
}

export function richText(text, max = REPLY_MAX) {
  const s = String(text ?? '').slice(0, max);
  const parts = [];
  for (let i = 0; i < s.length; i += RICH_TEXT_CHUNK) parts.push({ type: 'text', text: { content: s.slice(i, i + RICH_TEXT_CHUNK) } });
  return parts;
}

export async function markDecided(env, id, { status, reply, decidedBy }, { fetchImpl = fetch } = {}) {
  const pageId = cleanId(id);
  if (!pageId) throw new HttpError(400, 'invalid', { field: 'id' });
  return call(env, 'PATCH', `/pages/${pageId}`, {
    properties: {
      Status: { select: { name: status } },
      Reply: { rich_text: richText(reply) },
      'Decided by': { rich_text: richText(decidedBy, 200) },
    },
  }, fetchImpl);
}
