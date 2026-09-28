import { buildICS, icsEscape, icsFold, icsUid } from './ics.mjs';
import { assert, assertEquals, assertStringIncludes } from './testing.ts';

const NOW = new Date('2026-09-28T07:10:00.123Z');
const unfold = (t: string) => t.replace(/\r\n /g, '');

Deno.test('icsEscape escapes backslash, ; , and newlines', () => {
  assertEquals(icsEscape('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf');
  assertEquals(icsEscape(null), '');
});

Deno.test('icsFold: ≤75 octets per line, never splits UTF-8, round-trips', () => {
  const line = 'SUMMARY:' + 'Pályázati határidő: őűáéí '.repeat(12) + '🙂'.repeat(20);
  const folded = icsFold(line);
  for (const l of folded.split('\r\n')) assert(new TextEncoder().encode(l).length <= 75, `too long: ${l}`);
  assert(folded.split('\r\n').slice(1).every((l) => l.startsWith(' ')));
  assertEquals(unfold(folded), line);
  assert(!folded.includes('�'));
  assertEquals(icsFold('SHORT'), 'SHORT');
  const exactly75 = 'X'.repeat(75);
  assertEquals(icsFold(exactly75), exactly75);
  assertEquals(icsFold(exactly75 + 'Y'), exactly75 + '\r\n Y');
});

Deno.test('buildICS: all-day events, two alarms, stable UID, CRLF, skips non-dates', () => {
  const list = [
    { id: 'pg-DIMOP_PLUSZ-1.2.3/B-24', title: 'Digitális; fejlesztés, KKV', deadline: '2026-12-31', amount: '5–50 M Ft', url: 'https://palyazat.gov.hu/x' },
    { id: 'roll', title: 'Folyamatos hitel', deadline: 'Folyamatos' },
    { id: 'flag', title: 'Rolling flag', deadline: '2026-11-01', rollingDeadline: true },
    { id: 'bad', title: 'Rossz dátum', deadline: '2026-02-31' },
  ];
  const { text, count } = buildICS(list, { now: NOW, calName: 'Teszt', refresh: 'PT12H' });
  assertEquals(count, 1);
  assert(text.endsWith('END:VCALENDAR\r\n'));
  assert(!/[^\r]\n/.test(text), 'only CRLF line breaks');
  for (const l of text.split('\r\n')) assert(new TextEncoder().encode(l).length <= 75);
  const u = unfold(text);
  assertStringIncludes(u, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n');
  assertStringIncludes(u, 'X-WR-CALNAME:Teszt');
  assertStringIncludes(u, 'REFRESH-INTERVAL;VALUE=DURATION:PT12H');
  assertStringIncludes(u, 'UID:pg-DIMOP_PLUSZ-1.2.3_B-24@aipalyazo.hu');
  assertStringIncludes(u, 'DTSTAMP:20260928T071000Z');
  assertStringIncludes(u, 'DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101');
  assertStringIncludes(u, 'SUMMARY:Pályázati határidő: Digitális\\; fejlesztés\\, KKV');
  assertStringIncludes(u, 'URL:https://aipalyazo.hu/aipalyazo/portal.html?grant=pg-DIMOP_PLUSZ-1.2.3%2FB-24');
  assertEquals((u.match(/BEGIN:VALARM/g) || []).length, 2);
  assertStringIncludes(u, 'TRIGGER:-P14D');
  assertStringIncludes(u, 'TRIGGER:-P3D');
  assertEquals(icsUid('a b/c'), 'a_b_c@aipalyazo.hu');
  // same input → identical output (stable for calendar clients)
  assertEquals(buildICS(list, { now: NOW, calName: 'Teszt', refresh: 'PT12H' }).text, text);
});

Deno.test('portal.html buildICS and the shared module agree on event content', async () => {
  // Pull the portal's functions out of the page and compare the unfolded output.
  const html = await Deno.readTextFile(new URL('../../../aipalyazo/portal.html', import.meta.url));
  const start = html.indexOf('function icsEscape(');
  const end = html.indexOf('function downloadICS(');
  if (start < 0 || end < 0) { console.warn('portal buildICS not found — skipped'); return; }
  const src = html.slice(start, end);
  const portal = new Function(`${src}; return buildICS;`)() as (l: unknown[]) => { text: string; count: number };
  const list = [{ id: 'x/1', title: 'Árvíztűrő, tükörfúrógép; ' + 'hosszú cím '.repeat(10), deadline: '2027-03-15', amount: '10 M Ft', url: 'https://example.hu' }];
  const a = unfold(portal(list).text).split('\r\n').filter((l) => !l.startsWith('DTSTAMP'));
  const b = unfold(buildICS(list).text).split('\r\n').filter((l) => !l.startsWith('DTSTAMP') && !l.startsWith('X-WR-TIMEZONE') && !l.startsWith('TRANSP'));
  assertEquals(b, a);
});

Deno.test('icsEscape: bare CR, LS/PS and control chars cannot start a new property line', () => {
  const out = icsEscape('A\rEND:VEVENT\rBEGIN:VEVENT\u2028SUMMARY:evil\u0000\u001b');
  assertEquals(/[\r\n\u2028\u2029\u0000-\u001f]/.test(out), false);
  assertEquals(out, 'A\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:evil');
});
