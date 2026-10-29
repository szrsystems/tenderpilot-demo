#!/usr/bin/env node
// =========================================================================
// AIpályázó — one public, indexable page per call (SEO)
// =========================================================================
// Runs in the daily job right after fetch-live-grants.mjs. Writes:
//   aipalyazo/palyazat/<slug>.html   one page per listed call
//   aipalyazo/palyazat/index.html    all open calls (hazai + EU), searchable
//   aipalyazo/palyazat/pages.json    manifest: slug → id, title, first/last seen
//   aipalyazo/sitemap.xml            static pages + every open call page
//   robots.txt (repo root)           crawlers only read /robots.txt
// A call that leaves the feed keeps its URL for 365 days as a noindex
// "lezárult" page (no dead links from Google/e-mails), then is deleted.
// Slugs come from the call id (stable), never from the title (can change).
// Everything printed from the feed is HTML-escaped.
// =========================================================================
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { GUIDES } from './guides.mjs';
const Cards = createRequire(import.meta.url)('../aipalyazo/lib/cards.js');
const todayHU = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });

export const SITE = 'https://aipalyazo.hu';
export const BASE = `${SITE}/aipalyazo`;
const KEEP_CLOSED_DAYS = 365;

const TYPE_HU = { grant: 'Vissza nem térítendő támogatás', loan: 'Kedvezményes hitel', equity: 'Tőkebefektetés', 'grant+equity': 'Támogatás + tőkebefektetés', 'grant+loan': 'Kombinált (támogatás + hitel)', guarantee: 'Garancia', prize: 'Díj / pályázati nyeremény', voucher: 'Utalvány' };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

export function slugify(id) {
  const s = String(id || '')
    .replace(/^(pg|v|eu)-/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return s || 'palyazat';
}

// Unique slug per id (two ids could normalise to the same text).
export function assignSlugs(ids, manifest = {}) {
  const byId = new Map(Object.entries(manifest).map(([slug, m]) => [m.id, slug]));
  const used = new Set(Object.keys(manifest));
  const out = new Map();
  for (const id of ids) {
    if (byId.has(id)) { out.set(id, byId.get(id)); continue; }
    let base = slugify(id), slug = base, n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug); out.set(id, slug);
  }
  return out;
}

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const huDate = (d) => (isDate(d) ? `${d.slice(0, 4)}. ${d.slice(5, 7)}. ${d.slice(8, 10)}.` : '');
export function isOpen(g, today) {
  if (isDate(g.deadline)) return g.deadline >= today;
  return true; // "Folyamatos" / no date: open while listed
}
function deadlineHu(g) {
  if (isDate(g.deadline)) return huDate(g.deadline) + (g.rolling ? ' (a következő beadási forduló; folyamatos beadás)' : '');
  return 'Folyamatos beadás (a keret kimerüléséig)';
}
const ft = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace('.', ',')} Mrd Ft` : `${Math.round(n / 1e6)} M Ft`);

const MARK = '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="5" fill="#12844a"/><path d="M7.5 10.5h11M7.5 16h8M7.5 21.5h5.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M18.5 20.5l3 3 5.5-7.5" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Page-specific styles on top of assets/site.css (the shared design system).
const PAGE_CSS = `
.crumbs{font:400 13px/1.4 var(--mono);color:var(--ink-3);margin:var(--s5) 0 var(--s4)}.crumbs a{color:var(--ink-3)}
.call-head{padding-bottom:var(--s5);border-bottom:1px solid var(--line);margin-bottom:var(--s5)}
.call-head h1{font-size:clamp(26px,3.4vw,38px);letter-spacing:-.02em;margin:var(--s2) 0 var(--s3);overflow-wrap:anywhere;max-width:30ch}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--s3)}
.call-grid{display:grid;gap:var(--s6);padding-bottom:var(--s7)}
@media(min-width:1000px){.call-grid{grid-template-columns:minmax(0,1fr) 360px;gap:var(--s7)}.call-side{position:sticky;top:88px;align-self:start}}
.call-main h2{font-size:21px;margin:var(--s6) 0 var(--s3)}.call-main h2:first-child{margin-top:0}
.call-main p,.call-main li{color:var(--ink-2)}
.facts{width:100%;border-collapse:collapse;font-size:15px}.facts th,.facts td{text-align:left;vertical-align:top;padding:10px 0;border-bottom:1px solid var(--line)}
.facts th{width:42%;color:var(--ink-3);font-weight:500;padding-right:12px;font-size:14px}.facts td{overflow-wrap:anywhere}
.side-box{border:1px solid var(--line);border-top:3px solid var(--brand);border-radius:var(--r-lg);padding:var(--s5);background:var(--surface);margin-top:var(--s5)}
.side-box h2{font-size:19px;margin-bottom:var(--s2)}.side-box p{font-size:15px;color:var(--ink-2)}.side-box .btn{width:100%;margin-top:var(--s2)}
.sum h3{font-size:16px;margin:var(--s4) 0 var(--s2)}.sum ul{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.sum li{padding:10px 0;border-bottom:1px solid var(--line);color:var(--ink)}
.q{display:block;font:400 13px/1.5 var(--mono);color:var(--ink-3);margin-top:4px;overflow-wrap:anywhere}
.req{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}.req li{padding:10px 0;border-bottom:1px solid var(--line);display:grid;gap:2px}
.req b{color:var(--ink)}.req span{font-size:14px;color:var(--ink-3)}
.log{list-style:none;margin:0;padding:0}.log li{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);font-size:15px}
.log time{font:400 13.5px/1.6 var(--mono);color:var(--ink-3)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.filters button{min-height:40px;padding:0 14px;border:1px solid var(--line-strong);background:var(--paper);color:var(--ink);border-radius:999px;font:500 14px/1 var(--sans);cursor:pointer}
.filters button[aria-pressed="true"]{background:var(--brand);color:#fff;border-color:var(--brand)}
.hubs{margin:var(--s5) 0 var(--s6);display:grid;gap:var(--s4)}@media(min-width:900px){.hubs{grid-template-columns:repeat(4,minmax(0,1fr))}}
.hubs h2{font:500 13px/1.4 var(--mono);text-transform:uppercase;color:var(--ink-3);margin-bottom:var(--s2)}
.hub-links{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:15px}.hub-links .n{font-family:var(--mono);color:var(--ink-3);font-size:13px}
.list-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--s3);margin:var(--s6) 0 var(--s2)}
.list-head h2{font-size:22px}.list-head .count{font:400 14px/1 var(--mono);color:var(--ink-3)}
.page-intro{max-width:70ch;color:var(--ink-2);font-size:17px}
.empty-note{padding:var(--s4) 0;color:var(--ink-3)}
.back-link{margin:var(--s5) 0}.end-note{margin-bottom:var(--s7)}.side-box.narrow{max-width:640px;margin-bottom:var(--s7)}.disclaimer{margin-top:var(--s6)}
.site-foot .brand-p{margin-top:var(--s3)}
.faq-list{margin:0;border-top:1px solid var(--line)}.faq-list dt{font-weight:600;color:var(--ink);padding-top:12px}.faq-list dd{margin:4px 0 0;padding-bottom:12px;border-bottom:1px solid var(--line);color:var(--ink-2);overflow-wrap:anywhere}
.related{margin:0;padding-left:18px}.related li{margin:6px 0}
.guide{max-width:760px}.guide h2{margin-top:var(--s6)}.guide .lead{font-size:18px;color:var(--ink)}.guide .live{margin:var(--s4) 0}.guide section ul,.guide section ol{padding-left:20px}.guide section li{margin:6px 0}.guide .facts th{width:38%}
.news-list{list-style:none;padding:0;margin:0}.news-list li{padding:10px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.news-list a{font-weight:600}.news h2 .count{font-size:14px;color:var(--ink-3);font-weight:500}
.loan-calc{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:12px 0}.loan-calc label{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:14px}.loan-out .big{font-size:22px}@media (max-width:640px){.loan-calc{grid-template-columns:1fr}}
.sources{padding-left:18px;overflow-wrap:anywhere}.sources li{margin:6px 0}
.guide-list{list-style:none;padding:0;margin:var(--s5) 0;max-width:760px}.guide-list li{padding:var(--s4) 0;border-bottom:1px solid var(--line)}.guide-list a{font-weight:600;font-size:18px}.guide-list p{margin:6px 0 0;color:var(--ink-2)}
`;

function shell({ title, description, canonical, noindex, body, jsonld, depth = 1, current = 'palyazat', ogType = 'website' }) {
  const up = '../'.repeat(depth);
  return `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://gc.zgo.at; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://*.goatcounter.com; base-uri 'self'; object-src 'none'; form-action 'self'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, follow">' : `<link rel="canonical" href="${esc(canonical)}">`}
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:locale" content="hu_HU">
<meta property="og:site_name" content="AIpályázó">
<meta property="og:image" content="${BASE}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ffffff">
<link rel="icon" type="image/svg+xml" href="${up}favicon.svg">
<link rel="alternate" type="application/rss+xml" title="AIpályázó – új pályázatok" href="${BASE}/hirek/rss.xml">
<link rel="preload" href="${up}assets/fonts/ibm-plex-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${up}assets/site.css">
<style>${PAGE_CSS}</style>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<a class="skip" href="#main">Ugrás a tartalomra</a>
<header class="site-head">
  <div class="wrap">
    <a class="brand" href="${up}index.html" aria-label="AIpályázó főoldal">${MARK}<span><b>AI</b>pályázó</span></a>
    <nav class="site-nav" aria-label="Fő navigáció"><a href="${up}palyazat/index.html"${current === 'palyazat' ? ' aria-current="page"' : ''}>Nyitott pályázatok</a><a href="${up}utmutato/index.html"${current === 'utmutato' ? ' aria-current="page"' : ''}>Útmutatók</a><a href="${up}index.html#hogyan">Hogyan működik</a></nav>
    <div class="head-actions">
      <a class="btn btn-quiet btn-sm hide-sm" href="${up}login.html" data-guest>Belépés</a>
      <a class="btn btn-primary btn-sm" href="${up}signup.html" data-guest>Regisztráció</a>
      <a class="btn btn-primary btn-sm" href="${up}portal.html" data-member hidden>Portál</a>
      <button class="btn btn-ghost btn-sm head-menu" type="button" data-menu-toggle aria-expanded="false" aria-controls="mobile-nav" aria-label="Menü"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
  </div>
  <div class="wrap"><nav id="mobile-nav" class="mobile-nav" aria-label="Mobil navigáció"><a href="${up}palyazat/index.html">Nyitott pályázatok</a><a href="${up}utmutato/index.html">Útmutatók</a><a href="${up}index.html#hogyan">Hogyan működik</a><a href="${up}login.html">Belépés</a></nav></div>
</header>
<main id="main"><div class="wrap">
${body}
</div></main>
<footer class="site-foot">
  <div class="wrap">
    <div class="cols">
      <div><a class="brand" href="${up}index.html">${MARK}<span><b>AI</b>pályázó</span></a><p class="brand-p">Ingyenes pályázatfigyelő magyar vállalkozásoknak. Tájékoztató szolgáltatás: beadás előtt mindig a hivatalos felhívás az irányadó.</p></div>
      <div><h4>Pályázatok</h4><ul><li><a href="${up}palyazat/index.html">Nyitott felhívások</a></li><li><a href="${up}palyazat/index.html#temak">Témák és programok</a></li><li><a href="${up}utmutato/index.html">Útmutatók</a></li><li><a href="${up}hirek/index.html">Heti hírek</a></li><li><a href="${up}portal.html">Portál</a></li></ul></div>
      <div><h4>Rólunk</h4><ul><li><a href="mailto:info@aipalyazo.hu">info@aipalyazo.hu</a></li></ul></div>
      <div><h4>Jogi</h4><ul><li><a href="${up}impresszum.html">Impresszum</a></li><li><a href="${up}adatvedelem.html">Adatkezelés</a></li><li><a href="${up}aszf.html">ÁSZF</a></li></ul></div>
    </div>
    <div class="legal"><span>© 2026 AIpályázó · Széphelyi Olivér Soma egyéni vállalkozó</span><span>Nem használunk követő sütiket.</span></div>
  </div>
</footer>
<script src="${up}lib/attribution.js"></script>
<script src="${up}assets/site.js" defer></script>
<script src="${up}assets/analytics.js" defer></script>
</body>
</html>
`;
}

const TAG_HU = {
  consortium: 'Nemzetközi konzorcium szükséges (partnerek más országokból)', women_led: 'Nők által alapított vagy vezetett cégeknek', youth_founder: 'Fiatal alapítóknak',
  jobseeker: 'Álláskeresők vállalkozásindításához', research_led: 'Kutatóhely (egyetem, kutatóintézet) a pályázó vagy a vezető partner', rnd_project: 'K+F / innovációs projekt a támogatás tárgya',
  deeptech: 'Mélytechnológiai (deep-tech) innováció', farmer: 'Mezőgazdasági termelőknek (pl. őstermelő, agrárvállalkozás)', fisheries: 'Halászati és akvakultúra-vállalkozásoknak', forestry: 'Erdőgazdálkodóknak',
  tourism_ntak: 'NTAK-regisztrált turisztikai szolgáltatóknak', restaurant: 'Vendéglátóhelyeknek', social_enterprise: 'Társadalmi vállalkozásoknak', cluster_manager: 'Csak akkreditált klasztermenedzsment-szervezeteknek',
  employer: 'Alkalmazottat foglalkoztató cégeknek', hires_disadvantaged: 'Célcsoportból (pl. fiatal, álláskereső) felvett munkavállaló bérére', bank_loan: 'Bankon vagy hitelközvetítőn keresztül, hitelbírálattal',
};
function requiresHtml(g) {
  const r = g.requires || {}, ev = g.requiresEvidence || {};
  const items = [];
  for (const [k, v] of Object.entries(r)) {
    let label = TAG_HU[k];
    if (k === 'startup_max_years') label = `Legfeljebb ${Number(v)} éves cégeknek`;
    if (k === 'min_revenue_huf') label = `Legalább ${Number(v) >= 1e9 ? Number(v) / 1e9 + ' Mrd' : Math.round(Number(v) / 1e6) + ' M'} Ft éves árbevétel`;
    if (!label || v === false) continue;
    items.push(`<li><b>${esc(label)}</b>${ev[k] ? `<span>„${esc(ev[k])}”</span>` : ''}</li>`);
  }
  if (g.scope === 'eu' && g.singleApplicant === false && !r.consortium) items.unshift(`<li><b>${esc(TAG_HU.consortium)}</b></li>`);
  const size = (g.sizeClasses || []).length ? `<li><b>Cégméret: ${esc(g.sizeClasses.join(', '))}</b></li>` : '';
  const region = (g.regions || []).length ? `<li><b>Csak ezekben a régiókban: ${esc(g.regions.join(', '))}</b></li>` : '';
  const all = size + region + items.join('');
  return all ? `<h2>Ki pályázhat?</h2><ul class="req">${all}</ul>` : '';
}

const CHANGE_HU = { new: 'Felkerült a listára', deadline: 'Határidő módosult', keret: 'A keretösszeg módosult', 'szabad-keret': 'A szabad keret változott', removed: 'Lekerült a listáról', page: 'A hivatalos oldal tartalma változott', 'deadline-official': 'Új határidő a hivatalos oldalon' };
function changeValue(type, v) {
  if (v == null || v === '') return '';
  if (/keret/.test(type) && typeof v === 'number') return ft(v);
  if (isDate(v)) return huDate(v);
  return String(v);
}
function changesHtml(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const rows = [...list].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 12).map((c) => {
    const what = CHANGE_HU[c.type] || 'Változás';
    const detail = c.from != null || c.to != null ? `: ${esc(changeValue(c.type, c.from) || '—')} → ${esc(changeValue(c.type, c.to) || '—')}` : '';
    return `<li><time datetime="${esc(c.date)}">${esc(huDate(c.date) || c.date)}</time><span>${esc(what)}${detail}</span></li>`;
  }).join('');
  return `<h2>Mi változott?</h2><ul class="log">${rows}</ul>`;
}

function factsRows(g) {
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<tr><th scope="row">${k}</th><td>${v}</td></tr>`); };
  add('Kiíró', esc(g.issuer));
  add('Felhívás kódja', g.code ? `<span class="mono">${esc(g.code)}</span>` : '');
  add('Támogatás formája', esc(TYPE_HU[g.type] || g.type || ''));
  add('Kategória', esc(g.cat));
  add('Összeg', esc(g.amount));
  add('Támogatási arány / feltétel', g.rate ? esc(g.rate) : '');
  if (g.keret > 0) add('Teljes keret', `<span class="num">${esc(ft(g.keret))}</span>` + (g.remaining >= 0 && g.remaining != null ? ` · még szabad: <b class="num">${esc(ft(g.remaining))}</b> (hivatalos adat)` : ''));
  add('Beadási határidő', `<b class="mono">${esc(deadlineHu(g))}</b>`);
  if (isDate(g.windowOpen)) add('Beadás kezdete', esc(huDate(g.windowOpen)));
  add('Cégméret', (g.sizeClasses || []).length ? esc(g.sizeClasses.join(', ')) : '');
  add('Régió', (g.regions || []).length ? esc(g.regions.join(', ')) : (g.scope === 'eu' ? 'EU-s program — magyar cégek is pályázhatnak' : 'Országos'));
  if (g.regionNote) add('Régió megjegyzés', esc(g.regionNote));
  if (g.scope === 'eu' && g.singleApplicant === false) add('Konzorcium', 'Jellemzően több ország partnereivel közösen (konzorciumban) lehet pályázni');
  const url = safeUrl(g.url);
  add('Hivatalos oldal', url ? `<a href="${esc(url)}" target="_blank" rel="noopener nofollow">${esc(g.source || hostOf(url))} ↗</a>` : '');
  return `<table class="facts">${rows.join('')}</table>`;
}

