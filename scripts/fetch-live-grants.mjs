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
// Secondary: the curated grants.json — but ONLY entries that (a) link to an
// official domain, (b) have a future deadline, (c) whose link is alive
// right now, and (d) aren't already covered by the API feed. This keeps
// the hazai (non-EU) programs (KAVOSZ, MFB, MTÜ…) while dropping the dead
// and consulting-site entries.
//
// Output:
//   aipalyazo/grants_live.json  — portal-schema grant list
//   aipalyazo/grants-meta.json  — updatedAt, counts, keret/deadline changes
//
// Run: node scripts/fetch-live-grants.mjs
// =========================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
const CURATED = 'aipalyazo/grants.json';

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
  const f = (n) => n >= Mrd ? `${+(n / Mrd).toFixed(1)} Mrd Ft` : n >= M ? `${Math.round(n / M)}M Ft` : `${Math.round(n / 1000)}E Ft`;
  const min = t.minSupportAmount || 0, max = t.maxSupportAmount || 0;
  if (min >= 100_000 && max > min) return `${f(min)} – ${f(max)}`;
  if (max) return `max ${f(max)}`;
  if (t.sumAvailableSupportAmount) return `keret: ${f(t.sumAvailableSupportAmount)}`;
  return '';
}

function catFor(t) {
  const name = t.name || '';
  for (const [re, cat] of KW_CAT) if (re.test(name)) return cat;
  return OP_CAT[t.operationalProgram] || 'KKV fejlesztés';
}

