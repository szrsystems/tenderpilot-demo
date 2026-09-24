// Run: node --test scripts/monitor/monitor.test.mjs   (offline: fake sites + fake LLM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesIn, parseRobots, htmlToText, extractLinks } from './lib.mjs';
import { validate, grounded } from './extract.mjs';
import { runMonitor, euTopicFacts, CODE_RE } from './run.mjs';
import { applyMonitor } from '../fetch-live-grants.mjs';

const TODAY = '2026-09-24';

test('Hungarian and English date formats', () => {
  assert.deepEqual(datesIn('Beadási határidő: 2026. október 30. 23:59'), ['2026-10-30']);
  assert.deepEqual(datesIn('2026.11.15-ig, illetve 2027-01-14'), ['2026-11-15', '2027-01-14']);
  assert.deepEqual(datesIn('Deadline: 4 November 2026, 17:00 CET'), ['2026-11-04']);
  assert.deepEqual(datesIn('closes October 28, 2026'), ['2026-10-28']);
  assert.deepEqual(datesIn('30/10/2026'), ['2026-10-30']);
});

test('robots, text and links', () => {
  assert.deepEqual(parseRobots('User-agent: Googlebot\nDisallow: /x\nUser-agent: *\nDisallow: /admin\nDisallow:'), ['/admin']);
  assert.equal(htmlToText('<p>Keret:&nbsp;10&nbsp;M&nbsp;Ft</p><script>x()</script>'), 'Keret: 10 M Ft');
  assert.deepEqual(extractLinks('<a href="/tamogatas/kap-1">a</a><a href="https://x.hu/#top">b</a>', 'https://kap.gov.hu/tags/842'), ['https://kap.gov.hu/tamogatas/kap-1', 'https://x.hu']);
});

const PAGE = 'KAP-RD99-1-26 Minta támogatás\nA felhívás státusza: Nyitott\nBenyújtási időszak: 2026. október 1. – 2026. november 30.\nTámogatás: max. 50 millió Ft\nKedvezményezettek: mikro-, kis- és középvállalkozások';
const GOOD = {
  is_funding_call: true, status: 'open', title: 'Minta támogatás', code: 'KAP-RD99-1-26', type: 'grant', cat: 'Mezőgazdaság',
  deadline: '2026-11-30', rolling: false, window_open: '2026-10-01', amount: 'max. 50 millió Ft', businesses_can_apply: true, sizes: ['mikro', 'kis', 'közép'],
  note_hu: 'KKV-k pályázhatnak.',
  evidence: { title: 'KAP-RD99-1-26 Minta támogatás', status: 'A felhívás státusza: Nyitott', deadline: 'Benyújtási időszak: 2026. október 1. – 2026. november 30.', amount: 'Támogatás: max. 50 millió Ft', eligibility: 'mikro-, kis- és középvállalkozások' },
};

test('grounding: accepts quoted facts, rejects invented ones', () => {
  assert.equal(grounded('a  felhívás   STÁTUSZA: nyitott', PAGE), true);
  assert.equal(validate(GOOD, PAGE, TODAY).ok, true);
  const badDate = { ...GOOD, deadline: '2026-12-31' };
  assert.match(validate(badDate, PAGE, TODAY).problems.join(), /not in its quote/);
  const invented = { ...GOOD, evidence: { ...GOOD.evidence, deadline: 'Határidő: 2026. december 31.' }, deadline: '2026-12-31' };
  assert.match(validate(invented, PAGE, TODAY).problems.join(), /deadline quote not on page/);
  assert.match(validate({ ...GOOD, businesses_can_apply: false }, PAGE, TODAY).problems.join(), /businesses cannot apply/);
});

test('EU topicDetails: next deadline and closed detection', () => {
  const open = { TopicDetails: { actions: [{ status: { abbreviation: 'Open' }, deadlineDates: [Date.UTC(2026, 8, 2), Date.UTC(2026, 10, 4)] }] } };
  assert.deepEqual(euTopicFacts(open, TODAY), { next: '2026-11-04', closed: false });
  const past = { TopicDetails: { actions: [{ status: { abbreviation: 'Closed' }, deadlineDates: [Date.UTC(2026, 8, 2)] }] } };
  assert.equal(euTopicFacts(past, TODAY).closed, true);
});

// ---- a small fake internet ----------------------------------------------
function fakeWeb(pages) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const p = pages[url];
    if (typeof p === 'function') return p();
    if (!p) return { ok: false, status: 404, url, headers: new Map(), text: async () => 'not found' };
    const body = typeof p === 'string' ? p : JSON.stringify(p);
    return { ok: true, status: 200, url, headers: new Map([['content-type', typeof p === 'string' ? 'text/html' : 'application/json']]), text: async () => body };
  };
  return { fetchImpl, calls };
}
const html = (t) => `<html><body><main>${t.split('\n').map((l) => `<p>${l}</p>`).join('')}</main></body></html>`;