function hostOf(u) { try { return new URL(u).hostname || u; } catch { return u; } }

function summaryHtml(s) {
  if (!s || !Array.isArray(s.sections) || !s.sections.length) return '';
  return `<h2>A felhívás röviden</h2>
<div class="sum">${s.sections.map((sec) => `<h3>${esc(sec.title)}</h3><ul>${(sec.items || []).map((it) => `<li>${esc(it.text)}<span class="q">„${esc(it.quote)}”</span></li>`).join('')}</ul>`).join('')}</div>
<p class="muted small">Az összefoglalót mesterséges intelligencia készítette a <a href="${esc(safeUrl(s.sourceUrl))}" target="_blank" rel="noopener nofollow">hivatalos szövegből</a>; minden pont alatt ott a szó szerinti idézet, amire épül. Készült: ${esc(s.generatedAt || '')}.</p>`;
}

const HU_MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
const longDate = (d) => isDate(d) ? `${d.slice(0, 4)}. ${HU_MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}.` : '';
export function metaDescription(g) {
  const t = `${Cards.brief(g)}${g.issuer ? ` Kiíró: ${g.issuer}.` : ''} Nézze meg ingyen, jogosult-e a cége.`;
  return clip(t, 160);
}
// cut at a word boundary
function clip(t, n) {
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1); const i = cut.lastIndexOf(' ');
  return (i > n * 0.6 ? cut.slice(0, i) : cut).replace(/[\s,;:.–-]+$/, '') + '…';
}
// <title>: what people search for first; long official titles are shortened (the H1 keeps the full title)
export function pageTitle(g) {
  const tail = ' | AIpályázó';
  const dl = isDate(g.deadline) ? ` – határidő ${huDate(g.deadline)}` : '';
  if ((g.title + ' – pályázat' + dl + tail).length <= 70) return `${g.title} – pályázat${dl}${tail}`;
  if ((g.title + dl + tail).length <= 75) return `${g.title}${dl}${tail}`;
  return clip(g.title, 60) + tail;
}

