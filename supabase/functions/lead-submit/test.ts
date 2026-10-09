// deno test -A --config <deno.json mapping jsr:@supabase/supabase-js@2 → npm:> supabase/functions/lead-submit/test.ts
import { handler, LIMITS } from './index.ts';
import { assert, assertEquals, assertMatch, assertStringIncludes, memMailer, memStore, staticFeed } from '../_shared/testing.ts';
import { verifyStatusToken } from '../_shared/lead-token.ts';

const GRANT = { id: 'pg-GINOP_PLUSZ-1.2.3-24', title: 'Hivatalos cím <b>', code: 'GINOP_PLUSZ-1.2.3-24', deadline: '2026-12-31', url: 'https://palyazat.gov.hu/x' };
const ENV = { LEAD_NOTIFY_TO: 'op@aipalyazo.hu, dft@example.hu', LEAD_STATUS_SECRET: 'sekret', LEAD_SALT: 'salt', RESEND_API_KEY: 're_x' };

const body = (o: Record<string, unknown> = {}) => ({
  grantId: GRANT.id, grantTitle: 'Kliens cím', name: 'Kiss Anna', email: 'Anna@Example.com', phone: '+36 30 123 4567',
  company: 'Anna Kft.', message: 'Érdekel <script>alert(1)</script>', consent: true,
  match: { score: 82, verdict: 'APPLY', checks: [{ key: 'size', status: 'ok', reason: 'Pályázhat kisvállalkozásként.', label: 'Cégméret' }, { key: 'region', status: 'fail', reason: 'Nem jogosult' }, { key: 'basics', status: 'unknown', reason: 'Ellenőrizendő' }], profile: { company: 'Anna Kft.', employees: '10-49', site_region: 'Észak-Alföld', teaor: '6201', years_operating: '3-5', evil: 'x' } },
  ...o,
});
const req = (o: unknown, headers: Record<string, string> = {}) => new Request('http://x/lead-submit', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://aipalyazo.hu', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', ...headers },
  body: typeof o === 'string' ? o : JSON.stringify(o),
});
function setup(env: Record<string, string | undefined> = ENV, feed = staticFeed([GRANT])) {
  const store = memStore();
  const mailer = memMailer();
  const deps = { env, store, mailer, grants: feed, getUserId: async (t: string) => (t === 'user-jwt' ? 'u-1' : null) };
  return { store, mailer, deps };
}

Deno.test('stores the lead, notifies partner + requester, returns ref', async () => {
  const { store, mailer, deps } = setup();
  const r = await handler(req(body(), { authorization: 'Bearer user-jwt' }), deps);
  assertEquals(r.status, 200);
  assertEquals(r.headers.get('access-control-allow-origin'), 'https://aipalyazo.hu');
  const j = await r.json();
  assertEquals(j.ok, true);
  assertMatch(j.ref, /^L-[A-Z2-7]{6}$/);
  const row = store.rows[0];
  assertEquals(row.email, 'anna@example.com');
  assertEquals(row.user_id, 'u-1');
  assertEquals(row.grant_title, GRANT.title, 'official title from feed');
  assertEquals(row.match_snapshot?.grant?.code, GRANT.code);
  assertEquals(row.match_snapshot?.titleFromClient, undefined);
  assertEquals(Object.keys(row.match_snapshot?.profile ?? {}).includes('evil'), false);
  assertMatch(row.ip_hash!, /^[0-9a-f]{64}$/);
  assert(row.notified_at, 'notified_at set after partner mail');
  assertEquals(row.status, 'sent');

  assertEquals(mailer.sent.length, 2);
  const [partner, confirm] = mailer.sent;
  assertEquals(partner.to, ['op@aipalyazo.hu', 'dft@example.hu']);
  assertEquals(partner.replyTo, 'anna@example.com');
  assertEquals(partner.subject, `[AIpályázó lead ${j.ref}] ${GRANT.title}`);
  assertStringIncludes(partner.html, '&lt;script&gt;');
  assert(!partner.html.includes('<script>'), 'escaped');
  assertStringIncludes(partner.html, 'Hivatalos cím &lt;b&gt;');
  assertStringIncludes(partner.html, 'https://palyazat.gov.hu/x');
  assertStringIncludes(partner.html, '✓');
  assertStringIncludes(partner.html, '✗');
  assertStringIncludes(partner.html, 'Észak-Alföld');
  for (const s of ['contacted', 'applied', 'won', 'lost', 'spam']) {
    const m = partner.html.match(new RegExp(`lead-status\\.html\\?ref=${j.ref}&amp;s=${s}&amp;t=([0-9a-f]{32})`));
    assert(m, `link for ${s}`);
    assert(await verifyStatusToken('sekret', j.ref, s, m[1]));
  }
  assertEquals(confirm.to, ['anna@example.com']);
  assertStringIncludes(confirm.html, j.ref);
  assertStringIncludes(confirm.html, 'A DFT-Hungária pályázatírói');
  assertStringIncludes(confirm.html, 'továbbítjuk a DFT-Hungária részére');
  assertStringIncludes(confirm.html, 'adatvedelem.html');
  assertStringIncludes(confirm.html, 'Hivatalos cím &lt;b&gt;');
  assert(!confirm.html.includes('Kiss Anna') && !confirm.html.includes('Érdekel'), 'no user text echoed to the recipient');
});

