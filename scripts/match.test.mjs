// Run: node --test scripts/match.test.mjs — the company ↔ grant matcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../aipalyazo/lib/match.js');
const TODAY = '2026-09-25';
const maker = { company: 'X', employees: '26-50', industries: ['Manufacturing'], site_region: 'Észak-Alföld', years_operating: '3-5', public_debt_free: 'igen', in_difficulty: 'nem', own_funds: 'igen' };
const g = (o) => ({ title: 'Teszt', cat: 'KKV fejlesztés', type: 'grant', deadline: '2026-12-31', regions: [], sizeClasses: [], scope: 'hazai', ...o });
const fails = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.key);

test('portal and e-mail use the same matcher file', () => {
  assert.equal(readFileSync(new URL('../aipalyazo/lib/match.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../supabase/functions/_shared/match.js', import.meta.url), 'utf8'));
});
test('sector-only calls: fish processing is not for a manufacturer, is for a farm', () => {
  const fish = g({ title: 'Halfeldolgozás', cat: 'Mezőgazdaság' });
  assert.deepEqual(fails(M.match(fish, maker, TODAY)), ['sector']);
  assert.equal(M.match(fish, { ...maker, industries: ['Agriculture'] }, TODAY).eligible, true);
});
test('region, size and closed years are hard checks', () => {
  assert.deepEqual(fails(M.match(g({ regions: ['Budapest'] }), maker, TODAY)), ['region']);
  assert.deepEqual(fails(M.match(g({ sizeClasses: ['mikrovállalkozás'] }), maker, TODAY)), ['size']);
  assert.deepEqual(fails(M.match(g({ note: 'Min. 2 lezárt üzleti év kell.' }), { ...maker, years_operating: '1' }, TODAY)), ['years']);
  assert.ok(M.match(g({ regions: ['Budapest'] }), maker, TODAY).score <= 30);
});
test('public debt / company in difficulty blocks state aid, not EU calls', () => {
  assert.deepEqual(fails(M.match(g({}), { ...maker, public_debt_free: 'nem' }, TODAY)), ['basics']);
  assert.equal(M.match(g({ scope: 'eu', singleApplicant: true }), { ...maker, public_debt_free: 'nem' }, TODAY).eligible, true);
});
test('ranking: topic match beats generic, grant beats loan, consortium is a warning', () => {
  const topic = M.match(g({ title: 'Ipari gyártókapacitás bővítése' }), maker, TODAY).score;
  const generic = M.match(g({ cat: 'Turizmus', title: 'Általános' }), maker, TODAY).score;
  const loan = M.match(g({ title: 'Ipari gyártókapacitás bővítése', type: 'loan' }), maker, TODAY).score;
  const consort = M.match(g({ title: 'Ipari gyártás', scope: 'eu', singleApplicant: false }), maker, TODAY);
  assert.ok(topic > generic && topic > loan, `${topic} ${generic} ${loan}`);
  assert.ok(consort.checks.some((c) => c.key === 'consortium' && c.status === 'warn'));
  assert.equal(consort.group, 'consortium');
});
test('no profile: neutral, never claims APPLY', () => {
  const r = M.match(g({}), null, TODAY);
  assert.equal(r.personal, false);
  assert.equal(r.verdict, 'REVIEW');
});
test('every live item gets a valid match for a sample profile', () => {
  const items = JSON.parse(readFileSync(new URL('../aipalyazo/grants_live.json', import.meta.url), 'utf8'));
  for (const it of items) {
    const r = M.match(it, maker, TODAY);
    assert.ok(Number.isFinite(r.score) && r.score >= 5 && r.score <= 99, it.id);
    assert.ok(r.checks.every((c) => c.label && c.reason && ['ok', 'warn', 'fail', 'unknown', 'neutral'].includes(c.status)), it.id);
  }
});