// Questions people (and AI assistants) ask about a call, answered only from the data we hold.
export function faqItems(g) {
  const out = [];
  const who = [g.note, (g.sizeClasses || []).length ? `Cégméret: ${g.sizeClasses.join(', ')}.` : '', (g.regions || []).length ? `Régió: ${g.regions.join(', ')}.` : (g.regionNote || '')].filter(Boolean).join(' ');
  if (who) out.push({ q: 'Ki pályázhat?', a: who });
  const money = [g.amount && `Összeg: ${g.amount}.`, g.rate && `Támogatási arány / kamat: ${g.rate}.`].filter(Boolean).join(' ');
  if (money) out.push({ q: 'Mennyi támogatás kapható?', a: money });
  const when = isDate(g.deadline)
    ? `A beadási határidő ${longDate(g.deadline)}${isDate(g.windowOpen) ? ` A beadás kezdete: ${longDate(g.windowOpen)}` : ''} A pontos időpontot és az esetleges módosításokat a hivatalos felhívás tartalmazza.`
    : 'Folyamatosan lehet beadni, amíg a keret ki nem merül vagy a kiíró le nem zárja.';
  out.push({ q: 'Mi a beadási határidő?', a: when });
  if (g.issuer || g.url) out.push({ q: 'Hol lehet beadni?', a: `A kiíró: ${g.issuer || g.source || 'lásd a hivatalos oldalt'}.${safeUrl(g.url) ? ` A hivatalos felhívás: ${safeUrl(g.url)}` : ''}`, html: `A kiíró: ${esc(g.issuer || g.source || 'lásd a hivatalos oldalt')}.${safeUrl(g.url) ? ` <a href="${esc(safeUrl(g.url))}" rel="noopener" target="_blank">A hivatalos felhívás megnyitása ↗</a>` : ''}` });
  return out;
}
function faqHtml(items) {
  if (!items.length) return '';
  return `<h2>Gyakori kérdések</h2><dl class="faq-list">${items.map((x) => `<dt>${esc(x.q)}</dt><dd>${x.html || esc(x.a)}</dd>`).join('')}</dl>`;
}
function relatedHtml(related, prefix = '') {
  if (!related || !related.length) return '';
  return `<h2>Hasonló felhívások</h2><ul class="related">${related.map((r) => `<li><a href="${esc(prefix + r.slug)}.html">${esc(r.title)}</a>${isDate(r.deadline) ? ` <span class="muted">· határidő ${esc(huDate(r.deadline))}</span>` : ''}</li>`).join('')}</ul>`;
}

export function renderPage(g, slug, summary, { updatedAt, changes, related } = {}) {
  const canonical = `${BASE}/palyazat/${slug}.html`;
  const portal = `../portal.html?grant=${encodeURIComponent(g.id)}`;
  const checked = g.lastChecked || g.verifiedAt || (g.modified ? String(g.modified).slice(0, 10) : '') || updatedAt || '';
  const tags = [
    `<span class="tag brand">${g.scope === 'eu' ? 'EU / nemzetközi' : 'Hazai'}</span>`,
    Cards.FIN_BADGE[Cards.finKind(g)] ? `<span class="tag fin">${esc(Cards.FIN_BADGE[Cards.finKind(g)])}</span>` : `<span class="tag">${esc(TYPE_HU[g.type] || g.type || 'Támogatás')}</span>`,
    isDate(g.deadline) ? `<span class="tag signal">Határidő: ${esc(huDate(g.deadline))}</span>` : '<span class="tag">Folyamatos beadás</span>',
  ].join('');
  const jsonld = [
    {
      '@context': 'https://schema.org', '@type': 'MonetaryGrant', name: g.title, url: canonical,
      description: metaDescription(g), funder: { '@type': 'Organization', name: g.issuer || g.source || '' },
      ...(safeUrl(g.url) ? { sameAs: safeUrl(g.url) } : {}),
    },
    ...(faqItems(g).length ? [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqItems(g).map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) }] : []),
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'AIpályázó', item: `${BASE}/index.html` },
        { '@type': 'ListItem', position: 2, name: 'Pályázatok', item: `${BASE}/palyazat/index.html` },
        { '@type': 'ListItem', position: 3, name: g.title, item: canonical },
      ],
    },
  ];
  const body = `<nav class="crumbs" aria-label="Morzsamenü"><a href="../index.html">AIpályázó</a> / <a href="index.html">Pályázatok</a></nav>
<header class="call-head">
<p class="eyebrow">${esc(g.code || g.issuer || '')}</p>
<h1>${esc(g.title)}</h1>
<div class="tags">${tags}</div>
<span class="stamp">Forrás: <b>${esc(g.source || 'hivatalos oldal')}</b> · ellenőrizve: ${esc(checked)}</span>
</header>
<div class="call-grid">
<div class="call-main">
<h2>Röviden</h2><p>${esc(Cards.brief(g))}</p>
${g.note ? `<h2>Kinek szól?</h2><p>${esc(g.note)}</p>` : ''}
${requiresHtml(g)}
${summaryHtml(summary)}
${changesHtml(changes)}
${faqHtml(faqItems(g))}
${relatedHtml(related)}
${guideLinksHtml(guidesFor(g), '../utmutato/')}
<div class="notice warn disclaimer">Tájékoztató összefoglaló. Mindig a hivatalos felhívás és annak módosításai az irányadók — beadás előtt ellenőrizze a kiíró oldalán.</div>
</div>
<aside class="call-side" aria-label="Alapadatok">
${factsRows(g)}
<div class="side-box">
<h2>Jogosult erre a cége?</h2>
<p>Pontonként összevetjük a feltételeket a cége adataival (méret, régió, TEÁOR, működési idő, köztartozás), és megmutatjuk, mi hiányzik. Ingyenes. Kérésre pályázatíró partnerünk díjmentesen felveszi Önnel a kapcsolatot.</p>
<a class="btn btn-primary" href="${esc(portal)}">Megnézem a portálon</a>
<a class="btn btn-ghost" href="../index.html#ellenorzes">Gyors ellenőrzés regisztráció nélkül</a>
</div>
</aside>
</div>`;
  return shell({ title: pageTitle(g), description: metaDescription(g), canonical, noindex: false, body, jsonld });
}

export function renderClosed(m, slug) {
  const canonical = `${BASE}/palyazat/${slug}.html`;
  const body = `<nav class="crumbs" aria-label="Morzsamenü"><a href="../index.html">AIpályázó</a> / <a href="index.html">Pályázatok</a></nav>
<header class="call-head"><p class="eyebrow">Archív</p><h1>${esc(m.title)}</h1><div class="tags"><span class="tag danger">Lezárult vagy már nem elérhető</span></div></header>
<p class="page-intro">Ez a felhívás ${esc(m.closedAt || '')} óta nem szerepel a hivatalos forrásokban (lejárt, felfüggesztették vagy kimerült a kerete).</p>
<div class="side-box narrow"><h2>Nézze meg, mire pályázhat most</h2><p>Naponta frissülő listánkban a nyitott felhívásokat mutatjuk, a cége adataival pontonként összevetve.</p>
<a class="btn btn-primary" href="index.html">Nyitott pályázatok</a><a class="btn btn-ghost" href="../index.html#ellenorzes">Gyors ellenőrzés</a></div>`;
  return shell({ title: `${clip(m.title, 55)} – lezárult | AIpályázó`, description: `${m.title}: ez a felhívás lezárult. Nézze meg a nyitott pályázatokat.`, canonical, noindex: true, body });
}


// ---- topic hub pages (SEO) ---------------------------------------------
// palyazat/tema/<slug>.html — one page per programme family, company type,
// support form and region, generated from the feed. A hub is written only
// when it has at least MIN_HUB open calls. Intros are plain facts.
export const MIN_HUB = 2;
const txt = (g) => `${g.title || ''} ${g.note || ''}`;
const has = (g, k) => !!(g.requires && g.requires[k]);
const code = (g) => `${g.code || ''} ${g.id || ''}`;
const sizes = (g) => (g.sizeClasses || []).map((x) => String(x).toLowerCase());
const isEic = (g) => /\bEIC\b/.test(`${g.issuer || ''} ${g.title || ''}`) || /-eic-/i.test(g.id || '');
const REGIONS = ['Budapest', 'Pest', 'Közép-Dunántúl', 'Nyugat-Dunántúl', 'Dél-Dunántúl', 'Észak-Magyarország', 'Észak-Alföld', 'Dél-Alföld'];