Deno.test('PARTNER_NAME is configurable', async () => {
  const { mailer, deps } = setup({ ...ENV, PARTNER_NAME: 'Európa Pályázat Kft.' });
  await handler(req(body()), deps);
  assertStringIncludes(mailer.sent[1].html, 'Az Európa Pályázat Kft. pályázatírói');
  assert(!mailer.sent[1].html.includes('DFT'));
});

Deno.test('unknown grant id: client title truncated and flagged, not echoed to requester', async () => {
  const { store, mailer, deps } = setup();
  const r = await handler(req(body({ grantId: 'nincs-ilyen', grantTitle: 'Nyerj iPhone-t! http://evil.example ' + 'x'.repeat(400) })), deps);
  assertEquals(r.status, 200);
  const row = store.rows[0];
  assertEquals(row.grant_title!.length, 300);
  assertEquals(row.match_snapshot?.titleFromClient, true);
  assert(!mailer.sent[1].html.includes('evil.example'));
  assertStringIncludes(mailer.sent[0].html, 'böngésző által küldött cím');
});

Deno.test('feed down → still stored with client title', async () => {
  const { store, deps } = setup(ENV, staticFeed([], { fail: true }));
  const r = await handler(req(body()), deps);
  assertEquals(r.status, 200);
  assertEquals(store.rows[0].grant_title, 'Kliens cím');
});

Deno.test('validation errors name the field', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ consent: false }, 'consent'],
    [{ consent: 'true' }, 'consent'],
    [{ name: 'A' }, 'name'],
    [{ name: 'x'.repeat(121) }, 'name'],
    [{ name: 'Kiss\nAnna' }, 'name'],
    [{ email: 'nope' }, 'email'],
    [{ email: 'a'.repeat(250) + '@x.hu' }, 'email'],
    [{ phone: '1'.repeat(41) }, 'phone'],
    [{ phone: 'hívjon' }, 'phone'],
    [{ company: 'c'.repeat(201) }, 'company'],
    [{ message: 'm'.repeat(2001) }, 'message'],
    [{ grantId: '' }, 'grantId'],
    [{ grantId: 'g'.repeat(201) }, 'grantId'],
    [{ match: 'x' }, 'match'],
    [{ match: { score: 101 } }, 'match'],
    [{ match: { checks: 'x' } }, 'match'],
  ];
  for (const [o, field] of cases) {
    const { store, deps } = setup();
    const r = await handler(req(body(o)), deps);
    assertEquals(r.status, 400, JSON.stringify(o).slice(0, 60));
    assertEquals(await r.json(), { error: 'invalid', field });
    assertEquals(store.rows.length, 0);
  }
  const { deps } = setup();
  assertEquals((await handler(req('not json'), deps)).status, 400);
  assertEquals((await handler(req(JSON.stringify(body({ message: 'x'.repeat(70000) }))), deps)).status, 400);
  assertEquals((await handler(new Request('http://x', { method: 'GET' }), deps)).status, 405);
});

Deno.test('long match reasons are truncated, not rejected', async () => {
  const { store, deps } = setup();
  const checks = Array.from({ length: 30 }, (_, i) => ({ key: 'k' + i, status: 'weird', reason: 'r'.repeat(1000) }));
  const r = await handler(req(body({ match: { score: 50, checks } })), deps);
  assertEquals(r.status, 200);
  const snap = store.rows[0].match_snapshot!;
  assertEquals(snap.checks!.length, 20);
  assertEquals(snap.checks![0].reason.length, 400);
  assertEquals(snap.checks![0].status, 'unknown');
});

Deno.test('duplicate (same e-mail + grant within 24h) sends nothing and does not reveal the ref to strangers', async () => {
  const { store, mailer, deps } = setup();
  await (await handler(req(body()), deps)).json();
  const sentBefore = mailer.sent.length;
  const r = await handler(req(body({ email: 'ANNA@example.com' })), deps);
  const j = await r.json();
  assertEquals(j.ok, true);
  assertEquals(j.duplicate, undefined);
  assert(/^L-[A-Z2-7]{6}$/.test(j.ref) && j.ref !== store.rows[0].lead_ref);
  assertEquals(mailer.sent.length, sentBefore);
  assertEquals(store.rows.length, 1);
});

