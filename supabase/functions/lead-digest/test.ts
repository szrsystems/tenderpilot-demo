import { handler, isOverdue, workingDaysBetween } from './index.ts';
import { assert, assertEquals, assertStringIncludes, memMailer, memStore } from '../_shared/testing.ts';
import type { LeadRow } from '../_shared/lead-store.ts';

const ENV = { CRON_SECRET: 'cron', LEAD_NOTIFY_TO: 'op@aipalyazo.hu,dft@example.hu', LEAD_STATUS_SECRET: 's', RESEND_API_KEY: 're_x' };
const MONDAY = new Date('2026-09-28T07:10:00Z');
const TUESDAY = new Date('2026-09-29T07:10:00Z');
const call = (deps: Parameters<typeof handler>[1], body: unknown = {}, secret = 'cron') =>
  handler(new Request('http://x/lead-digest', { method: 'POST', headers: { 'x-cron-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }), deps);

Deno.test('working days (Budapest calendar, Mon–Fri)', () => {
  const d = (s: string) => new Date(s);
  assertEquals(workingDaysBetween(d('2026-09-21T10:00:00Z'), d('2026-09-21T18:00:00Z')), 0); // same Monday
  assertEquals(workingDaysBetween(d('2026-09-21T10:00:00Z'), d('2026-09-24T08:00:00Z')), 3); // Mon → Thu
  assertEquals(workingDaysBetween(d('2026-09-25T10:00:00Z'), d('2026-09-28T08:00:00Z')), 1); // Fri → Mon
  assertEquals(workingDaysBetween(d('2026-09-26T10:00:00Z'), d('2026-09-28T08:00:00Z')), 1); // Sat → Mon
  // 23:30 Friday in Budapest is still Friday even though UTC says 21:30
  assertEquals(workingDaysBetween(d('2026-09-25T21:30:00Z'), d('2026-09-28T08:00:00Z')), 1);
  // 00:30 Saturday Budapest (= Friday 22:30 UTC) counts from Saturday
  assertEquals(workingDaysBetween(d('2026-09-25T22:30:00Z'), d('2026-09-29T08:00:00Z')), 2);
  const lead = (notified: string | null, status: LeadRow['status'] = 'sent') => ({ status, notified_at: notified } as LeadRow);
  assert(isOverdue(lead('2026-09-23T09:00:00Z'), MONDAY)); // Wed → Mon = 3
  assert(!isOverdue(lead('2026-09-24T09:00:00Z'), MONDAY)); // Thu → Mon = 2
  assert(!isOverdue(lead('2026-09-22T09:00:00Z', 'contacted'), MONDAY));
  assert(!isOverdue(lead(null, 'new'), MONDAY));
});

Deno.test('rejects calls without the cron secret', async () => {
  assertEquals((await call({ env: ENV, store: memStore(), mailer: memMailer() }, {}, 'wrong')).status, 403);
  assertEquals((await call({ env: { ...ENV, CRON_SECRET: '' }, store: memStore(), mailer: memMailer() }, {}, '')).status, 403);
  assertEquals((await handler(new Request('http://x', { method: 'GET' }), { env: ENV })).status, 405);
});

Deno.test('retries unnotified leads once each, respects attempt cap, never re-sends', async () => {
  const clock = () => TUESDAY.getTime();
  const store = memStore([
    { grant_title: 'A', created_at: '2026-09-28T09:00:00Z', notify_attempts: 1, notify_error: 'resend 500' },
    { grant_title: 'B', created_at: '2026-09-28T09:00:00Z', notify_attempts: 5, notify_error: 'legacy_pre_pipeline' },
    { grant_title: 'C', created_at: '2026-09-27T09:00:00Z', notified_at: '2026-09-27T09:00:01Z', status: 'sent' },
  ], clock);
  const mailer = memMailer();
  let purged = 0;
  const r = await call({ env: ENV, store, mailer, now: () => TUESDAY, purge: async () => { purged++; return 3; } });
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.retry, { attempted: 1, sent: 1, failed: 0, skipped: 0 });
  assertEquals(j.weekly, 'not_today');
  assertEquals(j.purged, 3);
  assertEquals(purged, 1);
  assertEquals(mailer.sent.length, 1);
  assertStringIncludes(mailer.sent[0].subject, store.rows[0].lead_ref);
  assert(store.rows[0].notified_at);
  assertEquals(store.rows[0].status, 'sent');
  assertEquals(store.rows[1].notified_at, null);
  // second run: nothing left to send
  const again = await (await call({ env: ENV, store, mailer, now: () => TUESDAY, purge: async () => 0 })).json();
  assertEquals(again.retry.attempted, 0);
  assertEquals(mailer.sent.length, 1);
});

Deno.test('no LEAD_NOTIFY_TO: the digest still goes to info@aipalyazo.hu', async () => {
  const store = memStore([{ created_at: '2026-09-28T06:00:00Z' }]);
  const mailer = memMailer();
  await (await call({ env: { ...ENV, LEAD_NOTIFY_TO: '' }, store, mailer, now: () => MONDAY, purge: async () => 0 })).json();
  assert(mailer.sent.every((m: any) => JSON.stringify(m.to).includes('info@aipalyazo.hu')));
});

Deno.test('Monday weekly summary: recent leads + flagged overdue with status links', async () => {
  const store = memStore([
    { grant_title: 'Régi <nyitott>', company: 'Késő Kft.', created_at: '2026-09-15T09:00:00Z', notified_at: '2026-09-15T09:00:05Z', status: 'sent' },
    { grant_title: 'Friss', company: 'Friss Kft.', created_at: '2026-09-25T09:00:00Z', notified_at: '2026-09-25T09:00:05Z', status: 'sent' },
    { grant_title: 'Kész', created_at: '2026-09-24T09:00:00Z', notified_at: '2026-09-24T09:00:05Z', status: 'won' },
    { grant_title: 'Elakadt', created_at: '2026-09-26T09:00:00Z', notify_attempts: 5, notify_error: 'resend 422 bad' },
  ], () => MONDAY.getTime());
  const mailer = memMailer();
  const j = await (await call({ env: ENV, store, mailer, now: () => MONDAY, purge: async () => 0 })).json();
  assertEquals(j.weekly, { sent: true, recent: 3, overdue: 1, undelivered: 1 });
  const m = mailer.sent.at(-1)!;
  assertEquals(m.to, ['op@aipalyazo.hu', 'dft@example.hu']);
  assertEquals(m.subject, '[AIpályázó] Heti lead-összesítő — 3 új, 1 visszajelzésre vár');
  assertStringIncludes(m.html, 'Régi &lt;nyitott&gt;');
  assertStringIncludes(m.html, `lead-status.html?ref=${store.rows[0].lead_ref}&amp;s=contacted`);
  assert(!m.html.includes(`ref=${store.rows[1].lead_ref}&amp;`), 'fresh lead is not flagged');
  assertStringIncludes(m.html, 'resend 422 bad');
  assertStringIncludes(m.html, 'Nyertes pályázat');
});

Deno.test('weekly on demand ({weekly:true}) on a Tuesday; mail failure → 502', async () => {
  const store = memStore([], () => TUESDAY.getTime());
  const ok = await (await call({ env: ENV, store, mailer: memMailer(), now: () => TUESDAY, purge: async () => 0 }, { weekly: true })).json();
  assertEquals(ok.weekly.sent, true);
  const r = await call({ env: ENV, store, mailer: memMailer({ failFor: () => true }), now: () => TUESDAY, purge: async () => 0 }, { weekly: true });
  assertEquals(r.status, 502);
});