export const HUBS = [
  // programme families
  { slug: 'ginop-plusz', group: 'Programok', name: 'GINOP Plusz', h1: 'GINOP Plusz pályázatok és hitelek', intro: 'A Gazdaságfejlesztési és Innovációs Operatív Program Plusz (GINOP Plusz) a Széchenyi Terv Plusz vállalkozásfejlesztési, innovációs és foglalkoztatási programja.', test: (g) => /GINOP/i.test(code(g)) },
  { slug: 'dimop-plusz', group: 'Programok', name: 'DIMOP Plusz', h1: 'DIMOP Plusz pályázatok és hitelek', intro: 'A Digitális Megújulás Operatív Program Plusz (DIMOP Plusz) a vállalkozások digitalizációját és a digitális startupokat támogatja.', test: (g) => /DIMOP/i.test(code(g)) },
  { slug: 'kehop-plusz', group: 'Programok', name: 'KEHOP Plusz', h1: 'KEHOP Plusz pályázatok és hitelek vállalkozásoknak', intro: 'A Környezeti és Energiahatékonysági Operatív Program Plusz (KEHOP Plusz) energiahatékonysági, megújulóenergia- és geotermikus fejlesztéseket finanszíroz.', test: (g) => /KEHOP/i.test(code(g)) },
  { slug: 'mahop-plusz', group: 'Programok', name: 'MAHOP Plusz', h1: 'MAHOP Plusz halászati és akvakultúra pályázatok', intro: 'A Magyar Akvakultúra és Halászati Operatív Program Plusz (MAHOP Plusz) az akvakultúra, a halfeldolgozás és a természetesvízi halgazdálkodás fejlesztését támogatja.', test: (g) => /MAHOP/i.test(code(g)) },
  { slug: 'kap', group: 'Programok', name: 'KAP Stratégiai Terv', h1: 'KAP Stratégiai Terv pályázatok (agrár és vidékfejlesztés)', intro: 'A Közös Agrárpolitika (KAP) Stratégiai Terv vidékfejlesztési felhívásait a KAP Nemzeti Irányító Hatóság hirdeti meg a kap.gov.hu oldalon.', test: (g) => /\bKAP-RD/i.test(code(g)) || /^KAP\b/.test(g.issuer || '') },
  { slug: 'horizon-europe', group: 'Programok', name: 'Horizon Europe', h1: 'Horizon Europe felhívások magyar vállalkozásoknak', intro: 'A Horizon Europe az EU kutatási és innovációs keretprogramja; a legtöbb témára nemzetközi konzorciumban lehet pályázni. Az EIC felhívásai külön oldalon szerepelnek.', test: (g) => g.scope === 'eu' && /Horizon/i.test(g.issuer || '') && !isEic(g) },
  { slug: 'eic', group: 'Programok', name: 'EIC', h1: 'Európai Innovációs Tanács (EIC) felhívások', intro: 'Az Európai Innovációs Tanács (EIC) mélytechnológiai startupokat és KKV-kat támogat vissza nem térítendő támogatással és tőkebefektetéssel; több felhívására egyetlen cég is pályázhat.', test: (g) => g.scope === 'eu' && isEic(g) },
  { slug: 'eu-egyeb-programok', group: 'Programok', name: 'Erasmus+ és egyéb EU-programok', h1: 'Erasmus+, Digital Europe, EIT és egyéb EU-s felhívások', intro: 'Az EU kutatási keretprogramján kívüli uniós felhívások: Erasmus+, Digital Europe, EIT-tudásközösségek, EU-s partnerségek, kaszkád (FSTP) felhívások és más nemzetközi programok.', test: (g) => g.scope === 'eu' && !/Horizon/i.test(g.issuer || '') && !isEic(g) },
  { slug: 'szechenyi-kartya', group: 'Programok', name: 'Széchenyi Kártya Program', h1: 'Széchenyi Kártya Program hitelei', intro: 'A Széchenyi Kártya Program kamattámogatott, kezességgel biztosított hiteleit a KAVOSZ ügyintézőinél, a partnerbankokon keresztül lehet igényelni.', test: (g) => /Széchenyi Kártya|KAVOSZ/i.test(g.issuer || '') },
  // company types
  { slug: 'egyeni-vallalkozo', group: 'Cégtípus', name: 'Egyéni vállalkozóknak', h1: 'Pályázatok és hitelek egyéni vállalkozóknak', intro: 'Azok a felhívások, amelyek kedvezményezettjei között a felhívás szövege kifejezetten említi az egyéni vállalkozókat (természetes személy mikrovállalkozókat).', test: (g) => sizes(g).includes('mikrovállalkozás természetes személy') || /egyéni vállalkoz/i.test(txt(g)) },
  { slug: 'mikrovallalkozas', group: 'Cégtípus', name: 'Mikrovállalkozásoknak', h1: 'Pályázatok és hitelek mikrovállalkozásoknak', intro: 'Azok a hazai felhívások, amelyekre mikrovállalkozás (10 főnél kevesebb foglalkoztatott, legfeljebb 2 millió eurós árbevétel vagy mérlegfőösszeg) is pályázhat.', test: (g) => g.scope !== 'eu' && sizes(g).some((x) => x.startsWith('mikro')) && !/mikro nem/i.test(g.note || '') },
  { slug: 'kkv', group: 'Cégtípus', name: 'KKV-knak', h1: 'Pályázatok és hitelek kis- és középvállalkozásoknak (KKV)', intro: 'Hazai felhívások, amelyekre mikro-, kis- vagy középvállalkozás pályázhat.', test: (g) => g.scope !== 'eu' && (sizes(g).some((x) => /mikro|kis|közép/.test(x)) || /\bKKV|kis- és középvállalkozás/i.test(txt(g))) },
  { slug: 'startup', group: 'Cégtípus', name: 'Induló vállalkozásoknak, startupoknak', h1: 'Pályázatok, tőke és hitel induló vállalkozásoknak és startupoknak', intro: 'Felhívások, amelyek szövege kifejezetten induló vállalkozásokat vagy startupokat nevez meg a kedvezményezettek között.', test: (g) => has(g, 'startup_max_years') || (/startup|induló/i.test(txt(g)) && g.singleApplicant !== false) },
  { slug: 'mezogazdasagi-termelo', group: 'Cégtípus', name: 'Mezőgazdasági termelőknek', h1: 'Pályázatok és hitelek mezőgazdasági termelőknek', intro: 'Mezőgazdasági termelőknek, őstermelőknek és agrárvállalkozásoknak szóló hazai felhívások és hitelek.', test: (g) => has(g, 'farmer') || sizes(g).includes('őstermelő') || (g.scope !== 'eu' && g.cat === 'Mezőgazdaság' && !has(g, 'forestry') && !has(g, 'fisheries')) },
  { slug: 'turisztikai-vallalkozas', group: 'Cégtípus', name: 'Turisztikai vállalkozásoknak', h1: 'Pályázatok és hitelek turisztikai és vendéglátó vállalkozásoknak', intro: 'Szálláshelyeknek, vendéglátóhelyeknek és más turisztikai szolgáltatóknak szóló hazai felhívások; több közülük NTAK-regisztrációhoz kötött.', test: (g) => has(g, 'tourism_ntak') || has(g, 'restaurant') || (g.scope !== 'eu' && g.cat === 'Turizmus') },
  // support forms
  { slug: 'vissza-nem-teritendo', group: 'Támogatási forma', name: 'Vissza nem térítendő támogatás', h1: 'Vissza nem térítendő támogatások vállalkozásoknak', intro: 'Felhívások, amelyekben a támogatás egésze vagy egy része vissza nem térítendő (a kombinált hitel + támogatás konstrukciókkal együtt).', test: (g) => /grant/.test(g.type || '') },
  { slug: 'hitel', group: 'Támogatási forma', name: 'Kedvezményes hitel', h1: 'Kedvezményes hitelek és lízing vállalkozásoknak', intro: 'Kamattámogatott vagy kedvezményes kamatozású hitelek, lízing és kombinált hiteltermékek.', test: (g) => /loan/.test(g.type || '') },
  { slug: 'toke', group: 'Támogatási forma', name: 'Tőkebefektetés', h1: 'Kockázati tőke és tőkebefektetési programok', intro: 'Állami és uniós tőkeprogramok, amelyekben a befektető részesedést szerez a vállalkozásban.', test: (g) => /equity/.test(g.type || '') },
  { slug: 'garancia', group: 'Támogatási forma', name: 'Garancia, kezesség', h1: 'Hitelgarancia és kezességvállalás vállalkozásoknak', intro: 'Intézményi kezességvállalás és uniós garanciaprogramok banki hitelekhez, lízinghez, bankgaranciához.', test: (g) => g.type === 'guarantee' },
  // regions (only calls restricted to a set of regions)
  ...REGIONS.map((r) => ({
    slug: 'regio-' + r.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    group: 'Régió', name: r, h1: `Régiós pályázatok és hitelek: ${r}`,
    intro: `Azok a felhívások, amelyek csak meghatározott régiókban megvalósuló fejlesztést támogatnak, és ezek között szerepel ${r === 'Budapest' || r === 'Pest' ? r : `a(z) ${r} régió`}. Az országos felhívások az összes pályázat listáján találhatók.`,
    test: (g) => (g.regions || []).includes(r),
  })),
];

export function selectHubs(open) {
  return HUBS.map((h) => ({ ...h, items: open.filter((g) => { try { return h.test(g); } catch { return false; } }) }))
    .filter((h) => h.items.length >= MIN_HUB);
}

const byDeadline = (a, b) => {
  const da = isDate(a.deadline) ? a.deadline : '9999', db = isDate(b.deadline) ? b.deadline : '9999';
  return da.localeCompare(db) || a.title.localeCompare(b.title, 'hu');
};

function regRow(g, href, withSearch) {
  const data = withSearch ? ` data-s="${esc(`${g.title} ${g.code || ''} ${g.issuer || ''} ${g.cat || ''} ${g.note || ''} ${g.amount || ''} ${(g.regions || []).join(' ')}`.toLowerCase())}" data-scope="${g.scope === 'eu' ? 'eu' : 'hu'}" data-type="${esc(g.type || '')}"` : '';
  const today = todayHU();
  return `<article class="gcard${Cards.cardClass(g)}"${data}><div class="gc-head">${Cards.srcTag(g)}<div class="gc-main"><a class="gc-title" href="${esc(href)}">${esc(g.title)}</a><div class="gc-sub">${esc([g.code, g.issuer].filter(Boolean).join(' · '))}</div><div class="badges">${Cards.badges(g, { today })}</div></div><div class="gc-side"><div><div class="gc-amt-label">${esc(Cards.amountLabel(g))}</div><div class="gc-amt">${esc(g.amount || '—')}</div>${Cards.rateLine(g)}</div></div></div>${Cards.bars(g, { today })}</article>`;
}

// "2026. október 13-i" (1 → "1-jei")
function asOfDate(d) {
  if (!isDate(d)) return '';
  const day = +d.slice(8, 10);
  return `${d.slice(0, 4)}. ${HU_MONTHS[+d.slice(5, 7) - 1]} ${day}-${day === 1 ? 'jei' : 'i'}`;
}

