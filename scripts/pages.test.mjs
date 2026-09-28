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

import { selectHubs, renderHub, HUBS, MIN_HUB } from './build-pages.mjs';

test('topic hubs: only with ≥2 open calls, linked from the index, in the sitemap, CollectionPage JSON-LD', () => {
  const today = '2026-09-25';
  const grants = [
    g({ id: 'pg-GINOP_PLUSZ-1.4.3-24', code: 'GINOP_PLUSZ-1.4.3-24', title: 'KKV Technológia', type: 'loan', regions: ['Pest', 'Dél-Alföld'] }),
    g({ id: 'pg-GINOP_PLUSZ-1.1.6-25', code: 'GINOP_PLUSZ-1.1.6-25', title: 'Klaszter', type: 'grant', regions: ['Dél-Alföld'] }),
    g({ id: 'pg-GINOP_PLUSZ-9.9.9-20', code: 'GINOP_PLUSZ-9.9.9-20', title: 'Lejárt', deadline: '2026-01-01' }),
    g({ id: 'pg-DIMOP_PLUSZ-1.2.3/A-24', code: 'DIMOP_PLUSZ-1.2.3/A-24', title: 'Digitalizáció', type: 'loan+grant' }),
    g({ id: 'v-eic', code: null, title: 'EIC Accelerator', issuer: 'Horizon Europe – EIC', scope: 'eu', singleApplicant: true }),
  ];
  const r = buildAll({ grants, today, updatedAt: '2026-09-25T05:00:00Z' });
  const hubFiles = [...r.files.keys()].filter((k) => k.startsWith('palyazat/tema/'));
  assert.ok(hubFiles.includes('palyazat/tema/ginop-plusz.html'));        // 2 open GINOP calls (the expired one does not count)
  assert.ok(hubFiles.includes('palyazat/tema/regio-del-alfold.html'));
  assert.ok(!hubFiles.includes('palyazat/tema/dimop-plusz.html'));       // only 1 → no hub
  assert.ok(!hubFiles.includes('palyazat/tema/regio-pest.html'));
  assert.ok(!hubFiles.includes('palyazat/tema/eic.html'));
  assert.equal(r.stats.hubs, hubFiles.length);

  const html = r.files.get('palyazat/tema/ginop-plusz.html');
  assert.match(html, /<h1>GINOP Plusz pályázatok és hitelek<\/h1>/);
  assert.ok(html.includes('rel="canonical" href="https://aipalyazo.hu/aipalyazo/palyazat/tema/ginop-plusz.html"'));
  assert.ok(html.includes('"@type":"CollectionPage"'));
  assert.ok(html.includes('href="../ginop-plusz-1-4-3-24.html"') && html.includes('href="../ginop-plusz-1-1-6-25.html"'));
  assert.ok(!html.includes('Lejárt'));
  assert.ok(html.includes('href="../index.html"'));                       // back to the index
  assert.ok(html.includes('href="../../favicon.svg"'));                   // shell at depth 2
  assert.ok(!/<[a-z][^>]*\sstyle=/i.test(html), 'no inline style attributes');
  assert.match(html, /Jelenleg 2 nyitott felhívás/);

  const index = r.files.get('palyazat/index.html');
  assert.ok(index.includes('href="tema/ginop-plusz.html"') && index.includes('href="tema/regio-del-alfold.html"'));
  assert.ok(!index.includes('href="tema/dimop-plusz.html"'));
  const sm = r.files.get('sitemap.xml');
  assert.ok(sm.includes('/palyazat/tema/ginop-plusz.html') && !sm.includes('/palyazat/tema/dimop-plusz.html'));
});

test('hub definitions: unique slugs, every group present, filters behave', () => {
  const slugs = HUBS.map((h) => h.slug);
  assert.equal(slugs.length, new Set(slugs).size);
  for (const s of ['ginop-plusz', 'dimop-plusz', 'kehop-plusz', 'mahop-plusz', 'kap', 'horizon-europe', 'eic', 'eu-egyeb-programok', 'szechenyi-kartya',
    'egyeni-vallalkozo', 'mikrovallalkozas', 'kkv', 'startup', 'mezogazdasagi-termelo', 'turisztikai-vallalkozas',
    'vissza-nem-teritendo', 'hitel', 'toke', 'garancia']) assert.ok(slugs.includes(s), s);
  const hub = (slug) => HUBS.find((h) => h.slug === slug);
  assert.equal(hub('eic').test(g({ scope: 'eu', issuer: 'Horizon Europe – EIC' })), true);
  assert.equal(hub('horizon-europe').test(g({ scope: 'eu', issuer: 'Horizon Europe – EIC' })), false);
  assert.equal(hub('turisztikai-vallalkozas').test(g({ requires: { tourism_ntak: true } })), true);
  assert.equal(hub('mikrovallalkozas').test(g({ sizeClasses: ['kisvállalkozás'], note: 'Kis- és középvállalkozásoknak (mikro nem)' })), false);
  assert.equal(hub('hitel').test(g({ type: 'loan+grant' })), true);
  assert.equal(hub('vissza-nem-teritendo').test(g({ type: 'loan+grant' })), true);
  assert.equal(selectHubs([g()]).length, 0, `a single call never makes a hub (MIN_HUB=${MIN_HUB})`);
  const html = renderHub({ ...hub('kkv'), items: [g(), g({ id: 'v-2', title: 'Második' })] }, new Map([['pg-GINOP_PLUSZ-1.2.3/B-24', 'a'], ['v-2', 'b']]), {});
  assert.ok(html.includes('Teszt &lt;felhívás&gt;') && !html.includes('<felhívás>'));
});
