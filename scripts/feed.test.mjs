// Run: node --test scripts/feed.test.mjs
// Offline tests for the daily feed builder (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFeed, budapestDate, autoExclude, selectVerified, codeKey, codeIndex, diff, markBudget, sourceStatus, normUrl } from './fetch-live-grants.mjs';
import { fetchEuCalls, mapEuHit, euDate, horizonActionDropped, isNonBusinessId, normalizeEuItem } from './fetch-eu-calls.mjs';

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
  // fund-manager / intermediary wording only — real business loan products stay
  assert.ok(autoExclude({ name: 'Kombinált keret DIMOP PLUSZ 1.prioritás keretében - technikai felhívás', minSupportAmount: 1e6, maxSupportAmount: 3e8 }));
  assert.ok(autoExclude({ name: 'HVSZ és Közvetítők költségtérítése', minSupportAmount: 0, maxSupportAmount: 5e8 }));
  assert.ok(autoExclude({ name: 'Pénzügyi közvetítők forrásbiztosítása', minSupportAmount: 1e6, maxSupportAmount: 5e8 }));
  for (const name of ['Széchenyi Hitelkeret vállalkozásoknak', 'Egyműveletes kombinált keret: hitel és vissza nem térítendő támogatás KKV-knak', 'Kombinált hitelkeret beruházásokra', 'Tudásközvetítő innovációs projektek'])
    assert.equal(autoExclude({ name, minSupportAmount: 5e6, maxSupportAmount: 5e8 }), null, name);
});

test('palyazat.gov.hu: a call closing today (Budapest date) stays; large-company-only calls are kept', async () => {
  const base = { status: 'Aktív', minSupportAmount: 5e6, maxSupportAmount: 5e8, sumAvailableSupportAmount: 1e9, sumRequestedSupportAmount: 0 };
  const t = [
    { ...base, code: 'GINOP_PLUSZ-7.7.1-26', name: 'Ma záró felhívás', endTime: '2026-09-23T22:00:00.000Z', beneficiaries: ['kisvállalkozás'] }, // = 24 Sep Budapest
    { ...base, code: 'GINOP_PLUSZ-7.7.2-26', name: 'Tegnap zárt', endTime: '2026-09-22T22:00:00.000Z', beneficiaries: ['kisvállalkozás'] },
    { ...base, code: 'GINOP_PLUSZ-7.7.3-26', name: 'Nagyvállalati beruházás', endTime: '2027-03-30T22:00:00.000Z', beneficiaries: ['nagyvállalkozás'] },
    { ...base, code: 'GINOP_PLUSZ-7.7.4-26', name: 'Nagyvállalati K+F', endTime: '2027-03-30T22:00:00.000Z', beneficiaries: ['nagyvállalat'] },
    { ...base, code: 'GINOP_PLUSZ-7.7.5-26', name: 'Önkormányzati', endTime: '2027-03-30T22:00:00.000Z', beneficiaries: ['önkormányzat'] },
  ];
  const out = await buildFeed({ tenders: t, verifiedItems: [], apiVerified: {}, euItems: [], today: TODAY });
  assert.deepEqual(out.grants.map((g) => g.code), ['GINOP_PLUSZ-7.7.1-26', 'GINOP_PLUSZ-7.7.3-26', 'GINOP_PLUSZ-7.7.4-26']);
  assert.equal(out.grants[0].deadline, TODAY);
  assert.deepEqual(out.grants[1].sizeClasses, ['nagyvállalkozás']);
});

test('fully requested keret: still listed, flagged budgetExhausted', async () => {
  const out = await buildFeed({ tenders, verifiedItems, apiVerified, euItems: [], today: TODAY });
  const by = Object.fromEntries(out.grants.map((g) => [g.id, g]));
  assert.equal(by['pg-MAHOP_PLUSZ-2.1.1-25'].budgetExhausted, true);   // ~140% requested
  assert.equal(by['pg-MAHOP_PLUSZ-2.5.1-25'].budgetExhausted, true);   // ~113% requested
  assert.equal(by['pg-GINOP_PLUSZ-1.4.3-24'].budgetExhausted, undefined);
  assert.equal(markBudget({ keret: 100, requested: 100, remaining: 0 }).budgetExhausted, true);
  assert.equal(markBudget({ keret: 0, requested: 0, remaining: 0 }).budgetExhausted, undefined); // unknown keret
  assert.equal(markBudget({ keret: 100, requested: 40, remaining: 60, budgetExhausted: true }).budgetExhausted, undefined);
});

