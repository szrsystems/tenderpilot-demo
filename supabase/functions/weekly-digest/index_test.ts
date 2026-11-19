// Run: CRON_SECRET=t deno test --allow-env --import-map=<map stubbing jsr:@supabase/supabase-js@2> supabase/functions/weekly-digest/
import assert from 'node:assert/strict';
import { handler } from './index.ts';
import { fakeAdmin } from '../_shared/fake-admin.ts';

const grant = { id: 'g1', title: 'Informatikai fejlesztés KKV-knak', note: 'szoftver, digitális', amount: '10 M Ft', deadline: '2027-03-01', days: 100, sizeClasses: [], regions: [] };
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ user_id: `u${String(i).padStart(4, '0')}`, weekly_enabled: true, frequency: 'heti', unsubscribe_token: `t${i}`, recipient_email: null, section_top_n: 5, last_digest_at: null,
  profiles: { email: `u${i}@example.com`, display_name: 'X', company: 'Minta Kft', industries: ['IT'], employees: '6-10', site_region: 'Budapest', years_operating: '5+', teaor: '6201', public_debt_free: 'igen', in_difficulty: 'nem', revenue: '50-200M', own_funds: 'igen' } }));
const req = (offset: number) => new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 't' }, body: JSON.stringify({ offset }) });
const now = new Date('2026-11-23T07:00:00Z');

Deno.test('weekly digest: paged batches, re-run skips users already served', async () => {
  const admin = fakeAdmin({ notif_prefs: rows(230) });
  const batches: number[] = [];
  const sendBatch = async (m: unknown[]) => { batches.push(m.length); };
  let offset: number | null = 0, sent = 0, pages = 0;
  while (offset !== null) {
    const r = await (await handler(req(offset), { admin, sendBatch, grants: [grant], now })).json();
    sent += r.sent; offset = r.next; pages++;
  }
  assert.equal(pages, 3);
  assert.ok(sent > 0 && batches.every((n) => n <= 100));
  const re = await (await handler(req(0), { admin, sendBatch, grants: [grant], now })).json();
  assert.equal(re.sent, 0, 'a same-week re-run must not resend');
});

Deno.test('weekly digest: failed batch reports ok:false and leaves last_digest_at empty', async () => {
  const admin = fakeAdmin({ notif_prefs: rows(2) });
  const r = await (await handler(req(0), { admin, sendBatch: async () => { throw new Error('down'); }, grants: [grant], now })).json();
  assert.equal(r.ok, false);
  assert.ok(admin.tables.notif_prefs.every((x: any) => !x.last_digest_at));
});