function mapTender(t) {
  const deadline = (t.endTime || '').slice(0, 10);
  const regions = (t.categories || []).filter((c) => ALL_REGIONS.some((r) => c.includes(r) || r.includes(c)));
  const sizeClasses = (t.beneficiaries || []).filter((b) => BUSINESS_BENEF.includes(b));
  const nationwide = regions.length === 0 || regions.length >= 7;
  const cat = catFor(t);
  return {
    id: 'pg-' + t.code,
    code: t.code,
    title: t.name,
    cat,
    amount: fmtAmount(t),
    keret: t.sumAvailableSupportAmount || 0,
    deadline,
    days: 0, score: 0, // recomputed client-side
    // Canonical detail page (verified after mapping; falls back to this
    // redirect link when the call has no detail page yet):
    // /programok/szechenyi-terv-plusz/<op>/<code-slug>/alapadatok
    url: `https://www.palyazat.gov.hu/palyazatok/redirect?program=szechenyi-terv-plusz&op=${encodeURIComponent(t.operationalProgram || '')}&code=${encodeURIComponent(t.code)}`,
    source: 'palyazat.gov.hu',
    status: t.status,
    // Live budget monitoring: the API publishes both the total keret and the
    // already-requested sum → remaining budget, refreshed by the daily cron.
    requested: t.sumRequestedSupportAmount || 0,
    remaining: Math.max(0, (t.sumAvailableSupportAmount || 0) - (t.sumRequestedSupportAmount || 0)),
    regions: nationwide ? [] : regions, // [] = országos
    sizeClasses,
    rate: t.rateOfSupport || '',
    modified: t.modificationTime || '',
    live: true, // came from the official API this run
    factors: {
      size: sizeClasses.some((s) => /mikro/i.test(s)) ? 92 : sizeClasses.length ? 82 : 70,
      industry: OP_CAT[t.operationalProgram] || KW_CAT.some(([re]) => re.test(t.name || '')) ? 85 : 72,
      location: nationwide ? 95 : 78,
      preference: 85,
    },
  };
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

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  // ---- 1) Official API feed --------------------------------------------
  const res = await fetch(API, {
    method: 'POST', headers: API_HEADERS,
    body: JSON.stringify({ pagination: { pageSize: 5000, pageIndex: 0 }, filtering: { exactFilters: [] }, sort: { direction: 'desc', field: 'endTime' } }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const { tenders } = await res.json();
  console.log(`API: ${tenders.length} tenders total`);

  const now = Date.now();
  const apiGrants = tenders
    .filter((t) => t.status === 'Aktív')
    .filter((t) => t.endTime && new Date(t.endTime).getTime() > now)
    .filter((t) => (t.beneficiaries || []).some((b) => BUSINESS_BENEF.includes(b)))
    .map(mapTender);
  console.log(`API: ${apiGrants.length} open business calls`);

  // Upgrade to canonical alapadatok deep links where they exist — the same
  // page the government site shows (keret %, dates, feltételek). Slug rule:
  // GINOP_PLUSZ-1.4.6-24 → ginop-plusz-146-24 (lowercase, dots/slashes out).
  let canonical = 0;
  for (let i = 0; i < apiGrants.length; i += 10) {
    await Promise.all(apiGrants.slice(i, i + 10).map(async (g) => {
      const op = (g.url.match(/op=([A-Z_%-]+)/) || [])[1];
      if (!op || !/_PLUSZ$/.test(decodeURIComponent(op))) return; // only STP programs have this URL shape
      const slug = g.code.toLowerCase().replace(/_/g, '-').replace(/[./]/g, '').replace(/--+/g, '-');
      const opSlug = decodeURIComponent(op).toLowerCase().replace(/_/g, '-');
      const candidate = `https://www.palyazat.gov.hu/programok/szechenyi-terv-plusz/${opSlug}/${slug}/alapadatok`;
      if (await linkAlive(candidate)) { g.url = candidate; canonical++; }
    }));
  }
  console.log(`API: ${canonical}/${apiGrants.length} upgraded to canonical alapadatok links`);

  // ---- 2) Curated survivors (hazai programs the API doesn't cover) ------
  let curated = [];
  let droppedByRegistry = 0;
  if (existsSync(CURATED)) {
    const all = JSON.parse(readFileSync(CURATED, 'utf8'));
    // The official registry is authoritative for Széchenyi Terv Plusz calls:
    // verified 2026-07-06 that the curated set's GINOP/DIMOP/… entries are
    // either closed (Lezárva) or carry codes the registry has never heard of
    // (synthetic demo leftovers) — so ALL coded curated entries are dropped;
    // genuinely open ones arrive via the API feed with live keret anyway.
    const candidates = all.filter((g) => {
      if (!g.deadline || g.deadline < today) return false;
      let host = ''; try { host = new URL(g.url).hostname.replace(/^www\./, ''); } catch { return false; }
      if (!OFFICIAL_DOMAINS.some((d) => host.includes(d))) return false;
      const codeM = (g.title || '').match(/(?:GINOP|DIMOP|KEHOP|EFOP|TOP|MAHOP|IKOP|VINOP)\s*Plusz?\s*[-–]?\s*\d[\d.]*(?:-\d+)?/i);
      if (codeM) {
        // Széchenyi-coded call: if Aktív, the API feed already carries it
        // (with live keret); if Lezárva/Felfüggesztve/unknown code, it is not
        // verifiably open. Either way the curated copy goes.
        droppedByRegistry++;
        return false;
      }
      return true;
    }).map((g) => ({
      ...g,
      // Normalise legacy category names to the canonical portal set.
      cat: ({ 'Energia': 'Energiahatékonyság', 'Digitalizáció': 'Digitális átalakulás' })[g.cat] || g.cat,
    }));
    console.log(`curated: ${candidates.length} official-domain candidates; checking links…`);
    const CHUNK = 10;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const batch = candidates.slice(i, i + CHUNK);
      const alive = await Promise.all(batch.map((g) => linkAlive(g.url)));
      batch.forEach((g, j) => { if (alive[j]) curated.push({ ...g, live: false, verifiedAt: today }); });
    }
    console.log(`curated: ${curated.length} alive survivors`);
  }

  const grants = [...apiGrants, ...curated];

  // ---- 3) Change detection vs previous run ------------------------------
  const changes = [];
  if (existsSync(OUT_GRANTS)) {
    const prev = Object.fromEntries(JSON.parse(readFileSync(OUT_GRANTS, 'utf8')).map((g) => [g.id, g]));
    for (const g of grants) {
      const p = prev[g.id];
      if (!p) { changes.push({ id: g.id, type: 'new', title: g.title }); continue; }
      if (p.deadline !== g.deadline) changes.push({ id: g.id, type: 'deadline', from: p.deadline, to: g.deadline, title: g.title });
      if ((p.keret || 0) !== (g.keret || 0)) changes.push({ id: g.id, type: 'keret', from: p.keret, to: g.keret, title: g.title });
      if ((p.remaining ?? -1) !== (g.remaining ?? -1)) changes.push({ id: g.id, type: 'szabad-keret', from: p.remaining, to: g.remaining, title: g.title });
    }
    for (const id of Object.keys(prev)) if (!grants.some((g) => g.id === id)) changes.push({ id, type: 'removed', title: prev[id].title });
  }

  writeFileSync(OUT_GRANTS, JSON.stringify(grants, null, 1));
  writeFileSync(OUT_META, JSON.stringify({
    updatedAt: new Date().toISOString(),
    counts: { total: grants.length, api: apiGrants.length, curated: curated.length },
    changes: changes.slice(0, 100),
  }, null, 1));
  console.log(`WROTE ${grants.length} grants (${apiGrants.length} live API + ${curated.length} curated) | ${changes.length} changes`);
}

main().catch((e) => { console.error(e); process.exit(1); });
