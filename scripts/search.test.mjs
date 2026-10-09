import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const S = createRequire(import.meta.url)('../aipalyazo/lib/search.js');
const G = [
  { id: 'a', title: 'Mikro-, kis- és középvállalkozások digitalizációjának támogatása', cat: 'Digitális átalakulás', note: 'Webáruház, szoftver', scope: 'hazai' },
  { id: 'b', title: 'Széchenyi Lízing MAX+ — KKV gépjármű- és eszközlízing', cat: 'KKV fejlesztés', note: 'gépek, járművek', scope: 'hazai' },
  { id: 'c', title: 'Vállalkozások energiahatékonysági fejlesztése', cat: 'Energiahatékonyság', note: 'napelem, hőszivattyú', scope: 'hazai' },
  { id: 'd', title: 'Horizon Europe cluster call', cat: 'Kutatás-fejlesztés', scope: 'eu' },
];
const ids = (q) => S.rank(q, G).map((x) => x.g.id);

test('accents do not matter', () => {
  assert.deepEqual(ids('gepek')[0], 'b');
  assert.deepEqual(ids('gépek')[0], 'b');
  assert.equal(ids('energiahatekonysag')[0], 'c');
});
test('everyday words find official wording', () => {
  assert.equal(ids('webshop')[0], 'a');
  assert.ok(ids('napelemet szeretnénk')[0] === 'c');
  assert.ok(ids('új CNC-gép').includes('b'));
});
test('no match → empty; empty query → everything', () => {
  assert.deepEqual(ids('xyzqwe'), []);
  assert.equal(ids('').length, G.length);
});
test('matchText: all words, accent-insensitive', () => {
  assert.equal(S.matchText('szechenyi lizing', 'Széchenyi Lízing MAX+'), true);
  assert.equal(S.matchText('szechenyi napelem', 'Széchenyi Lízing MAX+'), false);
});

// ---- live feed regression tests (aipalyazo/grants_live.json)
const FEED = createRequire(import.meta.url)('../aipalyazo/grants_live.json');
const live = (q) => S.rank(q, FEED);
const pos = (q, re) => live(q).findIndex((x) => re.test(`${x.g.title} ${x.g.code || ''}`));

test('rare words beat generic ones (IDF + generic stop words)', () => {
  assert.deepEqual(S.tokens('szálláshely fejlesztés'), ['szallashely']);
  assert.deepEqual(S.tokens('fejlesztés'), ['fejlesztes']); // alone it still searches
  const r = live('szálláshely fejlesztés');
  assert.ok(r.length < 60, `too many results: ${r.length}`);
  assert.ok(pos('szálláshely fejlesztés', /Turisztikai Kártya|KTH Start/i) < 3);
  assert.ok(pos('webshop fejlesztés', /DIMOP_PLUSZ-1\.2\.3\/A/) < 3);
});
test('code field only boosts programme names and numbers', () => {
  const top = live('digitalizáció').slice(0, 3);
  assert.ok(top.every((x) => x.g.scope !== 'eu'), 'EU DIGITAL topics must not lead');
  assert.ok(pos('digitalizáció', /DIMOP_PLUSZ-1\.2\.3\/A/) < 3);
  assert.ok(live('GINOP').every((x) => /ginop/i.test(`${x.g.code} ${x.g.title} ${x.g.note}`)));
});
test('narrow, lower-weight concept expansion', () => {
  assert.ok(pos('CNC', /Akvakult|Kockázati Tőke/i) < 0, 'no aquaculture / VC fund for CNC');
  assert.ok(live('CNC').length < 20);
  assert.ok(live('traktor').slice(0, 3).every((x) => /agr[aá]r/i.test(x.g.title)));
  const kap = pos('napelem', /KAP-RD06/);
  assert.ok(kap < 0 || kap > 10);
  // expansion-only hits rank below direct hits
  const r = live('halászat'), firstExp = r.findIndex((x) => !x.direct);
  assert.ok(r.slice(firstExp).every((x) => !x.direct));
});
test('stems are at least 5 letters, short words need a whole word', () => {
  assert.ok(pos('export', /exposure/i) < 0);
  const kth = pos('startup', /KTH Start/);
  assert.ok(kth < 0 || kth > 5);
  assert.equal(pos('startup', /startup/i), 0);
  assert.ok(pos('elektromos autó', /automation/i) < 0);
  assert.equal(S.matchText('nő', 'Novel approaches'), false);
  assert.equal(S.matchText('gép', 'új gépek beszerzése'), true);
});
test('recall: fish, women, EV charging, typos, K+F', () => {
  assert.ok(live('halászat').filter((x) => /MAHOP/.test(x.g.code || '')).length >= 3);
  assert.ok(live('nők').some((x) => /Women TechEU/.test(x.g.title)));
  assert.ok(live('töltőállomás').length >= 1);
  assert.ok(live('napelm').length >= 10, 'one-letter typo is forgiven');
  assert.deepEqual(live('napelm').slice(0, 5).map((x) => x.g.id), live('napelem').slice(0, 5).map((x) => x.g.id));
  assert.ok(live('K+F').length >= 20);
  assert.ok(live('napelemes rendszer csarnokra').length >= 10);
});
test('call codes keep their digits and stay inside the programme', () => {
  const d = live('DIMOP Plusz 1.2.3');
  assert.ok(d.length >= 2 && d.every((x) => /^DIMOP_PLUSZ-1\.2\.3/.test(x.g.code)));
  const g = live('GINOP Plusz-1.4.3');
  assert.equal(g[0].g.code, 'GINOP_PLUSZ-1.4.3-24');
  assert.ok(g.every((x) => /^GINOP/i.test(x.g.code)));
  assert.ok(live("GINOP Plusz-1.2.3").every((x) => /GINOP/i.test(`${x.g.code} ${x.g.title} ${x.g.note}`)));
  assert.equal(S.matchText('DIMOP Plusz 1.2.3', 'Digitalizáció DIMOP_PLUSZ-1.2.3/A-24'), true);
  assert.equal(S.matchText('DIMOP Plusz 1.2.3', 'GINOP_PLUSZ-1.2.3-24'), false);
});
test('"vissza nem térítendő" is a type filter', () => {
  const r = live('vissza nem térítendő');
  assert.equal(r.length, FEED.filter((g) => /^(grant|wage-subsidy|loan\+grant|grant\+equity)$/.test(g.type) && !/nem vissza nem t/i.test(g.note || '')).length);
  assert.ok(r.every((x) => /^(grant|wage-subsidy|loan\+grant|grant\+equity)$/.test(x.g.type)));
  assert.ok(live('vissza nem térítendő napelem').every((x) => /grant|wage/.test(x.g.type)));
});
test('stop-word-only query is not a search', () => {
  assert.deepEqual(S.tokens('pályázat'), []);
  assert.equal(S.active('pályázat'), false);
  assert.equal(S.active('napelem'), true);
  assert.equal(S.active('vissza nem térítendő'), true);
  assert.equal(live('pályázat').length, FEED.length);
});
test('relevant(): relative cut, no fixed top-N', () => {
  const r = live('digitalizáció'), k = S.relevant(r, 0.2);
  assert.ok(k.length >= 3 && k.length <= r.length);
  assert.ok(S.relevant(live('vissza nem térítendő'), 0.2).length > 60);
});