Deno.test('duplicate: the signed-in owner gets the existing ref back', async () => {
  const { deps } = setup();
  const first = await (await handler(req(body(), { authorization: 'Bearer user-jwt' }), deps)).json();
  const r = await handler(req(body(), { authorization: 'Bearer user-jwt' }), deps);
  assertEquals(await r.json(), { ok: true, duplicate: true, ref: first.ref });
});

Deno.test('rate limits: junk / oversized forwarded IPs share one bucket instead of bypassing the limit', async () => {
  const { deps } = setup();
  for (let i = 0; i < LIMITS.perIp1h; i++) {
    const junk = 'a'.repeat(70) + i + ', 1.2.3.4';
    assertEquals((await handler(req(body({ email: `j${i}@example.com` }), { 'x-forwarded-for': junk }), deps)).status, 200);
  }
  assertEquals((await handler(req(body({ email: 'j-next@example.com' }), { 'x-forwarded-for': 'zzz' }), deps)).status, 429);
});

Deno.test('rate limits: global hourly cap stops floods from rotating IPs', async () => {
  const { deps } = setup();
  for (let i = 0; i < LIMITS.global1h; i++) {
    const ip = `198.51.${Math.floor(i / 5)}.${i % 5}`;
    assertEquals((await handler(req(body({ email: `f${i}@example.com` }), { 'x-forwarded-for': ip }), deps)).status, 200);
  }
  assertEquals((await handler(req(body({ email: 'late@example.com' }), { 'x-forwarded-for': '192.0.2.200' }), deps)).status, 429);
});

Deno.test('rate limits: per e-mail per day, per IP per hour', async () => {
  {
    const { deps } = setup();
    for (let i = 0; i < LIMITS.perEmail24h; i++) assertEquals((await handler(req(body({ grantId: 'g' + i })), deps)).status, 200);
    const r = await handler(req(body({ grantId: 'g-next' })), deps);
    assertEquals(r.status, 429);
    assertEquals(await r.json(), { error: 'rate_limited' });
  }
  {
    const { deps } = setup();
    for (let i = 0; i < LIMITS.perIp1h; i++) assertEquals((await handler(req(body({ email: `p${i}@example.com` })), deps)).status, 200);
    assertEquals((await handler(req(body({ email: 'other@example.com' })), deps)).status, 429);
    // another IP is fine
    assertEquals((await handler(req(body({ email: 'other@example.com' }), { 'x-forwarded-for': '198.51.100.7' }), deps)).status, 200);
  }
});

Deno.test('turnstile: enforced only when TURNSTILE_SECRET is set, fails closed', async () => {
  const calls: string[] = [];
  const fakeFetch = (ok: boolean | 'throw') => (async (_u: string | URL | Request, init?: RequestInit) => {
    calls.push(String((init?.body as URLSearchParams)?.get('response')));
    if (ok === 'throw') throw new Error('network');
    return new Response(JSON.stringify({ success: ok }), { status: 200 });
  }) as typeof fetch;
  for (const [f, tok, status] of [[fakeFetch(true), 'tok', 200], [fakeFetch(false), 'tok', 403], [fakeFetch('throw'), 'tok', 403], [fakeFetch(true), undefined, 403]] as const) {
    const { deps } = setup({ ...ENV, TURNSTILE_SECRET: 'ts' });
    const r = await handler(req(body({ turnstileToken: tok })), { ...deps, fetch: f });
    assertEquals(r.status, status);
    if (status === 403) assertEquals(await r.json(), { error: 'captcha_failed' });
  }
  assertEquals(calls.includes('tok'), true);
  const hostFetch = (hostname: string) => (async () => new Response(JSON.stringify({ success: true, hostname }), { status: 200 })) as typeof fetch;
  for (const [h, status] of [['aipalyazo.hu', 200], ['www.aipalyazo.hu', 200], ['evil.example', 403], ['aipalyazo.hu.evil.example', 403]] as const) {
    const { deps: d2 } = setup({ ...ENV, TURNSTILE_SECRET: 'ts' });
    assertEquals((await handler(req(body({ turnstileToken: 'tok' })), { ...d2, fetch: hostFetch(h) })).status, status, h);
  }
  const { deps } = setup();
  assertEquals((await handler(req(body()), { ...deps, fetch: fakeFetch(false) })).status, 200, 'no secret → no captcha');
});

