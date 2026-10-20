import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listProposals, getProposal, markDecided, richText, blocksToText, notionConfigured, cleanId } from '../src/notion.js';

const DB = '9fc2e5b1516f4212852510241783c0ad';
const PAGE = '3ffe5852-471e-8165-94d6-db7f43f59d44';
const ENV = { NOTION_TOKEN: 'secret_test_token', NOTION_INBOX_DB: DB };

const rt = (s) => [{ plain_text: s }];
const page = {
  id: PAGE,
  url: 'https://www.notion.so/x',
  parent: { type: 'database_id', database_id: '9fc2e5b1-516f-4212-8525-10241783c0ad' },
  properties: {
    Name: { title: rt('Week of Nov 2') },
    'Week of': { date: { start: '2026-11-02' } },
    Status: { select: { name: 'Proposed' } },
  },
};
const blocks = {
  results: [
    { type: 'paragraph', paragraph: { rich_text: rt('Hi Jacob') } },
    { type: 'code', code: { rich_text: [{ plain_text: '{"week_of":' }, { plain_text: '"2026-11-02"}' }] } },
  ],
};

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, ...opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    for (const [match, reply] of routes) {
      if (url.includes(match)) return { ok: reply.status ? reply.status < 400 : true, status: reply.status || 200, json: async () => reply.body };
    }
    return { ok: false, status: 404, json: async () => ({ code: 'object_not_found' }) };
  };
  fn.calls = calls;
  return fn;
}

test('config and ids', () => {
  assert.equal(notionConfigured({}), false);
  assert.equal(notionConfigured(ENV), true);
  assert.equal(cleanId(PAGE), '3ffe5852471e816594d6db7f43f59d44');
  assert.equal(cleanId('../etc'), null);
});

test('listProposals queries Proposed pages and reads code blocks', async () => {
  const fetchImpl = mockFetch([[`/databases/${DB}/query`, { body: { results: [page] } }], ['/blocks/', { body: blocks }]]);
  const list = await listProposals(ENV, { fetchImpl });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Week of Nov 2');
  assert.equal(list[0].week_of, '2026-11-02');
  assert.equal(list[0].text, '{"week_of":"2026-11-02"}', 'code blocks win over paragraphs');
  const q = fetchImpl.calls[0];
  assert.equal(q.method, 'POST');
  assert.deepEqual(q.body.filter, { property: 'Status', select: { equals: 'Proposed' } });
  assert.equal(q.headers['Notion-Version'], '2022-06-28');
  assert.equal(q.headers.Authorization, 'Bearer secret_test_token');
  assert.equal(fetchImpl.calls.length, 2, 'one query + one children call per page');
});

test('getProposal only accepts pages in the inbox database', async () => {
  const ok = mockFetch([['/pages/', { body: page }], ['/blocks/', { body: blocks }]]);
  assert.equal((await getProposal(ENV, PAGE, { fetchImpl: ok })).status, 'Proposed');
  const other = mockFetch([['/pages/', { body: { ...page, parent: { type: 'database_id', database_id: 'aa'.repeat(16) } } }]]);
  await assert.rejects(getProposal(ENV, PAGE, { fetchImpl: other }), /invalid/);
});

test('markDecided sends Status, chunked Reply and Decided by', async () => {
  const fetchImpl = mockFetch([['/pages/', { body: {} }]]);
  await markDecided(ENV, PAGE, { status: 'Accepted', reply: 'x'.repeat(2500), decidedBy: 'a@example.com' }, { fetchImpl });
  const c = fetchImpl.calls[0];
  assert.equal(c.method, 'PATCH');
  assert.deepEqual(c.body.properties.Status, { select: { name: 'Accepted' } });
  const parts = c.body.properties.Reply.rich_text;
  assert.ok(parts.every((p) => p.text.content.length <= 2000));
  assert.equal(parts.map((p) => p.text.content).join('').length, 1900, 'reply capped at 1900 chars');
  assert.equal(richText('a'.repeat(4500), 5000).length, 3);
});

test('errors never echo the token; missing token is not_configured', async () => {
  const fetchImpl = mockFetch([['/databases/', { status: 401, body: { code: 'unauthorized', message: 'API token is invalid.' } }]]);
  await assert.rejects(listProposals(ENV, { fetchImpl }), (err) => {
    assert.equal(err.code, 'notion_unavailable');
    assert.doesNotMatch(JSON.stringify(err.extra), /secret_test_token/);
    assert.match(err.extra.message, /NOTION_TOKEN/);
    return true;
  });
  await assert.rejects(listProposals({ NOTION_INBOX_DB: DB }, { fetchImpl }), (err) => err.code === 'notion_not_configured');
  const down = async () => { throw new Error('ECONNRESET secret_test_token'); };
  await assert.rejects(listProposals(ENV, { fetchImpl: down }), (err) => err.code === 'notion_unavailable' && !/secret/.test(err.extra.message));
});

test('blocksToText falls back to paragraph text', () => {
  assert.equal(blocksToText([{ type: 'paragraph', paragraph: { rich_text: rt('{"a":1}') } }]), '{"a":1}');
  assert.equal(blocksToText(null), '');
});
