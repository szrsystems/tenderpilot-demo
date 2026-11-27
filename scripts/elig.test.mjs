// Run: node --test scripts/elig.test.mjs — detailed eligibility sheet (DFT model):
// derived values, new call tags, universal state-aid rules, sheet helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { checkRequires, cleanRequires } from './requires.mjs';
const require = createRequire(import.meta.url);
require('../aipalyazo/lib/hu-geo.js');
require('../aipalyazo/lib/hu-favoured.js');
const M = require('../aipalyazo/lib/match.js');
const EL = require('../aipalyazo/lib/elig-schema.js');
const TODAY = '2026-11-25';
const base = { company: 'X', legal_form: 'Kft', employees: '6-10', industries: ['Manufacturing'], teaor: '2562', site_region: 'Észak-Magyarország', years_operating: '3-5', public_debt_free: 'igen', in_difficulty: 'nem', own_funds: 'igen' };
const withE = (e, o = {}) => ({ ...base, ...o, elig: e });
const g = (o) => ({ title: 'Gépbeszerzés gyártó KKV-knak', cat: 'KKV fejlesztés', type: 'grant', deadline: '2027-03-31', regions: [], sizeClasses: [], scope: 'hazai', ...o });
const tag = (requires) => g({ requires, requiresEvidence: Object.fromEntries(Object.keys(requires).map((k) => [k, 'idézet a felhívásból'])) });
const st = (r, key) => (r.checks.find((c) => c.key === key) || {}).status;
const fails = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.key);

test('founding date gives exact closed full years', () => {
  assert.equal(M.derive(withE({ founded_date: '2023-03-10' }), TODAY)._years, 2); // 2024, 2025
  assert.equal(M.derive(withE({ founded_date: '2024-01-01' }), TODAY)._years, 2);
  assert.equal(M.derive(withE({ founded_date: '2026-02-01' }), TODAY)._years, 0);
  const r = M.match(tag({ min_closed_years: 3 }), withE({ founded_date: '2023-03-10' }), TODAY);
  assert.equal(st(r, 'years'), 'fail');
});

test('SME size from headcount + annual report, group level, public ownership', () => {
  const fin = [{ avg_stat_headcount: '8', net_revenue: '600000', total_assets: '300000' }]; // 600 M Ft = 1.5 M €
  assert.equal(M.derive(withE({ fin }), TODAY)._tier, 'micro');
  // a 60% subsidiary with 30 people pushes it into "small"
  const links = [{ name: 'Leány Kft', rel: 'leany', pct: '60', headcount: '30', revenue: '900', assets: '400' }];
  const d = M.derive(withE({ fin, links }), TODAY);
  assert.equal(d._tier, 'small'); assert.equal(d.group_member, 'igen');
  assert.deepEqual(M.match(g({ sizeClasses: ['mikrovállalkozás'] }), withE({ fin, links }), TODAY).checks.filter((c) => c.key === 'size').map((c) => c.status), ['fail']);
  // a 30% partner counts proportionally: 8 + 0.3 × 5 people → still micro
  assert.equal(M.derive(withE({ fin, links: [{ rel: 'tulajdonos', pct: '30', headcount: '5', revenue: '100' }] }), TODAY)._tier, 'micro');
  // link without figures → size stays unconfirmed (no guessing)
  assert.equal(M.derive(withE({ fin, links: [{ rel: 'tulajdonos', pct: '80' }] }), TODAY)._tier, undefined);
  // 25%+ state / municipal ownership → not an SME
  assert.deepEqual(fails(M.match(g({ sizeClasses: ['mikrovállalkozás', 'kisvállalkozás', 'középvállalkozás'] }), withE({ fin, state_ownership_pct: '20', municipal_ownership_pct: '10' }), TODAY)), ['size']);
});