import { createHash } from 'node:crypto';
const G = require('../aipalyazo/lib/hu-geo.js');
test('postcode → region; copies identical', () => {
  assert.equal(readFileSync(new URL('../aipalyazo/lib/hu-geo.js', import.meta.url), 'utf8'), readFileSync(new URL('../supabase/functions/_shared/hu-geo.js', import.meta.url), 'utf8'));
  assert.equal(G.regionOf('1025'), 'Budapest');
  assert.equal(G.regionOf('2440'), 'Pest');
  assert.equal(G.regionOf('4032'), 'Észak-Alföld');
  assert.equal(G.regionOf('8360'), 'Nyugat-Dunántúl');
  assert.equal(G.regionOf('7621'), 'Dél-Dunántúl');
  assert.equal(G.regionOf('x'), null);
});
test('TEÁOR drives sector and exclusion checks', () => {
  assert.deepEqual(M.teaorIndustries('1071 Kenyérgyártás'), ['Manufacturing', 'Food']);
  const r = M.match(g({}), { ...maker, industries: [], teaor: '6820' }, TODAY);
  assert.ok(r.checks.some((c) => c.key === 'teaor' && c.status === 'warn'));
  assert.deepEqual(M.missingFields({ employees: '1-5' }).map((f) => f.key), ['site_region', 'teaor', 'years_operating', 'public_debt_free', 'in_difficulty', 'own_funds', 'rnd']);
});
test('NAV queryTaxpayer: request signature and response parsing', async () => {
  const { buildQueryTaxpayerXml, parseTaxpayerResponse, normalizeTaxNumber } = await import('../supabase/functions/_shared/nav.mjs');
  const h = (alg) => (s) => createHash(alg).update(s).digest('hex');
  const xml = await buildQueryTaxpayerXml({ login: 'l', password: 'p', signKey: 'k', ownTaxNumber: '12345678', software: { id: 'HU12345678AIPALY01', name: 'x', version: '1.0', devName: 'x', devContact: 'x@y.hu', devTaxNumber: '12345678' }, targetTaxNumber: '87654321', requestId: 'RID1', date: new Date('2026-09-25T10:11:12.345Z') }, { sha512Hex: h('sha512'), sha3_512Hex: h('sha3-512') });
  assert.ok(xml.includes(h('sha3-512')('RID120260925101112k').toUpperCase()));
  assert.ok(xml.includes(h('sha512')('p').toUpperCase()));
  assert.equal(normalizeTaxNumber('12345678-1-41'), '12345678');
  const ok = parseTaxpayerResponse('<ns2:R><result><funcCode>OK</funcCode></result><ns2:taxpayerValidity>true</ns2:taxpayerValidity><ns2:taxpayerName>MINTA BT</ns2:taxpayerName><ns2:incorporation>ORGANIZATION</ns2:incorporation><ns2:taxpayerAddressItem><ns2:taxpayerAddressType>HQ</ns2:taxpayerAddressType><ns3:postalCode>6720</ns3:postalCode><ns3:city>SZEGED</ns3:city></ns2:taxpayerAddressItem></ns2:R>');
  assert.equal(ok.legalForm, 'Bt'); assert.equal(ok.postalCode, '6720');
  assert.equal(parseTaxpayerResponse('<x><funcCode>OK</funcCode><taxpayerValidity>false</taxpayerValidity></x>').found, false);
  assert.equal(parseTaxpayerResponse('<x><funcCode>ERROR</funcCode><errorCode>E</errorCode></x>').ok, false);
});