test('palyazat.gov.hu API failure keeps yesterday\'s API items (overlay re-applied) and reports apiFailed', async () => {
  const prevGrants = [
    { id: 'pg-GINOP_PLUSZ-1.4.4-24', code: 'GINOP_PLUSZ-1.4.4-24', title: 'KKV Technológia Plusz Budapest', cat: 'KKV fejlesztés', deadline: '2026-12-31', url: 'https://www.palyazat.gov.hu/x', live: true, scope: 'hazai', keret: 10, requested: 12, remaining: 0 },
    { id: 'pg-OLD', code: 'OLD', title: 'Lejárt', cat: 'KKV fejlesztés', deadline: '2026-09-01', url: 'https://www.palyazat.gov.hu/y', live: true, scope: 'hazai' },
    { id: 'pg-GINOP_PLUSZ-1.4.6-24', code: 'GINOP_PLUSZ-1.4.6-24', title: 'Hitelkeret alapkezelőnek', cat: 'KKV fejlesztés', deadline: '2027-12-31', url: 'https://www.palyazat.gov.hu/z', live: true, scope: 'hazai' },
  ];
  const out = await buildFeed({ tenders: null, verifiedItems: [], apiVerified, euItems: [], prevGrants, today: TODAY });
  assert.equal(out.apiFailed, true);
  assert.deepEqual(out.apiGrants.map((g) => g.id), ['pg-GINOP_PLUSZ-1.4.4-24']);
  assert.deepEqual(out.apiGrants[0].regions, ['Budapest']); // overlay re-applied
  assert.equal(out.apiGrants[0].budgetExhausted, true);
  assert.ok(out.excluded.some((e) => e.code === 'GINOP_PLUSZ-1.4.6-24'));
  const ok = await buildFeed({ tenders, verifiedItems: [], apiVerified, euItems: [], today: TODAY });
  assert.equal(ok.apiFailed, false);
});

test('grants-meta source status: per-source ok flags, apiFailed, dataFrom = last good run', () => {
  const prevMeta = { updatedAt: '2026-10-08T05:00:00Z', sources: { palyazatApi: { ok: true, lastOk: '2026-10-08T05:00:00Z' }, euApi: { ok: true, lastOk: '2026-10-08T05:00:00Z' } } };
  const s = sourceStatus({ apiFailed: true, apiError: 'API 503', apiCount: 17, euCount: 300, prevMeta, now: '2026-10-09T05:00:00Z' });
  assert.equal(s.sourcesOk, false);
  assert.equal(s.apiFailed, true);
  assert.equal(s.euApiFailed, false);
  assert.deepEqual(s.sources.palyazatApi, { ok: false, error: 'API 503', items: 17, dataFrom: '2026-10-08T05:00:00Z', lastOk: '2026-10-08T05:00:00Z' });
  assert.deepEqual(s.sources.euApi, { ok: true, items: 300, lastOk: '2026-10-09T05:00:00Z' });
  // second failed day: dataFrom stays at the last good run
  const s2 = sourceStatus({ apiFailed: true, prevMeta: { updatedAt: '2026-10-09T05:00:00Z', sources: s.sources }, now: '2026-10-10T05:00:00Z' });
  assert.equal(s2.sources.palyazatApi.dataFrom, '2026-10-08T05:00:00Z');
  assert.equal(sourceStatus({ prevMeta: {} }).sourcesOk, true);
});

