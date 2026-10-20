// Small input validators. Each returns the clean value or throws a 400.
import { HttpError } from './db.js';
import { isDate } from '../public/js/core/dates.js';

const bad = (field, msg) => new HttpError(400, 'invalid', { field, message: msg });

export function str(body, field, { max = 200, required = false, nullable = true } = {}) {
  const v = body[field];
  if (v == null || v === '') {
    if (required) throw bad(field, 'is required');
    return nullable ? null : '';
  }
  if (typeof v !== 'string') throw bad(field, 'must be text');
  const s = v.trim();
  if (required && !s) throw bad(field, 'is required');
  if (s.length > max) throw bad(field, `must be at most ${max} characters`);
  return s;
}

export function int(body, field, { min = 0, max = 1000, required = false } = {}) {
  const v = body[field];
  if (v == null || v === '') {
    if (required) throw bad(field, 'is required');
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(field, `must be a whole number from ${min} to ${max}`);
  return n;
}

export function flag(body, field) {
  const v = body[field];
  if (v === true || v === 1) return 1;
  if (v === false || v === 0 || v == null) return 0;
  throw bad(field, 'must be true or false');
}

export function date(body, field, { required = true } = {}) {
  const v = body[field];
  if (v == null || v === '') {
    if (required) throw bad(field, 'is required');
    return null;
  }
  if (!isDate(v)) throw bad(field, 'must be a date like 2026-10-20');
  return v;
}

export function oneOf(body, field, values, { required = true, fallback } = {}) {
  const v = body[field];
  if (v == null || v === '') {
    if (required && fallback === undefined) throw bad(field, 'is required');
    return fallback ?? null;
  }
  if (!values.includes(v)) throw bad(field, `must be one of: ${values.join(', ')}`);
  return v;
}

export function expectedVersion(body) {
  const v = body.expected_version;
  if (!Number.isInteger(v) || v < 0) throw bad('expected_version', 'is required (a whole number)');
  return v;
}

export function url(body, field) {
  const s = str(body, field, { max: 500 });
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad(field, 'must be a web address');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(field, 'must start with http:// or https://');
  return u.toString();
}

export function stringList(value, field, { maxItems = 50, maxLen = 60 } = {}) {
  if (!Array.isArray(value)) throw bad(field, 'must be a list');
  if (value.length > maxItems) throw bad(field, `can have at most ${maxItems} items`);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') throw bad(field, 'items must be text');
    const s = item.trim();
    if (!s) continue;
    if (s.length > maxLen) throw bad(field, `items must be at most ${maxLen} characters`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
