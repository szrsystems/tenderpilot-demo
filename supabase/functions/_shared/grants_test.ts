import { createGrantFeed } from './grants.ts';
import { assertEquals } from './testing.ts';

Deno.test('grant feed: caches for the TTL, serves stale on failure, throws with no copy', async () => {
  let t = 0, calls = 0, fail = false;
  const f = (async () => {
    calls++;
    if (fail) throw new Error('down');
    return new Response(JSON.stringify([{ id: 'a', title: 'A' }, { id: 'b' }, null]));
  }) as unknown as typeof fetch;
  const feed = createGrantFeed({ url: 'https://feed', fetch: f, ttlMs: 1000, now: () => t, cache: new Map() });
  assertEquals((await feed.byId('a'))?.title, 'A');
  assertEquals(await feed.byId('b'), null, 'entries without a title are dropped');
  assertEquals((await feed.all()).length, 1);
  assertEquals(calls, 1, 'cached');
  t = 2000; fail = true;
  assertEquals((await feed.byId('a'))?.title, 'A', 'stale copy');
  assertEquals(calls, 2);
  const cold = createGrantFeed({ url: 'https://feed', fetch: f, cache: new Map() });
  let threw = false;
  try { await cold.all(); } catch { threw = true; }
  assertEquals(threw, true);
});
