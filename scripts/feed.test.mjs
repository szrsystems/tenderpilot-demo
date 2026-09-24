// Run: node --test scripts/feed.test.mjs
// Offline tests for the daily feed builder (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFeed, budapestDate, autoExclude, selectVerified, codeKey } from './fetch-live-grants.mjs';
import { fetchEuCalls, mapEuHit, euDate } from './fetch-eu-calls.mjs';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const { tenders } = load('./test-fixtures/ginapp-tenders.json');
const apiVerified = load('./api-verified.json');
const verifiedItems = load('./verified-grants.json').items;
const sedia = load('./test-fixtures/sedia-page1.json');
const TODAY = '2026-09-24';

test('deadline uses the Budapest date, not the UTC date', () => {
  assert.equal(budapestDate('2026-12-30T23:00:00.000Z'), '2026-12-31'); // winter (CET)
  assert.equal(budapestDate('2027-06-29T22:00:00.000Z'), '2027-06-30'); // summer (CEST)
  assert.equal(budapestDate('2026-10-12T12:00:00.000Z'), '2026-10-12');
});

test('auto-exclusion catches fund-manager lines and rail, keeps normal calls', () => {
  assert.ok(autoExclude({ name: 'Technikai felhívás a hitelkeret biztosítására', minSupportAmount: 1, maxSupportAmount: 5e10 }));
  assert.ok(autoExclude({ name: 'Vasúti járművek', operationalProgram: 'IKOP_PLUSZ' }));
  assert.equal(autoExclude({ name: 'Új KKV beruházási felhívás', minSupportAmount: 5e6, maxSupportAmount: 5e7 }), null);
});

test('code keys match across the API and hand-verified spellings', () => {
  assert.equal(codeKey('GINOP_PLUSZ-1.4.3-24'), codeKey('GINOP Plusz-1.4.3-24/A'));
  assert.notEqual(codeKey('DIMOP Plusz-1.2.3/A-24'), codeKey('DIMOP Plusz-1.2.3/B-24'));
});

test('verified items: expired hidden, rolling kept as Folyamatos, old verification flagged/hidden', () => {
  const items = [
    { id: 'a', deadline: '2026-09-01', verifiedAt: TODAY },
    { id: 'b', deadline: null, rolling: true, verifiedAt: TODAY },
    { id: 'c', deadline: '2027-01-01', verifiedAt: '2026-07-01' },
    { id: 'd', deadline: '2027-01-01', verifiedAt: '2026-05-01' },
  ];
  const r = selectVerified(items, TODAY);
  assert.deepEqual(r.kept.map((g) => g.id), ['b', 'c']);
  assert.equal(r.kept[0].deadline, 'Folyamatos');
  assert.deepEqual(r.stale, ['c']);
  assert.deepEqual(r.dropped.map((x) => x.id), ['a', 'd']);
});

test('EU hit mapping: EIC kept, Horizon CSA dropped, Horizon IA kept, stale "open" dropped, cascade kept', () => {
  const m = sedia.results.map((h) => mapEuHit(h, TODAY));
  assert.equal(m[0].deadline, '2026-10-28');
  assert.equal(m[0].amount, '€500k–€4M');
  assert.equal(m[0].singleApplicant, true);
  assert.equal(m[1], null);                 // CSA research topic
  assert.equal(m[2].singleApplicant, false); // Innovation Action → consortium note
  assert.match(m[2].note, /konzorcium/);
  assert.equal(m[3].cat, 'Digitális átalakulás');
  assert.equal(m[4], null);                 // status says open, deadline passed
  assert.equal(m[5].issuer, 'EU kaszkád (FSTP) felhívás');
  assert.equal(euDate('1793145600000'), '2026-10-28');
});

test('EU fetch sends multipart JSON parts and pages until totalResults', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    assert.ok(init.body instanceof FormData);
    const q = init.body.get('query');
    assert.equal(q.type, 'application/json');
    return { ok: true, json: async () => sedia };
  };
  const items = await fetchEuCalls({ today: TODAY, fetchImpl: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /apiKey=SEDIA/);
  assert.equal(items.length, 4);
});

test('full build on the 2026-09-24 API data', async () => {
  const euItems = sedia.results.map((h) => mapEuHit(h, TODAY)).filter(Boolean);
  const out = await buildFeed({ tenders, verifiedItems, apiVerified, euItems, today: TODAY });
  const ids = new Set(out.grants.map((g) => g.id));

  // every hand-excluded code is gone, the synthetic technical line too
  for (const [code, v] of Object.entries(apiVerified)) if (v && v.exclude) assert.ok(!ids.has('pg-' + code), code);
  assert.ok(!ids.has('pg-DIMOP_PLUSZ-9.9.9/Z1-26'));
  assert.ok(!ids.has('pg-GINOP_PLUSZ-8.8.8-25'));   // not Aktív

  // Budapest-only loan is tagged Budapest, deadline fixed
  const bp = out.grants.find((g) => g.id === 'pg-GINOP_PLUSZ-1.4.4-24');
  assert.deepEqual(bp.regions, ['Budapest']);
  assert.equal(bp.deadline, '2026-12-31');
  assert.equal(bp.type, 'loan');

  // unknown new API code → shown, flagged for review, no invented regions
  const nw = out.grants.find((g) => g.id === 'pg-GINOP_PLUSZ-9.9.9-26');
  assert.equal(nw.needsReview, true);
  assert.deepEqual(nw.regions, []);
  assert.equal(nw.deadline, '2027-03-31');

  // hand-verified duplicates of API calls are not listed twice
  const keys = out.grants.map((g) => codeKey(g.code)).filter(Boolean);
  assert.equal(keys.length, new Set(keys).size, 'duplicate codes');

  // EU auto items that are already hand-verified are skipped
  assert.ok(!ids.has('eu-HORIZON-EIC-2026-PATHFINDERCHALLENGES-01-02'));
  assert.ok(ids.has('eu-HORIZON-CL4-2027-01-DIGITAL-EMERGING-07'));

  // every item has what the portal needs
  for (const g of out.grants) {
    assert.ok(g.id && g.title && g.cat && g.url && g.deadline, g.id);
    assert.ok(g.factors && typeof g.factors.size === 'number', g.id);
    assert.ok(/^https:\/\//.test(g.url), g.id);
    assert.ok(g.deadline === 'Folyamatos' || g.deadline >= TODAY, g.id + ' ' + g.deadline);
  }
});

test('EU API failure keeps yesterday\'s still-open auto EU items', async () => {
  const prevGrants = [
    { id: 'eu-X', code: 'X', auto: true, scope: 'eu', deadline: '2026-11-01', title: 'x', cat: 'KKV fejlesztés', url: 'https://ec.europa.eu/x' },
    { id: 'eu-Y', code: 'Y', auto: true, scope: 'eu', deadline: '2026-09-01', title: 'y', cat: 'KKV fejlesztés', url: 'https://ec.europa.eu/y' },
  ];
  const out = await buildFeed({ tenders, verifiedItems, apiVerified, euItems: null, prevGrants, today: TODAY });
  assert.equal(out.euFailed, true);
  assert.deepEqual(out.euAuto.map((g) => g.id), ['eu-X']);
});
