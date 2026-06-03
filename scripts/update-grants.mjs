// GrantPilot — daily monitor.
//
// Today this verifies reachability of every known grant-source domain,
// records timestamps + HTTP status, and emits grantpilot/grants-status.json.
// The portal reads that file on load and displays "Adatbázis frissítve: X".
//
// This is the framework — real per-source scrapers (parsing felhívás lists
// for new/changed grants) plug in here later. The architecture is in place:
// daily cron → script → JSON committed → Pages auto-deploys → portal shows it.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const SOURCES = [
  { name: 'palyazat.gov.hu',          url: 'https://www.palyazat.gov.hu/',                   weight: 59 },
  { name: 'palyazatmenedzser.hu',     url: 'https://palyazatmenedzser.hu/',                  weight: 50 },
  { name: 'palyazatok.org',           url: 'https://palyazatok.org/',                        weight: 24 },
  { name: 'nkfih.gov.hu',             url: 'https://nkfih.gov.hu/',                          weight: 15 },
  { name: 'ec.europa.eu',             url: 'https://ec.europa.eu/info/funding-tenders_en',   weight: 12 },
  { name: 'kavosz.hu',                url: 'https://www.kavosz.hu/',                         weight: 11 },
  { name: 'szechenyi2020.hu',         url: 'https://www.szechenyi2020.hu/',                  weight: 7 },
  { name: 'mfb.hu',                   url: 'https://www.mfb.hu/',                            weight: 7 },
  { name: 'mtu.gov.hu',               url: 'https://mtu.gov.hu/',                            weight: 6 },
  { name: 'bgazrt.hu',                url: 'https://www.bgazrt.hu/',                         weight: 6 },
  { name: 'hiventures.hu',            url: 'https://www.hiventures.hu/',                     weight: 5 },
  { name: 'hepa.hu',                  url: 'https://hepa.hu/',                               weight: 3 },
  { name: 'hipa.hu',                  url: 'https://hipa.hu/',                               weight: 3 },
  { name: 'exim.hu',                  url: 'https://www.exim.hu/',                           weight: 3 },
];

const OUT_PATH = 'grantpilot/grants-status.json';
const TIMEOUT_MS = 12_000;
const USER_AGENT = 'GrantPilot-Monitor/1.0 (+https://grantpilot.hu/bot; contact: bot@grantpilot.hu)';

// Sources with a known index/list URL get an extra "item count" pass — crude
// HTML pattern matching that flags when new entries appear vs the previous run.
// Patterns verified against the live sites — adjust if a source redesigns.
const COUNTABLE = {
  'palyazatmenedzser.hu':  { listUrl: 'https://palyazatmenedzser.hu/palyazatok/', pattern: /<article\b/gi },
  'nkfih.gov.hu':          { listUrl: 'https://nkfih.gov.hu/palyazoknak',        pattern: /palyazati-felhivas/gi },
  'palyazatok.org':        { listUrl: 'https://palyazatok.org/',                 pattern: /type-post\b/gi }
};

async function fetchText(url, signal) {
  const res = await fetch(url, { method: 'GET', redirect: 'follow', signal, headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' } });
  if (!res.ok) return '';
  return await res.text();
}

async function check(source) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let status = 0, ok = false, error = null, itemCount = null, listUrl = null;
  try {
    // HEAD first (lightest). Many Hungarian gov sites only support GET — fall
    // back to GET if HEAD is rejected.
    let res = await fetch(source.url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 405 || res.status === 403) {
      res = await fetch(source.url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
    }
    status = res.status;
    ok = res.ok || (status >= 200 && status < 400);

    // Best-effort item count for sources with known index URLs.
    const c = COUNTABLE[source.name];
    if (ok && c) {
      listUrl = c.listUrl;
      try {
        const text = await fetchText(c.listUrl, ctrl.signal);
        if (text) {
          const m = text.match(c.pattern);
          itemCount = m ? m.length : 0;
        }
      } catch (_) { /* best-effort only */ }
    }
  } catch (e) {
    error = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error';
  } finally {
    clearTimeout(t);
  }
  return { ...source, status, ok, latencyMs: Date.now() - startedAt, error, itemCount, listUrl, checkedAt: new Date().toISOString() };
}

(async () => {
  const previous = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, 'utf8') || '{}')
    : { sources: [] };
  const prevByName = Object.fromEntries((previous.sources || []).map(s => [s.name, s]));

  // Concurrency-limit to 6 to be a polite bot.
  const results = [];
  const queue = SOURCES.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const src = queue.shift();
      const r = await check(src);
      const prev = prevByName[r.name];
      if (prev) {
        r.statusChanged = prev.status !== r.status || prev.ok !== r.ok;
        r.firstSeenOk = prev.firstSeenOk || (r.ok ? r.checkedAt : null);
        r.lastSeenOk  = r.ok ? r.checkedAt : (prev.lastSeenOk || null);
        if (r.itemCount !== null && prev.itemCount !== null && prev.itemCount !== undefined) {
          r.itemCountDelta = r.itemCount - prev.itemCount;
        } else {
          r.itemCountDelta = 0;
        }
      } else {
        r.statusChanged = false;
        r.firstSeenOk = r.ok ? r.checkedAt : null;
        r.lastSeenOk  = r.ok ? r.checkedAt : null;
        r.itemCountDelta = 0;
      }
      results.push(r);
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => b.weight - a.weight);

  const okCount = results.filter(s => s.ok).length;
  const failCount = results.length - okCount;
  const counted = results.filter(s => s.itemCount !== null && s.itemCount !== undefined);
  const totalListed = counted.reduce((s, r) => s + r.itemCount, 0);
  const newGrantsDetected = results.reduce((s, r) => s + Math.max(0, r.itemCountDelta || 0), 0);
  const out = {
    schemaVersion: 2,
    lastChecked: new Date().toISOString(),
    summary: {
      totalSources: results.length,
      ok: okCount,
      failing: failCount,
      avgLatencyMs: Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length),
      countedSources: counted.length,
      totalListedItems: totalListed,
      newGrantsDetected
    },
    notes: [
      'Daily monitor: HEAD/GET reachability check for all known Hungarian grant-source sites.',
      'For palyazat.gov.hu, palyazatmenedzser.hu, palyazatok.org and nkfih.gov.hu the bot also fetches the public felhívás index and counts items — when the count grows, "newGrantsDetected" reflects it.',
      'Pattern-based counting is best-effort and may shift if a source reorganises its page; do not treat numbers as authoritative — verify against the official source link.'
    ],
    sources: results
  };

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`OK: ${okCount}/${results.length} sources reachable. Counted ${counted.length} index pages, total listed ${totalListed}, new since last run: ${newGrantsDetected}. Wrote ${OUT_PATH}.`);
})().catch(e => { console.error('monitor failed:', e); process.exit(1); });
