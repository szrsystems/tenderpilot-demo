import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { normalizePhone: n } = createRequire(import.meta.url)('../aipalyazo/lib/phone.js');

test('browser and Edge Function copies of phone.js are identical', () => {
  assert.equal(readFileSync(new URL('../aipalyazo/lib/phone.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../supabase/functions/_shared/phone.js', import.meta.url), 'utf8'));
});

test('Hungarian numbers in any common spelling are accepted and tidied', () => {
  assert.equal(n('+36 30 123 4567'), '+36 30 123 4567');
  assert.equal(n('06-30/123-4567'), '+36 30 123 4567');
  assert.equal(n('0036 70 1234567'), '+36 70 123 4567');
  assert.equal(n('06 1 234 5678'), '+36 1 234 5678');
  assert.equal(n('+36 22 123 456'), '+36 22 123 456');
  assert.equal(n('+36 21 123 4567'), '+36 21 123 4567');
  assert.equal(n('+49 151 23456789'), '+4915123456789');
});

test('made-up or incomplete numbers are rejected', () => {
  for (const bad of ['12345', '+36 30 12345', '+36 30 123 45678', '06 1 234 567', 'abc', '+36 22 123 4567', '123456789', '+0 123', '06 30 123 4567 ext 2', ''])
    assert.equal(n(bad), null, bad);
});
