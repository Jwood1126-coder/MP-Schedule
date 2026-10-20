import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { revisionOf } from '../src/inbox.js';

test('a revision is the first 16 hex characters of the SHA-256 of the text as read', async () => {
  const text = '{"week_of":"2026-11-09","dinners":[{"date":"2026-11-10","recipe":"Chili – spicy"}]}';
  const r = await revisionOf(text);
  assert.match(r, /^[0-9a-f]{16}$/);
  assert.equal(r, createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16));
  assert.equal(await revisionOf(text), r, 'stable');
  assert.notEqual(await revisionOf(`${text} `), r, 'any edit changes it');
});
