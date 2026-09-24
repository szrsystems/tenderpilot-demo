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

function shell({ title, description, canonical, noindex, body, jsonld, depth = 1 }) {
  const up = '../'.repeat(depth);
  return `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; object-src 'none'">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, follow">' : `<link rel="canonical" href="${esc(canonical)}">`}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:locale" content="hu_HU">
<link rel="icon" type="image/svg+xml" href="${up}favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
<style>
:root{--g50:#f0fdf4;--g100:#dcfce7;--g200:#bbf7d0;--g600:#16a34a;--g700:#15803d;--g800:#166534;--gr50:#f9fafb;--gr100:#f3f4f6;--gr200:#e5e7eb;--gr400:#9ca3af;--gr500:#6b7280;--gr600:#4b5563;--gr700:#374151;--gr900:#111827;--am50:#fffbeb;--am600:#d97706;--red600:#dc2626}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--gr900);background:#fff;-webkit-font-smoothing:antialiased;line-height:1.6}
nav{border-bottom:1px solid var(--gr200);padding:14px 16px}
.nav-in{max-width:880px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
.logo{font-size:18px;font-weight:800;color:var(--gr900);text-decoration:none}.logo span{color:var(--g600)}
.nav-cta{font-size:13px;font-weight:700;color:#fff;background:var(--g700);padding:8px 14px;border-radius:9px;text-decoration:none;white-space:nowrap}
main{max-width:880px;margin:0 auto;padding:28px 16px 48px}
.crumbs{font-size:12px;color:var(--gr500);margin-bottom:14px}.crumbs a{color:var(--gr500);text-decoration:none}
h1{font-size:clamp(22px,4vw,30px);font-weight:800;letter-spacing:-.4px;line-height:1.25;margin-bottom:10px;overflow-wrap:anywhere}
h2{font-size:17px;font-weight:700;margin:28px 0 10px}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}
.b{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--gr100);color:var(--gr700)}.b.g{background:var(--g100);color:var(--g800)}.b.r{background:#fee2e2;color:var(--red600)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 0;border-bottom:1px solid var(--gr100);vertical-align:top}
th{width:34%;color:var(--gr500);font-weight:600;font-size:13px;padding-right:12px}
td{overflow-wrap:anywhere}
a{color:var(--g700)}
p{font-size:14.5px;color:var(--gr700);margin-bottom:10px}
.sum h3{font-size:14px;font-weight:700;margin:16px 0 6px;color:var(--gr900)}
.sum ul{list-style:none}.sum li{font-size:14px;color:var(--gr700);padding:4px 0 4px 16px;position:relative}
.sum li:before{content:'';position:absolute;left:2px;top:12px;width:6px;height:6px;border-radius:50%;background:var(--g600)}
.q{display:block;font-size:12px;color:var(--gr500);font-style:italic;margin-top:2px;overflow-wrap:anywhere}
.cta{margin:30px 0;padding:22px;border-radius:14px;background:linear-gradient(135deg,var(--g50),#fff);border:1px solid var(--g200)}
.cta h2{margin:0 0 6px}.cta p{margin-bottom:14px}
.btn{display:inline-block;font-weight:700;font-size:14px;padding:11px 20px;border-radius:10px;text-decoration:none;margin:0 8px 8px 0}
.btn.p{background:var(--g700);color:#fff}.btn.s{background:#fff;color:var(--g700);border:1px solid var(--g200)}
.note{background:var(--am50);border-left:3px solid var(--am600);padding:12px 16px;border-radius:4px;font-size:13px;color:var(--gr700);margin:22px 0}
.muted{font-size:12.5px;color:var(--gr500)}
.list{list-style:none}.list li{border-bottom:1px solid var(--gr100);padding:12px 0}
.list a{font-weight:600;color:var(--gr900);text-decoration:none;overflow-wrap:anywhere}.list a:hover{color:var(--g700)}
.list .m{font-size:12.5px;color:var(--gr500);margin-top:2px}
#q{width:100%;padding:11px 14px;border:1px solid var(--gr200);border-radius:10px;font:inherit;font-size:15px;margin:6px 0 10px}
footer{border-top:1px solid var(--gr200);padding:22px 16px;text-align:center;font-size:12px;color:var(--gr400)}
footer a{color:var(--gr500);margin:0 8px;text-decoration:none}
</style>
</head>
<body>
<nav><div class="nav-in"><a class="logo" href="${up}index.html">AI<span>pályázó</span></a><a class="nav-cta" href="${up}onboarding.html">Ingyenes illeszkedés-vizsgálat</a></div></nav>
<main>
${body}
</main>
<footer><a href="${up}impresszum.html">Impresszum</a><a href="${up}adatvedelem.html">Adatkezelés</a><a href="${up}aszf.html">ÁSZF</a><a href="${up}palyazat/index.html">Összes pályázat</a></footer>
</body>
</html>
`;
}

