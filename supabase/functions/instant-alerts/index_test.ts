// Run: CRON_SECRET=t deno test --allow-env --import-map=<map stubbing jsr:@supabase/supabase-js@2> supabase/functions/instant-alerts/
import assert from 'node:assert/strict';
import { handler } from './index.ts';
import { fakeAdmin } from '../_shared/fake-admin.ts';

const grant = { id: 'g-new', title: 'Informatikai fejlesztés KKV-knak', note: 'szoftver, digitális', amount: '10 M Ft', deadline: '2027-03-01', sizeClasses: [], regions: [] };
const profile = (i: number) => ({ email: `u${i}@example.com`, display_name: 'X', company: 'Minta Kft', industries: ['IT'], employees: '6-10', site_region: 'Budapest', years_operating: '5+', teaor: '6201', public_debt_free: 'igen', in_difficulty: 'nem', revenue: '50-200M', own_funds: 'igen' });
const users = (n: number) => Array.from({ length: n }, (_, i) => ({ user_id: `u${String(i).padStart(4, '0')}`, instant_enabled: true, unsubscribe_token: `t${i}`, recipient_email: null, profiles: profile(i) }));
const req = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 't' }, body: JSON.stringify(body) });

Deno.test('pages of 100 users: one batch call per page, next cursor, logs after send', async () => {
  const admin = fakeAdmin({ notif_prefs: users(250), alert_log: [], bookmarks: [] });
  const batches: number[] = [];
  const sendBatch = async (m: unknown[]) => { batches.push(m.length); };
  let offset: number | null = 0, pages = 0, sent = 0;
  while (offset !== null) {
    const r = await (await handler(req({ grants: [grant], changes: [{ type: 'new', id: 'g-new' }], offset }), { admin, sendBatch, today: '2026-11-19' })).json();
    assert.equal(r.ok, true); sent += r.sent; offset = r.next; pages++;
  }
  assert.equal(pages, 3);
  assert.equal(sent, 250, 'every opted-in, matching user gets one mail');
  assert.ok(batches.every((n) => n <= 100));
  assert.equal(sent, batches.reduce((a, b) => a + b, 0));
  assert.equal(admin.tables.alert_log.length, sent);
  // same run again: nothing is sent twice
  const again = await (await handler(req({ grants: [grant], changes: [{ type: 'new', id: 'g-new' }] }), { admin, sendBatch, today: '2026-11-19' })).json();
  assert.equal(again.sent, 0);
});

Deno.test('failed batch: nothing logged, so the users are retried next run', async () => {
  const admin = fakeAdmin({ notif_prefs: users(3), alert_log: [], bookmarks: [] });
  const r = await (await handler(req({ grants: [grant], changes: [{ type: 'new', id: 'g-new' }] }), { admin, sendBatch: async () => { throw new Error('429'); }, today: '2026-11-19' })).json();
  assert.equal(r.sent, 0); assert.equal(r.failed, 3);
  assert.equal(admin.tables.alert_log.length, 0);
  assert.equal(r.next, null);
});

Deno.test('bootstrap feed (everything new) never mails', async () => {
  const changes = Array.from({ length: 41 }, (_, i) => ({ type: 'new', id: `g${i}` }));
  const r = await (await handler(req({ grants: [], changes }), { admin: fakeAdmin({}), sendBatch: async () => { throw new Error('must not send'); } })).json();
  assert.equal(r.sent, 0); assert.equal(r.next, null);
});
