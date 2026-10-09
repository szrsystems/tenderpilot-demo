import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../aipalyazo/lib/cards.js');
const today = '2026-10-09';
const plus = (days) => new Date(Date.parse(today) + days * 864e5).toISOString().slice(0, 10);
const width = (html, label) => {
  const part = html.split('<div class="gbar">').find((x) => x.includes(label)) || '';
  const m = part.match(/<i class="[a-z]+ p(\d+)"/); return m ? +m[1] : null;
};

test('window not open yet: opening-date badge, no urgency badges, neutral bar', () => {
  const g = { type: 'grant', windowOpen: '2026-10-20', deadline: '2026-10-25' };
  const b = C.badges(g, { today });
  assert.match(b, /Nyílik: 2026\. 10\. 20\./);
  assert.doesNotMatch(b, /Sürgős|Hamarosan lejár|jár le/);
  const h = C.bars(g, { today });
  assert.match(h, /még nem nyílt meg/);
  assert.match(h, /class="soft p0"/);
  assert.doesNotMatch(h, /class="red/);
});
test('window already open: normal deadline badges', () => {
  const g = { type: 'grant', windowOpen: '2026-09-01', deadline: '2026-10-19' };
  assert.match(C.badges(g, { today }), /Sürgős · 10 nap/);
  assert.doesNotMatch(C.badges(g, { today }), /Nyílik/);
});
test('without a window the deadline bar uses a fixed, labelled 90-day scale', () => {
  const at = (days) => C.bars({ deadline: plus(days) }, { today });
  assert.equal(width(at(10), 'Beadási határidő'), 10);
  assert.equal(width(at(45), 'Beadási határidő'), 50);
  assert.equal(width(at(90), 'Beadási határidő'), 100);
  assert.equal(width(at(400), 'Beadási határidő'), 100);
  assert.equal(width(at(1), 'Beadási határidő'), 5); // still visible
  assert.match(at(45), /90 napos skála/);
  assert.doesNotMatch(at(45), /style=/);
});
test('bar widths are always p0…p100 classes in 5% steps', () => {
  for (let d = -3; d < 200; d += 7) {
    const h = C.bars({ deadline: plus(d), keret: 1000, remaining: d * 3 }, { today });
    for (const m of h.matchAll(/ p(\d+)"/g)) assert.equal(+m[1] % 5, 0);
  }
});
test('public API unchanged', () => {
  for (const k of ['esc', 'srcTag', 'badges', 'bars', 'budget', 'ft', 'TYPE_HU']) assert.ok(C[k], k);
  assert.equal(C.esc('<a>'), '&lt;a&gt;');
});