export function renderHub(hub, slugs, { updatedAt } = {}) {
  const canonical = `${BASE}/palyazat/tema/${hub.slug}.html`;
  const items = [...hub.items].sort(byDeadline);

  const nGrant = items.filter((g) => /grant|wage/.test(g.type || '')).length, nLoan = items.filter((g) => /loan|guarantee/.test(g.type || '')).length;
  const nextDl = items.map((g) => g.deadline).filter(isDate).sort()[0];
  const asOf = updatedAt ? asOfDate(String(updatedAt).slice(0, 10)) : '';
  const stats = `${asOf ? asOf + ' állapot szerint ' : 'Jelenleg '}${items.length} nyitott felhívás tartozik ide${nGrant || nLoan ? ` (${[nGrant && nGrant + ' vissza nem térítendő támogatás', nLoan && nLoan + ' hitel vagy garancia'].filter(Boolean).join(', ')})` : ''}${nextDl ? `; a legközelebbi határidő ${longDate(nextDl)}` : '.'}`;
  const intro = `${stats} ${hub.intro} A lista naponta frissül hivatalos forrásokból.`;
  const body = `<nav class="crumbs" aria-label="Morzsamenü"><a href="../../index.html">AIpályázó</a> / <a href="../index.html">Pályázatok</a> / ${esc(hub.group)}</nav>
<header class="call-head"><p class="eyebrow">${esc(hub.group)}</p><h1>${esc(hub.h1)}</h1><p class="page-intro intro">${esc(intro)}</p></header>
<div class="gcards hub-list">${items.map((g) => regRow(g, '../' + slugs.get(g.id) + '.html')).join('')}</div>
<p class="back-link"><a href="../index.html">← Összes nyitott pályázat</a></p>
<div class="notice warn end-note">Tájékoztató lista. Mindig a hivatalos felhívás és annak módosításai az irányadók.</div>`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: hub.h1, url: canonical, description: hub.intro, inLanguage: 'hu',
    isPartOf: { '@type': 'WebSite', name: 'AIpályázó', url: `${BASE}/index.html` },
    mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.map((g, i) => ({ '@type': 'ListItem', position: i + 1, url: `${BASE}/palyazat/${slugs.get(g.id)}.html`, name: g.title })) },
  };
  const description = clip(`${stats} ${hub.intro}`, 160);
  const year = String(updatedAt || new Date().toISOString()).slice(0, 4);
  const title = hub.h1.length <= 50 ? `${hub.h1} – ${items.length} nyitott | AIpályázó` : (/(nak|nek)$/.test(hub.name) ? `Pályázatok ${/^[A-ZÁÉÍÓÖŐÚÜŰ]{2}/.test(hub.name) ? hub.name : hub.name.charAt(0).toLowerCase() + hub.name.slice(1)} ${year}` : `${hub.name} pályázatok ${year}`) + ` – ${items.length} nyitott | AIpályázó`;
  return shell({ title, description, canonical, noindex: false, body, jsonld, depth: 2 });
}

export function hubLinks(hubs) {
  if (!hubs || !hubs.length) return '';
  const groups = [...new Set(hubs.map((h) => h.group))];
  return `<nav class="hubs" id="temak" aria-label="Témák">${groups.map((gr) => `<h2>${esc(gr)}</h2><ul class="hub-links">${hubs.filter((h) => h.group === gr).map((h) => `<li><a href="tema/${esc(h.slug)}.html">${esc(h.name)}</a> <span class="n">(${h.items.length})</span></li>`).join('')}</ul>`).join('')}</nav>`;
}

export function renderIndex(open, slugs, { updatedAt, hubs = [] } = {}) {
  const sorted = [...open].sort(byDeadline);
  const hu = sorted.filter((g) => g.scope !== 'eu'), eu = sorted.filter((g) => g.scope === 'eu');
  const row = (g) => regRow(g, slugs.get(g.id) + '.html', true);
  const body = `<nav class="crumbs" aria-label="Morzsamenü"><a href="../index.html">AIpályázó</a> / Pályázatok</nav>
<header class="call-head"><p class="eyebrow">Naponta frissítve${updatedAt ? ' · ' + esc(String(updatedAt).slice(0, 10)) : ''}</p>
<h1>Nyitott pályázatok magyar vállalkozásoknak</h1>
<p class="page-intro">${open.length} nyitott felhívás — ${hu.length} hazai és ${eu.length} EU-s / nemzetközi. Csak olyan kiírások, amelyekre vállalkozás pályázhat, és amelyek határideje még nem járt le. Mi változott a héten? <a href="../hirek/index.html">Heti összefoglaló</a>.</p></header>
<div class="bigsearch"><h2>Mire keres támogatást?</h2><form role="search" data-nosubmit><div class="inp"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><label class="visually-hidden" for="q">Keresés a pályázatok között</label>
<input id="q" type="search" placeholder="Pl. energia, gép, digitalizáció, GINOP, turizmus…" autocomplete="off"></div></form>
<div class="filters" role="group" aria-label="Szűrés">
<button type="button" data-f="all" aria-pressed="true">Mind</button>
<button type="button" data-f="hu" aria-pressed="false">Hazai</button>
<button type="button" data-f="eu" aria-pressed="false">EU-s</button>
<button type="button" data-f="grant" aria-pressed="false">Vissza nem térítendő</button>
<button type="button" data-f="loan" aria-pressed="false">Hitel</button>
</div></div>
<div class="list-head"><h2>Hazai pályázatok és hitelek</h2><span class="count" data-count="hu">${hu.length}</span></div>
<div class="gcards list" data-list="hu">${hu.map(row).join('')}</div>
<div class="list-head"><h2>EU-s és nemzetközi</h2><span class="count" data-count="eu">${eu.length}</span></div>
<div class="gcards list" data-list="eu">${eu.map(row).join('')}</div>
<p class="empty-note" id="empty" hidden>Nincs találat. Próbáljon rövidebb keresőszót.</p>
${hubLinks(hubs)}
<div class="side-box narrow"><h2>Melyikre jogosult a cége?</h2><p>Négy adat alapján azonnal megmutatjuk, regisztráció nélkül.</p><a class="btn btn-primary" href="../index.html#ellenorzes">Gyors ellenőrzés</a></div>
<script src="../lib/search.js"></script>
<script src="../assets/list-filter.js" defer></script>`;
  const jsonld = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Nyitott pályázatok magyar vállalkozásoknak', url: `${BASE}/palyazat/index.html` };
  return shell({ title: 'Nyitott pályázatok vállalkozásoknak (hazai és EU) — naponta frissítve | AIpályázó', description: `${open.length} nyitott hazai és EU-s pályázat, hitel és tőkeprogram magyar cégeknek, naponta frissítve hivatalos forrásokból. Ingyenes illeszkedés-vizsgálat.`, canonical: `${BASE}/palyazat/index.html`, noindex: false, body, jsonld });
}

// ---- evergreen guides (utmutato/) -----------------------------------------
export { GUIDES };
const GUIDE_BY_SLUG = new Map(GUIDES.map((x) => [x.slug, x]));
// 2–3 guides that fit a call: how-to always, then size / EU / loan / de minimis.
export function guidesFor(g) {
  const out = ['hogyan-palyazzunk'];
  if (g.scope === 'eu') out.push('eu-palyazatok-magyar-cegeknek');
  else if ((g.sizeClasses || []).length) out.push('kkv-minosites');
  if (/Széchenyi|KAVOSZ/i.test(`${g.title || ''} ${g.issuer || ''}`) && /loan/.test(g.type || '')) out.push('szechenyi-mikrohitel-max');
  if (/loan|guarantee/.test(g.type || '')) out.push('vissza-nem-teritendo-vagy-hitel');
  else if (g.scope !== 'eu' && /de minimis/i.test(`${g.rate || ''} ${g.note || ''} ${g.amount || ''}`)) out.push('de-minimis-tamogatas');
  return out.filter((s) => GUIDE_BY_SLUG.has(s)).slice(0, 3).map((s) => GUIDE_BY_SLUG.get(s));
}
export function guideLinksHtml(list, prefix = '') {
  if (!list || !list.length) return '';
  return `<h2>Hasznos útmutatók</h2><ul class="related">${list.map((x) => `<li><a href="${esc(prefix + x.slug)}.html">${esc(x.title)}</a></li>`).join('')}</ul>`;
}

export function renderGuide(guide, { open = [], hubs = [], today } = {}) {
  const canonical = `${BASE}/utmutato/${guide.slug}.html`;
  const hubSet = new Set(hubs.map((h) => h.slug));
  const link = (slug, text) => (hubSet.has(slug) ? `<a href="../palyazat/tema/${esc(slug)}.html">${esc(text)}</a>` : esc(text));
  let live = '';
  try { live = guide.live ? guide.live(open, link) : ''; } catch { live = ''; }
  const others = GUIDES.filter((x) => x.slug !== guide.slug);
  const jsonld = [
    {
      '@context': 'https://schema.org', '@type': 'Article', headline: guide.title, description: guide.description,
      url: canonical, mainEntityOfPage: canonical, inLanguage: 'hu', datePublished: guide.updated, dateModified: guide.updated,
      image: `${BASE}/assets/og.png`,
      author: { '@type': 'Organization', name: 'AIpályázó', url: `${BASE}/index.html` },
      publisher: { '@type': 'Organization', name: 'AIpályázó', url: `${BASE}/index.html`, logo: { '@type': 'ImageObject', url: `${BASE}/assets/og.png` } },
      citation: guide.sources.map(([name, url]) => ({ '@type': 'CreativeWork', name, url })),
    },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: guide.faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'AIpályázó', item: `${BASE}/index.html` },
        { '@type': 'ListItem', position: 2, name: 'Útmutatók', item: `${BASE}/utmutato/index.html` },
        { '@type': 'ListItem', position: 3, name: guide.title, item: canonical },
      ],
    },
  ];
  const body = `<nav class="crumbs" aria-label="Morzsamenü"><a href="../index.html">AIpályázó</a> / <a href="index.html">Útmutatók</a></nav>
<article class="guide">
<header class="call-head"><p class="eyebrow">Útmutató · Frissítve: <time datetime="${esc(guide.updated)}">${esc(longDate(guide.updated))}</time></p>
<h1>${esc(guide.title)}</h1>
<p class="page-intro lead">${esc(guide.lead)}</p></header>
${live ? `<div class="notice ok live"><b>Mai adatok${today ? ` (${esc(longDate(today))})` : ''}:</b> ${live}</div>` : ''}
${guide.sections.map((x) => `<section><h2>${esc(x.h)}</h2>${x.html}</section>`).join('\n')}
${faqHtml(guide.faq)}
<h2>Források</h2><ul class="sources">${guide.sources.map(([name, url]) => `<li><a href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(name)} ↗</a></li>`).join('')}</ul>
<div class="side-box narrow"><h2>Melyik felhívásra jogosult a cége?</h2><p>Négy adat alapján azonnal megmutatjuk a nyitott felhívások közül, regisztráció nélkül.</p><a class="btn btn-primary" href="../index.html#ellenorzes">Gyors ellenőrzés</a> <a class="btn btn-ghost" href="../palyazat/index.html">Összes nyitott pályázat</a></div>
${guideLinksHtml(others).replace('Hasznos útmutatók', 'További útmutatók')}
<p class="notice warn disclaimer">Általános tájékoztatás, nem jogi vagy pénzügyi tanácsadás. Egy adott pályázatnál mindig a hivatalos felhívás és a hatályos jogszabályok az irányadók.</p>
</article>`;
  return shell({ title: `${guide.seoTitle || clip(guide.title, 58)} | AIpályázó`, description: clip(guide.description, 160), canonical, noindex: false, body, jsonld, current: 'utmutato', ogType: 'article' });
}