test('code keys match across the API and hand-verified spellings; /A and /B variants stay apart', () => {
  assert.equal(codeKey('GINOP_PLUSZ-1.4.3-24/A'), codeKey('GINOP Plusz-1.4.3-24/A'));
  assert.notEqual(codeKey('GINOP_PLUSZ-1.4.3-24/B'), codeKey('GINOP_PLUSZ-1.4.3-24'));
  assert.notEqual(codeKey('DIMOP Plusz-1.2.3/A-24'), codeKey('DIMOP Plusz-1.2.3/B-24'));
  // the base code is only a fallback when no exact match exists
  const idx = codeIndex(['GINOP_PLUSZ-1.4.3-24', 'KEHOP_PLUSZ-4.2.3-25/A']);
  assert.equal(idx.has('GINOP Plusz-1.4.3-24/A'), true);   // variant → plain base listed
  assert.equal(idx.has('KEHOP Plusz-4.2.3-25'), true);      // plain → a variant listed
  assert.equal(idx.has('KEHOP Plusz-4.2.3-25/B'), false);   // other variant: different call
  const one = codeIndex(['GINOP_PLUSZ-1.4.3-24/A']);
  assert.equal(one.has('GINOP_PLUSZ-1.4.3-24/B'), false);
  assert.equal(one.has('GINOP_PLUSZ-1.4.3-24/A'), true);
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
  assert.equal(m[5].id, 'eu-cs-14742');      // cascade: own id from its own portal URL
  assert.equal(m[5].code, null);
  assert.equal(m[5].parentTopic, 'TRUNSPORT Open Call 1');
  assert.equal(euDate('1793145600000'), '2026-10-28');
});

test('Horizon filter: keeps RIA, IA, EIC, PCP, lump sum; drops only non-SME CSA and Programme Cofund', () => {
  assert.equal(horizonActionDropped('HORIZON-RIA HORIZON Research and Innovation Actions', 'Advanced materials'), null);
  assert.equal(horizonActionDropped('HORIZON-IA HORIZON Innovation Actions', 'Pilots'), null);
  assert.equal(horizonActionDropped('HORIZON-AG-LS HORIZON Lump Sum Grant', 'Lump sum RIA'), null);
  assert.equal(horizonActionDropped('HORIZON-PCP HORIZON Pre-commercial Procurement', 'PCP for health'), null);
  assert.equal(horizonActionDropped('HORIZON-CSA HORIZON Coordination and Support Actions', 'Proof of market to improve valorisation'), 'csa');
  assert.equal(horizonActionDropped('', 'Support to the network of contact points (CSA)'), 'csa');
  assert.equal(horizonActionDropped('HORIZON-CSA HORIZON Coordination and Support Actions', "'Innovate to transform' support for SME's sustainability transition"), null);
  assert.equal(horizonActionDropped('HORIZON-COFUND HORIZON Programme Cofund Actions', 'European Partnership X'), 'cofund');
  // a Research and Innovation Action hit is mapped and kept
  const ria = { metadata: { type: ['1'], identifier: ['HORIZON-CL4-2027-01-MAT-PROD-99'], title: ['Research topic'], typesOfAction: ['HORIZON-RIA HORIZON Research and Innovation Actions'], frameworkProgramme: ['43108390'], deadlineDate: ['2027-02-02T00:00:00.000+0000'] } };
  assert.equal(mapEuHit(ria, TODAY).id, 'eu-HORIZON-CL4-2027-01-MAT-PROD-99');
});

