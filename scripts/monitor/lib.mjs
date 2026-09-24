// =========================================================================
// AIpályázó monitor — shared helpers (no dependencies)
// =========================================================================
import { createHash } from 'node:crypto';

export const UA = 'Mozilla/5.0 (compatible; AIpalyazoBot/1.0; +https://aipalyazo.hu/aipalyazo/impresszum.html)';

// ---- polite fetching ------------------------------------------------------
// One request at a time per host, a pause between requests, robots.txt
// respected, hard timeout. Different hosts run in parallel.
const lastHit = new Map();
const hostQueue = new Map();
const robotsCache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function robotsAllows(url, fetchImpl) {
  const u = new URL(url);
  if (!robotsCache.has(u.host)) {
    let rules = [];
    try {
      const r = await fetchImpl(`${u.protocol}//${u.host}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (r.ok) rules = parseRobots(await r.text());
    } catch { /* no robots.txt → allowed */ }
    robotsCache.set(u.host, rules);
  }
  const path = u.pathname + u.search;
  return !robotsCache.get(u.host).some((p) => p && path.startsWith(p));
}

// Disallow lines that apply to every bot ("User-agent: *").
export function parseRobots(txt) {
  const out = [];
  let applies = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (/^user-agent$/i.test(k)) applies = v.trim() === '*';
    else if (applies && /^disallow$/i.test(k) && v.trim()) out.push(v.trim());
  }
  return out;
}

export function makeFetcher({ fetchImpl = fetch, delayMs = 1200, timeoutMs = 20000, respectRobots = true, cache = null } = {}) {
  const fetchOnce = async function politeFetch(url) {
    const host = new URL(url).host;
    const prev = hostQueue.get(host) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    hostQueue.set(host, prev.then(() => mine));
    await prev;
    try {
      const wait = (lastHit.get(host) || 0) + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      if (respectRobots && !(await robotsAllows(url, fetchImpl))) return { url, status: 0, blocked: 'robots', text: '', html: '' };
      lastHit.set(host, Date.now());
      const res = await fetchImpl(url, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'hu,en;q=0.8' }, signal: AbortSignal.timeout(timeoutMs) });
      const ctype = res.headers?.get?.('content-type') || '';
      const body = await res.text();
      const isJson = /json/.test(ctype) || /^\s*[{[]/.test(body);
      return { url, finalUrl: res.url || url, status: res.status, html: isJson ? '' : body, json: isJson ? safeJson(body) : null, text: isJson ? '' : htmlToText(body) };
    } catch (e) {
      return { url, status: 0, error: String(e && e.message || e), text: '', html: '' };
    } finally {
      release();
    }
  };
  // Optional per-run cache: the re-check, summaries and discovery read many
  // of the same pages — fetch each once per run.
  if (!cache) return fetchOnce;
  return (url) => { if (!cache.has(url)) cache.set(url, fetchOnce(url)); return cache.get(url); };
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---- HTML → readable text ------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bdquo: '„', rdquo: '”', ldquo: '“', euro: '€' };
export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/td|\/th)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export function extractLinks(html, baseUrl) {
  const out = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    try { const u = new URL(decodeEntities(m[1]), baseUrl); if (!/^https?:$/.test(u.protocol)) continue; u.hash = ''; out.add(u.href.replace(/\/$/, '')); } catch { /* bad href */ }
  }
  return [...out];
}
export const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[\s ]+/g, ' ').replace(/[„”“"']/g, '"').trim();

// ---- dates ----------------------------------------------------------------
const HU_MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');

// Every date written in a snippet, as YYYY-MM-DD. Understands
// "2026. október 30.", "2026.10.30.", "2026-10-30", "30/10/2026",
// "30 October 2026", "October 30, 2026".
export function datesIn(text) {
  const t = String(text).toLowerCase();
  const out = new Set();
  const add = (y, m, d) => { y = +y; m = +m; d = +d; if (y > 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) out.add(`${y}-${pad(m)}-${pad(d)}`); };
  for (const m of t.matchAll(/(20\d\d)\.\s*(január|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s*(\d{1,2})/g)) add(m[1], HU_MONTHS.indexOf(m[2]) + 1, m[3]);
  for (const m of t.matchAll(/(20\d\d)[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/g)) add(m[1], m[2], m[3]);
  for (const m of t.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](20\d\d)\b/g)) add(m[3], m[2], m[1]);
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d\d)/g)) add(m[3], EN_MONTHS.indexOf(m[2]) + 1, m[1]);
  for (const m of t.matchAll(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)/g)) add(m[3], EN_MONTHS.indexOf(m[1]) + 1, m[2]);
  return [...out].sort();
}

export const todayBudapest = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });

// Run fn over items with limited parallelism.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