test('annual report: firm in difficulty and negative equity exclude from state aid', () => {
  const hurt = withE({ founded_date: '2015-05-01', fin: [{ equity: '1000', share_capital: '3000' }] });
  const r = M.match(g({}), hurt, TODAY);
  assert.ok(fails(r).includes('basics'));
  assert.match(r.checks.find((c) => c.key === 'basics').reason, /jegyzett tőke felénél/);
  // a young company (< 3 closed years) is not "in difficulty" by this rule
  assert.equal(M.derive(withE({ founded_date: '2024-06-01', fin: [{ equity: '1000', share_capital: '3000' }] }), TODAY).in_difficulty, 'nem');
  const neg = withE({ founded_date: '2024-06-01', fin: [{ equity: '-500', share_capital: '3000' }] });
  assert.ok(fails(M.match(g({}), neg, TODAY)).includes('equity'));
  assert.equal(st(M.match(g({ scope: 'eu', singleApplicant: true }), neg, TODAY), 'equity'), 'warn');
});

test('legal proceedings and compliance declarations', () => {
  assert.match(M.match(g({}), withE({ proceedings: ['in_liquidation'] }), TODAY).checks.find((c) => c.key === 'basics').reason, /felszámolás/);
  assert.equal(M.derive(withE({ proceedings: ['in_restructuring'] }), TODAY).insolvency, undefined);
  assert.equal(M.derive(withE({ proceedings_none: true }), TODAY).insolvency, 'nem');
  assert.deepEqual(fails(M.match(g({}), withE({ orderly_labor_relations: 'nem', transparency_ok: 'igen' }), TODAY)), ['compliance']);
  assert.deepEqual(fails(M.match(g({}), withE({ is_offshore_owner: 'igen' }), TODAY)), ['compliance']);
  assert.equal(st(M.match(g({}), withE({ orderly_labor_relations: 'igen', transparency_ok: 'igen' }), TODAY), 'compliance'), 'ok');
  // unanswered: no check at all (it would push every score down)
  assert.equal(st(M.match(g({}), withE({}), TODAY), 'compliance'), undefined);
  // EU money: Hungarian labour / transparency rules are not applied
  assert.equal(st(M.match(g({ scope: 'eu', singleApplicant: true }), withE({ orderly_labor_relations: 'nem' }), TODAY), 'compliance'), undefined);
  assert.deepEqual(fails(M.match(g({}), withE({ company_status: 'szunetel' }), TODAY)), ['status']);
});

test('project site decides region and favoured district', () => {
  const p = withE({ project_postcode: '1117', project_city: 'Budapest' }); // seat in Észak-Magyarország, project in Budapest
  assert.deepEqual(fails(M.match(g({ regions: ['Észak-Magyarország', 'Észak-Alföld'] }), p, TODAY)), ['region']);
  const fav = tag({ favoured_district: true });
  assert.equal(st(M.match(fav, p, TODAY), 'favoured'), 'fail');
  assert.equal(st(M.match(fav, withE({ project_postcode: '3600', project_city: 'Ózd' }), TODAY), 'favoured'), 'ok');
});

test('TEÁOR list tags: match, mismatch caps the verdict, exclusions fail', () => {
  const call = tag({ teaor_codes: ['2562', '2511'] });
  assert.equal(st(M.match(call, withE({}), TODAY), 'teaor_codes'), 'ok');
  const other = M.match(call, withE({}, { teaor: '6201', industries: ['IT'] }), TODAY);
  assert.equal(st(other, 'teaor_codes'), 'warn'); assert.notEqual(other.verdict, 'APPLY');
  // the project's own activity counts first
  assert.equal(st(M.match(call, withE({ project_teaor: '2511' }, { teaor: '4690' }), TODAY), 'teaor_codes'), 'ok');
  // a 6-digit ÖVTJ code still matches its 4-digit TEÁOR
  assert.equal(st(M.match(call, withE({}, { teaor: '256201' }), TODAY), 'teaor_codes'), 'ok');
  assert.deepEqual(fails(M.match(tag({ excluded_teaor: ['49'] }), withE({}, { teaor: '4941' }), TODAY)), ['teaor_codes']);
});

