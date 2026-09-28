// Run: node --test scripts/changes.test.mjs
// Per-call change log (aipalyazo/changes.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mergeChanges, MAX_PER_ID } from './changes-log.mjs';
import { diff } from './fetch-live-grants.mjs';

test('feed diff → dated log entries, merged with the previous file', () => {
  const prev = [{ id: 'a', deadline: '2026-10-01', keret: 100, remaining: 50, title: 'A' }, { id: 'b', deadline: '2026-11-01', title: 'B' }];
  const now = [{ id: 'a', deadline: '2026-10-15', keret: 100, remaining: 20, title: 'A' }, { id: 'c', deadline: '2026-12-01', title: 'C' }];
  const log = mergeChanges({ a: [{ date: '2026-09-01', type: 'new' }] }, diff(prev, now), '2026-09-28');
  assert.deepEqual(log.a, [
    { date: '2026-09-01', type: 'new' },
    { date: '2026-09-28', type: 'deadline', from: '2026-10-01', to: '2026-10-15' },
    { date: '2026-09-28', type: 'szabad-keret', from: 50, to: 20 },
  ]);
  assert.deepEqual(log.b, [{ date: '2026-09-28', type: 'removed' }]);
  assert.deepEqual(log.c, [{ date: '2026-09-28', type: 'new' }]);
});

test('idempotent when run twice on the same day', () => {
  const ch = [{ id: 'a', type: 'deadline', from: '2026-10-01', to: '2026-10-15' }, { id: 'a', type: 'page' }];
  const once = mergeChanges({}, ch, '2026-09-28');
  const twice = mergeChanges(once, ch, '2026-09-28');
  assert.deepEqual(twice, once);
  assert.equal(once.a.length, 2);
});

test('keeps 12 months and at most 50 entries per id', () => {
  const old = { a: [{ date: '2025-09-01', type: 'page' }, { date: '2025-10-15', type: 'page' }] };
  assert.deepEqual(mergeChanges(old, [], '2026-09-28').a, [{ date: '2025-10-15', type: 'page' }]);
  assert.deepEqual(mergeChanges({ x: [{ date: '2024-01-01', type: 'new' }] }, [], '2026-09-28'), {});
  const many = { a: Array.from({ length: 70 }, (_, i) => ({ date: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, type: 'keret', from: i, to: i + 1 })) };
  const r = mergeChanges(many, [{ id: 'a', type: 'page' }], '2026-09-28');
  assert.equal(r.a.length, MAX_PER_ID);
  assert.deepEqual(r.a.at(-1), { date: '2026-09-28', type: 'page' });
});

test('monitor "deadline-official" is logged once per distinct move', () => {
  const ch = [{ id: 'v', type: 'deadline-official', from: '2026-10-28', to: '2026-11-12' }];
  const d1 = mergeChanges({}, ch, '2026-09-27');
  const d2 = mergeChanges(d1, ch, '2026-09-28');
  assert.equal(d2.v.length, 1);
  assert.equal(mergeChanges(d2, [{ id: 'v', type: 'deadline-official', from: '2026-11-12', to: '2026-11-20' }], '2026-09-29').v.length, 2);
});

test('published changes.json has the documented shape', () => {
  const f = new URL('../aipalyazo/changes.json', import.meta.url);
  if (!existsSync(f)) return;
  const log = JSON.parse(readFileSync(f, 'utf8'));
  for (const [id, list] of Object.entries(log)) {
    assert.ok(Array.isArray(list) && list.length <= MAX_PER_ID, id);
    for (const e of list) {
      assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, id);
      assert.ok(['new', 'deadline', 'keret', 'szabad-keret', 'removed', 'page', 'deadline-official'].includes(e.type), id + ' ' + e.type);
    }
  }
});
