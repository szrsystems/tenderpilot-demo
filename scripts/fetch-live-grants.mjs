#!/usr/bin/env node
// =========================================================================
// AIpályázó — live grant feed builder (daily cron)
// =========================================================================
// Primary source: the official palyazat.gov.hu backend API (ginapp-api.
// fair.gov.hu) — the same API the government site's own frontend calls.
// It returns STRUCTURED data: real call codes, ISO deadlines, min/max
// support, total keret, eligible company-size classes and regions, plus
// modificationTime for change detection. No scraping, no LLM guessing.
//
// Hand-verification layer (2026-09 audit):
//   scripts/api-verified.json   — per API call code: exclude (fund-manager
//       budget lines, rail projects, public-sector calls…) or overlay the
//       checked facts (funding type, eligible regions, notes).
//   scripts/verified-grants.json — hand-verified opportunities the API does
//       not carry (Széchenyi Kártya, MFB, KAP, NKFIH, EU calls…), each with
//       verifiedAt + sources. Replaces the old grants.json + link-check path,
//       which let synthetic entries through and flip-flopped daily.
// EU: scripts/fetch-eu-calls.mjs — the official EU Funding & Tenders API.
//
// Output:
//   aipalyazo/grants_live.json  — portal-schema grant list
//   aipalyazo/grants-meta.json  — updatedAt, counts, keret/deadline changes
//
// Run: node scripts/fetch-live-grants.mjs
// =========================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchEuCalls } from './fetch-eu-calls.mjs';

const API = 'https://ginapp-api.fair.gov.hu/papi/tenders/list';
const API_HEADERS = {
  'Content-Type': 'application/json',
  // Public constants baked into the site's own JS bundle — not secrets.
  'application-name': 'FairApp',
  'device-id': '40b0c32c-77fe-4380-9f5e-be96ae24fabd',
  'User-Agent': 'Mozilla/5.0 (compatible; AIpalyazoBot/1.0; +https://aipalyazo.hu)',
};

const OUT_GRANTS = 'aipalyazo/grants_live.json';
const OUT_META = 'aipalyazo/grants-meta.json';
const API_VERIFIED = 'scripts/api-verified.json';
const VERIFIED = 'scripts/verified-grants.json';
const STALE_DAYS = 45;   // verified item not re-checked for this long → flagged
const EXPIRE_DAYS = 90;  // …and hidden after this long

// Business beneficiaries → this is a KKV product; keep calls a company can apply to.
const BUSINESS_BENEF = [
  'vállalkozás', 'mikrovállalkozás', 'kisvállalkozás', 'középvállalkozás',
  'egyéb vállalkozás', 'mikrovállalkozás természetes személy', 'Mikrovállalkozás',
];

// Official domains allowed from the curated set (aggregators/consultants dropped).
const OFFICIAL_DOMAINS = [
  'palyazat.gov.hu', 'nkfih.gov.hu', 'kavosz.hu', 'mfb.hu', 'mtu.gov.hu',
  'szechenyi2020.hu', 'kormany.hu', 'bgazrt.hu', 'hiventures.hu', 'mekh.hu',
  'exim.hu', 'hepa.hu', 'emet.gov.hu', 'ec.europa.eu', 'eic.ec.europa.eu',
  'cinea.ec.europa.eu', 'uia-initiative.eu', 'allamkincstar.gov.hu',
  'magyarfalu', 'vali.ifka.hu', 'ifka.hu', 'nak.hu', 'sztnh.gov.hu',
];

