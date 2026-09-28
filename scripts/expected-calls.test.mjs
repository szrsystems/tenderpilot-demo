// Run: node --test scripts/expected-calls.test.mjs
// aipalyazo/expected-calls.json — officially announced, not-yet-open calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const expected = load('../aipalyazo/expected-calls.json');
const live = load('../aipalyazo/grants_live.json');
const FIELDS = ['id', 'title', 'programme', 'expectedWindow', 'audience', 'amountHint', 'source', 'sourceNote', 'addedAt'];
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(\d+\. kor\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const codeKey = (c) => String(c || '').toLowerCase().replace(/plusz/g, '').replace(/[^a-z0-9]/g, '');

test('every expected call has all fields, an https official source and a short note', () => {
  assert.ok(Array.isArray(expected) && expected.length > 0);
  const ids = new Set();
  for (const e of expected) {
    for (const f of FIELDS) assert.ok(typeof e[f] === 'string' && e[f].trim(), `${e.id}: ${f}`);
    assert.ok(!ids.has(e.id), 'duplicate ' + e.id); ids.add(e.id);
    assert.match(e.source, /^https:\/\//, e.id);
    assert.ok(e.sourceNote.length <= 200, e.id + ' sourceNote too long');
    assert.match(e.addedAt, /^\d{4}-\d{2}-\d{2}$/, e.id);
    if (e.code) assert.ok(typeof e.code === 'string');
  }
});

test('no expected call is already listed as open (by title or code)', () => {
  const titles = new Set(live.map((g) => norm(g.title)));
  const codes = new Set(live.map((g) => codeKey(g.code)).filter(Boolean));
  for (const e of expected) {
    assert.ok(!titles.has(norm(e.title)), `${e.id} is already open: ${e.title}`);
    if (e.code) assert.ok(!codes.has(codeKey(e.code)), `${e.id} code already open`);
  }
});
