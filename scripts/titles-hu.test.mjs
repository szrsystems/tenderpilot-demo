// Run: node --test scripts/titles-hu.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHungarianTitles, missingTitles, cleanTranslations, hungarianTitle } from './titles-hu.mjs';

test('English EU titles get a Hungarian title; the English name is kept', () => {
  const grants = [
    { id: 'a', scope: 'eu', title: 'Textile circularity through advanced processing (Textilkörforgás fejlett gyártástechnológiákkal)' },
    { id: 'b', scope: 'eu', title: 'Industrial leadership in AI, Data and Robotics' },
    { id: 'c', scope: 'eu', title: 'Towards networked Local Digital Twins in the EU' },
    { id: 'd', scope: 'hu', title: 'Mikro-, kis- és középvállalkozások digitalizációja' },
  ];
  const cache = { b: { en: 'Industrial leadership in AI, Data and Robotics', hu: 'Ipari vezető szerep az MI, adat és robotika terén' } };
  assert.deepEqual(missingTitles(grants, cache).map((x) => x.id), ['c']);
  assert.equal(applyHungarianTitles(grants, cache), 2);
  assert.equal(grants[0].title, 'Textilkörforgás fejlett gyártástechnológiákkal');
  assert.equal(grants[0].titleOriginal, 'Textile circularity through advanced processing');
  assert.equal(grants[1].title, 'Ipari vezető szerep az MI, adat és robotika terén');
  assert.equal(grants[2].titleOriginal, undefined, 'no translation yet → stays English');
  assert.equal(grants[3].titleOriginal, undefined, 'domestic calls untouched');
  assert.equal(applyHungarianTitles(grants, cache), 0, 'idempotent');
});

test('a changed English title is translated again; bad model answers are dropped', () => {
  const g = { id: 'b', scope: 'eu', title: 'New wording of the call' };
  assert.equal(hungarianTitle(g, { b: { en: 'Old wording', hu: 'Régi' } }), null);
  const batch = [{ id: 'x', en: 'Call one' }, { id: 'y', en: 'Call two' }, { id: 'z', en: 'Call three' }];
  const out = cleanTranslations({ x: '„Első felhívás”', y: 'Call two', z: 'ok' }, batch);
  assert.deepEqual(out, { x: { en: 'Call one', hu: 'Első felhívás' } });
});