// operationalProgram → portal category (refined by name keywords below).
const OP_CAT = {
  GINOP_PLUSZ: 'KKV fejlesztés',
  DIMOP_PLUSZ: 'Digitális átalakulás',
  KEHOP_PLUSZ: 'Energiahatékonyság',
  EFOP_PLUSZ: 'Oktatás',
  MAHOP_PLUSZ: 'Mezőgazdaság',
  HAVE_PLUSZ: 'Mezőgazdaság',
  TOP_PLUSZ: 'KKV fejlesztés',
  IKOP_PLUSZ: 'KKV fejlesztés',
  'RRF-GS': 'Energiahatékonyság',
};
const KW_CAT = [
  [/digit|informatik|szoftver|mesterséges intelligencia|kiberbiztonság/i, 'Digitális átalakulás'],
  [/energia|napelem|megújuló|zöld/i, 'Energiahatékonyság'],
  [/kutat|innovác|K\+F|technológia/i, 'Kutatás-fejlesztés'],
  [/képz|oktat|kompetencia/i, 'Oktatás'],
  [/export|nemzetközi piac/i, 'Export'],
  [/turisz|szálláshely|vendéglát/i, 'Turizmus'],
  [/agrár|mezőgazda|élelmiszer|halász|erdő/i, 'Mezőgazdaság'],
  [/környezet|klíma|hulladék|víz/i, 'Környezetvédelem'],
  [/foglalkoztat|munkahely|bér/i, 'Munkahelyteremtés'],
];

const ALL_REGIONS = ['Budapest', 'Pest', 'Közép-Dunántúl', 'Nyugat-Dunántúl', 'Dél-Dunántúl',
  'Észak-Magyarország', 'Észak-Alföld', 'Dél-Alföld'];

function fmtAmount(t) {
  const M = 1_000_000, Mrd = 1_000_000_000;
  const f = (n) => n >= Mrd ? `${+(n / Mrd).toFixed(1)} Mrd Ft` : n >= M ? `${Math.round(n / M)} M Ft` : `${Math.round(n / 1000)} E Ft`;
  const min = t.minSupportAmount || 0, max = t.maxSupportAmount || 0;
  if (min >= 100_000 && max > min) return `${f(min)} – ${f(max)}`;
  if (max) return `max ${f(max)}`;
  return ''; // the total keret is shown separately — never as a per-company amount
}

function catFor(t) {
  const name = t.name || '';
  for (const [re, cat] of KW_CAT) if (re.test(name)) return cat;
  return OP_CAT[t.operationalProgram] || 'KKV fejlesztés';
}

// The API stores deadlines as Budapest midnight in UTC ("2026-12-30T23:00Z"
// = 31 Dec). Slicing the UTC string showed every deadline one day early.
export function budapestDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' }); // YYYY-MM-DD
}

// Calls a company cannot apply to directly. Catches NEW codes of the kinds
// the 2026-09 audit found (the known ones are listed in api-verified.json).
const NON_SME_NAME = /technikai|költségtérítés|alapkezel|hitelkeret|kombinált keret|közvetítő|tagsági jogviszony|minősítés\b|kármentesítés/i;
const NON_SME_OP = new Set(['IKOP_PLUSZ']);
export function autoExclude(t) {
  if (NON_SME_OP.has(t.operationalProgram)) return 'közlekedési infrastruktúra, kijelölt kedvezményezett';
  if (NON_SME_NAME.test(t.name || '')) return 'alapkezelői / technikai felhívás';
  if ((t.minSupportAmount || 0) <= 1 && (t.maxSupportAmount || 0) >= 1e9) return 'teljes keret mint „támogatási összeg” — pénzügyi eszköz sor';
  return null;
}

function factorsFor(g) {
  const sizes = g.sizeClasses || [];
  return {
    size: sizes.some((s) => /mikro/i.test(s)) ? 92 : sizes.length ? 82 : 75,
    industry: 85,
    location: !g.regions || g.regions.length === 0 ? 95 : 78,
    preference: g.scope === 'eu' ? (g.singleApplicant ? 72 : 58) : 85,
  };
}

