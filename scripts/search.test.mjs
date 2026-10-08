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
