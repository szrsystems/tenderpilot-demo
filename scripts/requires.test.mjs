// Run: node --test scripts/requires.test.mjs
// Eligibility tags: vocabulary, evidence and consistency of the hand-verified data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRES_KEYS, checkRequires, cleanRequires, withConsortiumTag, consortiumEvidence } from './requires.mjs';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const verified = load('./verified-grants.json').items;
const apiVerified = load('./api-verified.json');
const live = load('../aipalyazo/grants_live.json');

test('every tag in the verified lists uses the vocabulary and carries evidence', () => {
  const all = [
    ...verified.map((it) => [it.id, it]),
    ...Object.entries(apiVerified).filter(([k, v]) => v && typeof v === 'object').map(([k, v]) => ['api:' + k, v]),
    ...live.map((g) => ['live:' + g.id, g]),
  ];
  let tagged = 0;
  for (const [id, it] of all) {
    const p = checkRequires(it);
    assert.deepEqual(p, [], `${id}: ${p.join('; ')}`);
    if (it.requires) tagged++;
    for (const k of Object.keys(it.requires || {})) assert.ok(REQUIRES_KEYS.includes(k), `${id}: ${k}`);
  }
  assert.ok(tagged > 50, 'tags present');
});

test('EU calls that are not single-applicant are tagged consortium', () => {
  for (const g of live) if (g.scope === 'eu' && g.singleApplicant === false) assert.equal(g.requires && g.requires.consortium, true, g.id);
  for (const it of verified) if (it.scope === 'eu' && it.singleApplicant === false) assert.equal(it.requires && it.requires.consortium, true, it.id);
});

test('checkRequires rejects unknown keys, bad values and missing evidence', () => {
  assert.deepEqual(checkRequires({}), []);
  assert.match(checkRequires({ requires: { vegan: true }, requiresEvidence: { vegan: 'xxxx' } }).join(), /unknown key vegan/);
  assert.match(checkRequires({ requires: { farmer: true } }).join(), /farmer has no evidence/);
  assert.match(checkRequires({ requires: { startup_max_years: true }, requiresEvidence: { startup_max_years: 'max. 3 éves cég' } }).join(), /positive number/);
  assert.match(checkRequires({ requires: { farmer: true }, requiresEvidence: { farmer: 'x'.repeat(161) } }).join(), /longer than 160/);
  assert.match(checkRequires({ requires: { farmer: true }, requiresEvidence: { farmer: 'őstermelők', forestry: 'erdő' } }).join(), /evidence for unset key forestry/);
  assert.match(checkRequires({ requires: {} }).join(), /empty requires/);
});

test('cleanRequires keeps only grounded vocabulary tags', () => {
  const page = 'Kizárólag NTAK-regisztrált szálláshelyek pályázhatnak. A cég legfeljebb 3 éve működik.';
  const r = cleanRequires({
    tourism_ntak: { value: true, evidence: 'Kizárólag NTAK-regisztrált szálláshelyek pályázhatnak.' },
    startup_max_years: { value: 3, evidence: 'legfeljebb 3 éve működik' },
    farmer: { value: true, evidence: 'őstermelők pályázhatnak' },          // not on the page
    vip: { value: true, evidence: 'Kizárólag' },                           // not in the vocabulary
    restaurant: { value: false, evidence: 'Kizárólag' },                   // false → dropped
  }, (q) => page.includes(q));
  assert.deepEqual(r.requires, { tourism_ntak: true, startup_max_years: 3 });
  assert.equal(r.requiresEvidence.startup_max_years, 'legfeljebb 3 éve működik');
  assert.equal(cleanRequires({ farmer: { value: true, evidence: 'nincs' } }, () => false), null);
});

test('withConsortiumTag adds the tag from the note, leaves others alone', () => {
  const g = withConsortiumTag({ id: 'x', scope: 'eu', singleApplicant: false, note: 'Angol nyelvű EU felhívás; jellemzően nemzetközi konzorcium szükséges.' });
  assert.equal(g.requires.consortium, true);
  assert.equal(g.requiresEvidence.consortium, 'jellemzően nemzetközi konzorcium szükséges.');
  assert.equal(withConsortiumTag({ id: 'y', scope: 'eu', singleApplicant: true }).requires, undefined);
  assert.equal(withConsortiumTag({ id: 'z', scope: 'hazai' }).requires, undefined);
  assert.equal(consortiumEvidence('Nemzetközi konzorcium szükséges (min. 3 ország, legalább 1 EU-tagállamból); KKV partnerként részt vehet.'), 'Nemzetközi konzorcium szükséges (min. 3 ország, legalább 1 EU-tagállamból)');
});