test('EU: cancelled and non-business identifiers dropped; INFRA, WIDERA, Digital education stay', () => {
  for (const id of ['HORIZON-NEB-2027-01-REGEN-03-CANCELLED', 'HORIZON-EIT-2025-KIC-IBA-UM', 'HORIZON-EIT-2025-MOC-IBA', 'EURATOM-2021-ADHOC-IBA', 'HORIZON-MISS-2025-CIT-SGA', 'HORIZON-EIC-2021-EEN-01-01', 'DIGITAL-ECCC-2027-DEPLOY-CYBER-11-NCC', 'DIGITAL-ECCC-2024-DEPLOY-NCC-06-MS-COORDINATION', 'CERV-2025-DAPHNE'])
    assert.equal(isNonBusinessId(id), true, id);
  for (const id of ['HORIZON-INFRA-2027-01-DEV-02', 'HORIZON-WIDERA-2027-ACCESS-03', 'DIGITAL-2026-SKILLS-08-SPECIALISED-EDU', 'DIGITAL-JU-CHIPS-2026-AI1-SG', 'HORIZON-EIC-2026-ACCELERATOR-01', 'HORIZON-CL5-2026-D2-01-SGAX'])
    assert.equal(isNonBusinessId(id), false, id);
  const hit = (identifier) => ({ metadata: { type: ['1'], identifier: [identifier], title: ['T'], frameworkProgramme: ['43152860'], deadlineDate: ['2027-02-02T00:00:00.000+0000'] } });
  assert.equal(mapEuHit(hit('DIGITAL-ECCC-2027-DEPLOY-CYBER-11-NCC'), TODAY), null);
  assert.ok(mapEuHit(hit('DIGITAL-2026-SKILLS-08-SPECIALISED-EDU'), TODAY));
  // yesterday's items get the same rules (EU API down / offline rebuild)
  const cs = 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/competitive-calls-cs/44121492';
  assert.deepEqual(normalizeEuItem({ id: 'eu-HORIZON-CL5-2021-D2-01-16', code: 'HORIZON-CL5-2021-D2-01-16', title: 'DUT', url: cs }), { id: 'eu-cs-44121492', code: null, parentTopic: 'HORIZON-CL5-2021-D2-01-16', title: 'DUT', url: cs });
  assert.equal(normalizeEuItem({ id: 'eu-HORIZON-EIT-2025-KIC-IBA-H', code: 'HORIZON-EIT-2025-KIC-IBA-H', title: 'EITHEALTH Business Plan 2026', url: cs }), null);
});