export function renderGuidesIndex() {
  const canonical = `${BASE}/utmutato/index.html`;
  const body = `<nav class="crumbs" aria-label="Morzsamenü"><a href="../index.html">AIpályázó</a> / Útmutatók</nav>
<header class="call-head"><p class="eyebrow">Útmutatók</p><h1>Pályázati útmutatók vállalkozásoknak</h1>
<p class="page-intro">Rövid, forrásokkal ellátott válaszok a leggyakoribb kérdésekre: cégméret, de minimis, támogatás vagy hitel, a beadás lépései és az EU-s pályázatok.</p></header>
<ul class="guide-list">${GUIDES.map((x) => `<li><a href="${esc(x.slug)}.html">${esc(x.title)}</a><p>${esc(x.description)}</p></li>`).join('')}</ul>
<div class="side-box narrow"><h2>Melyik felhívásra jogosult a cége?</h2><p>Négy adat alapján azonnal megmutatjuk, regisztráció nélkül.</p><a class="btn btn-primary" href="../index.html#ellenorzes">Gyors ellenőrzés</a></div>`;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Pályázati útmutatók vállalkozásoknak', url: canonical, inLanguage: 'hu',
      hasPart: GUIDES.map((x) => ({ '@type': 'Article', headline: x.title, url: `${BASE}/utmutato/${x.slug}.html` })) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'AIpályázó', item: `${BASE}/index.html` },
      { '@type': 'ListItem', position: 2, name: 'Útmutatók', item: canonical },
    ] },
  ];
  return shell({ title: 'Pályázati útmutatók: KKV, de minimis, hitel, beadás, EU | AIpályázó', description: 'Rövid, forrásokkal ellátott útmutatók magyar vállalkozásoknak: KKV-minősítés, de minimis keret, támogatás vagy hitel, a pályázás lépései, EU-s pályázatok.', canonical, noindex: false, body, jsonld, current: 'utmutato' });
}

// ---- weekly news (hirek/) ---------------------------------------------------
// Built only from changes.json (kept 12 months), so every week page can be
// regenerated any day. Starts on NEWS_START: earlier "new" entries are the
// initial import and source clean-ups, not real news.
export const NEWS_START = '2026-10-12';
export const PREFERRED_SOURCE_URL = 'https://www.google.com/preferences/source?q=aipalyazo.hu';
const NEWS_TYPES = new Set(['new', 'deadline', 'keret', 'szabad-keret']); // deadline-official is an internal review flag, not news
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const mondayOf = (d) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
export function weekRange(mon) {
  const sun = addDays(mon, 6);
  const [y1, m1, d1] = [mon.slice(0, 4), +mon.slice(5, 7), +mon.slice(8, 10)];
  const [y2, m2, d2] = [sun.slice(0, 4), +sun.slice(5, 7), +sun.slice(8, 10)];
  if (y1 !== y2) return `${y1}. ${HU_MONTHS[m1 - 1]} ${d1}. – ${y2}. ${HU_MONTHS[m2 - 1]} ${d2}.`;
  if (m1 !== m2) return `${y1}. ${HU_MONTHS[m1 - 1]} ${d1}. – ${HU_MONTHS[m2 - 1]} ${d2}.`;
  return `${y1}. ${HU_MONTHS[m1 - 1]} ${d1}–${d2}.`;
}
export function newsWeeks(today) {
  const out = [];
  const cutoff = addDays(today, -364);
  for (let m = mondayOf(NEWS_START); m <= today; m = addDays(m, 7)) if (addDays(m, 6) >= cutoff) out.push(m);
  return out.reverse();
}
// Entries of one week: [{ id, date, type, from, to, title }]
export function weekEntries(changes, mon) {
  const sun = addDays(mon, 6), out = [];
  for (const [id, list] of Object.entries(changes || {})) {
    if (!Array.isArray(list)) continue;
    const first = list.reduce((m, e) => (e && e.date && (!m || e.date < m) ? e.date : m), '');
    for (const e of list) {
      if (!e || !NEWS_TYPES.has(e.type) || e.date < mon || e.date > sun || e.date < NEWS_START) continue;
      // A call that drops out and comes back (source outage) is not news.
      if (e.type === 'new' && e.date > first) continue;
      out.push({ id, ...e });
    }
  }
  // Several moves of one value in a week (or a move and its undo) → one net change.
  const net = new Map();
  for (const e of out) {
    if (e.type === 'new') continue;
    const k = e.id + '|' + e.type, prev = net.get(k);
    net.set(k, prev ? { ...prev, from: (prev.date <= e.date ? prev : e).from, to: (prev.date <= e.date ? e : prev).to, date: prev.date > e.date ? prev.date : e.date } : e);
  }
  return [...out.filter((e) => e.type === 'new'), ...[...net.values()].filter((e) => String(e.from) !== String(e.to))].sort((a, b) => b.date.localeCompare(a.date) || String(a.id).localeCompare(String(b.id)));
}
const n0 = (n, word) => `${n} ${word}`;
function newsRow(e, ctx, prefix) {
  const g = ctx.byId.get(e.id) || {};
  const title = g.title || e.title || e.id;
  const slug = ctx.idToSlug.get(e.id);
  const name = slug ? `<a href="${prefix}palyazat/${esc(slug)}.html">${esc(title)}</a>` : esc(title);
  const meta = [g.issuer, isDate(g.deadline) ? `határidő: ${longDate(g.deadline)}` : (g.id ? 'folyamatos beadás' : ''), ctx.openIds.has(e.id) ? '' : 'azóta lezárult vagy lekerült'].filter(Boolean).map(esc).join(' · ');
  let what = '';
  if (e.type !== 'new') what = `${esc(CHANGE_HU[e.type] || 'Változás')}${e.from != null || e.to != null ? `: ${esc(changeValue(e.type, e.from) || '—')} → ${esc(changeValue(e.type, e.to) || '—')}` : ''}`;
  return `<li>${name}${what ? `<br><span>${what}</span>` : ''}${meta ? `<br><span class="muted">${meta}</span>` : ''}</li>`;
}
function weekStats(entries, byId) {
  const fresh = entries.filter((e) => e.type === 'new');
  const eu = fresh.filter((e) => (byId.get(e.id) || {}).scope === 'eu').length;
  return { fresh, hu: fresh.length - eu, eu, deadlines: entries.filter((e) => /deadline/.test(e.type)).length, keret: entries.filter((e) => /keret/.test(e.type)).length };
}
const prefBtn = (prefix) => `<div class="side-box narrow"><h2>Kövesse a változásokat</h2><p>Minden héten összefoglaljuk, mely felhívások kerültek fel, és mi módosult. Ha a Google-ben előnyben részesített forrásként jelöli meg az AIpályázó-t, a keresőben gyakrabban látja a híreinket.</p><a class="btn btn-primary" href="${PREFERRED_SOURCE_URL}" target="_blank" rel="noopener">Hozzáadás a Google-ben ↗</a> <a class="btn btn-ghost" href="${prefix}hirek/rss.xml">RSS-hírcsatorna</a></div>`;

