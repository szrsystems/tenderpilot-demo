import { handler, type Ops } from './index.ts';
import { assertEquals } from '../_shared/testing.ts';

const USER = { id: 'u-1', email: 'Kiss.Anna@Example.com' };
function fakeOps(failAt?: keyof Ops) {
  const calls: string[] = [];
  const step = (name: keyof Ops) => async (...args: unknown[]) => {
    calls.push(`${name}:${args.join(',')}`);
    if (failAt === name) throw new Error('db exploded with internals');
  };
  const ops: Ops = { blockEmail: step('blockEmail'), anonymizeLeads: step('anonymizeLeads'), deleteUserData: step('deleteUserData'), deleteAuthUser: step('deleteAuthUser') };
  return { ops, calls };
}
const req = (jwt?: string, b: unknown = { confirm: 'TÖRLÉS', email: 'kiss.anna@example.com' }) => new Request('http://x/delete-user', { method: 'POST', headers: jwt ? { authorization: `Bearer ${jwt}` } : {}, body: JSON.stringify(b) });
const deps = (ops: Ops) => ({ env: {}, ops, getUser: async (t: string) => (t === 'good' ? USER : null) });

Deno.test('success runs every step in order and blocks the hashed address', async () => {
  const { ops, calls } = fakeOps();
  const r = await handler(req('good'), deps(ops));
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { ok: true });
  // sha256('kiss.anna@example.com')
  const want = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kiss.anna@example.com')))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assertEquals(calls, [`blockEmail:${want}`, 'anonymizeLeads:u-1,Kiss.Anna@Example.com', 'deleteUserData:u-1', 'deleteAuthUser:u-1']);
});

Deno.test('each failing step is reported truthfully and stops the sequence', async () => {
  const cases: [keyof Ops, string, boolean, number][] = [
    ['blockEmail', 'block', false, 1],
    ['anonymizeLeads', 'leads', false, 2],
    ['deleteUserData', 'data', false, 3],
    ['deleteAuthUser', 'account', true, 4],
  ];
  for (const [failAt, step, dataDeleted, n] of cases) {
    const { ops, calls } = fakeOps(failAt);
    const r = await handler(req('good'), deps(ops));
    assertEquals(r.status, 500);
    assertEquals(await r.json(), { error: 'delete_failed', step, dataDeleted });
    assertEquals(calls.length, n);
  }
});

Deno.test('auth required', async () => {
  const { ops, calls } = fakeOps();
  assertEquals((await handler(req(), deps(ops))).status, 401);
  assertEquals((await handler(req('bad'), deps(ops))).status, 401);
  assertEquals((await handler(new Request('http://x', { method: 'GET' }), deps(ops))).status, 405);
  assertEquals(calls.length, 0);
});

Deno.test('nothing is deleted without the typed confirmation (word + own e-mail)', async () => {
  for (const b of [{}, { confirm: 'torles', email: 'kiss.anna@example.com' }, { confirm: 'TÖRLÉS', email: 'other@example.com' }]) {
    const { ops, calls } = fakeOps();
    const r = await handler(req('good', b), deps(ops));
    assertEquals(r.status, 400);
    assertEquals(calls.length, 0);
  }
});
