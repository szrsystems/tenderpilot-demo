// =========================================================================
// AIpályázó — per-call change log (aipalyazo/changes.json)
// =========================================================================
// { "<grantId>": [ { date: "YYYY-MM-DD", type, from?, to? }, … ] }
// Types: new, deadline, keret, szabad-keret, removed (feed builder),
//        page, deadline-official (daily monitor: official page changed).
// Kept: the last 12 months per id, at most 50 entries per id, oldest first.
// Merging is idempotent: the same entry on the same day is stored once.
// =========================================================================

export const KEEP_DAYS = 365;
export const MAX_PER_ID = 50;

const sig = (e) => JSON.stringify([e.date, e.type, e.from ?? null, e.to ?? null]);
const minus = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);

// changes: [{ id, type, from?, to? }] (the diff format) — all dated `today`.
export function mergeChanges(prev, changes, today) {
  const out = {};
  const cutoff = minus(today, KEEP_DAYS);
  const add = (id, e) => {
    const list = out[id] || (out[id] = []);
    if (!list.some((x) => sig(x) === sig(e))) list.push(e);
  };
  for (const [id, list] of Object.entries(prev || {})) {
    if (!Array.isArray(list)) continue;
    for (const e of list) if (e && e.date && e.type) add(id, e);
  }
  for (const c of changes || []) {
    if (!c || !c.id || !c.type) continue;
    const e = { date: today, type: c.type };
    if (c.from !== undefined && c.from !== null) e.from = c.from;
    if (c.to !== undefined && c.to !== null) e.to = c.to;
    // Titles let the portal's news page name calls that are no longer in the feed.
    if ((c.type === 'new' || c.type === 'removed') && typeof c.title === 'string' && c.title) e.title = c.title.slice(0, 200);
    // The monitor re-reports an official deadline every day until the
    // verified list is updated — log each distinct move once.
    if (c.type === 'deadline-official' && (out[c.id] || []).some((x) => x.type === e.type && x.from === e.from && x.to === e.to)) continue;
    add(c.id, e);
  }
  const result = {};
  for (const id of Object.keys(out).sort()) {
    const list = out[id].filter((e) => e.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
    if (list.length) result[id] = list.slice(-MAX_PER_ID);
  }
  return result;
}
