// iCalendar (RFC 5545) export of grant deadlines — shared by the `calendar`
// edge function. Same content as aipalyazo/portal.html buildICS(): an all-day
// event on the deadline with reminders 14 and 3 days before; rolling
// ("Folyamatos") calls have no date and are skipped.
// Differences: lines are folded at 75 OCTETS (not characters) without
// splitting a UTF-8 sequence, and the clock / calendar name are injectable.

export const PORTAL_URL = 'https://aipalyazo.hu/aipalyazo/portal.html';

/** Escape a TEXT value: backslash, semicolon, comma, newline. */
export function icsEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/[;,]/g, (m) => '\\' + m).replace(/\r?\n/g, '\\n');
}

const enc = new TextEncoder();

/** Fold one content line: ≤75 octets per physical line, continuation lines start with a space. */
export function icsFold(line) {
  const out = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) { // iterates whole code points
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
      limit = 75;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** UTC timestamp in iCalendar basic format, e.g. 20260928T071000Z. */
export function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/** Stable UID per grant id. */
export function icsUid(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_') + '@aipalyazo.hu';
}

/**
 * @param {Array<{id:string,title:string,deadline?:string,amount?:string,url?:string,rollingDeadline?:boolean}>} list
 * @param {{now?: Date, calName?: string, refresh?: string}} [opts]
 * @returns {{text: string, count: number}}
 */
export function buildICS(list, opts = {}) {
  const stamp = icsStamp(opts.now ?? new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AIpalyazo//Hataridok//HU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape(opts.calName ?? 'AIpályázó határidők'), 'X-WR-TIMEZONE:Europe/Budapest'];
  if (opts.refresh) lines.push('REFRESH-INTERVAL;VALUE=DURATION:' + opts.refresh, 'X-PUBLISHED-TTL:' + opts.refresh);
  let n = 0;
  for (const g of list || []) {
    if (!g || g.rollingDeadline || !/^\d{4}-\d{2}-\d{2}$/.test(g.deadline || '')) continue;
    const start = new Date(g.deadline + 'T12:00:00Z');
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== g.deadline) continue; // e.g. 2026-02-31
    const d = g.deadline.replace(/-/g, '');
    const next = new Date(start); next.setUTCDate(next.getUTCDate() + 1);
    const d2 = next.toISOString().slice(0, 10).replace(/-/g, '');
    const link = PORTAL_URL + '?grant=' + encodeURIComponent(g.id);
    lines.push('BEGIN:VEVENT', 'UID:' + icsUid(g.id), 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + d2,
      'SUMMARY:' + icsEscape('Pályázati határidő: ' + g.title),
      'DESCRIPTION:' + icsEscape((g.amount ? 'Összeg: ' + g.amount + '\n' : '') + 'Hivatalos oldal: ' + (g.url || '—') + '\nAIpályázó: ' + link + '\nA határidőt mindig ellenőrizze a hivatalos kiírásban.'),
      'URL:' + link,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape('2 hét múlva lejár: ' + g.title), 'TRIGGER:-P14D', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape('3 nap múlva lejár: ' + g.title), 'TRIGGER:-P3D', 'END:VALARM',
      'END:VEVENT');
    n++;
  }
  lines.push('END:VCALENDAR');
  return { text: lines.map(icsFold).join('\r\n') + '\r\n', count: n };
}