export function renderWeek(mon, { changes, byId, idToSlug, openIds, open = [], today }) {
  const sun = addDays(mon, 6), current = today >= mon && today <= sun;
  const canonical = `${BASE}/hirek/het-${mon}.html`;
  const entries = weekEntries(changes, mon);
  const st = weekStats(entries, byId);
  const ctx = { byId, idToSlug, openIds };
  const range = weekRange(mon);
  const until = current ? ` (${longDate(today).replace(/\.$/, '')}-i állapot)` : '';
  const lead = st.fresh.length || st.deadlines || st.keret
    ? `${range} között ${st.fresh.length} új felhívás került fel a listánkra (${[st.hu && `${st.hu} hazai`, st.eu && `${st.eu} EU-s / nemzetközi`].filter(Boolean).join(', ')})${st.deadlines ? `, ${st.deadlines} felhívás határideje módosult` : ''}${st.keret ? `, ${st.keret} felhívás kerete változott` : ''}.${until}`
    : `${range} között nem került fel új felhívás, és nem módosult határidő.${until}`;
  const list = (h, arr) => (arr.length ? `<h2>${h} <span class="count">${arr.length}</span></h2><ul class="news-list">${arr.map((e) => newsRow(e, ctx, '../')).join('')}</ul>` : '');
  const huNew = st.fresh.filter((e) => (byId.get(e.id) || {}).scope !== 'eu');
  const euNew = st.fresh.filter((e) => (byId.get(e.id) || {}).scope === 'eu');
  const soon = current ? open.filter((g) => isDate(g.deadline) && g.deadline >= today && g.deadline <= addDays(today, 14)).sort(byDeadline) : [];
  const soonHtml = soon.length ? `<h2>Hamarosan lejár (14 napon belül) <span class="count">${soon.length}</span></h2><ul class="news-list">${soon.map((g) => `<li><a href="../palyazat/${esc(idToSlug.get(g.id))}.html">${esc(g.title)}</a><br><span class="muted">${esc([g.issuer, 'határidő: ' + longDate(g.deadline)].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>` : '';
  const body = `<nav class="crumbs" aria-label="Morzsamenü"><a href="../index.html">AIpályázó</a> / <a href="index.html">Heti hírek</a></nav>
<article class="guide news">
<header class="call-head"><p class="eyebrow">Heti összefoglaló${current ? ' · folyamatosan frissül' : ''}</p>
<h1>Új pályázatok és változások: ${esc(range)}</h1>
<p class="page-intro lead">${esc(lead)}</p></header>
${list('Új hazai felhívások és hitelek', huNew)}
${list('Új EU-s és nemzetközi felhívások', euNew)}
${list('Határidő-módosítások', entries.filter((e) => /deadline/.test(e.type)))}
${list('Keretváltozások', entries.filter((e) => /keret/.test(e.type)))}
${soonHtml}
<p class="muted">Az „új” azt jelenti, hogy a felhívás ezen a héten került fel a listánkra; korábban is megjelenhetett a kiíró oldalán. Mindig a hivatalos felhívás az irányadó.</p>
${prefBtn('../')}
<p><a href="index.html">← Összes heti összefoglaló</a> · <a href="../palyazat/index.html">Összes nyitott pályázat</a></p>
</article>`;
  const modified = current ? today : sun;
  const jsonld = [
    {
      '@context': 'https://schema.org', '@type': 'NewsArticle', headline: `Új pályázatok és változások: ${range}`, description: clip(lead, 300),
      url: canonical, mainEntityOfPage: canonical, inLanguage: 'hu', datePublished: `${mon}T08:00:00+01:00`, dateModified: `${modified}T08:00:00+01:00`,
      image: [`${BASE}/assets/og.png`],
      author: { '@type': 'Organization', name: 'AIpályázó', url: `${BASE}/index.html` },
      publisher: { '@type': 'Organization', name: 'AIpályázó', url: `${BASE}/index.html`, logo: { '@type': 'ImageObject', url: `${BASE}/assets/og.png` } },
    },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'AIpályázó', item: `${BASE}/index.html` },
      { '@type': 'ListItem', position: 2, name: 'Heti hírek', item: `${BASE}/hirek/index.html` },
      { '@type': 'ListItem', position: 3, name: range, item: canonical },
    ] },
  ];
  const title = `Új pályázatok ${range} – ${st.fresh.length} új felhívás | AIpályázó`;
  return { html: shell({ title, description: clip(lead, 160), canonical, noindex: false, body, jsonld, current: 'hirek', ogType: 'article' }), stats: st, modified };
}

export function renderNewsIndex(weeks, statsByWeek, today) {
  const canonical = `${BASE}/hirek/index.html`;
  const latest = weeks[0];
  const s0 = latest && statsByWeek.get(latest);
  const body = `<nav class="crumbs" aria-label="Morzsamenü"><a href="../index.html">AIpályázó</a> / Heti hírek</nav>
<header class="call-head"><p class="eyebrow">Heti hírek · naponta frissül</p><h1>Pályázati hírek: új felhívások és változások hétről hétre</h1>
<p class="page-intro">Minden héten összefoglaljuk, mely pályázatok, hitelek és EU-s felhívások kerültek fel a listánkra, melyiknek módosult a határideje vagy a kerete, és mi jár le hamarosan.${s0 ? ` Ezen a héten eddig ${s0.fresh.length} új felhívás került fel.` : ''}</p></header>
<ul class="guide-list">${weeks.map((m) => { const st = statsByWeek.get(m); return `<li><a href="het-${m}.html">${esc(weekRange(m))}</a><p>${st.fresh.length} új felhívás${st.fresh.length ? ` (${[st.hu && `${st.hu} hazai`, st.eu && `${st.eu} EU-s`].filter(Boolean).join(', ')})` : ''}${st.deadlines ? ` · ${st.deadlines} határidő-módosítás` : ''}${st.keret ? ` · ${st.keret} keretváltozás` : ''}</p></li>`; }).join('')}</ul>
${prefBtn('../')}`;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Pályázati hírek hétről hétre', url: canonical, inLanguage: 'hu', dateModified: today,
      hasPart: weeks.map((m) => ({ '@type': 'NewsArticle', headline: `Új pályázatok és változások: ${weekRange(m)}`, url: `${BASE}/hirek/het-${m}.html` })) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'AIpályázó', item: `${BASE}/index.html` },
      { '@type': 'ListItem', position: 2, name: 'Heti hírek', item: canonical },
    ] },
  ];
  return shell({ title: 'Pályázati hírek hétről hétre: új felhívások, határidők | AIpályázó', description: 'Heti összefoglaló: új hazai és EU-s pályázatok, hitelek, határidő- és keretváltozások magyar vállalkozásoknak, naponta frissítve hivatalos forrásokból.', canonical, noindex: false, body, jsonld, current: 'hirek' });
}

const xmlEsc = (s) => esc(s).replace(/&#39;/g, '&apos;');
const rfc822 = (d) => new Date(d + 'T06:00:00Z').toUTCString();
export function buildRss({ changes, byId, idToSlug, openIds, today }) {
  const from = addDays(today, -30);
  const items = [];
  for (const [id, list] of Object.entries(changes || {})) {
    if (!openIds.has(id) || !idToSlug.has(id) || !Array.isArray(list)) continue;
    const first = list.reduce((m, e) => (e && e.date && (!m || e.date < m) ? e.date : m), '');
    for (const e of list) if (e.type === 'new' && e.date === first && e.date >= from && e.date >= NEWS_START) items.push({ id, date: e.date });
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const body = items.slice(0, 100).map(({ id, date }) => {
    const g = byId.get(id); const link = `${BASE}/palyazat/${idToSlug.get(id)}.html`;
    return `<item><title>${xmlEsc(g.title)}</title><link>${xmlEsc(link)}</link><guid isPermaLink="false">${xmlEsc(id)}#${date}</guid><pubDate>${rfc822(date)}</pubDate><description>${xmlEsc(Cards.brief(g))}</description></item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>AIpályázó – új pályázatok magyar vállalkozásoknak</title>
<link>${BASE}/hirek/index.html</link>
<atom:link href="${BASE}/hirek/rss.xml" rel="self" type="application/rss+xml"/>
<description>Újonnan listázott hazai és EU-s pályázatok, hitelek és tőkeprogramok, naponta frissítve hivatalos forrásokból.</description>
<language>hu</language>
<lastBuildDate>${rfc822(today)}</lastBuildDate>
${body}
</channel></rss>
`;
}

// ---- homepage pre-render ----------------------------------------------------
// The homepage figures and "Közelgő határidők" cards are filled by JS in the
// browser; crawlers and AI assistants that do not run JS saw "—" and an empty
// block. The daily build writes the same numbers into the HTML (same rules as
// assets/pages/index.js), and the script still refreshes them on load.
const isConsortium = (g) => !!((g.requires && g.requires.consortium) || (g.scope === 'eu' && g.singleApplicant === false));
const ftHome = (n) => (n >= 1e9 ? (n / 1e9).toFixed(0) + ' Mrd Ft' : Math.round(n / 1e6) + ' M Ft');
export function prerenderHome(html, { open, slugs, today, updatedAt }) {
  const dleft = (d) => (isDate(d) ? daysBetween(today, d) : null);
  const feed = open.filter((g) => { const d = dleft(g.deadline); return d === null || d >= 0; });
  const hu = feed.filter((g) => g.scope !== 'eu');
  const soon = feed.filter((g) => { const d = dleft(g.deadline); return d !== null && d <= 30; });
  const budget = hu.reduce((s, g) => s + (typeof g.remaining === 'number' && g.remaining > 0 ? g.remaining : 0), 0);
  const fig = { open: String(feed.length), hu: String(hu.length), soon: String(soon.length), budget: budget ? ftHome(budget) : '—' };
  let out = html;
  for (const [k, v] of Object.entries(fig)) out = out.replace(new RegExp(`(data-fig="${k}">)[^<]*(</div>)`), `$1${esc(v)}$2`);
  const items = feed.filter((g) => { const d = dleft(g.deadline); return d !== null && d <= 90 && !isConsortium(g); }).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const pick = [...items.filter((g) => g.scope !== 'eu').slice(0, 3), ...items.filter((g) => g.scope === 'eu').slice(0, 2)].sort((a, b) => a.deadline.localeCompare(b.deadline));
  const cards = pick.map((g) => regRow(g, slugs.get(g.id) ? `palyazat/${slugs.get(g.id)}.html` : `portal.html?grant=${encodeURIComponent(g.id)}`, false)).join('');
  out = out.replace(/(<div class="gcards" id="next-deadlines"[^>]*>)[\s\S]*?(<\/div>\s*<p style="text-align:center;margin-top:var\(--s5\)">)/, `$1${cards}$2`);
  out = out.replace(/(<p class="asof" data-asof>)[^<]*(<\/p>)/, `$1Frissítve: ${esc(longDate(today))} · Forrás: palyazat.gov.hu, EU Funding &amp; Tenders, kiírói oldalak$2`);
  return out;
}

export const STATIC_PAGES = [
  // onboarding.html / signup.html are app pages with noindex — never list them here.
  ['index.html', '1.0', 'weekly'], ['palyazat/index.html', '0.9', 'daily'],
  ['impresszum.html', '0.2', 'yearly'], ['adatvedelem.html', '0.2', 'yearly'], ['aszf.html', '0.2', 'yearly'],
];
export function buildSitemap(open, slugs, today, hubs = [], news = []) {
  const url = (loc, pri, freq, lastmod) => `  <url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>${freq}</changefreq><priority>${pri}</priority></url>`;
  const lines = STATIC_PAGES.map(([p, pri, f]) => url(`${BASE}/${p}`, pri, f, p === 'palyazat/index.html' ? today : ''));
  for (const g of open) {
    const lm = [g.lastChecked, g.verifiedAt, g.modified && String(g.modified).slice(0, 10)].filter(isDate).sort().pop();
    lines.push(url(`${BASE}/palyazat/${slugs.get(g.id)}.html`, '0.7', 'weekly', lm || ''));
  }
  for (const h of hubs) lines.push(url(`${BASE}/palyazat/tema/${h.slug}.html`, '0.6', 'daily', today));
  const newest = GUIDES.map((x) => x.updated).filter(isDate).sort().pop();
  lines.push(url(`${BASE}/utmutato/index.html`, '0.6', 'monthly', newest || ''));
  for (const x of GUIDES) lines.push(url(`${BASE}/utmutato/${x.slug}.html`, '0.6', 'monthly', isDate(x.updated) ? x.updated : ''));
  if (news.length) lines.push(url(`${BASE}/hirek/index.html`, '0.7', 'daily', today));
  for (const w of news) lines.push(url(`${BASE}/hirek/het-${w.mon}.html`, '0.5', w.modified === today ? 'daily' : 'yearly', w.modified));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}

// llms.txt (llmstxt.org): a short, plain map of the site for AI assistants and answer engines.
export function buildLlmsTxt({ open, hubs = [], today }) {
  const hub = (h) => `- [${h.h1}](${BASE}/palyazat/tema/${h.slug}.html): ${h.items.length} nyitott felhívás`;
  return `# AIpályázó

> Ingyenes, naponta frissülő pályázatfigyelő magyar vállalkozásoknak: nyitott hazai (Széchenyi Terv Plusz, KAP, MFB, NKFIH, Széchenyi Kártya) és EU-s (Horizon Europe, EIC, LIFE, Digital Europe stb.) felhívások hivatalos forrásból, a cég adataival pontról pontra összevetve.

- Állapot: ${today} — ${open} nyitott felhívás, amelyre vállalkozás pályázhat.
- Forrás: palyazat.gov.hu API, EU Funding & Tenders Portal, a kiírók hivatalos oldalai; minden felhívásnál feltüntetjük a forrást és az ellenőrzés napját.
- Lakossági, civil, önkormányzati és magánszemélyeknek szóló felhívások nem szerepelnek.
- Az adatok tájékoztató jellegűek; mindig a hivatalos felhívás az irányadó.
- Hivatkozáskor kérjük, a felhívás saját oldalára mutasson (palyazat/<felhívás>.html).

## Fő oldalak
- [Nyitott pályázatok listája](${BASE}/palyazat/index.html): minden nyitott felhívás határidő szerint, hazai és EU-s bontásban
- [Heti pályázati hírek](${BASE}/hirek/index.html): új felhívások, határidő- és keretváltozások hétről hétre (RSS: ${BASE}/hirek/rss.xml)
- [Gyors jogosultság-ellenőrzés](${BASE}/index.html#ellenorzes): 4 adat alapján, regisztráció nélkül
- [Oldaltérkép](${BASE}/sitemap.xml)

## Útmutatók (forrásokkal)
${GUIDES.map((x) => `- [${x.title}](${BASE}/utmutato/${x.slug}.html): ${x.description}`).join('\n')}

## Témák, programok, cégtípusok és régiók
${hubs.map(hub).join('\n')}

## Kapcsolat és jogi információk
- [Impresszum](${BASE}/impresszum.html) — Széphelyi Olivér Soma egyéni vállalkozó, info@aipalyazo.hu
- [Adatkezelési tájékoztató](${BASE}/adatvedelem.html)
`;
}

export const ROBOTS = `# Search engines and AI assistants (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot,
# Google-Extended, Applebot …) are welcome to read the public grant pages.
# See also https://aipalyazo.hu/llms.txt
User-agent: *
Allow: /
Disallow: /aipalyazo/portal.html
Disallow: /aipalyazo/login.html
Disallow: /aipalyazo/reset-password.html
Disallow: /aipalyazo/confirm-email.html
Disallow: /aipalyazo/leiratkozas.html
Disallow: /tenderpilot/

Sitemap: ${BASE}/sitemap.xml
`;

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Pure: returns { files: Map(relPath → content), manifest, removed: [relPath], stats }
export function buildAll({ grants, summaries = {}, manifest = {}, today, updatedAt, changes = {} }) {
  const open = grants.filter((g) => g && g.id && g.title && isOpen(g, today));
  const slugs = assignSlugs(open.map((g) => g.id), manifest);
  const files = new Map();
  const next = {};
  const openIds = new Set(open.map((g) => g.id));
  for (const g of open) {
    const slug = slugs.get(g.id);
    const prev = manifest[slug];
    next[slug] = { id: g.id, title: g.title, firstSeen: (prev && prev.firstSeen) || today, lastSeen: today };
    const related = open.filter((x) => x.id !== g.id && x.cat === g.cat && x.scope === g.scope).sort(byDeadline).slice(0, 5).map((x) => ({ slug: slugs.get(x.id), title: x.title, deadline: x.deadline }));
    files.set(`palyazat/${slug}.html`, renderPage(g, slug, summaries[g.id], { updatedAt, changes: changes[g.id], related }));
  }
  const removed = [];
  let closed = 0;
  for (const [slug, m] of Object.entries(manifest)) {
    if (next[slug] || openIds.has(m.id)) continue;
    const closedAt = m.closedAt || today;
    if (daysBetween(closedAt, today) > KEEP_CLOSED_DAYS) { removed.push(`palyazat/${slug}.html`); continue; }
    next[slug] = { ...m, closedAt };
    files.set(`palyazat/${slug}.html`, renderClosed(next[slug], slug));
    closed++;
  }
  const hubs = selectHubs(open);
  for (const h of hubs) files.set(`palyazat/tema/${h.slug}.html`, renderHub(h, slugs, { updatedAt }));
  files.set('palyazat/index.html', renderIndex(open, slugs, { updatedAt, hubs }));
  for (const x of GUIDES) files.set(`utmutato/${x.slug}.html`, renderGuide(x, { open, hubs, today }));
  files.set('utmutato/index.html', renderGuidesIndex());
  // weekly news
  const byId = new Map(grants.filter((g) => g && g.id).map((g) => [g.id, g]));
  const idToSlug = new Map(Object.entries(next).map(([slug, m]) => [m.id, slug]));
  const weeks = newsWeeks(today), statsByWeek = new Map(), news = [];
  for (const mon of weeks) {
    const r = renderWeek(mon, { changes, byId, idToSlug, openIds, open, today });
    files.set(`hirek/het-${mon}.html`, r.html); statsByWeek.set(mon, r.stats); news.push({ mon, modified: r.modified });
  }
  if (weeks.length) {
    files.set('hirek/index.html', renderNewsIndex(weeks, statsByWeek, today));
    files.set('hirek/rss.xml', buildRss({ changes, byId, idToSlug, openIds, today }));
  }
  files.set('sitemap.xml', buildSitemap(open, slugs, today, hubs, news));
  const sortedManifest = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  files.set('palyazat/pages.json', JSON.stringify(sortedManifest, null, 1) + '\n');
  return { files, manifest: sortedManifest, removed, stats: { open: open.length, hubs: hubs.length, guides: GUIDES.length, newsWeeks: weeks.length, closed, removed: removed.length, withSummary: open.filter((g) => summaries[g.id]).length } };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const site = join(root, 'aipalyazo');
  const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
  const grants = readJson(join(site, 'grants_live.json'), null);
  if (!Array.isArray(grants) || grants.length < 20) { console.error('build-pages: feed missing or too small — pages left untouched'); process.exit(0); }
  const summaries = readJson(join(site, 'summaries.json'), {});
  const meta = readJson(join(site, 'grants-meta.json'), {});
  const manifest = readJson(join(site, 'palyazat', 'pages.json'), {});
  const changes = readJson(join(site, 'changes.json'), {});
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  const { files, removed, stats } = buildAll({ grants, summaries, manifest, today, updatedAt: meta.updatedAt, changes });
  mkdirSync(join(site, 'palyazat', 'tema'), { recursive: true });
  mkdirSync(join(site, 'utmutato'), { recursive: true });
  mkdirSync(join(site, 'hirek'), { recursive: true });
  for (const [rel, content] of files) writeFileSync(join(site, rel), content);
  for (const rel of removed) { const p = join(site, rel); if (existsSync(p)) unlinkSync(p); }
  // Stray html files not in the manifest (e.g. hand-deleted manifest) are removed.
  const keep = new Set([...files.keys()].map((k) => k.replace(/^palyazat\//, '')));
  for (const f of readdirSync(join(site, 'palyazat'))) if (f.endsWith('.html') && !keep.has(f)) unlinkSync(join(site, 'palyazat', f));
  // Hubs that fell under the threshold today are removed (regenerated when back).
  for (const f of readdirSync(join(site, 'palyazat', 'tema'))) if (f.endsWith('.html') && !files.has(`palyazat/tema/${f}`)) unlinkSync(join(site, 'palyazat', 'tema', f));
  for (const f of readdirSync(join(site, 'utmutato'))) if (f.endsWith('.html') && !files.has(`utmutato/${f}`)) unlinkSync(join(site, 'utmutato', f));
  for (const f of readdirSync(join(site, 'hirek'))) if (/\.(html|xml)$/.test(f) && !files.has(`hirek/${f}`)) unlinkSync(join(site, 'hirek', f));
  {
    const homeP = join(site, 'index.html');
    const before = readFileSync(homeP, 'utf8');
    const openNow = grants.filter((g) => g && g.id && g.title && isOpen(g, today));
    const slugMap = new Map(Object.entries(JSON.parse(files.get('palyazat/pages.json'))).filter(([, m]) => !m.closedAt).map(([slug, m]) => [m.id, slug]));
    const after = prerenderHome(before, { open: openNow, slugs: slugMap, today, updatedAt: meta.updatedAt });
    if (after !== before) writeFileSync(homeP, after);
  }
  writeFileSync(join(root, 'robots.txt'), ROBOTS);
  writeFileSync(join(root, 'llms.txt'), buildLlmsTxt({ open: stats.open, hubs: selectHubs(grants.filter((g) => g && g.id && g.title && isOpen(g, today))), today }));
  console.log(`build-pages: ${stats.open} open pages (${stats.withSummary} with summary), ${stats.hubs} topic hubs, ${stats.guides} guides, ${stats.newsWeeks} news weeks, ${stats.closed} closed kept, ${stats.removed} removed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
