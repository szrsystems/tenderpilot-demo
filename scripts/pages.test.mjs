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
  assert.match(html, /2 nyitott felhívás tartozik ide/);
  assert.match(html, /állapot szerint|Jelenleg/);

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

import { faqItems, pageTitle, metaDescription } from './build-pages.mjs';
test('SEO: short titles and descriptions, FAQ answered only from data', () => {
  const long = g({ title: 'Mikro-, kis- és középvállalkozások digitalizációjának támogatása egyműveletes kombinált hiteltermék keretében' });
  assert.ok(pageTitle(long).length <= 75, pageTitle(long));
  assert.ok(pageTitle(g()).includes('határidő 2026. 12. 31.'));
  assert.ok(metaDescription(long).length <= 160);
  const faq = faqItems(g());
  assert.deepEqual(faq.map((x) => x.q), ['Ki pályázhat?', 'Mennyi támogatás kapható?', 'Mi a beadási határidő?', 'Hol lehet beadni?']);
  assert.match(faq[2].a, /2026\. december 31\./);
  const html = renderPage(g(), 'x', null, { related: [{ slug: 'masik', title: 'Másik <b>', deadline: '2026-11-30' }] });
  assert.match(html, /"@type":"FAQPage"/);
  assert.ok(html.includes('href="masik.html"') && html.includes('Másik &lt;b&gt;'));
  assert.match(html, /og:image/);
});

import { changedUrls } from './indexnow.mjs';
import { buildLlmsTxt } from './build-pages.mjs';
test('IndexNow: today\'s pages + daily pages; llms.txt lists hubs', () => {
  const xml = '<url><loc>https://a/x.html</loc><lastmod>2026-10-13</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>\n<url><loc>https://a/y.html</loc><lastmod>2026-10-01</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>\n<url><loc>https://a/h.html</loc><changefreq>daily</changefreq><priority>0.6</priority></url>';
  assert.deepEqual(changedUrls(xml, '2026-10-13'), ['https://a/x.html', 'https://a/h.html']);
  assert.equal(changedUrls(xml, '2026-10-13', true).length, 3);
  const t = buildLlmsTxt({ open: 5, hubs: [{ slug: 'kkv', h1: 'KKV', items: [1, 2] }], today: '2026-10-13' });
  assert.match(t, /^# AIpályázó/);
  assert.match(t, /tema\/kkv\.html\): 2 nyitott/);
});