test('two cascades under one parent topic stay separate; verified items replace auto twins by URL, altUrl or title+deadline', async () => {
  const CS = 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/competitive-calls-cs/';
  const casc = (n, title, deadline) => ({ metadata: { type: ['8'], identifier: ['HORIZON-CL4-2023-DIGITAL-EMERGING-01-02'], title: [title], deadlineDate: [deadline + 'T00:00:00.000+0000'], url: [CS + n] } });
  const a = mapEuHit(casc(45634882, 'FORTIS advanced human robot interaction', '2026-11-04'), TODAY);
  const b = mapEuHit(casc(45634999, 'Other cascade under the same topic', '2026-11-20'), TODAY);
  assert.notEqual(a.id, b.id);
  const topic = (id, title, deadline, url) => ({ id: 'eu-' + id, code: id, title, deadline, url, scope: 'eu', auto: true, cat: 'KKV fejlesztés' });
  const euItems = [a, b,
    topic('HORIZON-X-01', 'Same call, other code', '2027-01-10', 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-X-01'),
    topic('HORIZON-Y-02', 'Twin by Title', '2027-02-10', 'https://ec.europa.eu/y'),
    topic('HORIZON-Z-03', 'Unrelated', '2027-02-10', 'https://ec.europa.eu/z')];
  const v = (id, extra) => ({ id, title: id, cat: 'KKV fejlesztés', verifiedAt: TODAY, scope: 'eu', url: 'https://example.eu/' + id, ...extra });
  const verifiedItems = [
    v('v-fortis', { deadline: '2026-11-04', url: 'https://fortis-project.eu/open-call-2/', altUrls: [CS + '45634882'] }),
    v('v-x', { deadline: '2027-01-10', url: 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/horizon-x-01/' }),
    v('v-y', { deadline: '2027-02-10', title: 'Twin by title' }),
  ];
  const out = await buildFeed({ tenders: [], verifiedItems, apiVerified: {}, euItems, today: TODAY });
  assert.deepEqual(out.euAuto.map((g) => g.id), [b.id, 'eu-HORIZON-Z-03']);
  assert.equal(normUrl('https://www.Example.eu/a/?q=1#x'), normUrl('http://example.eu/a?q=1'));
  assert.notEqual(normUrl('https://p.hu/r?code=A'), normUrl('https://p.hu/r?code=B'));
});

test('withdrawn verified item is hidden and blocks its auto EU twin', async () => {
  const url = 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/horizon-eic-2026-step';
  const verifiedItems = [{ id: 'v-step', code: 'HORIZON-EIC-2026-STEP', title: 'EIC STEP', cat: 'KKV fejlesztés', deadline: '2026-11-25', url, verifiedAt: TODAY, scope: 'eu', withdrawn: 'cut-off törölve' }];
  const euItems = [{ id: 'eu-HORIZON-EIC-2026-STEP', code: 'HORIZON-EIC-2026-STEP', title: 'STEP Scale Up', deadline: '2026-11-25', url: url.replace('horizon-eic-2026-step', 'HORIZON-EIC-2026-STEP'), scope: 'eu', auto: true, cat: 'KKV fejlesztés' }];
  const out = await buildFeed({ tenders: [], verifiedItems, apiVerified: {}, euItems, today: TODAY });
  assert.equal(out.grants.length, 0);
  assert.ok(out.dropped.some((d) => d.id === 'v-step' && /visszavonva/.test(d.why)));
});

test('change log: a verified item replacing its auto twin (or a cascade re-id) is not removed+new', () => {
  const u = 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/';
  const prev = [
    { id: 'eu-HORIZON-EIC-2026-PATHFINDERCHALLENGES-01-01', title: 'Auto title', deadline: '2026-10-28', url: u + 'HORIZON-EIC-2026-PATHFINDERCHALLENGES-01-01' },
    { id: 'eu-HORIZON-CL5-2021-D2-01-16', title: 'Co-Funded Partnership: DUT', deadline: '2026-11-17', url: 'https://ec.europa.eu/cs/44121492' },
    { id: 'v-old', title: 'Same Title', deadline: '2027-01-01', url: 'https://a.eu/1' },
    { id: 'gone', title: 'Really gone', deadline: '2027-01-01', url: 'https://a.eu/gone' },
  ];
  const now = [
    { id: 'v-horizon-eic-2026-pathfinderchallenges-01-01', title: 'Verified title', deadline: '2026-10-29', url: u + 'horizon-eic-2026-pathfinderchallenges-01-01' },
    { id: 'eu-cs-44121492', title: 'Co-Funded Partnership: DUT', deadline: '2026-11-17', url: 'https://ec.europa.eu/cs/44121492' },
    { id: 'eu-SAME', title: 'Same title', deadline: '2027-01-01', url: 'https://ec.europa.eu/same' },
    { id: 'brand-new', title: 'New call', deadline: '2027-01-01', url: 'https://a.eu/new' },
  ];
  const ch = diff(prev, now);
  assert.deepEqual(ch.map((c) => `${c.type}:${c.id}`).sort(), ['deadline:v-horizon-eic-2026-pathfinderchallenges-01-01', 'new:brand-new', 'removed:gone']);
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

test('eligibility tags pass through: API overlay, verified items, auto EU consortium tag', async () => {
  const euItems = sedia.results.map((h) => mapEuHit(h, TODAY)).filter(Boolean);
  const out = await buildFeed({ tenders, verifiedItems, apiVerified, euItems, today: TODAY });
  const byId = Object.fromEntries(out.grants.map((g) => [g.id, g]));
  // API item: tags come from the api-verified.json overlay
  const bp = byId['pg-GINOP_PLUSZ-1.4.4-24'];
  assert.equal(bp.requires.bank_loan, true);
  assert.ok(bp.requiresEvidence.bank_loan.length > 4);
  // hand-verified item keeps its own tags
  const v = verifiedItems.find((it) => it.requires && it.requires.forestry && (!it.deadline || it.deadline >= TODAY));
  assert.deepEqual(byId[v.id].requires, v.requires);
  // auto EU consortium call gets the tag with its note as evidence
  const ia = byId['eu-HORIZON-CL4-2027-01-DIGITAL-EMERGING-07'];
  assert.equal(ia.singleApplicant, false);
  assert.equal(ia.requires.consortium, true);
  assert.match(ia.requiresEvidence.consortium, /konzorcium/);
  // overlay with tags on an otherwise unknown code
  const t = tenders.find((x) => x.code === 'GINOP_PLUSZ-9.9.9-26');
  const o2 = await buildFeed({ tenders: [t], verifiedItems: [], apiVerified: { [t.code]: { requires: { employer: true }, requiresEvidence: { employer: 'min. 1 fő foglalkoztatott' }, sources: [] } }, euItems: [], today: TODAY });
  assert.deepEqual(o2.grants[0].requires, { employer: true });
});

test('offline rebuild re-applies overlays and verified items to yesterday\'s feed', async () => {
  const { rebuildOffline } = await import('./rebuild-offline.mjs');
  const prevGrants = [
    { id: 'pg-A', code: 'A', title: 'A', cat: 'KKV fejlesztés', deadline: '2026-12-31', url: 'https://x.hu/a', live: true, scope: 'hazai' },
    { id: 'pg-B', code: 'B', title: 'B', cat: 'KKV fejlesztés', deadline: '2026-12-31', url: 'https://x.hu/b', live: true, scope: 'hazai' },
    { id: 'pg-C', code: 'C', title: 'C', cat: 'KKV fejlesztés', deadline: '2026-09-01', url: 'https://x.hu/c', live: true, scope: 'hazai' },
    { id: 'eu-X', code: 'X', auto: true, scope: 'eu', singleApplicant: false, note: 'Angol nyelvű EU felhívás; jellemzően nemzetközi konzorcium szükséges.', deadline: '2026-11-01', title: 'x', cat: 'KKV fejlesztés', url: 'https://ec.europa.eu/x' },
  ];
  const apiVerified = { A: { note: 'új', requires: { bank_loan: true }, requiresEvidence: { bank_loan: 'MFB Pontokon' }, sources: ['https://x.hu/a'] }, B: { exclude: true, reason: 'technikai' } };
  const out = await rebuildOffline({ prevGrants, verifiedItems: [{ id: 'v-1', title: 'V', cat: 'KKV fejlesztés', deadline: '2026-10-30', url: 'https://kth.hu/v', verifiedAt: TODAY, scope: 'hazai' }], apiVerified, monitor: null, today: TODAY });
  assert.deepEqual(out.grants.map((g) => g.id), ['pg-A', 'v-1', 'eu-X']);
  assert.equal(out.grants[0].note, 'új');
  assert.deepEqual(out.grants[0].requires, { bank_loan: true });
  assert.equal(out.grants[2].requires.consortium, true);
  assert.deepEqual(out.excluded.map((e) => e.code), ['B']);
});

import { isForIndividuals } from './fetch-eu-calls.mjs';
test('calls for private persons are dropped; organisation and large-company calls stay', () => {
  for (const [t, id] of [['MSCA Postdoctoral Fellowships 2026', 'HORIZON-MSCA-2026-PF-01'], ['ERC Advanced Grant', 'ERC-2026-ADG'], ['Lakossági napelem program', ''], ['PhD candidates mobility', '']])
    assert.equal(isForIndividuals(t, id), true, t);
  for (const [t, id] of [['Joint Cluster Initiatives (EUROCLUSTERS)', 'SMP-COSME-2026-CLUSTER'], ['Large-scale battery manufacturing (IA)', 'HORIZON-CL5-2026-D2-01'], ['Student and family engagement for civic participation', 'HORIZON-CL2-2027-01-DEMOCRACY-03'], ['EIC Accelerator', 'HORIZON-EIC-2026-ACCELERATOR'], ['MSCA Doctoral Networks 2026', 'HORIZON-MSCA-2026-DN-01-01'], ['MSCA Staff Exchanges 2026', 'HORIZON-MSCA-2026-SE-01-01']])
    assert.equal(isForIndividuals(t, id), false, t);
});
