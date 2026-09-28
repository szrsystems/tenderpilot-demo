import { handler } from './index.ts';
import { assert, assertEquals, memStore } from '../_shared/testing.ts';
import type { AdminUser } from './index.ts';

const USERS: Record<string, AdminUser> = {
  admin: { id: 'a', email: 'Boss@AIpalyazo.hu', email_confirmed_at: '2026-01-01T00:00:00Z' },
  unconfirmed: { id: 'b', email: 'boss@aipalyazo.hu', email_confirmed_at: null },
  other: { id: 'c', email: 'someone@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
};
const ENV = { ADMIN_EMAILS: 'ops@aipalyazo.hu, boss@aipalyazo.hu' };
const store = () => Object.assign(
  memStore(Array.from({ length: 7 }, (_, i) => ({ grant_id: 'g' + i, status: (i % 2 ? 'won' : 'sent') as 'won' | 'sent' }))),
  { idByRef: async (ref: string) => null as string | null },
);
const deps = (s = store(), env: Record<string, string | undefined> = ENV) => ({ env, store: s, getUser: async (t: string) => USERS[t] ?? null });
const get = (qs: string, jwt = 'admin') => new Request(`http://x/admin-leads${qs}`, { headers: { authorization: `Bearer ${jwt}` } });
const post = (b: unknown, jwt = 'admin') => new Request('http://x/admin-leads', { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });

Deno.test('auth: JWT required, confirmed e-mail in ADMIN_EMAILS only', async () => {
  assertEquals((await handler(new Request('http://x'), deps())).status, 401);
  assertEquals((await handler(get('', 'nobody'), deps())).status, 401);
  assertEquals((await handler(get('', 'unconfirmed'), deps())).status, 403);
  assertEquals((await handler(get('', 'other'), deps())).status, 403);
  assertEquals((await handler(get('', 'admin'), deps(store(), {}))).status, 403, 'no ADMIN_EMAILS → nobody');
  assertEquals((await handler(get('', 'admin'), deps())).status, 200);
});

Deno.test('list: pagination, status filter, POST without body lists too', async () => {
  let j = await (await handler(get('?limit=3&offset=2'), deps())).json();
  assertEquals([j.count, j.total, j.limit, j.offset], [3, 7, 3, 2]);
  j = await (await handler(get('?status=won'), deps())).json();
  assertEquals(j.total, 3);
  assert(j.leads.every((l: { status: string }) => l.status === 'won'));
  j = await (await handler(post(undefined), deps())).json();
  assertEquals(j.count, 7);
  j = await (await handler(post({ limit: 2, status: 'sent' }), deps())).json();
  assertEquals([j.count, j.total], [2, 4]);
  for (const qs of ['?limit=0', '?limit=501', '?limit=abc', '?offset=-1', '?status=bogus']) {
    const r = await handler(get(qs), deps());
    assertEquals(r.status, 400, qs);
  }
});

Deno.test('update_status by id or ref (admin may set paid)', async () => {
  const s = store();
  s.idByRef = async (ref) => s.rows.find((r) => r.lead_ref === ref)?.id ?? null;
  const target = s.rows[0];
  let r = await handler(post({ action: 'update_status', id: target.id, status: 'paid', note: 'Számla 2026/12' }), deps(s));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).lead.status, 'paid');
  assertEquals(target.status_note, 'Számla 2026/12');
  r = await handler(post({ action: 'update_status', ref: s.rows[1].lead_ref.toLowerCase(), status: 'contacted' }), deps(s));
  assertEquals(r.status, 200);
  assertEquals(s.rows[1].status, 'contacted');
  assertEquals((await handler(post({ action: 'update_status', id: target.id, status: 'nope' }), deps(s))).status, 400);
  assertEquals((await handler(post({ action: 'update_status', status: 'won' }), deps(s))).status, 400);
  assertEquals((await handler(post({ action: 'update_status', ref: 'L-ZZZZZZ', status: 'won' }), deps(s))).status, 404);
  assertEquals((await handler(post({ action: 'update_status', id: target.id, status: 'won' }, 'other'), deps(s))).status, 403);
  assertEquals((await handler(post({ action: 'drop_table' }), deps(s))).status, 400);
});

Deno.test('errors do not leak details', async () => {
  const s = store();
  s.page = async () => { throw new Error('relation "leads" secret detail'); };
  const r = await handler(get(''), deps(s));
  assertEquals(r.status, 500);
  assertEquals(await r.json(), { error: 'server' });
});