function mapTender(t, overlay) {
  const cat = catFor(t);
  const g = {
    id: 'pg-' + t.code,
    code: t.code,
    title: String(t.name || '').replace(/[<>"]/g, '').trim(),
    issuer: 'Széchenyi Terv Plusz / palyazat.gov.hu',
    cat,
    type: 'grant',
    amount: fmtAmount(t),
    keret: t.sumAvailableSupportAmount || 0,
    deadline: budapestDate(t.endTime),
    days: 0, score: 0, // recomputed client-side
    url: `https://www.palyazat.gov.hu/palyazatok/redirect?program=szechenyi-terv-plusz&op=${encodeURIComponent(t.operationalProgram || '')}&code=${encodeURIComponent(t.code)}`,
    source: 'palyazat.gov.hu',
    status: t.status,
    requested: t.sumRequestedSupportAmount || 0,
    remaining: Math.max(0, (t.sumAvailableSupportAmount || 0) - (t.sumRequestedSupportAmount || 0)),
    // The API's `categories` are facet tags, not eligibility: every call
    // carried the same six regions. Regions come ONLY from verified data.
    regions: [],
    sizeClasses: (t.beneficiaries || []).filter((b) => BUSINESS_BENEF.includes(b)),
    rate: t.rateOfSupport ? `${t.rateOfSupport}% támogatási intenzitás` : null,
    modified: t.modificationTime || '',
    live: true,
    scope: 'hazai',
  };
  if (overlay) {
    for (const k of ['type', 'cat', 'regions', 'regionNote', 'amount', 'deadline', 'windowOpen', 'note', 'url', 'rate', 'verifiedAt', 'confidence']) {
      if (overlay[k] === false) delete g[k];          // e.g. rate: false = the API value is misleading
      else if (overlay[k] !== undefined && overlay[k] !== null) g[k] = overlay[k];
    }
    g.sources = (overlay.sources || []).slice(0, 3);
  } else {
    g.needsReview = true;
    g.regionNote = 'Régiós és jogosultsági feltételek: lásd a hivatalos felhívást.';
  }
  g.factors = factorsFor(g);
  return g;
}

async function linkAlive(url) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': API_HEADERS['User-Agent'] } });
    clearTimeout(to);
    return r.status >= 200 && r.status < 400;
  } catch { return false; }
}

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// Hand-verified items: shown until their deadline; rolling ones (no fixed
// deadline) stay while their verification is fresh.
export function selectVerified(items, today) {
  const kept = [], stale = [], dropped = [];
  for (const it of items) {
    if (it.deadline && it.deadline < today) { dropped.push({ id: it.id, why: 'lejárt' }); continue; }
    // Freshness = the later of the human check and the last successful
    // automatic re-check of the official page (scripts/monitor).
    const checked = [it.verifiedAt, it.lastChecked].filter(Boolean).sort().pop();
    const age = daysBetween(checked, today);
    if (age > EXPIRE_DAYS) { dropped.push({ id: it.id, why: `${age} napja nem ellenőrzött` }); continue; }
    const g = { ...it, live: false, days: 0, score: 0, sources: (it.sources || []).slice(0, 3) };
    if (!g.deadline) g.deadline = 'Folyamatos';
    if (age > STALE_DAYS) { g.stale = true; stale.push(it.id); }
    g.factors = factorsFor(g);
    kept.push(g);
  }
  return { kept, stale, dropped };
}

// Code key for de-duplication across sources: "GINOP Plusz-1.4.3-24/A" and
// "GINOP_PLUSZ-1.4.3-24" → "ginoppluszi1.4.3-24"-style normal form.
export const codeKey = (c) => String(c || '').toLowerCase().replace(/plusz/g, '').replace(/[^a-z0-9]/g, '').replace(/(\d)[a-z]$/, '$1');