function factsRows(g) {
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<tr><th>${k}</th><td>${v}</td></tr>`); };
  add('Kiíró', esc(g.issuer));
  add('Felhívás kódja', g.code ? esc(g.code) : '');
  add('Támogatás formája', esc(TYPE_HU[g.type] || g.type || ''));
  add('Kategória', esc(g.cat));
  add('Összeg', esc(g.amount));
  add('Támogatási arány / feltétel', g.rate ? esc(g.rate) : '');
  if (g.keret > 0) add('Teljes keret', esc(ft(g.keret)) + (g.remaining >= 0 && g.remaining != null ? ` · még szabad: <b>${esc(ft(g.remaining))}</b> (hivatalos adat)` : ''));
  add('Beadási határidő', esc(deadlineHu(g)));
  if (isDate(g.windowOpen)) add('Beadás kezdete', esc(huDate(g.windowOpen)));
  add('Cégméret', (g.sizeClasses || []).length ? esc(g.sizeClasses.join(', ')) : '');
  add('Régió', (g.regions || []).length ? esc(g.regions.join(', ')) : (g.scope === 'eu' ? 'EU-s program — magyar cégek is pályázhatnak' : 'Országos'));
  if (g.regionNote) add('Régió megjegyzés', esc(g.regionNote));
  if (g.scope === 'eu' && g.singleApplicant === false) add('Konzorcium', 'Jellemzően több ország partnereivel közösen (konzorciumban) lehet pályázni');
  const url = safeUrl(g.url);
  add('Hivatalos oldal', url ? `<a href="${esc(url)}" target="_blank" rel="noopener nofollow">${esc(g.source || new URL(url).hostname)} ↗</a>` : '');
  return `<table>${rows.join('')}</table>`;
}

function summaryHtml(s) {
  if (!s || !Array.isArray(s.sections) || !s.sections.length) return '';
  return `<h2>A felhívás röviden</h2>
<div class="sum">${s.sections.map((sec) => `<h3>${esc(sec.title)}</h3><ul>${(sec.items || []).map((it) => `<li>${esc(it.text)}<span class="q">„${esc(it.quote)}”</span></li>`).join('')}</ul>`).join('')}</div>
<p class="muted">Az összefoglalót mesterséges intelligencia készítette a <a href="${esc(safeUrl(s.sourceUrl))}" target="_blank" rel="noopener nofollow">hivatalos szövegből</a>; minden pont mellett ott a szó szerinti idézet, amire épül. Készült: ${esc(s.generatedAt || '')}.</p>`;
}

export function metaDescription(g) {
  const parts = [g.title, g.amount && `Összeg: ${g.amount}`, isDate(g.deadline) ? `határidő: ${huDate(g.deadline)}` : 'folyamatos beadás', g.issuer && `kiíró: ${g.issuer}`];
  const t = parts.filter(Boolean).join(' · ') + '. Nézze meg ingyen, jogosult-e a cége.';
  return t.length > 300 ? t.slice(0, 297) + '…' : t;
}

export function renderPage(g, slug, summary, { updatedAt } = {}) {
  const canonical = `${BASE}/palyazat/${slug}.html`;
  const portal = `../portal.html?grant=${encodeURIComponent(g.id)}`;
  const checked = g.lastChecked || g.verifiedAt || (g.modified ? String(g.modified).slice(0, 10) : '') || updatedAt || '';
  const badges = [
    `<span class="b g">${g.scope === 'eu' ? 'EU / nemzetközi' : 'Hazai'}</span>`,
    `<span class="b">${esc(TYPE_HU[g.type] || g.type || 'Támogatás')}</span>`,
    isDate(g.deadline) ? `<span class="b">Határidő: ${esc(huDate(g.deadline))}</span>` : '<span class="b">Folyamatos beadás</span>',
  ].join('');
  const jsonld = [
    {
      '@context': 'https://schema.org', '@type': 'MonetaryGrant', name: g.title, url: canonical,
      description: metaDescription(g), funder: { '@type': 'Organization', name: g.issuer || g.source || '' },
      ...(safeUrl(g.url) ? { sameAs: safeUrl(g.url) } : {}),
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'AIpályázó', item: `${BASE}/index.html` },
        { '@type': 'ListItem', position: 2, name: 'Pályázatok', item: `${BASE}/palyazat/index.html` },
        { '@type': 'ListItem', position: 3, name: g.title, item: canonical },
      ],
    },
  ];
  const body = `<div class="crumbs"><a href="../index.html">AIpályázó</a> › <a href="index.html">Pályázatok</a></div>
<h1>${esc(g.title)}</h1>
<div class="badges">${badges}</div>
${factsRows(g)}
${g.note ? `<h2>Röviden</h2><p>${esc(g.note)}</p>` : ''}
${summaryHtml(summary)}
<div class="cta">
<h2>Jogosult erre a cége?</h2>
<p>Adja meg cége adószámát, és pontonként megmutatjuk, megfelel-e a feltételeknek (méret, régió, TEÁOR, működési idő, köztartozás) — ingyen, regisztrációval. Kérésre a DFT-Hungária pályázatírói díjmentesen felveszik Önnel a kapcsolatot.</p>
<a class="btn p" href="${esc(portal)}">Megnézem a portálon</a><a class="btn s" href="../onboarding.html">Cégprofil megadása</a>
</div>
<div class="note">Tájékoztató összefoglaló. Mindig a hivatalos felhívás és annak módosításai az irányadók — beadás előtt ellenőrizze a kiíró oldalán.</div>
<p class="muted">Utolsó ellenőrzés: ${esc(checked)} · Az adatokat naponta frissítjük hivatalos forrásokból.</p>`;
  return shell({ title: `${g.title} — pályázat${isDate(g.deadline) ? `, határidő ${huDate(g.deadline)}` : ''} | AIpályázó`, description: metaDescription(g), canonical, noindex: false, body, jsonld });
}

export function renderClosed(m, slug) {
  const canonical = `${BASE}/palyazat/${slug}.html`;
  const body = `<div class="crumbs"><a href="../index.html">AIpályázó</a> › <a href="index.html">Pályázatok</a></div>
<h1>${esc(m.title)}</h1>
<div class="badges"><span class="b r">Lezárult vagy már nem elérhető</span></div>
<p>Ez a felhívás ${esc(m.closedAt || '')} óta nem szerepel a hivatalos forrásokban (lejárt, felfüggesztették vagy kimerült a kerete).</p>
<div class="cta"><h2>Nézze meg, mire pályázhat most</h2><p>Naponta frissülő listánkban a cégére szabott, nyitott felhívásokat mutatjuk.</p>
<a class="btn p" href="index.html">Nyitott pályázatok</a><a class="btn s" href="../onboarding.html">Ingyenes illeszkedés-vizsgálat</a></div>`;
  return shell({ title: `${m.title} — lezárult | AIpályázó`, description: `${m.title}: ez a felhívás lezárult. Nézze meg a nyitott pályázatokat.`, canonical, noindex: true, body });
}

export function renderIndex(open, slugs, { updatedAt } = {}) {
  const sorted = [...open].sort((a, b) => {
    const da = isDate(a.deadline) ? a.deadline : '9999', db = isDate(b.deadline) ? b.deadline : '9999';
    return da.localeCompare(db) || a.title.localeCompare(b.title, 'hu');
  });
  const li = (g) => `<li data-s="${esc(`${g.title} ${g.code || ''} ${g.issuer || ''} ${g.cat || ''}`.toLowerCase())}"><a href="${esc(slugs.get(g.id))}.html">${esc(g.title)}</a><div class="m">${esc(g.issuer || '')} · ${esc(g.amount || '')} · ${isDate(g.deadline) ? 'határidő: ' + esc(huDate(g.deadline)) : 'folyamatos'}</div></li>`;
  const hu = sorted.filter((g) => g.scope !== 'eu'), eu = sorted.filter((g) => g.scope === 'eu');
  const body = `<div class="crumbs"><a href="../index.html">AIpályázó</a> › Pályázatok</div>
<h1>Nyitott pályázatok magyar vállalkozásoknak</h1>
<p>${open.length} nyitott felhívás — ${hu.length} hazai és ${eu.length} EU-s / nemzetközi. Naponta frissítjük hivatalos forrásokból${updatedAt ? ` (utoljára: ${esc(String(updatedAt).slice(0, 10))})` : ''}.</p>
<input id="q" type="search" placeholder="Keresés (pl. GINOP, energia, Horizon, startup)…" aria-label="Keresés a pályázatok között">
<h2>Hazai pályázatok és hitelek (${hu.length})</h2><ul class="list">${hu.map(li).join('')}</ul>
<h2>EU-s és nemzetközi (${eu.length})</h2><ul class="list">${eu.map(li).join('')}</ul>
<div class="cta"><h2>Melyikre jogosult a cége?</h2><p>A portál pontonként összeveti cége adatait minden felhívás feltételeivel — ingyen.</p><a class="btn p" href="../onboarding.html">Ingyenes illeszkedés-vizsgálat</a></div>
<script>(function(){var q=document.getElementById('q');q.addEventListener('input',function(){var v=q.value.trim().toLowerCase();document.querySelectorAll('.list li').forEach(function(li){li.style.display=!v||li.getAttribute('data-s').indexOf(v)>=0?'':'none';});});})();</script>`;
  const jsonld = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Nyitott pályázatok magyar vállalkozásoknak', url: `${BASE}/palyazat/index.html` };
  return shell({ title: 'Nyitott pályázatok vállalkozásoknak (hazai és EU) — naponta frissítve | AIpályázó', description: `${open.length} nyitott hazai és EU-s pályázat, hitel és tőkeprogram magyar cégeknek, naponta frissítve hivatalos forrásokból. Ingyenes illeszkedés-vizsgálat.`, canonical: `${BASE}/palyazat/index.html`, noindex: false, body, jsonld });
}

export const STATIC_PAGES = [
  ['index.html', '1.0', 'weekly'], ['palyazat/index.html', '0.9', 'daily'], ['onboarding.html', '0.8', 'monthly'],
  ['signup.html', '0.7', 'monthly'], ['pricing.html', '0.6', 'monthly'],
  ['impresszum.html', '0.2', 'yearly'], ['adatvedelem.html', '0.2', 'yearly'], ['aszf.html', '0.2', 'yearly'],
];
export function buildSitemap(open, slugs, today) {
  const url = (loc, pri, freq, lastmod) => `  <url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>${freq}</changefreq><priority>${pri}</priority></url>`;
  const lines = STATIC_PAGES.map(([p, pri, f]) => url(`${BASE}/${p}`, pri, f, p === 'palyazat/index.html' ? today : ''));
  for (const g of open) {
    const lm = [g.lastChecked, g.verifiedAt, g.modified && String(g.modified).slice(0, 10)].filter(isDate).sort().pop();
    lines.push(url(`${BASE}/palyazat/${slugs.get(g.id)}.html`, '0.7', 'weekly', lm || ''));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}

export const ROBOTS = `User-agent: *
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
export function buildAll({ grants, summaries = {}, manifest = {}, today, updatedAt }) {
  const open = grants.filter((g) => g && g.id && g.title && isOpen(g, today));
  const slugs = assignSlugs(open.map((g) => g.id), manifest);
  const files = new Map();
  const next = {};
  const openIds = new Set(open.map((g) => g.id));
  for (const g of open) {
    const slug = slugs.get(g.id);
    const prev = manifest[slug];
    next[slug] = { id: g.id, title: g.title, firstSeen: (prev && prev.firstSeen) || today, lastSeen: today };
    files.set(`palyazat/${slug}.html`, renderPage(g, slug, summaries[g.id], { updatedAt }));
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
  files.set('palyazat/index.html', renderIndex(open, slugs, { updatedAt }));
  files.set('sitemap.xml', buildSitemap(open, slugs, today));
  const sortedManifest = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  files.set('palyazat/pages.json', JSON.stringify(sortedManifest, null, 1) + '\n');
  return { files, manifest: sortedManifest, removed, stats: { open: open.length, closed, removed: removed.length, withSummary: open.filter((g) => summaries[g.id]).length } };
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
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  const { files, removed, stats } = buildAll({ grants, summaries, manifest, today, updatedAt: meta.updatedAt });
  mkdirSync(join(site, 'palyazat'), { recursive: true });
  for (const [rel, content] of files) writeFileSync(join(site, rel), content);
  for (const rel of removed) { const p = join(site, rel); if (existsSync(p)) unlinkSync(p); }
  // Stray html files not in the manifest (e.g. hand-deleted manifest) are removed.
  const keep = new Set([...files.keys()].map((k) => k.replace(/^palyazat\//, '')));
  for (const f of readdirSync(join(site, 'palyazat'))) if (f.endsWith('.html') && !keep.has(f)) unlinkSync(join(site, 'palyazat', f));
  writeFileSync(join(root, 'robots.txt'), ROBOTS);
  console.log(`build-pages: ${stats.open} open pages (${stats.withSummary} with summary), ${stats.closed} closed kept, ${stats.removed} removed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