test('other DFT-model tags', () => {
  assert.deepEqual(fails(M.match(tag({ no_sole_trader: true }), withE({}, { legal_form: 'EV' }), TODAY)), ['sole_trader']);
  assert.equal(st(M.match(tag({ min_headcount: 3 }), withE({ fin: [{ avg_stat_headcount: '2' }] }), TODAY), 'headcount'), 'fail');
  assert.equal(st(M.match(tag({ min_headcount: 3 }), withE({ fin: [{ avg_stat_headcount: '4' }] }), TODAY), 'headcount'), 'ok');
  assert.equal(st(M.match(tag({ szvz: true }), withE({ is_szvz: 'nem' }), TODAY), 'szvz'), 'fail');
  assert.equal(st(M.match(tag({ max_settlement_pop: 5000 }), withE({ settlement_pop: '1000-5000' }), TODAY), 'settlement'), 'ok');
  assert.equal(st(M.match(tag({ max_settlement_pop: 5000 }), withE({ settlement_pop: '10000-50000' }), TODAY), 'settlement'), 'fail');
  assert.equal(st(M.match(tag({ premises_min_days: 60 }), withE({ project_site_reg_date: '2026-11-01' }), TODAY), 'premises'), 'warn');
  assert.equal(st(M.match(tag({ premises_min_days: 60 }), withE({ project_site_reg_date: '2026-06-01' }), TODAY), 'premises'), 'ok');
  assert.deepEqual(fails(M.match(tag({ not_started: true }), withE({ investment_started: 'igen' }), TODAY)), ['incentive']);
  assert.equal(st(M.match(g({}), withE({ investment_started: 'igen' }), TODAY), 'incentive'), 'warn');
  assert.deepEqual(fails(M.match(tag({ equity_vs_capital: true }), withE({ fin: [{ equity: '2000', share_capital: '3000' }] }), TODAY)), ['equity']);
  assert.equal(st(M.match(tag({ project_max_revenue_pct: 50 }), withE({ fin: [{ net_revenue: '100000' }], project_total_cost: '80' }), TODAY), 'limit'), 'warn');
  assert.equal(st(M.match(tag({ export: true }), withE({ fin: [{ export_revenue: '5000' }] }), TODAY), 'export'), 'ok');
});

test('exact de minimis amount', () => {
  assert.equal(st(M.match(tag({ de_minimis: true }), withE({ de_minimis_used_3y: '310000' }), TODAY), 'de_minimis'), 'fail');
  assert.equal(st(M.match(tag({ de_minimis: true }), withE({ de_minimis_used_3y: '200000', requested_aid_amount: '60' }), TODAY), 'de_minimis'), 'warn'); // 60 M Ft = 150 k € > 100 k € left
  assert.equal(st(M.match(tag({ de_minimis: true }), withE({ de_minimis_used_3y: '0' }), TODAY), 'de_minimis'), 'ok');
});

test('no detailed sheet: matching is unchanged', () => {
  const calls = [g({}), g({ regions: ['Budapest'] }), tag({ teaor_codes: ['6201'] }), g({ scope: 'eu', singleApplicant: true })];
  for (const c of calls) assert.deepEqual(M.match(c, { ...base, elig: {} }, TODAY), M.match(c, base, TODAY));
});

test('sheet helpers: completeness and clean', () => {
  assert.equal(EL.completeness({}).done, 0);
  const c = EL.completeness({ founded_date: '2020-01-01', proceedings_none: true, links_none: true });
  assert.equal(c.done, 3);
  const cleaned = EL.clean({ founded_date: ' 2020-01-01 ', x: '', fin: [{ equity: '−1 200' }, {}], links: [{ name: '', pct: '' }], proceedings: [], links_none: false });
  assert.deepEqual(cleaned, { founded_date: '2020-01-01', fin: [{ equity: '-1200' }, {}] });
  assert.ok(JSON.stringify(EL.clean({ links: Array.from({ length: 40 }, () => ({ name: 'A'.repeat(500), pct: '60' })) })).length < 24576);
});

test('codes tags: validated and cleaned', () => {
  assert.deepEqual(checkRequires({ requires: { teaor_codes: ['2562'] }, requiresEvidence: { teaor_codes: 'TEÁOR 25.62' } }), []);
  assert.ok(checkRequires({ requires: { teaor_codes: 'x' }, requiresEvidence: { teaor_codes: 'TEÁOR 25.62' } }).length);
  const c = cleanRequires({ teaor_codes: { value: ['25.62', '2511', 'abc', '1'], evidence: 'TEÁOR 25.62, 25.11' } });
  assert.deepEqual(c.requires.teaor_codes, ['2562', '2511']);
  assert.equal(cleanRequires({ teaor_codes: { value: ['x'], evidence: 'e e e e' } }), null);
});

