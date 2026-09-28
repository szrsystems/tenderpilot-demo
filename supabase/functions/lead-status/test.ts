import { handler } from './index.ts';
import { statusLink, statusToken, timingSafeEqual, verifyStatusToken } from '../_shared/lead-token.ts';
import { assert, assertEquals, assertMatch, memStore } from '../_shared/testing.ts';

const SECRET = 'test-secret';
const post = (b: unknown) => new Request('http://x/lead-status', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://aipalyazo.hu' }, body: JSON.stringify(b) });

Deno.test('token: HMAC-SHA256(secret, ref|status), first 32 hex', async () => {
  // Reference computed independently: printf 'L-ABCDEF|won' | openssl dgst -sha256 -hmac test-secret
  const full = '9f5044ade4fae5850cf492598ddac0df6dbaab7f913dda75fe1ae0f3430f6a20';
  const t = await statusToken(SECRET, 'L-ABCDEF', 'won');
  assertEquals(t, full.slice(0, 32));
  assertMatch(t, /^[0-9a-f]{32}$/);
});

Deno.test('token verification: right token only, bound to ref, status and secret', async () => {
  const t = await statusToken(SECRET, 'L-ABCDEF', 'won');
  assert(await verifyStatusToken(SECRET, 'L-ABCDEF', 'won', t));
  assert(!(await verifyStatusToken(SECRET, 'L-ABCDEF', 'lost', t)), 'other status');
  assert(!(await verifyStatusToken(SECRET, 'L-ABCDEG', 'won', t)), 'other ref');
  assert(!(await verifyStatusToken('other', 'L-ABCDEF', 'won', t)), 'other secret');
  assert(!(await verifyStatusToken('', 'L-ABCDEF', 'won', t)), 'no secret');
  assert(!(await verifyStatusToken(SECRET, 'L-ABCDEF', 'won', t.slice(0, 31) + (t[31] === '0' ? '1' : '0'))), 'one char off');
  assert(!(await verifyStatusToken(SECRET, 'L-ABCDEF', 'won', t.toUpperCase())), 'format');
  const paid = await statusToken(SECRET, 'L-ABCDEF', 'paid');
  assert(!(await verifyStatusToken(SECRET, 'L-ABCDEF', 'paid', paid)), 'paid is admin-only');
  assert(timingSafeEqual('abc', 'abc') && !timingSafeEqual('abc', 'abd') && !timingSafeEqual('abc', 'abcd'));
  const link = await statusLink(SECRET, 'L-ABCDEF', 'won');
  assertEquals(link, `https://aipalyazo.hu/aipalyazo/lead-status.html?ref=L-ABCDEF&s=won&t=${t}`);
});

Deno.test('valid POST updates status (+note); wrong token 403; unknown ref 404', async () => {
  const store = memStore([{ lead_ref: 'L-ABCDEF', status: 'sent' }]);
  const t = await statusToken(SECRET, 'L-ABCDEF', 'applied');
  let r = await handler(post({ ref: 'L-ABCDEF', s: 'applied', t, note: 'Beadva 10.02-án' }), { env: { LEAD_STATUS_SECRET: SECRET }, store });
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { ok: true, ref: 'L-ABCDEF', status: 'applied' });
  assertEquals(store.rows[0].status, 'applied');
  assertEquals(store.rows[0].status_note, 'Beadva 10.02-án');
  assert(store.rows[0].status_updated_at);

  r = await handler(post({ ref: 'L-ABCDEF', s: 'won', t }), { env: { LEAD_STATUS_SECRET: SECRET }, store });
  assertEquals(r.status, 403);
  assertEquals(store.rows[0].status, 'applied');

  const t2 = await statusToken(SECRET, 'L-ZZZZZZ', 'won');
  r = await handler(post({ ref: 'L-ZZZZZZ', s: 'won', t: t2 }), { env: { LEAD_STATUS_SECRET: SECRET }, store });
  assertEquals(r.status, 404);
});

Deno.test('input validation and configuration', async () => {
  const store = memStore();
  const env = { LEAD_STATUS_SECRET: SECRET };
  const t = '0'.repeat(32);
  for (const [b, field] of [[{ ref: 'X', s: 'won', t }, 'ref'], [{ ref: 'L-ABCDEF', s: 'paid', t }, 's'], [{ ref: 'L-ABCDEF', s: 'won', t: 'xyz' }, 't'], [{ ref: 'L-ABCDEF', s: 'won', t, note: 'n'.repeat(1001) }, 'note']] as const) {
    const r = await handler(post(b), { env, store });
    assertEquals(r.status, 400);
    assertEquals((await r.json()).field, field);
  }
  assertEquals((await handler(post({}), { env: {}, store })).status, 503);
  assertEquals((await handler(new Request('http://x', { method: 'GET' }), { env, store })).status, 405);
});
