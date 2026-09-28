import { handler, type CalendarStore } from './index.ts';
import { assert, assertEquals, assertStringIncludes, staticFeed } from '../_shared/testing.ts';

const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FEED = [
  { id: 'a', title: 'Mentett A', deadline: '2026-11-30', url: 'https://x.hu/a' },
  { id: 'b', title: 'Nem mentett', deadline: '2026-12-01' },
  { id: 'c', title: 'Mentett folyamatos', deadline: 'Folyamatos' },
];
const store: CalendarStore = {
  userByToken: async (t) => (t === TOKEN ? 'u-1' : null),
  bookmarkIds: async (u) => (u === 'u-1' ? ['a', 'c', 'gone'] : []),
};
const get = (qs: string) => new Request(`http://x/calendar${qs}`);
const deps = { env: {}, store, grants: staticFeed(FEED), now: () => new Date('2026-09-28T07:00:00Z') };

Deno.test('valid token → saved, dated calls only, text/calendar, cached 1h', async () => {
  const r = await handler(get(`?t=${TOKEN.toUpperCase()}`), deps);
  assertEquals(r.status, 200);
  assertEquals(r.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assertEquals(r.headers.get('cache-control'), 'private, max-age=3600');
  const t = await r.text();
  assertStringIncludes(t, 'UID:a@aipalyazo.hu');
  assert(!t.includes('Nem mentett') && !t.includes('UID:c@'));
  assertEquals((t.match(/BEGIN:VEVENT/g) || []).length, 1);
  assertStringIncludes(t, 'portal.html?grant=a');
});

Deno.test('invalid or unknown token → 404 with an empty calendar', async () => {
  for (const qs of ['', '?t=nope', '?t=11111111-1111-4111-8111-111111111111']) {
    const r = await handler(get(qs), deps);
    assertEquals(r.status, 404);
    const t = await r.text();
    assertStringIncludes(t, 'BEGIN:VCALENDAR');
    assert(!t.includes('VEVENT'));
    assertEquals(r.headers.get('cache-control'), 'no-store');
  }
});

Deno.test('feed or DB down → 503 (calendar apps keep their copy)', async () => {
  let r = await handler(get(`?t=${TOKEN}`), { ...deps, grants: staticFeed([], { fail: true }) });
  assertEquals(r.status, 503);
  r = await handler(get(`?t=${TOKEN}`), { ...deps, store: { ...store, userByToken: async () => { throw new Error('db'); } } });
  assertEquals(r.status, 503);
  assertEquals((await handler(new Request('http://x', { method: 'POST' }), deps)).status, 405);
});