test('ranking: farm-only calls fail for a metal workshop; EU calls stay below domestic for a non-R&D micro firm', () => {
  const metal = { ...base, rnd: 'nem' };
  assert.ok(fails(M.match(g({ title: 'Állatjóléti támogatás a tejtermelő szarvasmarha ágazatban', cat: 'Mezőgazdaság' }), metal, TODAY)).includes('sector'));
  assert.equal(st(M.match(g({ title: 'A KAP Stratégiai Terv felhívásai alapján támogatott beruházások', cat: 'Mezőgazdaság' }), metal, TODAY), 'sector'), 'warn');
  assert.equal(st(M.match(g({ title: 'LEADER együttműködések támogatása', cat: 'Mezőgazdaság' }), { ...metal, industries: ['Agriculture'], teaor: '0111' }, TODAY), 'applicant'), 'warn');
  const eu = M.match(g({ scope: 'eu', singleApplicant: true, title: 'Industrial robotics for manufacturing SMEs' }), metal, TODAY);
  assert.ok(eu.score <= 64);
});

test('audit 2026-11-27: farm sub-sectors by 4-digit TEÁOR, county-limited calls, EU keyword noise, project companies', () => {
  const crop = { ...base, legal_form: 'EV', industries: ['Agriculture'], teaor: '0111', rnd: 'nem' };
  assert.ok(fails(M.match(g({ title: 'Állatjóléti támogatás a tejtermelő szarvasmarha ágazatban', cat: 'Mezőgazdaság' }), crop, TODAY)).includes('sector'));
  assert.ok(fails(M.match(g({ title: 'Fagykárt szenvedett ültetvények cseréjének támogatása', cat: 'Mezőgazdaság' }), crop, TODAY)).includes('sector'));
  assert.equal(M.match(g({ title: 'Fagykárt szenvedett ültetvények cseréjének támogatása', cat: 'Mezőgazdaság' }), { ...crop, teaor: '0124' }, TODAY).eligible, true);
  assert.ok(fails(M.match(g({ title: 'MFB Élelmiszeripari Forgóeszköz Hitelprogram', type: 'loan' }), crop, TODAY)).includes('sector'));
  const jtf = g({ type: 'loan+grant', regions: ['Észak-Magyarország', 'Dél-Dunántúl'], counties: ['Baranya', 'Borsod-Abaúj-Zemplén', 'Heves'] });
  assert.equal(M.match(jtf, { ...base, location: '3600 Ózd' }, TODAY).eligible, true);
  assert.deepEqual(fails(M.match(jtf, { ...base, location: '3100 Salgótarján' }, TODAY)), ['region']); // Nógrád: same region, wrong county
  const it = { ...base, industries: ['IT'], teaor: '6201', employees: '1-5', site_region: 'Budapest', rnd: 'igen' };
  const generic = M.match(g({ scope: 'eu', singleApplicant: true, title: 'EU Co-funded Partnership on raw materials for the green and digital transition — kaszkád (FSTP) nyílt felhívás' }), it, TODAY);
  assert.notEqual(generic.verdict, 'APPLY');
  assert.notEqual(M.match(g({ type: 'loan', title: 'MFB Társasház Plusz Hitelprogram', note: 'Olyan projekttársaságok igényelhetik, amelyek értékesítési céllal társasházat építenek.' }), { ...base, industries: ['Construction'], teaor: '4120' }, TODAY).verdict, 'APPLY');
});

test('audit 2026-11-27: the homepage quick check (4 answers + stated assumptions) finds something to show', () => {
  const feed = JSON.parse(readFileSync(new URL('../aipalyazo/grants_live.json', import.meta.url), 'utf8'));
  const q = { company: 'q', industries: ['Manufacturing'], employees: '6-10', years_operating: '3-5', site_region: 'Észak-Alföld', public_debt_free: 'igen', in_difficulty: 'nem', insolvency: 'nem' };
  const shown = feed.map((x) => M.match(x, q, TODAY)).filter((m) => m.eligible && m.group !== 'consortium' && (m.verdict === 'APPLY' || m.verdict === 'REVIEW'));
  assert.ok(shown.length >= 5, `only ${shown.length}`);
});