// ---- matching v2: eligibility tags ("requires") ------------------------------
test('requires: consortium calls are never a top recommendation', () => {
  const g = { id: 'x', title: 'Horizon test', cat: 'Kutatás-fejlesztés', type: 'grant', scope: 'eu', singleApplicant: false, deadline: '2027-01-01', requires: { consortium: true, rnd_project: true } };
  const p = { company: 'A', industries: ['IT'], employees: '1-5', site_region: 'Budapest', years_operating: '3-5', rnd: 'igen' };
  const m = M.match(g, p, '2026-09-28');
  assert.equal(m.group, 'consortium');
  assert.notEqual(m.verdict, 'APPLY');
  assert.ok(m.checks.some((c) => c.key === 'consortium' && c.status === 'warn'));
});
test('requires: target groups fail for the wrong company and pass for the right one', () => {
  const base = { id: 'y', title: 'T', cat: 'KKV fejlesztés', type: 'grant', scope: 'hazai', deadline: '2027-01-01' };
  const it = { company: 'A', industries: ['IT'], employees: '1-5', site_region: 'Budapest', years_operating: '3-5', teaor: '6201' };
  assert.equal(M.match({ ...base, requires: { farmer: true } }, it, '2026-09-28').eligible, false);
  assert.equal(M.match({ ...base, requires: { jobseeker: true } }, it, '2026-09-28').eligible, false);
  assert.equal(M.match({ ...base, requires: { startup_max_years: 2 } }, it, '2026-09-28').eligible, false);
  assert.equal(M.match({ ...base, requires: { cluster_manager: true } }, it, '2026-09-28').eligible, false);
  assert.equal(M.match({ ...base, requires: { women_led: true } }, { ...it, women_led: 'nem' }, '2026-09-28').eligible, false);
  assert.equal(M.match({ ...base, requires: { women_led: true } }, { ...it, women_led: 'igen' }, '2026-09-28').eligible, true);
  assert.equal(M.match({ ...base, requires: { rnd_project: true } }, { ...it, rnd: 'nem' }, '2026-09-28').eligible, false);
  const farm = { company: 'F', industries: ['Agriculture'], employees: '1', site_region: 'Dél-Alföld', years_operating: '5+', teaor: '0111' };
  assert.equal(M.match({ ...base, requires: { farmer: true } }, farm, '2026-09-28').eligible, true);
  assert.equal(M.match({ ...base, requires: { fisheries: true } }, farm, '2026-09-28').eligible, false, 'crop farm is not a fish farm');
  assert.equal(M.match({ ...base, requires: { min_revenue_huf: 100e6 } }, { ...it, revenue: '<50M' }, '2026-09-28').eligible, false);
});
test('requires: the four audit companies no longer get a consortium or target-group call on top', () => {
  const feed = JSON.parse(readFileSync(new URL('../aipalyazo/grants_live.json', import.meta.url), 'utf8'));
  const P = [
    { company: 'x', industries: ['IT'], employees: '1-5', site_region: 'Budapest', years_operating: '3-5', public_debt_free: 'igen', in_difficulty: 'nem', own_funds: 'igen', teaor: '6201' },
    { company: 'x', industries: ['Manufacturing'], employees: '26-50', site_region: 'Észak-Alföld', years_operating: '5+', public_debt_free: 'igen', in_difficulty: 'nem', own_funds: 'igen', teaor: '2562' },
    { company: 'x', industries: ['Tourism', 'Restaurant'], employees: '1-5', site_region: 'Észak-Magyarország', years_operating: '5+', public_debt_free: 'igen', in_difficulty: 'nem', own_funds: 'igen', teaor: '5520' },
    { company: 'x', industries: ['General'], employees: '1', site_region: 'Dél-Alföld', years_operating: '2', public_debt_free: 'igen', in_difficulty: 'nem', own_funds: 'nem', teaor: '9602' },
  ];
  for (const p of P) {
    const top = feed.map((g) => ({ g, m: M.match(g, p, '2026-09-28') })).filter((x) => x.m.eligible).sort((a, b) => b.m.score - a.m.score).slice(0, 3);
    for (const t of top) {
      assert.notEqual(t.m.group, 'consortium', `${p.industries} got consortium call ${t.g.title}`);
      assert.ok(!(t.g.requires && (t.g.requires.jobseeker || t.g.requires.research_led || t.g.requires.cluster_manager)), `${p.industries} got ${t.g.title}`);
    }
  }
});
