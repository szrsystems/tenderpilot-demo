import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, assignSlugs, buildAll, renderPage, esc } from './build-pages.mjs';

const g = (o) => ({ id: 'pg-GINOP_PLUSZ-1.2.3/B-24', code: 'GINOP_PLUSZ-1.2.3/B-24', title: 'Teszt <felhívás>', issuer: 'Kiíró', cat: 'KKV', type: 'grant', amount: '10 M Ft', deadline: '2026-12-31', url: 'https://example.hu/a', source: 'example.hu', scope: 'hazai', regions: [], sizeClasses: ['kisvállalkozás'], note: 'Megjegyzés "idézőjellel"', verifiedAt: '2026-09-20', ...o });

test('slugs are ascii, stable and unique', () => {
  assert.equal(slugify('pg-GINOP_PLUSZ-1.2.3/B-24'), 'ginop-plusz-1-2-3-b-24');
  assert.equal(slugify('v-mfb-zöld-lendület'), 'mfb-zold-lendulet');
  const s = assignSlugs(['a_b', 'a-b', 'x'], {});
  assert.equal(s.get('a_b'), 'a-b'); assert.equal(s.get('a-b'), 'a-b-2');
  // manifest keeps existing slugs even if order changes
  const s2 = assignSlugs(['a-b', 'a_b'], { 'a-b': { id: 'a_b' }, 'a-b-2': { id: 'a-b' } });
  assert.equal(s2.get('a-b'), 'a-b-2'); assert.equal(s2.get('a_b'), 'a-b');
});

test('page escapes feed text, links the portal deep link and never trusts non-http urls', () => {
  const html = renderPage(g({ url: 'javascript:alert(1)' }), 'x', null, {});
  assert.ok(html.includes('Teszt &lt;felhívás&gt;'));
  assert.ok(!html.includes('<felhívás>'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('../portal.html?grant=pg-GINOP_PLUSZ-1.2.3%2FB-24'));
  assert.ok(html.includes('rel="canonical" href="https://aipalyazo.hu/aipalyazo/palyazat/x.html"'));
  assert.ok(html.includes('"@type":"MonetaryGrant"'));
  assert.ok(!/<\/script>[^]*<\/script>[^]*MonetaryGrant/.test(''));
});

test('summary sections render with quotes', () => {
  const html = renderPage(g(), 'x', { sourceUrl: 'https://example.hu/a', generatedAt: '2026-09-25', sections: [{ title: 'Ki pályázhat', items: [{ text: 'KKV-k', quote: 'mikro-, kis- és középvállalkozások' }] }] });
  assert.ok(html.includes('A felhívás röviden') && html.includes('mikro-, kis- és középvállalkozások'));
});

test('expired and removed calls become noindex pages, then are deleted after a year', () => {
  const today = '2026-09-25';
  const r1 = buildAll({ grants: [g(), g({ id: 'v-old', title: 'Régi', deadline: '2026-01-01' })], today });
  assert.equal(r1.stats.open, 1);
  assert.ok(!r1.files.has('palyazat/old.html'));
  const r2 = buildAll({ grants: [g({ id: 'v-new', title: 'Új' })], manifest: r1.manifest, today });
  const closed = r2.files.get('palyazat/ginop-plusz-1-2-3-b-24.html');
  assert.ok(closed.includes('noindex') && closed.includes('Lezárult'));
  assert.ok(!r2.files.get('sitemap.xml').includes('ginop-plusz-1-2-3-b-24'));
  assert.ok(r2.files.get('sitemap.xml').includes('palyazat/new.html'));
  const r3 = buildAll({ grants: [g({ id: 'v-new', title: 'Új' })], manifest: r2.manifest, today: '2027-12-01' });
  assert.deepEqual(r3.removed, ['palyazat/ginop-plusz-1-2-3-b-24.html']);
  // back in the feed → same URL again
  const r4 = buildAll({ grants: [g()], manifest: r2.manifest, today });
  assert.ok(r4.files.get('palyazat/ginop-plusz-1-2-3-b-24.html').includes('Megnézem a portálon'));
  assert.equal(r4.manifest['ginop-plusz-1-2-3-b-24'].closedAt, undefined);
});

test('rolling calls without a date stay open', () => {
  const r = buildAll({ grants: [g({ deadline: 'Folyamatos', rolling: true })], today: '2026-09-25' });
  assert.equal(r.stats.open, 1);
  assert.ok(r.files.get('palyazat/index.html').includes('folyamatos'));
});

test('esc handles quotes', () => assert.equal(esc(`<a href="x">'`), '&lt;a href=&quot;x&quot;&gt;&#39;'));