// Apply the daily monitor's results: hide items whose official page is gone
// or says closed (2 checks in a row), take over re-checked deadlines, and
// add auto-verified new calls (every fact quoted from an official page).
export function applyMonitor(items, monitor) {
  const { flags = {}, auto = [] } = monitor || {};
  const hide = flags.hide || {}, ov = flags.overrides || {};
  const hidden = [];
  const out = [];
  for (const it of items) {
    if (hide[it.id]) { hidden.push({ id: it.id, why: hide[it.id] }); continue; }
    const o = ov[it.id];
    out.push(o ? { ...it, ...(o.deadline ? { deadline: o.deadline } : {}), ...(o.lastChecked ? { lastChecked: o.lastChecked } : {}) } : it);
  }
  const have = new Set(out.map((g) => codeKey(g.code)).filter(Boolean));
  const urls = new Set(out.map((g) => g.url));
  for (const a of auto) {
    if (hide[a.id] || urls.has(a.url) || (a.code && have.has(codeKey(a.code)))) continue;
    out.push(a);
  }
  return { items: out, hidden };
}

export async function buildFeed({ tenders, verifiedItems, apiVerified, euItems, prevGrants = [], today, monitor = null }) {
  // ---- 1) Official API feed ---------------------------------------------
  const now = new Date(today + 'T00:00:00Z').getTime();
  const excluded = [];
  const apiGrants = [];
  for (const t of tenders) {
    if (t.status !== 'Aktív') continue;
    if (!t.endTime || new Date(t.endTime).getTime() < now) continue;
    if (!(t.beneficiaries || []).some((b) => BUSINESS_BENEF.includes(b))) continue;
    const ov = apiVerified[t.code];
    if (ov && ov.exclude) { excluded.push({ code: t.code, why: ov.reason }); continue; }
    const auto = !ov && autoExclude(t);
    if (auto) { excluded.push({ code: t.code, why: 'auto: ' + auto }); continue; }
    const g = mapTender(t, ov);
    if (g.deadline && g.deadline < today) continue;
    apiGrants.push(g);
  }

  // ---- 2) Hand-verified items (not already carried by the API) -----------
  const apiKeys = new Set(apiGrants.map((g) => codeKey(g.code)).filter(Boolean));
  const mon = applyMonitor(verifiedItems, monitor);
  const { kept, stale, dropped } = selectVerified(mon.items, today);
  dropped.push(...mon.hidden.map((h) => ({ id: h.id, why: 'monitor: ' + h.why })));
  const verified = kept.filter((g) => !(g.code && apiKeys.has(codeKey(g.code))));

  // ---- 3) EU API (auto) — skip what is already hand-verified -------------
  const haveKeys = new Set([...apiKeys, ...verified.map((g) => codeKey(g.code))].filter(Boolean));
  let euFailed = false;
  let eu = euItems;
  if (!Array.isArray(eu)) {
    // EU API failed this run: keep yesterday's auto EU items that are still
    // open, so one bad night doesn't remove hundreds of calls.
    euFailed = true;
    eu = prevGrants.filter((g) => g.auto && g.scope === 'eu' && g.deadline >= today);
  }
  const euAuto = eu.filter((g) => !haveKeys.has(codeKey(g.code))).map((g) => ({ ...g, live: true, days: 0, score: 0, factors: factorsFor(g) }));

  const grants = [...apiGrants, ...verified, ...euAuto];
  return { grants, apiGrants, verified, euAuto, excluded, stale, dropped, euFailed };
}

function diff(prevList, grants) {
  const changes = [];
  const prev = Object.fromEntries(prevList.map((g) => [g.id, g]));
  for (const g of grants) {
    const p = prev[g.id];
    if (!p) { changes.push({ id: g.id, type: 'new', title: g.title }); continue; }
    if (p.deadline !== g.deadline) changes.push({ id: g.id, type: 'deadline', from: p.deadline, to: g.deadline, title: g.title });
    if ((p.keret || 0) !== (g.keret || 0)) changes.push({ id: g.id, type: 'keret', from: p.keret, to: g.keret, title: g.title });
    if ((p.remaining ?? -1) !== (g.remaining ?? -1)) changes.push({ id: g.id, type: 'szabad-keret', from: p.remaining, to: g.remaining, title: g.title });
  }
  for (const id of Object.keys(prev)) if (!grants.some((g) => g.id === id)) changes.push({ id, type: 'removed', title: prev[id].title });
  return changes;
}

