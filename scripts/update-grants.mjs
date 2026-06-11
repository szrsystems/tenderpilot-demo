// AIpályázó — daily monitor.
//
// Today this verifies reachability of every known grant-source domain,
// records timestamps + HTTP status, and emits aipalyazo/grants-status.json.
// The portal reads that file on load and displays "Adatbázis frissítve: X".
//
// This is the framework — real per-source scrapers (parsing felhívás lists
// for new/changed grants) plug in here later. The architecture is in place:
// daily cron → script → JSON committed → Pages auto-deploys → portal shows it.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// botProtected: the site runs WAF/bot-detection that rejects datacenter IPs
// or non-browser clients (verified manually: they serve human visitors fine).
// When such a source fails it is reported as "blocked", not "failing", so the
// portal's health badge isn't dragged down by something that isn't an outage.
//
// szechenyi2020.hu was removed 2026-06-11: the domain is dead (the 2014-2020
// program ended; its successor content lives on palyazat.gov.hu). Replaced by
// szpi.hu (Széchenyi Programiroda) and two new sources: palyazatihirek.eu
// (grant-news aggregator) and nak.hu (agrárkamara — the data set carries 20
// Mezőgazdaság grants and had no dedicated agri source).
const SOURCES = [
  { name: 'palyazat.gov.hu',          url: 'https://www.palyazat.gov.hu/',                   weight: 59, botProtected: true },
  { name: 'palyazatmenedzser.hu',     url: 'https://palyazatmenedzser.hu/',                  weight: 50, botProtected: true },
  { name: 'palyazatok.org',           url: 'https://palyazatok.org/',                        weight: 24 },
  { name: 'nkfih.gov.hu',             url: 'https://nkfih.gov.hu/',                          weight: 15 },
  { name: 'ec.europa.eu',             url: 'https://ec.europa.eu/info/funding-tenders_en',   weight: 12 },
  { name: 'kavosz.hu',                url: 'https://www.kavosz.hu/',                         weight: 11 },
  { name: 'szpi.hu',                  url: 'https://szpi.hu/',                               weight: 7 },
  { name: 'mfb.hu',                   url: 'https://www.mfb.hu/',                            weight: 7 },
  { name: 'mtu.gov.hu',               url: 'https://mtu.gov.hu/',                            weight: 6 },
  { name: 'bgazrt.hu',                url: 'https://www.bgazrt.hu/',                         weight: 6 },
  // hiventures.hu serves an incomplete TLS chain — browsers and curl accept
  // it, Node's fetch rejects (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Up for humans.
  { name: 'hiventures.hu',            url: 'https://hiventures.hu/',                         weight: 5, botProtected: true },
  { name: 'palyazatihirek.eu',        url: 'https://www.palyazatihirek.eu/',                 weight: 4 },
  { name: 'nak.hu',                   url: 'https://nak.hu/',                                weight: 4 },
  { name: 'hepa.hu',                  url: 'https://hepa.hu/',                               weight: 3 },
  { name: 'hipa.hu',                  url: 'https://hipa.hu/',                               weight: 3, botProtected: true },
  { name: 'exim.hu',                  url: 'https://www.exim.hu/',                           weight: 3 },
];

const OUT_PATH = 'aipalyazo/grants-status.json';
const TIMEOUT_MS = 12_000;
const USER_AGENT = 'AIpalyazo-Monitor/1.0 (+https://aipalyazo.hu/bot; contact: bot@aipalyazo.hu)';
// Some sites reject unknown bots but accept a browser UA — used as a retry,
// the honest bot UA always goes first.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS * 2); // budget covers retries
  let status = 0, ok = false, error = null, itemCount = null, listUrl = null;
  try {
    // HEAD first (lightest). Many Hungarian gov sites only support GET — fall
    // back to GET if HEAD is rejected.
    let res = await fetch(source.url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 405 || res.status === 403) {
      res = await fetch(source.url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
    }
    // UA-based bot blockers (403/429) often accept a browser UA — one retry.
    if (res.status === 403 || res.status === 429) {
      res = await fetch(source.url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'hu-HU,hu;q=0.9' } });
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
    // Connection-level failures (status 0) get one browser-UA retry too —
    // transient resets and TLS-fingerprint blockers both look like this.
    if (!ok) {
      try {
        const res = await fetch(source.url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'hu-HU,hu;q=0.9' } });
        status = res.status;
        ok = res.ok || (status >= 200 && status < 400);
        if (ok) error = null;
      } catch (_) { /* keep original error */ }
    }
  } finally {
    clearTimeout(t);
  }
  // A bot-protected source that still fails from the runner is "blocked":
  // the site is up for humans, our datacenter request is what's rejected.
  const blocked = !ok && !!source.botProtected;
  return { ...source, status, ok, blocked, latencyMs: Date.now() - startedAt, error, itemCount, listUrl, checkedAt: new Date().toISOString() };
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
  const blockedCount = results.filter(s => s.blocked).length;
  const failCount = results.length - okCount - blockedCount;
  const counted = results.filter(s => s.itemCount !== null && s.itemCount !== undefined);
  const totalListed = counted.reduce((s, r) => s + r.itemCount, 0);
  const newGrantsDetected = results.reduce((s, r) => s + Math.max(0, r.itemCountDelta || 0), 0);
  const out = {
    schemaVersion: 3,
    lastChecked: new Date().toISOString(),
    summary: {
      totalSources: results.length,
      ok: okCount,
      blocked: blockedCount,
      failing: failCount,
      avgLatencyMs: Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length),
      countedSources: counted.length,
      totalListedItems: totalListed,
      newGrantsDetected
    },
    notes: [
      'Daily monitor: HEAD/GET reachability check for all known Hungarian grant-source sites; 403/429/connection failures get one browser-UA retry.',
      '"blocked" sources run bot protection that rejects datacenter requests — they serve human visitors normally and are not outages.',
      'For palyazatmenedzser.hu, palyazatok.org and nkfih.gov.hu the bot also fetches the public felhívás index and counts items — when the count grows, "newGrantsDetected" reflects it.',
      'Pattern-based counting is best-effort and may shift if a source reorganises its page; do not treat numbers as authoritative — verify against the official source link.'
    ],
    sources: results
  };

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`OK: ${okCount}/${results.length} reachable, ${blockedCount} bot-blocked, ${failCount} failing. Counted ${counted.length} index pages, total listed ${totalListed}, new since last run: ${newGrantsDetected}. Wrote ${OUT_PATH}.`);
})().catch(e => { console.error('monitor failed:', e); process.exit(1); });