Deno.test('partner mail failure: lead kept, error recorded, not marked notified', async () => {
  const store = memStore();
  const mailer = memMailer({ failFor: (m) => m.to.includes('op@aipalyazo.hu') });
  const r = await handler(req(body()), { env: ENV, store, mailer, grants: staticFeed([GRANT]) });
  assertEquals(r.status, 200);
  const row = store.rows[0];
  assertEquals(row.notified_at, null);
  assertEquals(row.notify_attempts, 1);
  assertStringIncludes(row.notify_error!, 'resend 500');
  assertEquals(row.status, 'new');
  assertEquals(mailer.sent.length, 1, 'confirmation still sent');
});

Deno.test('no LEAD_NOTIFY_TO → the lead goes to info@aipalyazo.hu', async () => {
  const { store, mailer, deps } = setup({ ...ENV, LEAD_NOTIFY_TO: undefined });
  assertEquals((await handler(req(body()), deps)).status, 200);
  assert(mailer.sent.some((m: any) => JSON.stringify(m.to).includes('info@aipalyazo.hu')));
  assert(store.rows[0].notified_at);
});

Deno.test('no status secret → no status links', async () => {
  const { mailer, deps } = setup({ ...ENV, LEAD_STATUS_SECRET: undefined });
  await handler(req(body()), deps);
  assert(!mailer.sent[0].html.includes('lead-status.html'));
});

Deno.test('server errors never leak internals', async () => {
  const { store, deps } = setup();
  store.failInsert = true;
  const r = await handler(req(body()), deps);
  assertEquals(r.status, 500);
  assertEquals(await r.json(), { error: 'server' });
});

Deno.test('CORS: unknown origin gets the default allow-origin, OPTIONS ok', async () => {
  const { deps } = setup();
  const r = await handler(new Request('http://x', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), deps);
  assertEquals(r.headers.get('access-control-allow-origin'), 'https://aipalyazo.hu');
});

Deno.test('campaign tags: stored on the lead and shown to the partner; junk tags dropped, never blocking', async () => {
  const { store, mailer, deps } = setup();
  const r = await handler(req(body({ attribution: { source: 'DFT', campaign: 'okt-2026_hirlevel', medium: 'email' } })), deps);
  assertEquals(r.status, 200);
  assertEquals([store.rows[0].utm_source, store.rows[0].utm_campaign, store.rows[0].utm_medium], ['dft', 'okt-2026_hirlevel', 'email']);
  assert(mailer.sent.some((m: any) => /Forrás[\s\S]*dft \/ okt-2026_hirlevel \/ email/.test(m.html || '') ));
  const r2 = await handler(req(body({ email: 'b@example.com', attribution: { source: '<script>', campaign: 'x' } })), deps);
  assertEquals(r2.status, 200);
  assertEquals([store.rows[1].utm_source, store.rows[1].utm_campaign], [null, null]);
});

Deno.test('global hourly cap is configurable (LEAD_GLOBAL_HOURLY_CAP)', async () => {
  const { deps } = setup({ ...ENV, LEAD_GLOBAL_HOURLY_CAP: '2' });
  for (let i = 0; i < 2; i++) assertEquals((await handler(req(body({ email: `c${i}@example.com` }), { 'x-forwarded-for': `192.0.2.${i}` }), deps)).status, 200);
  assertEquals((await handler(req(body({ email: 'c9@example.com' }), { 'x-forwarded-for': '192.0.2.99' }), deps)).status, 429);
});

Deno.test('phone: only real numbers; stored in one format', async () => {
  const { store, deps } = setup();
  const bad = await handler(req(body({ phone: '12345' })), deps);
  assertEquals(bad.status, 400);
  assertEquals(await bad.json(), { error: 'invalid', field: 'phone' });
  assertEquals((await handler(req(body({ phone: '06-30/123-4567' })), deps)).status, 200);
  assertEquals(store.rows[0].phone, '+36 30 123 4567');
});

import { clientIp, ipv6Prefix64 } from './index.ts';
Deno.test('IPv6 clients are rate-limited per /64', () => {
  assertEquals(ipv6Prefix64('2001:db8:abcd:12:1:2:3:4'), '2001:db8:abcd:12::/64');
  assertEquals(ipv6Prefix64('2001:db8::1'), '2001:db8:0:0::/64');
  const a = clientIp(new Request('http://x', { headers: { 'cf-connecting-ip': '2001:db8:abcd:12::9' } }));
  const b = clientIp(new Request('http://x', { headers: { 'cf-connecting-ip': '2001:db8:abcd:12:ffff::1' } }));
  assertEquals(a, b);
  assertEquals(clientIp(new Request('http://x', { headers: { 'cf-connecting-ip': '203.0.113.5' } })), '203.0.113.5');
});
