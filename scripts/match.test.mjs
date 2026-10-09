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

// ---- matching v3: engine audit (Oct 2026) ------------------------------------
const T3 = '2026-10-09';
const ok3 = { public_debt_free: 'igen', in_difficulty: 'nem', own_funds: 'igen', rnd: 'nem', women_led: 'nem' };
const live3 = JSON.parse(readFileSync(new URL('../aipalyazo/grants_live.json', import.meta.url), 'utf8'));
const byId3 = (id) => live3.find((x) => x.id === id);
const sizeOf = (r) => r.checks.find((c) => c.key === 'size').status;

test('size: 250+ is large (fails KKV-only calls), 101-249 is mid, legacy 100+ is unknown', () => {
  assert.equal(M.sizeTier('250+'), 'large');
  assert.equal(M.sizeTier('101-249'), 'mid');
  assert.equal(M.sizeTier('100+'), null);
  const large = { ...ok3, company: 'L', industries: ['Manufacturing'], employees: '250+', site_region: 'Közép-Dunántúl', teaor: '2932', years_operating: '5+' };
  const kkv = g({ title: 'Ipari gyártás', sizeClasses: ['mikrovállalkozás', 'kisvállalkozás', 'középvállalkozás'] });
  assert.deepEqual(fails(M.match(kkv, large, T3)), ['size']);
  assert.equal(sizeOf(M.match(g({ sizeClasses: ['mikrovállalkozás', 'kisvállalkozás', 'középvállalkozás', 'nagyvállalkozás'] }), large, T3)), 'ok');
  assert.equal(sizeOf(M.match(g({}), large, T3)), 'ok');
  assert.equal(sizeOf(M.match(kkv, { ...large, employees: '101-249' }, T3)), 'ok');
  const legacy = M.match(kkv, { ...large, employees: '100+' }, T3);
  assert.equal(sizeOf(legacy), 'unknown');
  assert.notEqual(legacy.verdict, 'APPLY');
  assert.equal(M.missingFields({ ...large, employees: '100+' }).some((f) => f.key === 'employees'), true);
  // The live KKV-only calls the audit found
  for (const id of ['v-szechenyi-kartya-folyoszamlahitel-max', 'pg-DIMOP_PLUSZ-1.2.3/A-24', 'pg-DIMOP_PLUSZ-1.2.3/B-24', 'pg-GINOP_PLUSZ-1.4.3-24']) {
    assert.equal(M.match(byId3(id), large, T3).verdict, 'SKIP', id);
  }
});
test('large companies still get APPLY on calls open to them, consortium calls included', () => {
  const large = { ...ok3, company: 'L', industries: ['Manufacturing'], employees: '250+', site_region: 'Közép-Dunántúl', teaor: '2932', years_operating: '5+', revenue: '10Mrd+' };
  const rows = live3.map((x) => M.match(x, large, T3)).filter((m) => m.verdict === 'APPLY');
  assert.ok(rows.length >= 5, `only ${rows.length} APPLY`);
  assert.ok(rows.some((m) => m.group === 'consortium'), 'no consortium APPLY for a large firm');
  const cons = g({ title: 'Ipari gyártás', scope: 'eu', singleApplicant: false, requires: { consortium: true } });
  assert.equal(M.match(cons, large, T3).verdict, 'APPLY');
  assert.notEqual(M.match(cons, { ...large, employees: '6-10' }, T3).verdict, 'APPLY');
});
test('generic business money is not APPLY without a topic match', () => {
  const p = { ...ok3, company: 'W', industries: ['Retail'], employees: '1-5', site_region: 'Észak-Alföld', teaor: '4791', years_operating: '2' };
  const loan = M.match(g({ title: 'Általános beruházási hitel', type: 'loan', cat: 'KKV fejlesztés' }), p, T3);
  assert.equal(loan.verdict, 'REVIEW');
  assert.ok(loan.checks.find((c) => c.key === 'sector').bonus <= 3);
  for (const id of ['v-szechenyi-mikrohitel-max', 'v-mfb-zold-lendulet-hitelprogram', 'v-garantiqa-investeu']) assert.notEqual(M.match(byId3(id), p, T3).verdict, 'APPLY', id);
});
test('TEÁOR: 4–6 digit codes, year labels ignored; missing TEÁOR leaves sector gates unknown', () => {
  assert.deepEqual(M.teaorIndustries('620104'), ['IT']);
  assert.deepEqual(M.teaorIndustries('6201'), ['IT']);
  assert.deepEqual(M.teaorIndustries('62.01'), ['IT']);
  assert.deepEqual(M.teaorIndustries('2025: 6201'), ['IT']);
  assert.deepEqual(M.teaorIndustries('0111 Gabonafélék termesztése'), ['Agriculture']);
  const farm = { ...ok3, company: 'F', industries: ['Agriculture'], employees: '1', site_region: 'Dél-Alföld', years_operating: '5+' };
  const fish = g({ title: 'Akvakultúra beruházás', requires: { fisheries: true } });
  const r = M.match(fish, farm, T3);
  assert.equal(r.eligible, true);
  assert.notEqual(r.verdict, 'APPLY');
  assert.ok(r.checks.some((c) => c.key === 'fisheries' && c.status === 'unknown'));
  assert.equal(M.match(fish, { ...farm, teaor: '0111' }, T3).eligible, false);
  assert.equal(M.match(fish, { ...farm, teaor: '0321' }, T3).verdict, 'APPLY');
  for (const id of ['pg-MAHOP_PLUSZ-2.5.1-25', 'pg-MAHOP_PLUSZ-2.1.1-25', 'pg-MAHOP_PLUSZ-1.3.1-25']) assert.notEqual(M.match(byId3(id), farm, T3).verdict, 'APPLY', id);
});
test('hard unknowns, empty budget and bonus stacking cap the verdict', () => {
  const p = { ...ok3, company: 'U', industries: ['General'], employees: '1' };
  assert.notEqual(M.match(byId3('v-vallalkozova-valast-elosegito-tamogatas'), p, T3).verdict, 'APPLY');
  const it = { ...ok3, company: 'I', industries: ['IT'], employees: '1-5', site_region: 'Budapest', teaor: '6201', years_operating: '3-5' };
  const topic = g({ title: 'Szoftverfejlesztés támogatása' });
  assert.equal(M.match(topic, it, T3).verdict, 'APPLY');
  assert.equal(M.match({ ...topic, keret: 1e9, remaining: 0 }, it, T3).verdict, 'REVIEW');
  assert.equal(M.match({ ...topic, requires: { women_led: true } }, { ...it, women_led: undefined }, T3).verdict, 'REVIEW');
  assert.equal(M.match({ ...topic, requires: { min_revenue_huf: 100e6 } }, it, T3).verdict, 'REVIEW');
  const stacked = M.match({ ...topic, requires: { rnd_project: true } }, { ...it, rnd: 'igen', categories: ['KKV fejlesztés'] }, T3);
  assert.ok(stacked.score <= 60 + 22 + 6 + 4 + 2, String(stacked.score));
});
test('sector keywords: no category matching, no substring traps', () => {
  const it = { ...ok3, company: 'I', industries: ['IT'], employees: '1-5', site_region: 'Budapest', teaor: '6201', years_operating: '3-5' };
  const bonus = (o, p = it) => M.match(g(o), p, T3).checks.find((c) => c.key === 'sector').bonus || 0;
  assert.ok(bonus({ title: 'Zöld átállás', cat: 'Digitális átalakulás', scope: 'eu' }) <= 3, 'category label is not a topic');
  assert.equal(bonus({ title: 'Adatvédelmi és adatkezelési fejlesztés' }), 18);
  const agri = { ...it, industries: ['Agriculture'], teaor: '1013' };
  assert.ok(bonus({ title: 'A nemzetgazdaság versenyképessége', scope: 'eu' }, agri) <= 3, 'gazd ≠ agriculture');
  assert.equal(M.match(g({ title: 'Erdőtelepítés' }), agri, T3).eligible, false, 'food processor is not a forestry');
  assert.equal(M.match(g({ title: 'Erdőtelepítés' }), { ...agri, teaor: '0210' }, T3).eligible, true);
  const constr = { ...it, industries: ['Construction'], teaor: '4120' };
  assert.ok(bonus({ title: 'Capacity building for researchers', scope: 'eu' }, constr) <= 3, 'building ≠ construction');
  assert.ok(bonus({ title: 'Kutatási kapacitásépítés', scope: 'eu' }, constr) <= 3, 'kapacitásépítés ≠ construction');
  assert.equal(bonus({ title: 'Épületenergetikai felújítás' }, constr), 18);
  const tour = { ...it, industries: ['Tourism'], teaor: '5510' };
  assert.ok(bonus({ title: 'Vendégkutatói ösztöndíj', scope: 'eu' }, tour) <= 3, 'vendégkutató ≠ tourism');
  const edu = { ...it, industries: ['Education'], teaor: '8559' };
  assert.ok(bonus({ title: 'Megvalósíthatósági tanulmány', scope: 'eu' }, edu) <= 3, 'tanulmány ≠ education');
});
test('public debt / difficulty: guarantees fail, EU calls warn', () => {
  const debt = { ...maker, public_debt_free: 'nem' };
  assert.deepEqual(fails(M.match(g({ type: 'guarantee' }), debt, T3)), ['basics']);
  const eu = M.match(g({ scope: 'eu', singleApplicant: true }), { ...maker, in_difficulty: 'igen' }, T3);
  assert.ok(eu.checks.some((c) => c.key === 'basics' && c.status === 'warn'));
  const constr = { ...ok3, company: 'C', industries: ['Construction'], employees: '11-25', site_region: 'Pest', teaor: '4120', years_operating: '5+', public_debt_free: 'nem' };
  for (const x of live3.filter((y) => y.type === 'guarantee')) assert.notEqual(M.match(x, constr, T3).verdict, 'APPLY', x.id);
});
test('closed years in words; employer minimum head-count', () => {
  const young = { ...maker, years_operating: '0' };
  assert.deepEqual(fails(M.match(g({ note: 'Legalább egy lezárt üzleti évvel rendelkező KKV-k.' }), young, T3)), ['years']);
  assert.deepEqual(fails(M.match(g({ note: 'Min. két lezárt üzleti év.' }), { ...maker, years_operating: '1' }, T3)), ['years']);
  const emp = g({ note: 'MGFÜ-regisztráció, min. 5 fő, 3 lezárt év.', requires: { employer: true } });
  const st = (e) => M.match(emp, { ...maker, employees: e }, T3).checks.find((c) => c.key === 'employer').status;
  assert.equal(st('1-5'), 'unknown');
  assert.equal(st('1'), 'fail');
  assert.equal(st('6-10'), 'ok');
});
test('personas: women-led deeptech startup sees Women TechEU and EIC Accelerator in its top 5', () => {
  const p = { ...ok3, company: 'D', industries: ['IT'], employees: '1-5', site_region: 'Budapest', teaor: '7219', years_operating: '0', rnd: 'igen', women_led: 'igen', revenue: '<50M' };
  const rank = (m) => (m.verdict === 'APPLY' ? 1000 : m.verdict === 'REVIEW' ? 500 : 0) + (m.group === 'hazai' ? 3 : 0) - (m.group === 'consortium' ? 10 : 0) + m.score;
  const top = live3.map((x) => ({ x, m: M.match(x, p, T3) })).filter((r) => r.m.eligible).sort((a, b) => rank(b.m) - rank(a.m)).slice(0, 5).map((r) => r.x.id);
  assert.ok(top.includes('v-horizon-eie-womentecheu-2'), top.join());
  assert.ok(top.includes('v-horizon-eic-2026-accelerator-01'), top.join());
});