import { GUIDES, renderGuide, renderGuidesIndex, guidesFor } from './build-pages.mjs';
test('guides: valid content, JSON-LD, hub links only to existing hubs, in sitemap and llms.txt', () => {
  const slugs = new Set();
  for (const x of GUIDES) {
    assert.match(x.slug, /^[a-z0-9-]+$/); assert.ok(!slugs.has(x.slug)); slugs.add(x.slug);
    assert.match(x.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(x.description.length <= 160 && x.description.length >= 80, x.slug + ' description length');
    assert.ok((x.seoTitle || x.title).length <= 60, x.slug + ' title length');
    assert.ok(x.sources.length >= 1 && x.sources.every(([, u]) => /^https:\/\//.test(u)));
    assert.ok(x.faq.length >= 2);
  }
  const open = [
    { id: 'a', title: 'A', scope: 'hu', type: 'grant', sizeClasses: ['mikrovállalkozás'], deadline: '2099-01-01' },
    { id: 'b', title: 'B', scope: 'eu', type: 'grant', singleApplicant: true },
  ];
  const hubs = [{ slug: 'kkv', items: [] }];
  for (const x of GUIDES) {
    const html = renderGuide(x, { open, hubs, today: '2026-10-13' });
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
    const types = blocks.flat().map((b) => b['@type']);
    assert.deepEqual(types, ['Article', 'FAQPage', 'BreadcrumbList']);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://aipalyazo.hu/aipalyazo/utmutato/${x.slug}.html">`));
    // only hubs that exist are linked
    for (const m of html.matchAll(/palyazat\/tema\/([a-z0-9-]+)\.html/g)) assert.equal(m[1], 'kkv');
    assert.ok(!/undefined|NaN/.test(html), x.slug + ' has no undefined');
  }
  assert.match(renderGuidesIndex(), /CollectionPage/);
  // grant pages link 1–3 guides, EU calls get the EU guide
  assert.ok(guidesFor(open[1]).some((x) => x.slug === 'eu-palyazatok-magyar-cegeknek'));
  assert.ok(guidesFor(open[0]).some((x) => x.slug === 'kkv-minosites'));
  assert.ok(guidesFor({ type: 'loan', scope: 'hu' }).some((x) => x.slug === 'vissza-nem-teritendo-vagy-hitel'));
  const grants = Array.from({ length: 3 }, (_, i) => ({ id: 'g' + i, title: 'G' + i, scope: 'hu', type: 'grant', deadline: '2099-01-01' }));
  const { files } = buildAll({ grants, today: '2026-10-13' });
  for (const x of GUIDES) assert.ok(files.has(`utmutato/${x.slug}.html`));
  assert.ok(files.has('utmutato/index.html'));
  assert.match(files.get('sitemap.xml'), /utmutato\/hogyan-palyazzunk\.html/);
  assert.match(files.get(`palyazat/${[...files.keys()].find((k) => /^palyazat\/g0/.test(k)).slice(9)}`), /\.\.\/utmutato\/hogyan-palyazzunk\.html/);
  assert.match(buildLlmsTxt({ open: 3, hubs: [], today: '2026-10-13' }), /## Útmutatók[\s\S]*utmutato\/kkv-minosites\.html/);
});

import { weekRange, mondayOf, newsWeeks, weekEntries, NEWS_START } from './build-pages.mjs';
test('weekly news: week maths, re-added calls and undone moves are not news, pages + RSS + sitemap', () => {
  assert.equal(mondayOf('2026-10-18'), '2026-10-12');
  assert.equal(mondayOf('2026-10-12'), '2026-10-12');
  assert.equal(weekRange('2026-10-12'), '2026. október 12–18.');
  assert.equal(weekRange('2026-10-26'), '2026. október 26. – november 1.');
  assert.equal(weekRange('2026-12-28'), '2026. december 28. – 2027. január 3.');
  assert.deepEqual(newsWeeks('2026-10-20'), ['2026-10-19', '2026-10-12']);
  assert.equal(NEWS_START, '2026-10-12');
  const changes = {
    fresh: [{ date: '2026-10-13', type: 'new', title: 'Fresh' }],
    back: [{ date: '2026-10-08', type: 'new' }, { date: '2026-10-09', type: 'removed' }, { date: '2026-10-13', type: 'new' }],
    flap: [{ date: '2026-10-13', type: 'deadline', from: '2026-10-30', to: '2026-11-30' }, { date: '2026-10-13', type: 'deadline', from: '2026-11-30', to: '2026-10-30' }],
    moved: [{ date: '2026-10-14', type: 'deadline', from: '2026-11-10', to: '2026-10-26' }, { date: '2026-10-14', type: 'deadline-official', from: 'x', to: 'y' }],
    old: [{ date: '2026-10-10', type: 'new' }],
  };
  const e = weekEntries(changes, '2026-10-12');
  assert.deepEqual(e.map((x) => x.id + ':' + x.type).sort(), ['fresh:new', 'moved:deadline']);
  const grants = [
    { id: 'fresh', title: 'Fresh call', scope: 'hu', type: 'grant', deadline: '2099-01-01', issuer: 'X' },
    { id: 'moved', title: 'Moved call', scope: 'eu', type: 'grant', deadline: '2026-10-26' },
    { id: 'z', title: 'Z', scope: 'hu', type: 'grant', deadline: '2099-01-01' },
  ];
  const { files } = buildAll({ grants, changes, today: '2026-10-14' });
  const wk = files.get('hirek/het-2026-10-12.html');
  assert.match(wk, /1 új felhívás került fel a listánkra \(1 hazai\), 1 felhívás határideje módosult/);
  assert.match(wk, /"@type":"NewsArticle"/);
  assert.match(wk, /Hamarosan lejár/);
  assert.match(wk, /google\.com\/preferences\/source\?q=aipalyazo\.hu/);
  assert.ok(files.has('hirek/index.html'));
  const rss = files.get('hirek/rss.xml');
  assert.match(rss, /<item><title>Fresh call<\/title>/);
  assert.ok(!/Moved call/.test(rss));
  assert.match(files.get('sitemap.xml'), /hirek\/het-2026-10-12\.html<\/loc><lastmod>2026-10-14<\/lastmod><changefreq>daily/);
});

import { prerenderHome } from './build-pages.mjs';
import { readFileSync as rfs } from 'node:fs';
test('homepage pre-render: figures, deadline cards and date are written into the HTML, idempotently', () => {
  const html = rfs(new URL('../aipalyazo/index.html', import.meta.url), 'utf8');
  const open = [
    { id: 'a', title: 'Hazai A', scope: 'hu', type: 'grant', deadline: '2026-10-25', remaining: 2e9 },
    { id: 'b', title: 'EU B', scope: 'eu', type: 'grant', deadline: '2026-11-01', singleApplicant: true },
    { id: 'c', title: 'EU konzorcium', scope: 'eu', type: 'grant', deadline: '2026-10-22', singleApplicant: false },
    { id: 'd', title: 'Folyamatos', scope: 'hu', type: 'loan', deadline: 'Folyamatos' },
  ];
  const slugs = new Map([['a', 'hazai-a'], ['b', 'eu-b']]);
  const out = prerenderHome(html, { open, slugs, today: '2026-10-20' });
  assert.match(out, /data-fig="open">4</);
  assert.match(out, /data-fig="hu">2</);
  assert.match(out, /data-fig="soon">3</);
  assert.match(out, /data-fig="budget">2 Mrd Ft</);
  assert.match(out, /href="palyazat\/hazai-a\.html"/);
  assert.ok(!/EU konzorcium/.test(out), 'consortium calls are not in the quick list');
  assert.match(out, /data-asof>Frissítve: 2026\. október 20\./);
  assert.equal(prerenderHome(out, { open, slugs, today: '2026-10-20' }), out);
});

import { STATIC_PAGES } from './build-pages.mjs';
test('sitemap static pages exist, are indexable and self-canonical (Search Console "noindex" warnings)', () => {
  for (const [p] of STATIC_PAGES) {
    const html = rfs(new URL('../aipalyazo/' + p, import.meta.url), 'utf8');
    assert.ok(!/name="robots" content="noindex/.test(html), p + ' is noindex but listed in the sitemap');
    assert.match(html, new RegExp(`<link rel="canonical" href="https://aipalyazo\\.hu/aipalyazo/${p.replace(/\./g, '\\.')}">`), p + ' canonical');
  }
});