test('daily run: re-check, hide after two failures, discover + auto-publish, queue the rest', async () => {
  const items = [
    { id: 'v-eu', title: 'EU topic', deadline: '2026-10-28', url: 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/horizon-x-01' },
    { id: 'v-gone', title: 'Megszűnt termék', deadline: 'Folyamatos', url: 'https://www.mfb.hu/vallalkozasok/mukodo/hitel/regi' },
    { id: 'v-ok', title: 'Stabil', deadline: '2026-12-31', url: 'https://bkik.hu/szechenyi/stabil' },
    { id: 'pg-X', title: 'API item (skipped)', url: 'https://www.palyazat.gov.hu/x' },
  ];
  const sources = [
    { id: 'kap', name: 'KAP', list: ['https://kap.gov.hu/tags/842'], pattern: '^https://kap\\.gov\\.hu/tamogatas/[a-z0-9-]+$', scope: 'hazai' },
    { id: 'eit', name: 'EIT', list: ['https://eit.europa.eu/opps'], pattern: '^https://eit\\.europa\\.eu/nomatch/', scope: 'eu' },
  ];
  const { fetchImpl } = fakeWeb({
    'https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/horizon-x-01.json': { TopicDetails: { actions: [{ status: { abbreviation: 'Open' }, deadlineDates: [Date.UTC(2026, 10, 12)] }] } },
    'https://bkik.hu/szechenyi/stabil': html('Stabil termék\nFolyamatos'),
    'https://kap.gov.hu/tags/842': '<a href="/tamogatas/kap-rd99-1-26">jó</a><a href="/tamogatas/kap-rd98-1-26">rossz</a><a href="/hirek/x">hír</a>',
    'https://kap.gov.hu/tamogatas/kap-rd99-1-26': html(PAGE),
    'https://kap.gov.hu/tamogatas/kap-rd98-1-26': html('KAP-RD98 Régi felhívás\nA felhívás lezárult.'),
    'https://eit.europa.eu/opps': '<a href="/other">x</a>',
  });
  // fake LLM: answers GOOD for the RD99 page, "closed" for RD98
  const llm = async (prompt) => (prompt.includes('KAP-RD99') ? JSON.stringify(GOOD)
    : JSON.stringify({ is_funding_call: true, status: 'closed', title: 'Régi felhívás', businesses_can_apply: true, evidence: { title: 'KAP-RD98 Régi felhívás', status: 'A felhívás lezárult.' } }));
  const cfg = { items, sources, officialDomains: ['gov.hu', 'mfb.hu', 'bkik.hu', 'europa.eu'], fetchImpl, llm, today: TODAY, delayMs: 0 };

  const r1 = await runMonitor({ ...cfg, state: {} });
  assert.equal(r1.flags.overrides['v-eu'].deadline, '2026-11-12');           // EU portal moved the deadline
  assert.equal(r1.flags.hide['v-gone'], undefined);                         // one 404 is not enough
  assert.ok(r1.review.some((x) => x.id === 'v-gone' && x.outcome === 'gone'));
  assert.equal(r1.auto.length, 1);
  assert.equal(r1.auto[0].deadline, '2026-11-30');
  assert.equal(r1.auto[0].windowOpen, '2026-10-01');
  assert.ok(r1.review.some((x) => x.kind === 'new' && /status closed/.test(x.detail)));
  assert.ok(r1.log.some((l) => /eit: .*0 matches/.test(l)));

  const r2 = await runMonitor({ ...cfg, state: r1.state, prevAuto: r1.auto });
  assert.match(r2.flags.hide['v-gone'], /gone/);                            // second 404 → hidden
  assert.equal(r2.auto.length, 1);                                          // kept, not re-fetched
  assert.equal(r2.flags.overrides['v-ok'].lastChecked, TODAY);              // unchanged page → fresh

  const applied = applyMonitor([...items, { id: 'v-other', code: 'KAP-RD99-1-26', url: 'https://x' }], { flags: r2.flags, auto: r2.auto });
  assert.ok(!applied.items.some((g) => g.id === 'v-gone'));
  assert.ok(!applied.items.some((g) => g.id === r2.auto[0].id));            // same code already listed → not duplicated
});

test('no LLM key: deterministic checks still run, new pages go to review', async () => {
  const { fetchImpl } = fakeWeb({
    'https://kap.gov.hu/tags/842': '<a href="/tamogatas/kap-rd99-1-26">x</a>',
    'https://kap.gov.hu/tamogatas/kap-rd99-1-26': html(PAGE),
  });
  const r = await runMonitor({ items: [], sources: [{ id: 'kap', name: 'KAP', list: ['https://kap.gov.hu/tags/842'], pattern: '^https://kap\\.gov\\.hu/tamogatas/', scope: 'hazai' }], officialDomains: ['gov.hu'], fetchImpl, llm: null, today: TODAY, delayMs: 0, state: {} });
  assert.equal(r.auto.length, 0);
  assert.equal(r.review.length, 1);
});

test('coverage cross-check: codes we miss and new items on another site go to review', async () => {
  assert.deepEqual('GINOP Plusz-1.4.3-24 és KAP-RD40-RD12-1-26, 2025-1.1.1-BAY_VOUCHER; DIMOP_PLUSZ-1.2.3/A-24'.match(CODE_RE),
    ['GINOP Plusz-1.4.3-24', 'KAP-RD40-RD12-1-26', '2025-1.1.1-BAY_VOUCHER', 'DIMOP_PLUSZ-1.2.3/A-24']);
  let day = 1;
  const { fetchImpl } = fakeWeb({
    'https://bench.hu/lista': () => ({ ok: true, status: 200, url: 'https://bench.hu/lista', headers: new Map([['content-type', 'text/html']]),
      text: async () => '<p>GINOP Plusz-1.4.3-24 és KEHOP Plusz-2.3.11-26</p><a href="/p/a">a</a>' + (day === 2 ? '<a href="/p/uj-felhivas">b</a>' : '') }),
  });
  const bench = [{ id: 'b', name: 'bench', list: ['https://bench.hu/lista'], linkPattern: '^https://bench\\.hu/p/' }];
  const base = { items: [{ id: 'x', code: 'GINOP_PLUSZ-1.4.3-24' }], sources: [], officialDomains: [], fetchImpl, llm: null, today: TODAY, delayMs: 0, benchmarks: bench };
  const r1 = await runMonitor({ ...base, state: {} });
  assert.deepEqual(r1.review.map((x) => x.title), ['KEHOP Plusz-2.3.11-26']);   // first run: only the missing code
  day = 2;
  const r2 = await runMonitor({ ...base, state: r1.state });
  assert.ok(r2.review.some((x) => x.kind === 'benchmark-new' && x.title === 'uj felhivas'));
});

import { validateSummary, updateSummaries } from './summarize.mjs';
import { makeFetcher } from './lib.mjs';

const CALL = `Kedvezményezettek köre: mikro-, kis- és középvállalkozások, legalább 1 lezárt üzleti évvel.
A támogatás összege: 3–20 millió Ft, a hitel legfeljebb 50%-a vissza nem térítendő.
Elszámolható: szoftverbeszerzés, hardver, webáruház fejlesztése.
Önerő: az elszámolható költség legalább 10%-a.
Benyújtás: 2027. június 30-ig folyamatosan, az MFB Pontokon.
Nem támogatható: ingatlanvásárlás. ${'Részletes feltételek. '.repeat(40)}`;

test('summary: only lines quoting the official text survive', () => {
  const raw = { items: [
    { section: 'who', text: 'KKV-k, legalább 1 lezárt évvel.', quote: 'mikro-, kis- és középvállalkozások, legalább 1 lezárt üzleti évvel' },
    { section: 'money', text: '3–20 M Ft, max. fele vissza nem térítendő.', quote: 'A támogatás összege: 3–20 millió Ft' },
    { section: 'own', text: 'Min. 10% önerő.', quote: 'legalább 10%-a' },
    { section: 'what', text: 'Autóvásárlás is.', quote: 'gépjármű beszerzése' },          // invented → dropped
    { section: 'bogus', text: 'x', quote: 'Önerő' },                                       // bad section → dropped
  ] };
  const v = validateSummary(raw, CALL);
  assert.equal(v.ok, true);
  assert.equal(v.kept, 3);
  assert.equal(v.dropped, 2);
  assert.deepEqual(v.sections.map((s) => s.key), ['who', 'money', 'own']);
  assert.equal(validateSummary({ items: raw.items.slice(3) }, CALL).ok, false);
});

test('summaries: generated once, reused while the source is unchanged, EU topics read from the portal JSON', async () => {
  let calls = 0;
  const llm = async () => { calls++; return JSON.stringify({ items: [
    { section: 'who', text: 'KKV-k.', quote: 'mikro-, kis- és középvállalkozások' },
    { section: 'money', text: '3–20 M Ft.', quote: '3–20 millió Ft' },
    { section: 'how', text: 'MFB Pontokon.', quote: 'az MFB Pontokon' },
  ] }); };
  const { fetchImpl } = fakeWeb({
    'https://mfb.hu/termek': html(CALL),
    'https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/horizon-y-01.json': { TopicDetails: { title: 'Y', description: '<p>' + CALL + '</p>', conditions: '' } },
    'https://www.palyazat.gov.hu/x': html('Betöltés…'),   // JS shell → skipped
  });
  const fetchPage = makeFetcher({ fetchImpl, delayMs: 0, cache: new Map() });
  const items = [
    { id: 'a', title: 'A', url: 'https://mfb.hu/termek' },
    { id: 'b', title: 'B', url: 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/horizon-y-01' },
    { id: 'c', title: 'C', url: 'https://www.palyazat.gov.hu/x' },
  ];
  const r1 = await updateSummaries({ items, fetchPage, llm, today: TODAY });
  assert.deepEqual(Object.keys(r1.summaries).sort(), ['a', 'b']);
  assert.equal(calls, 2);
  const r2 = await updateSummaries({ items: items.slice(0, 1), prev: r1.summaries, fetchPage, llm, today: TODAY });
  assert.equal(calls, 2);                          // unchanged source → no new call
  assert.deepEqual(Object.keys(r2.summaries), ['a']); // removed call's summary dropped
});