async function main() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });

  const res = await fetch(API, {
    method: 'POST', headers: API_HEADERS,
    body: JSON.stringify({ pagination: { pageSize: 5000, pageIndex: 0 }, filtering: { exactFilters: [] }, sort: { direction: 'desc', field: 'endTime' } }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const { tenders } = await res.json();
  // A broken/empty response must never wipe the published feed.
  if (!Array.isArray(tenders) || tenders.length < 50) throw new Error(`API returned only ${tenders && tenders.length} tenders — refusing to publish`);
  console.log(`API: ${tenders.length} tenders total`);

  const apiVerified = JSON.parse(readFileSync(API_VERIFIED, 'utf8'));
  const verifiedItems = JSON.parse(readFileSync(VERIFIED, 'utf8')).items;
  const prevGrants = existsSync(OUT_GRANTS) ? JSON.parse(readFileSync(OUT_GRANTS, 'utf8')) : [];

  let euItems = null;
  try { euItems = await fetchEuCalls({ today }); console.log(`EU: ${euItems.length} open/forthcoming calls kept`); }
  catch (e) { console.warn(`EU API failed (${e.message}) — keeping yesterday's EU items`); }

  const readOpt = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
  const monitor = { flags: readOpt('scripts/monitor/flags.json', {}), auto: readOpt('scripts/monitor/auto-grants.json', []) };
  const out = await buildFeed({ tenders, verifiedItems, apiVerified, euItems, prevGrants, today, monitor });

  // Upgrade API links to canonical alapadatok pages where they exist.
  let canonical = 0;
  const api = out.apiGrants.filter((g) => !apiVerified[g.code] || !apiVerified[g.code].url);
  for (let i = 0; i < api.length; i += 10) {
    await Promise.all(api.slice(i, i + 10).map(async (g) => {
      const op = (g.url.match(/op=([A-Z_%-]+)/) || [])[1];
      if (!op || !/_PLUSZ$/.test(decodeURIComponent(op))) return;
      const slug = g.code.toLowerCase().replace(/_/g, '-').replace(/[./]/g, '').replace(/--+/g, '-');
      const opSlug = decodeURIComponent(op).toLowerCase().replace(/_/g, '-');
      const candidate = `https://www.palyazat.gov.hu/programok/szechenyi-terv-plusz/${opSlug}/${slug}/alapadatok`;
      if (await linkAlive(candidate)) { g.url = candidate; canonical++; }
    }));
  }

  const { grants } = out;
  const changes = diff(prevGrants, grants);
  const needsReview = out.apiGrants.filter((g) => g.needsReview).map((g) => ({ code: g.code, title: g.title }));
  writeFileSync(OUT_GRANTS, JSON.stringify(grants, null, 1));
  writeFileSync(OUT_META, JSON.stringify({
    updatedAt: new Date().toISOString(),
    counts: {
      total: grants.length, api: out.apiGrants.length, verified: out.verified.length, euAuto: out.euAuto.length,
      hazai: grants.filter((g) => g.scope !== 'eu').length, eu: grants.filter((g) => g.scope === 'eu').length,
      excluded: out.excluded.length,
    },
    euApiFailed: out.euFailed,
    needsReview,          // new API codes nobody has checked yet → verify + add to api-verified.json
    staleVerified: out.stale,
    droppedVerified: out.dropped,
    excluded: out.excluded,
    changes: changes.slice(0, 100),
  }, null, 1));
  console.log(`WROTE ${grants.length} grants (${out.apiGrants.length} API, ${out.verified.length} verified, ${out.euAuto.length} EU auto; ${canonical} canonical links) | ${out.excluded.length} excluded | ${needsReview.length} need review | ${changes.length} changes`);
  if (needsReview.length) console.log('::warning::New API calls need manual review: ' + needsReview.map((x) => x.code).join(', '));
  if (out.stale.length) console.log('::warning::Verified items due for re-check: ' + out.stale.join(', '));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
