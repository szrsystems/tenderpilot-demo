/* =========================================================================
   AIpályázó portal (2026-10 rewrite)
   One file, no framework. Rules that keep it safe:
   - every value that comes from the feed, the profile or the URL goes
     through esc() before it touches innerHTML; links go through safeUrl();
   - actions are wired with data-* attributes + one delegated listener,
     never with inline onclick strings built from data;
   - there is no bundled/demo data: if the live feed cannot be loaded we show
     the last good copy (with its date) or an honest error.
   ========================================================================= */
(function () {
  'use strict';

  // ---------------------------------------------------------------- utils
  var CFG = window.AIP_CONFIG || {};
  var TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }
  function isDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || ''); }
  function days(d) { return isDate(d) ? Math.round((Date.parse(d) - Date.parse(TODAY)) / 864e5) : null; }
  function huDate(d) { return isDate(d) ? d.slice(0, 4) + '. ' + d.slice(5, 7) + '. ' + d.slice(8, 10) + '.' : 'folyamatos'; }
  function ft(n) { return n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace('.', ',').replace(',0', '') + ' Mrd Ft' : Math.round(n / 1e6) + ' M Ft'; }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function toast(msg) { var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3200); }
  function track(n) { try { if (window.aipTrack) window.aipTrack(n); } catch (e) {} }
  var TYPE_HU = { grant: 'vissza nem térítendő', loan: 'hitel', 'loan+grant': 'hitel + támogatás', 'grant+loan': 'támogatás + hitel', equity: 'tőkebefektetés', 'grant+equity': 'támogatás + tőke', guarantee: 'garancia', 'wage-subsidy': 'bértámogatás', 'in-kind': 'szolgáltatás', prize: 'díj', voucher: 'utalvány' };
  var SYM = { ok: '✓', fail: '✗', unknown: '?', warn: '!', neutral: '·' };
  var VERDICT = { APPLY: ['apply', 'Érdemes pályázni'], REVIEW: ['review', 'Érdemes megnézni'], SKIP: ['skip', 'Nem jogosult / kevésbé illik'] };
  var ICON_BM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';

  // ---------------------------------------------------------------- state
  var S = {
    feed: [], meta: {}, summaries: {}, changes: {}, expected: [], slugs: {}, feedFromCache: null, feedError: false,
    user: null, profile: lsGet('grantpilot:profile', null), bookmarks: new Set(lsGet('grantpilot:bookmarks', [])),
    matchCache: new Map(), view: 'attekintes', list: { q: '', cat: '', scope: 'all', type: 'all', onlyFit: true, sort: 'fit', page: 1, needIds: null, needQ: '' },
    ready: false
  };

  function hasProfile() { var p = S.profile; return !!(p && (p.company || p.employees || (p.industries && p.industries.length))); }
  function matchOf(g) {
    if (!window.AIPMatch) return null;
    var m = S.matchCache.get(g.id);
    if (!m) { m = AIPMatch.match(g, hasProfile() ? S.profile : null, TODAY); S.matchCache.set(g.id, m); }
    return m;
  }
  function resetMatches() { S.matchCache = new Map(); }
  function rank(g) { var m = matchOf(g); if (!m) return 0; return (m.verdict === 'APPLY' ? 1000 : m.verdict === 'REVIEW' ? 500 : 0) + (m.group === 'hazai' ? 100 : m.group === 'eu' ? 50 : 0) + m.score; }
  function byId(id) { for (var i = 0; i < S.feed.length; i++) if (S.feed[i].id === id) return S.feed[i]; return null; }
  function publicUrl(g) { return S.slugs[g.id] ? 'palyazat/' + encodeURIComponent(S.slugs[g.id]) + '.html' : ''; }

  // ---------------------------------------------------------------- data
  function getJSON(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }); }
  function loadData() {
    return Promise.all([
      getJSON('grants_live.json').then(function (a) {
        if (!Array.isArray(a) || a.length < 20) throw new Error('feed too small');
        lsSet('aip:feed-cache', { at: new Date().toISOString(), items: a });
        return a;
      }).catch(function () {
        var c = lsGet('aip:feed-cache', null);
        if (c && Array.isArray(c.items) && c.items.length) { S.feedFromCache = c.at; return c.items; }
        S.feedError = true; return [];
      }),
      getJSON('grants-meta.json').catch(function () { return {}; }),
      getJSON('summaries.json').catch(function () { return {}; }),
      getJSON('changes.json').catch(function () { return {}; }),
      getJSON('expected-calls.json').catch(function () { return []; }),
      getJSON('palyazat/pages.json').catch(function () { return {}; })
    ]).then(function (r) {
      S.feed = r[0].filter(function (g) { return g && g.id && g.title && (!isDate(g.deadline) || g.deadline >= TODAY); });
      S.meta = r[1] || {}; S.summaries = r[2] || {}; S.changes = r[3] || {}; S.expected = Array.isArray(r[4]) ? r[4] : [];
      Object.keys(r[5] || {}).forEach(function (slug) { var m = r[5][slug]; if (m && m.id && !m.closedAt) S.slugs[m.id] = slug; });
      resetMatches();
    });
  }

  // ---------------------------------------------------------------- auth
  function waitGp() { return new Promise(function (res) { if (window.gp) return res(); window.addEventListener('gp-ready', function () { res(); }, { once: true }); setTimeout(res, 4000); }); }
  function profileFromServer(p) {
    return {
      company: p.company || '', industry: p.industry || '', industries: Array.isArray(p.industries) && p.industries.length ? p.industries : (p.industry ? [p.industry] : []),
      employees: p.employees || '', revenue: p.revenue || '', location: p.location || '', site_region: p.site_region || '', years_operating: p.years_operating || '',
      legal_form: p.legal_form || '', public_debt_free: p.public_debt_free || '', own_funds: p.own_funds || '', in_difficulty: p.in_difficulty || '', teaor: p.teaor || '',
      rnd: p.rnd || '', women_led: p.women_led || '', categories: Array.isArray(p.categories) ? p.categories : [], contact_name: p.display_name || '', email: p.email || '', phone: p.phone || ''
    };
  }
  async function resolveUser() {
    await waitGp();
    if (!window.gp || !window.gp.client) return;
    try {
      var u = (await window.gp.client.auth.getUser()).data.user;
      if (!u) return;
      var prof = await window.gp.getUserProfile();
      var del = window.gp.checkDeletedAccount ? await window.gp.checkDeletedAccount().catch(function () { return { deleted: false }; }) : { deleted: false };
      if (del.deleted || (prof && (prof.display_name === '__DELETED__' || String(prof.email || '').indexOf('deleted-') === 0))) {
        try { await window.gp.client.auth.signOut({ scope: 'local' }); } catch (e) {}
        location.replace('login.html?signed_out=1');
        return;
      }
      S.user = { id: u.id, email: u.email || '', name: (prof && prof.display_name) || '' };
      if (prof && (prof.company || prof.employees || (prof.industries && prof.industries.length))) {
        // The server profile is the source of truth for a signed-in user.
        var local = S.profile || {};
        S.profile = Object.assign({}, local, profileFromServer(prof));
        if (!S.profile.phone && local.phone) S.profile.phone = local.phone; // view without phone (older schema)
        lsSet('grantpilot:profile', S.profile);
      } else if (hasProfile()) {
        // Filled before signing up (quick check / onboarding): push it up once.
        await pushProfile(S.profile);
      }
      pushAttribution();
      await syncBookmarks();
      resetMatches();
    } catch (e) { console.warn('[aip] auth resolve failed', e); }
  }
  async function pushProfile(p) {
    if (!S.user) return;
    var c = window.gp.client;
    var patch = { display_name: p.contact_name, company: p.company, industry: p.industry || (p.industries || [])[0], industries: p.industries, employees: p.employees, revenue: p.revenue, location: p.location, site_region: p.site_region, years_operating: p.years_operating, legal_form: p.legal_form, public_debt_free: p.public_debt_free, own_funds: p.own_funds, in_difficulty: p.in_difficulty, teaor: p.teaor, categories: p.categories, phone: p.phone };
    Object.keys(patch).forEach(function (k) { if (patch[k] === '' || patch[k] == null || (Array.isArray(patch[k]) && !patch[k].length)) delete patch[k]; });
    if (Object.keys(patch).length) { var r = await c.from('profiles').update(patch).eq('id', S.user.id); if (r.error) console.warn('[aip] profile push failed', r.error); }
    var v2 = {}; if (p.rnd) v2.rnd = p.rnd; if (p.women_led) v2.women_led = p.women_led;
    if (Object.keys(v2).length) await c.from('profiles').update(v2).eq('id', S.user.id);
  }
  async function pushAttribution() {
    if (!S.user || !window.gp) return; var c = window.gp.client;
    var a = window.AIPAttr && AIPAttr.get(); if (a) { try { await c.from('profiles').update({ acq_source: a.source, acq_campaign: a.campaign, acq_medium: a.medium, acq_at: a.at }).eq('id', S.user.id); } catch (eA) {} } // first touch only; the database keeps the first value
  }
  async function syncBookmarks() {
    if (!S.user) return;
    try {
      var r = await window.gp.client.from('bookmarks').select('grant_id').eq('user_id', S.user.id);
      if (r.error || !Array.isArray(r.data)) return;
      var remote = new Set(r.data.map(function (x) { return String(x.grant_id); }));
      var localOnly = Array.from(S.bookmarks).filter(function (id) { return !remote.has(id); });
      if (localOnly.length) await window.gp.client.from('bookmarks').upsert(localOnly.map(function (id) { return { user_id: S.user.id, grant_id: id }; }), { onConflict: 'user_id,grant_id', ignoreDuplicates: true });
      remote.forEach(function (id) { S.bookmarks.add(id); });
      lsSet('grantpilot:bookmarks', Array.from(S.bookmarks));
    } catch (e) { console.warn('[aip] bookmark sync failed', e); }
  }
  function toggleBookmark(id) {
    var on = !S.bookmarks.has(id);
    if (on) S.bookmarks.add(id); else S.bookmarks.delete(id);
    lsSet('grantpilot:bookmarks', Array.from(S.bookmarks));
    $$('[data-bm="' + CSS.escape(id) + '"]').forEach(function (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.setAttribute('aria-label', on ? 'Mentve — eltávolítás' : 'Mentés'); });
    updateCounts();
    if (S.user) {
      var c = window.gp.client;
      (on ? c.from('bookmarks').upsert({ user_id: S.user.id, grant_id: id }, { onConflict: 'user_id,grant_id', ignoreDuplicates: true }) : c.from('bookmarks').delete().eq('user_id', S.user.id).eq('grant_id', id))
        .then(function (r) { if (r && r.error) console.warn('[aip] bookmark save failed', r.error); });
    }
    if (on) track('bookmark');
    if (!on && S.view === 'mentett') render();
  }
  function signOut() {
    try {
      var rm = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && (k.indexOf('sb-') === 0 || k.indexOf('-auth-token') >= 0 || k.indexOf('grantpilot') === 0 || k.indexOf('aip:') === 0 || k.indexOf('gp_migrated_') === 0)) rm.push(k); }
      rm.forEach(function (k) { localStorage.removeItem(k); });
      sessionStorage.setItem('gp_just_signed_out', '1');
    } catch (e) {}
    try { if (window.gp && window.gp.client) window.gp.client.auth.signOut({ scope: 'local' }).catch(function () {}); } catch (e) {}
    location.href = 'login.html?signed_out=1';
  }

  // ---------------------------------------------------------------- shell
  function updateShell() {
    var who = $('#who'), sub = $('#who-sub'), su = $('#rail-signup');
    if (S.user) {
      who.textContent = (S.profile && S.profile.company) || S.user.name || S.user.email;
      sub.textContent = S.user.email;
      su.outerHTML = '<button class="btn btn-ghost btn-sm" type="button" data-act="signout" id="rail-signup">Kijelentkezés</button>';
    } else {
      who.textContent = hasProfile() ? (S.profile.company || 'Vendég') : 'Vendég';
      sub.textContent = 'Regisztráció nélkül böngészik';
    }
    updateCounts();
  }
  function updateCounts() {
    $('#count-all').textContent = S.feed.length || '';
    var saved = S.feed.filter(function (g) { return S.bookmarks.has(g.id); }).length;
    $('#count-saved').textContent = saved || '';
  }
  function setRail(open) {
    $('#rail').classList.toggle('open', open);
    $('#rail-scrim').hidden = !open;
    $('#rail-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // ---------------------------------------------------------------- router
  function parseHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var parts = h.split('/');
    return { view: parts[0] || 'attekintes', id: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : '' };
  }
  function route() {
    var r = parseHash();
    if (r.view === 'palyazat' && r.id) { if (S.view === 'palyazat' || !S.rendered) { S.view = 'palyazatok'; render(); } openDetail(r.id); return; }
    closeDetail(true);
    S.view = Object.prototype.hasOwnProperty.call(VIEWS, r.view) ? r.view : 'attekintes';
    render();
  }
  function render() {
    S.rendered = true;
    $$('.rail a.nav').forEach(function (a) { if (a.getAttribute('data-view') === S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    var v = $('#view');
    if (!S.ready) { v.innerHTML = '<p class="muted">Betöltés…</p>'; return; }
    v.innerHTML = VIEWS[S.view]();
    if (AFTER[S.view]) AFTER[S.view]();
    setRail(false);
  }

  // ---------------------------------------------------------------- pieces
  function marksHtml(m, n) {
    if (!m) return '';
    return m.checks.filter(function (c) { return c.status !== 'neutral'; }).slice(0, n || 6).map(function (c) { return '<span class="' + esc(c.status) + '">' + SYM[c.status] + ' ' + esc(c.label) + '</span>'; }).join('');
  }
  function isNewCall(g) { return (S.changes[g.id] || []).some(function (c) { return c.type === 'new' && days(c.date) !== null && days(c.date) >= -14; }); }
  function callRow(g, opts) {
    opts = opts || {};
    var m = matchOf(g), personal = m && m.personal, C = window.AIPCards;
    var v = m && personal ? VERDICT[m.verdict] : null;
    var saved = S.bookmarks.has(g.id);
    var fit = v ? '<div class="gc-fit ' + v[0] + '"><span class="sc">' + m.score + '</span>' + esc(v[1]) + '</div>' : '';
    return '<article class="gcard' + (v && v[0] === 'apply' ? ' apply' : '') + '">' +
      '<div class="gc-head">' + C.srcTag(g) +
        '<div class="gc-main"><button type="button" class="gc-title" data-open="' + esc(g.id) + '">' + esc(g.title) + '</button>' +
        '<div class="gc-sub">' + esc([g.code, g.issuer].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="badges">' + C.badges(g, { today: TODAY, isNew: isNewCall(g), consortium: m && m.group === 'consortium' }) + '</div></div>' +
        '<div class="gc-side"><div><div class="gc-amt-label">Támogatás</div><div class="gc-amt">' + esc(g.amount || '—') + '</div></div>' + fit + '</div>' +
      '</div>' +
      C.bars(g, { today: TODAY }) +
      (personal && !opts.noMarks ? '<div class="marks">' + marksHtml(m, 7) + '</div>' : '') +
      '<button type="button" class="bm" data-bm="' + esc(g.id) + '" aria-pressed="' + (saved ? 'true' : 'false') + '" aria-label="' + (saved ? 'Mentve — eltávolítás' : 'Mentés') + '">' + ICON_BM + '</button>' +
      '</article>';
  }
  function head(eyebrow, title, right) {
    return '<header class="view-head"><div>' + (eyebrow ? '<p class="eyebrow">' + eyebrow + '</p>' : '') + '<h1>' + title + '</h1></div>' + (right || '') + '</header>';
  }
  function freshness() {
    if (S.feedError) return '<div class="notice err" role="alert">A pályázati adatokat most nem sikerült betölteni. Kérjük, frissítse az oldalt később.</div>';
    if (S.feedFromCache) return '<div class="notice warn" role="status">Az adatok most nem frissíthetők; a ' + esc(S.feedFromCache.slice(0, 10)) + '-i mentett változatot látja.</div>';
    return '';
  }
  function stampLine() {
    var at = S.meta.updatedAt ? new Date(S.meta.updatedAt).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : TODAY;
    return '<span class="stamp-line">Frissítve: ' + esc(at) + '</span>';
  }
  function profileCallout() {
    if (!hasProfile()) return '<div class="callout"><p><b>Adja meg a cége adatait — kb. 1 perc.</b> Utána minden felhívásnál pontonként látja, mely feltételek teljesülnek.</p><a class="btn btn-primary" href="onboarding.html">Cégprofil megadása</a></div>';
    var miss = window.AIPMatch ? AIPMatch.missingFields(S.profile) : [];
    if (miss.length) return '<div class="callout warn"><p><b>' + miss.length + ' adat hiányzik a pontos ellenőrzéshez:</b> ' + esc(miss.map(function (f) { return f.label; }).join(', ')) + '. Ezek nélkül a feltételeket „?” jellel jelöljük.</p><a class="btn btn-ghost" href="onboarding.html">Profil kiegészítése</a></div>';
    return '';
  }
  function eligibleSorted(filterFn) {
    return S.feed.filter(function (g) { var m = matchOf(g); return m && (!m.personal || m.eligible) && (!filterFn || filterFn(g, m)); })
      .sort(function (a, b) { return rank(b) - rank(a); });
  }

  // ---------------------------------------------------------------- views
  var VIEWS = {}, AFTER = {};

  VIEWS.attekintes = function () {
    var personal = hasProfile();
    var fitting = eligibleSorted(function (g, m) { return m.group !== 'consortium'; });
    var good = personal ? fitting.filter(function (g) { return matchOf(g).verdict === 'APPLY'; }) : [];
    var soon = (personal ? fitting : S.feed).filter(function (g) { var d = days(g.deadline); return d !== null && d <= 30; });
    var budget = S.feed.filter(function (g) { return g.scope !== 'eu'; }).reduce(function (s, g) { return s + (typeof g.remaining === 'number' && g.remaining > 0 ? g.remaining : 0); }, 0);
    var consortium = S.feed.filter(function (g) { var m = matchOf(g); return m && m.group === 'consortium' && (!m.personal || m.eligible); }).length;
    var greet = S.user ? 'Jó napot' + (S.profile && S.profile.contact_name ? ', ' + esc(S.profile.contact_name.split(' ').slice(-1)[0]) : '') + '!' : 'Áttekintés';
    var saved = S.feed.filter(function (g) { return S.bookmarks.has(g.id); }).sort(function (a, b) { return (a.deadline || '9').localeCompare(b.deadline || '9'); });
    var recentChanges = [];
    saved.forEach(function (g) { (S.changes[g.id] || []).forEach(function (c) { if (c.type !== 'new' && days(c.date) !== null && days(c.date) >= -30) recentChanges.push({ g: g, c: c }); }); });
    var h = head(esc(S.profile && S.profile.company ? S.profile.company : 'AIpályázó portál'), greet, stampLine()) + freshness() + profileCallout();
    h += '<div class="figures" style="margin-bottom:var(--s5)">' +
      '<div class="figure"><div class="v num">' + S.feed.length + '</div><div class="k">nyitott felhívás</div></div>' +
      '<div class="figure"><div class="v num">' + (personal ? good.length : '—') + '</div><div class="k">' + (personal ? 'illik jól a cégéhez' : 'illik — profil kell') + '</div></div>' +
      '<div class="figure"><div class="v num">' + soon.length + '</div><div class="k">határidő 30 napon belül' + (personal ? ' (Önnek)' : '') + '</div></div>' +
      '<div class="figure"><div class="v num">' + (budget ? ft(budget) : '—') + '</div><div class="k">szabad hazai keret</div></div></div>';
    var top = (personal ? fitting : S.feed.slice().sort(function (a, b) { return (a.scope === 'eu') - (b.scope === 'eu') || (a.deadline || '9').localeCompare(b.deadline || '9'); })).slice(0, 6);
    h += '<div class="section-title"><h2>' + (personal ? 'Legjobb egyezések' : 'Nyitott felhívások') + '</h2><a href="#/palyazatok">Összes →</a></div><div class="gcards">' + (top.map(function (g) { return callRow(g); }).join('') || '<p class="empty">Nincs megjeleníthető felhívás.</p>') + '</div>';
    if (saved.length) h += '<div class="section-title"><h2>Mentett felhívások</h2><a href="#/mentett">Mind (' + saved.length + ') →</a></div><div class="gcards">' + saved.slice(0, 4).map(function (g) { return callRow(g, { noMarks: true }); }).join('') + '</div>';
    if (recentChanges.length) h += '<div class="section-title"><h2>Változások a mentett felhívásokban</h2></div><ul class="log">' + recentChanges.slice(0, 8).map(function (x) { return '<li><time>' + esc(huDate(x.c.date)) + '</time><span><button type="button" class="t" style="all:unset;cursor:pointer;color:var(--brand);text-decoration:underline" data-open="' + esc(x.g.id) + '">' + esc(x.g.title) + '</button> — ' + esc(changeText(x.c)) + '</span></li>'; }).join('') + '</ul>';
    if (consortium) h += '<p class="muted" style="margin-top:var(--s5)">További <b>' + consortium + '</b> nemzetközi, konzorciumban beadható EU-s felhívás: <a href="#/palyazatok" data-scope="consortium">megnézem</a>.</p>';
    return h;
  };

  VIEWS.palyazatok = function () {
    var L = S.list, personal = hasProfile();
    var counts = { all: 0, hu: 0, eu: 0, consortium: 0 };
    S.feed.forEach(function (g) { var m = matchOf(g); counts.all++; if (m.group === 'hazai') counts.hu++; else if (m.group === 'consortium') counts.consortium++; else counts.eu++; });
    var h = head('Pályázatok', 'Nyitott felhívások', stampLine()) + freshness();
    h += '<div class="bigsearch"><h2>Mire keres támogatást?</h2><form id="needs-form" role="search"><div class="inp"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><label class="visually-hidden" for="needs-q">Mire keres támogatást?</label><input id="needs-q" type="search" autocomplete="off" placeholder="Pl. új CNC-gép, napelem a csarnokra, webáruház, GINOP…" value="' + esc(L.needQ || L.q) + '"></div><button class="btn btn-primary" type="submit">Keresés</button></form>' +
      '<div class="chips">' + ['Gépet, eszközt vennék', 'Energetika, napelem', 'Weboldal, webáruház, szoftver', 'Telephely, csarnok', 'Munkatársak képzése', 'Külpiacra lépés', 'Új termék fejlesztése', 'Munkaerő felvétele'].map(function (c) { return '<button type="button" data-need="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + (L.needIds || L.q ? '<button type="button" data-need="">× Keresés törlése</button>' : '') + '</div>' +
      '<p class="hint">Írja le saját szavaival, és a Keresés gomb megmutatja a legjobban illő felhívásokat. Gépelés közben a lista azonnal szűkül.</p></div>';
    h += profileCallout();
    var cats = {}; S.feed.forEach(function (g) { if (g.cat) cats[g.cat] = (cats[g.cat] || 0) + 1; });
    var catList = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; });
    h += '<div class="catpills" role="group" aria-label="Téma"><button type="button" data-cat="" aria-pressed="' + !L.cat + '">Mind<span class="n">' + S.feed.length + '</span></button>' + catList.map(function (c) { return '<button type="button" data-cat="' + esc(c) + '" aria-pressed="' + (L.cat === c) + '">' + esc(c) + '<span class="n">' + cats[c] + '</span></button>'; }).join('') + '</div>';
    h += '<div class="toolbar"><div class="field"><label for="list-scope">Forrás</label><select id="list-scope">' + [['all', 'Mind (' + counts.all + ')'], ['hu', 'Hazai (' + counts.hu + ')'], ['eu', 'EU, egyedül is (' + counts.eu + ')'], ['consortium', 'EU, konzorciumban (' + counts.consortium + ')']].map(function (x) { return '<option value="' + x[0] + '"' + (L.scope === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="list-type">Támogatás formája</label><select id="list-type">' + [['all', 'Mind'], ['grant', 'Vissza nem térítendő'], ['loan', 'Hitel'], ['equity', 'Tőke'], ['guarantee', 'Garancia'], ['other', 'Egyéb (bér, szolgáltatás)']].map(function (x) { return '<option value="' + x[0] + '"' + (L.type === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="list-sort">Sorrend</label><select id="list-sort">' + [['fit', personal ? 'Illeszkedés' : 'Hazai először'], ['deadline', 'Határidő'], ['amount', 'Keret']].map(function (x) { return '<option value="' + x[0] + '"' + (L.sort === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div></div>';
    if (personal) h += '<label class="switch-row" style="margin-bottom:var(--s3)"><input type="checkbox" id="only-fit"' + (L.onlyFit ? ' checked' : '') + ' style="width:20px;height:20px;accent-color:var(--brand)"> Csak amire a cége jogosult lehet</label>';
    h += '<div id="list-out"></div>';
    return h;
  };
  function listItems() {
    var L = S.list, q = L.q.toLowerCase(), personal = hasProfile();
    var out = S.feed.filter(function (g) {
      var m = matchOf(g);
      if (L.needIds && L.needIds.indexOf(g.id) < 0) return false;
      if (L.cat && g.cat !== L.cat) return false;
      if (L.scope === 'hu' && m.group !== 'hazai') return false;
      if (L.scope === 'eu' && m.group !== 'eu') return false;
      if (L.scope === 'consortium' && m.group !== 'consortium') return false;
      if (L.type === 'grant' && !/grant/.test(g.type || '')) return false;
      if (L.type === 'loan' && !/loan/.test(g.type || '')) return false;
      if (L.type === 'equity' && !/equity/.test(g.type || '')) return false;
      if (L.type === 'guarantee' && g.type !== 'guarantee') return false;
      if (L.type === 'other' && /grant|loan|equity|guarantee/.test(g.type || '')) return false;
      if (personal && L.onlyFit && !m.eligible) return false;
      if (q && (g.title + ' ' + (g.code || '') + ' ' + (g.issuer || '') + ' ' + (g.cat || '') + ' ' + (g.note || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var amount = function (g) { return g.keret || (window.parseAmount ? parseAmount(g.amount || '') : 0); };
    if (L.needIds && L.sort === 'fit') out.sort(function (a, b) { return L.needIds.indexOf(a.id) - L.needIds.indexOf(b.id); });
    else if (L.sort === 'deadline') out.sort(function (a, b) { return (isDate(a.deadline) ? a.deadline : '9999').localeCompare(isDate(b.deadline) ? b.deadline : '9999'); });
    else if (L.sort === 'amount') out.sort(function (a, b) { return amount(b) - amount(a); });
    else out.sort(function (a, b) { return rank(b) - rank(a); });
    return out;
  }
  function renderList() {
    var items = listItems(), n = S.list.page * 30;
    var o = $('#list-out'); if (!o) return;
    o.innerHTML = '<p class="register-meta" style="margin:0 0 8px">' + items.length + ' találat' + (S.list.needIds ? ' a(z) „' + esc(S.list.needQ) + '” igényre' : '') + '</p>' +
      (items.length ? '<div class="gcards">' + items.slice(0, n).map(function (g) { return callRow(g); }).join('') + '</div>' : '<p class="empty">Nincs a szűrésnek megfelelő felhívás. ' + (hasProfile() && S.list.onlyFit ? 'Kapcsolja ki a „Csak amire a cége jogosult lehet” szűrőt, vagy ' : '') + 'próbáljon más szűrést.</p>') +
      (items.length > n ? '<div class="more"><button class="btn btn-ghost" type="button" data-more>Továbbiak (' + (items.length - n) + ')</button></div>' : '');
  }
  AFTER.palyazatok = function () {
    renderList();
    var deb;
    $('#needs-q').addEventListener('input', function (e) { clearTimeout(deb); deb = setTimeout(function () { S.list.needIds = null; S.list.needQ = ''; S.list.q = e.target.value.trim(); S.list.page = 1; renderList(); }, 150); });
    $('#list-scope').addEventListener('change', function (e) { S.list.scope = e.target.value; S.list.page = 1; renderList(); });
    $('#list-type').addEventListener('change', function (e) { S.list.type = e.target.value; S.list.page = 1; renderList(); });
    $('#list-sort').addEventListener('change', function (e) { S.list.sort = e.target.value; renderList(); });
    var of = $('#only-fit'); if (of) of.addEventListener('change', function (e) { S.list.onlyFit = e.target.checked; S.list.page = 1; renderList(); });
    $('#needs-form').addEventListener('submit', function (e) { e.preventDefault(); S.list.q = ''; needsSearch($('#needs-q').value.trim()); });
  };

  // needs finder: AI intent (signed-in) → categories/keywords; keyword fallback
  var NEED_CONCEPTS = [
    { q: /gép|eszköz|berendezés|csomagol|gyárt|technológ|beruház|vásárol|vennék|cnc|szerszám|jármű|targonca/, g: /eszközbe|gépbe|gépbeszerz|beruház|kapacit|gyárt|technológi|lízing|hitel/i },
    { q: /napelem|energia|energetik|áram|fűt|hőszivattyú|szigetel|korszerűsít|megújul|rezsi/, g: /energ|napelem|megújul|hőszivat|szigetel|geoterm|zöld/i },
    { q: /web|honlap|online|webshop|webáruház|digital|szoftver|rendszer|automatizál|mesterséges|\bai\b|crm|erp|adat/, g: /digit|szoftver|informatik|adat|automat|innov|\bAI\b|kiberbiztons/i },
    { q: /telephely|csarnok|ingatlan|épít|üzem|raktár|bővít|felújít|iroda|műhely/, g: /telephely|ingatlan|csarnok|raktár|felújít|beruház|kapacit/i },
    { q: /képz|oktat|tanf|tréning|betanít|tudás|kompetencia/, g: /képz|oktat|skill|training/i },
    { q: /export|külföld|külpiac|nemzetközi|piacra|kivitel/, g: /export|külpiac|nemzetközi|piacra|eureka|horizon|eic/i },
    { q: /kutat|fejleszt|innovác|prototípus|új termék|szabadalom|k\+f|labor/, g: /kutat|innov|k\+f|fejleszt|szellemi|eic|horizon/i },
    { q: /munkaerő|alkalmazott|munkatárs|felvétel|\bbér|foglalkoztat|munkahely|dolgozó/, g: /foglalkoztat|munkahely|bér|munkaerő/i },
    { q: /mezőgazda|gazda|traktor|állat|növény|föld|borász|élelmiszer|kertész|agrár/, g: /mező|agrár|gazda|élelmiszer|termelő|erdő|hal/i },
    { q: /szálloda|panzió|vendég|étterem|turisztik|szálláshely|kemping|gasztro/, g: /turiz|szálláshely|vendég|étterm|kth/i }
  ];
  function needsLocal(q) {
    var t = q.toLowerCase(), conc = NEED_CONCEPTS.filter(function (c) { return c.q.test(t); });
    var words = t.split(/[^a-záéíóöőúüű0-9]+/i).filter(function (w) { return w.length >= 4; });
    return S.feed.map(function (g) {
      var txt = (g.title + ' ' + (g.cat || '') + ' ' + (g.note || '')).toLowerCase(), s = 0;
      conc.forEach(function (c) { if (c.g.test(g.title)) s += 12; else if (c.g.test(txt)) s += 7; });
      words.forEach(function (w) { if (txt.indexOf(w) >= 0) s += 3; });
      return s > 0 ? { g: g, s: s + rank(g) / 400 } : null;
    }).filter(Boolean).sort(function (a, b) { return b.s - a.s; }).slice(0, 40).map(function (x) { return x.g.id; });
  }
  async function needsSearch(q) {
    S.list.needQ = q; S.list.page = 1;
    if (!q) { S.list.needIds = null; render(); return; }
    var ids = null;
    if (S.user) {
      try {
        var out = await aiCall('needs', { query: q, categories: Array.from(new Set(S.feed.map(function (g) { return g.cat; }))).slice(0, 40) });
        if (out && (out.categories || out.keywords)) {
          var cats = (out.categories || []).map(function (c) { return String(c).toLowerCase(); }), kws = (out.keywords || []).map(function (k) { return String(k).toLowerCase(); }).filter(function (k) { return k.length >= 3; });
          ids = S.feed.map(function (g) {
            var t = (g.title + ' ' + (g.note || '')).toLowerCase(), c = (g.cat || '').toLowerCase(), s = 0;
            if (cats.some(function (x) { return c && (x === c || c.indexOf(x) >= 0 || x.indexOf(c) >= 0); })) s += 12;
            kws.forEach(function (k) { if (t.indexOf(k) >= 0) s += 4; });
            return s > 0 ? { id: g.id, s: s + rank(g) / 400 } : null;
          }).filter(Boolean).sort(function (a, b) { return b.s - a.s; }).slice(0, 40).map(function (x) { return x.id; });
        }
      } catch (e) {}
    }
    if (!ids || !ids.length) ids = needsLocal(q);
    S.list.needIds = ids; S.list.sort = 'fit';
    track('needs-search');
    render();
  }

  VIEWS.mentett = function () {
    var saved = S.feed.filter(function (g) { return S.bookmarks.has(g.id); }).sort(function (a, b) { return (isDate(a.deadline) ? a.deadline : '9').localeCompare(isDate(b.deadline) ? b.deadline : '9'); });
    var gone = Array.from(S.bookmarks).filter(function (id) { return !byId(id); }).length;
    var h = head('Mentett', 'Mentett felhívások', saved.length ? '<button class="btn btn-ghost btn-sm" type="button" data-act="ics-saved">Naptárba (.ics)</button>' : '');
    if (!S.user) h += '<div class="callout"><p><b>A mentések most csak ebben a böngészőben vannak.</b> Regisztráljon, hogy más eszközön is elérje, és értesítést kapjon a változásokról.</p><a class="btn btn-primary" href="signup.html">Ingyenes regisztráció</a></div>';
    h += saved.length ? '<div class="gcards">' + saved.map(function (g) { return callRow(g); }).join('') + '</div>' : '<p class="empty">Még nincs mentett felhívás. A felhívások melletti könyvjelző gombbal mentheti őket.</p>';
    if (gone) h += '<p class="muted">' + gone + ' korábban mentett felhívás időközben lezárult, ezért nem szerepel a listán.</p>';
    if (S.user) h += '<p class="muted small" style="margin-top:var(--s4)">Tipp: a <a href="#/beallitasok">Beállításokban</a> találja az önmagát frissítő naptár-linket is.</p>';
    return h;
  };

  VIEWS.varhato = function () {
    var h = head('Tervezés', 'Várható felhívások');
    h += '<p class="lede" style="margin-bottom:var(--s5)">Hivatalos forrásban bejelentett, de még meg nem nyílt felhívások. Nem lehet még rájuk pályázni; a dátumok tervek, változhatnak.</p>';
    if (!S.expected.length) return h + '<p class="empty">Jelenleg nincs hivatalosan bejelentett, várható felhívás a listánkon.</p>';
    h += '<div class="calls">' + S.expected.map(function (x) {
      var src = safeUrl(x.source);
      return '<div class="call" style="grid-template-columns:minmax(0,1fr) auto"><div><span class="t" style="cursor:default">' + esc(x.title) + '</span><div class="meta">' + esc([x.programme, x.audience].filter(Boolean).join(' · ')) + '</div>' +
        (x.sourceNote ? '<p class="small" style="margin:6px 0 0;color:var(--ink-2)">' + esc(x.sourceNote) + '</p>' : '') +
        (src ? '<p class="small" style="margin:4px 0 0"><a href="' + esc(src) + '" target="_blank" rel="noopener">Forrás ↗</a></p>' : '') + '</div>' +
        '<div class="dl" style="text-align:right">' + esc(x.expectedWindow || '') + (x.amountHint ? '<small>' + esc(x.amountHint) + '</small>' : '') + '</div></div>';
    }).join('') + '</div>';
    return h;
  };

  VIEWS.kereseim = function () {
    var h = head('Konzultáció', 'Konzultációs kéréseim');
    h += '<div id="leads-out"><p class="muted">Betöltés…</p></div>';
    return h;
  };
  var STATUS_HU = { new: 'Beérkezett', sent: 'Továbbítva a partnernek', contacted: 'Felvették Önnel a kapcsolatot', applied: 'Beadták a pályázatot', won: 'Nyert', lost: 'Nem nyert', paid: 'Lezárva', spam: 'Elutasítva' };
  AFTER.kereseim = async function () {
    var local = lsGet('grantpilot:leads', []);
    var rows = [];
    if (S.user) {
      try {
        var r = await window.gp.client.from('leads').select('lead_ref, grant_id, grant_title, status, created_at').eq('user_id', S.user.id).order('created_at', { ascending: false }).limit(100);
        if (!r.error && Array.isArray(r.data)) rows = r.data;
      } catch (e) {}
    }
    if (!rows.length) rows = local.map(function (l) { return { lead_ref: l.ref, grant_id: l.grantId, grant_title: l.grantTitle, status: 'new', created_at: l.ts ? new Date(l.ts).toISOString() : '' }; });
    var o = $('#leads-out'); if (!o) return;
    if (!rows.length) { o.innerHTML = '<p class="empty">Még nem kért konzultációt. Egy felhívás adatlapján egy kattintással kérhet díjmentes konzultációt.</p>'; return; }
    o.innerHTML = '<div class="calls">' + rows.map(function (l) {
      var g = byId(l.grant_id);
      return '<div class="call" style="grid-template-columns:minmax(0,1fr) auto"><div>' + (g ? '<button type="button" class="t" data-open="' + esc(g.id) + '">' + esc(g.title) + '</button>' : '<span class="t" style="cursor:default">' + esc(l.grant_title || l.grant_id) + '</span>') +
        '<div class="meta">' + esc([l.lead_ref, l.created_at ? huDate(String(l.created_at).slice(0, 10)) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="dl" style="text-align:right">' + esc(STATUS_HU[l.status] || l.status || '') + '</div></div>';
    }).join('') + '</div>' + (S.user ? '' : '<p class="muted small" style="margin-top:var(--s4)">Bejelentkezve a kérései állapotát is látja.</p>');
  };

  // ---- drafts
  var DRAFTS_KEY = 'grantpilot:drafts';
  var currentDraft = null;
  VIEWS.vazlat = function () {
    var h = head('AI-eszköz', 'Pályázat-vázlat');
    if (currentDraft) {
      var g = byId(currentDraft.grantId) || { title: currentDraft.grantTitle || '(lezárult felhívás)' };
      h += '<div class="actions no-print"><button class="btn btn-ghost btn-sm" type="button" data-act="draft-back">← Vázlatok</button><button class="btn btn-ghost btn-sm" type="button" data-act="draft-print">Nyomtatás / PDF</button><button class="btn btn-primary btn-sm" type="button" data-act="draft-save">Mentés</button></div>';
      h += '<article class="doc-sheet"><p class="eyebrow">' + (currentDraft.ai ? 'AI-vázlat' : 'Sablon alapú vázlat') + ' · ' + esc(new Date(currentDraft.ts).toLocaleString('hu-HU')) + '</p><h2>' + esc(g.title) + '</h2>' +
        '<div class="notice warn" style="margin:var(--s3) 0 var(--s4)">Kezdő vázlat, nem beadható pályázat. A végleges szöveget, költségvetést és indikátorokat a hivatalos felhívás alapján, pályázatíróval kell véglegesíteni. A szöveg szerkeszthető.</div>' +
        currentDraft.sections.map(function (s, i) { return '<section class="sec"><h3>' + (i + 1) + '. ' + esc(s.title) + '</h3><div contenteditable="true" data-sec="' + i + '">' + s.body + '</div></section>'; }).join('') + '</article>';
      return h;
    }
    var drafts = lsGet(DRAFTS_KEY, []).slice().reverse();
    var opts = S.feed.slice().sort(function (a, b) { return rank(b) - rank(a); }).map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.title.length > 110 ? g.title.slice(0, 107) + '…' : g.title) + '</option>'; }).join('');
    h += '<div class="card" style="margin-bottom:var(--s5)"><h2>Új vázlat</h2><p class="muted">Válasszon felhívást: a cégprofilja alapján elkészítjük a magyar pályázati szerkezetű első vázlatot (9 fejezet, költségvetés-javaslat, indikátorok). ' + (S.user ? '' : 'Bejelentkezve mesterséges intelligencia írja; enélkül sablonból készül.') + '</p>' +
      '<div class="field"><label for="draft-pick">Felhívás</label><select id="draft-pick"><option value="">Válasszon…</option>' + opts + '</select></div><button class="btn btn-primary" type="button" data-act="draft-make">Vázlat készítése</button></div>';
    h += '<div class="section-title"><h2>Mentett vázlatok</h2></div>';
    h += drafts.length ? '<div class="calls">' + drafts.map(function (d) { var g = byId(d.grantId); return '<div class="call" style="grid-template-columns:minmax(0,1fr) auto auto"><div><span class="t" style="cursor:default">' + esc(g ? g.title : d.grantTitle || '(lezárult felhívás)') + '</span><div class="meta">' + esc(new Date(d.ts).toLocaleString('hu-HU')) + '</div></div><button class="btn btn-ghost btn-sm" type="button" data-draft-open="' + esc(d.id) + '">Megnyitás</button><button class="btn btn-quiet btn-sm" type="button" data-draft-del="' + esc(d.id) + '">Törlés</button></div>'; }).join('') + '</div>' : '<p class="empty">Még nincs mentett vázlat.</p>';
    return h;
  };
  function escObj(o) { var r = {}; Object.keys(o || {}).forEach(function (k) { var v = o[k]; r[k] = typeof v === 'string' ? esc(v) : Array.isArray(v) ? v.map(function (x) { return typeof x === 'string' ? esc(x) : x; }) : v; }); return r; }
  function textToHtml(t) { return String(t || '').split(/\n\s*\n+/).map(function (p) { return '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>'; }).join('') || '<p></p>'; }
  async function aiCall(task, payload) {
    if (!window.gp || !window.gp.client || !S.user) throw new Error('anon');
    var r = await window.gp.client.functions.invoke('ai-generate', { body: { task: task, payload: payload } });
    if (r.error) throw r.error;
    if (r.data && r.data.error) throw new Error(r.data.error);
    return r.data;
  }
  async function makeDraft(grantId) {
    var g = byId(grantId); if (!g) return;
    S.view = 'vazlat'; location.hash = '#/vazlat';
    $('#view').innerHTML = head('AI-eszköz', 'Pályázat-vázlat') + '<p class="muted">A vázlat készül… ez 10–20 másodperc lehet.</p>';
    var p = S.profile || {}, sections = null, viaAI = false;
    try {
      var out = await aiCall('draft', { grant: { id: g.id, title: g.title, code: g.code || '', cat: g.cat, amount: g.amount, deadline: g.deadline, source: g.source, issuer: g.issuer || '', type: g.type || '', rate: g.rate || '', note: g.note || '', url: g.url || '' },
        profile: { company: p.company, industry: (p.industries || [])[0] || p.industry, employees: p.employees, revenue: window.revenueLabel ? revenueLabel(p.revenue) : p.revenue, location: p.location, years_operating: p.years_operating, legal_form: p.legal_form } });
      if (out && Array.isArray(out.sections) && out.sections.length >= 5) { sections = out.sections.map(function (s) { return { title: String(s.title || ''), body: textToHtml(s.body) }; }); viaAI = true; }
    } catch (e) {}
    if (!sections) {
      var eg = escObj(g), ep = escObj(p);
      sections = [['Projekt összefoglaló', dr_section_summary], ['Pályázó bemutatása', dr_section_applicant], ['Projekt célja és indokoltsága', dr_section_goals], ['Tervezett tevékenységek', dr_section_activities], ['Indikátorok és vállalások', dr_section_indicators], ['Költségvetés-tervezet', dr_section_budget], ['Megvalósítási ütemterv', dr_section_timeline], ['Fenntarthatósági terv', dr_section_sustainability], ['Kockázatok és kezelésük', dr_section_risks]]
        .map(function (x) { var body = ''; try { body = x[1](eg, ep); } catch (e) { body = '<p></p>'; } return { title: x[0], body: body }; });
    }
    currentDraft = { id: 'D-' + Date.now().toString(36), grantId: g.id, grantTitle: g.title, ts: Date.now(), sections: sections, ai: viaAI };
    track('draft');
    render();
  }

  // ---- settings
  VIEWS.beallitasok = function () {
    var h = head('Fiók', 'Beállítások');
    var p = S.profile || {};
    h += '<div class="set-grid">';
    h += '<section class="card"><h2>Cégprofil</h2>' + (hasProfile() ? '<table class="facts">' + [['Cégnév', p.company], ['Tevékenység', (p.industries || []).map(function (c) { return typeof dr_industryLabel === 'function' ? dr_industryLabel(c) : c; }).join(', ')], ['Létszám', p.employees], ['Régió', p.site_region], ['TEÁOR', p.teaor], ['Lezárt üzleti évek', p.years_operating]].map(function (r) { return '<tr><th>' + r[0] + '</th><td>' + esc(r[1] || '—') + '</td></tr>'; }).join('') + '</table>' : '<p class="muted">Még nincs cégprofil.</p>') + '<p style="margin-top:var(--s4)"><a class="btn btn-primary" href="onboarding.html">' + (hasProfile() ? 'Profil szerkesztése' : 'Cégprofil megadása') + '</a></p></section>';
    if (S.user) {
      h += '<section class="card"><h2>Értesítések</h2><p class="muted small">A leveleket ide küldjük: <b>' + esc(S.user.email) + '</b></p>' +
        '<label class="toggle"><input type="checkbox" id="n-weekly"><span><b>Heti összefoglaló</b><span>Új, Önnek illő felhívások és közelgő határidők.</span></span></label>' +
        '<div class="field" style="margin:4px 0 8px 34px;max-width:240px"><label for="n-freq" class="visually-hidden">Gyakoriság</label><select id="n-freq"><option value="heti">Hetente</option><option value="kétheti">Kéthetente</option><option value="havi">Havonta</option></select></div>' +
        '<label class="toggle"><input type="checkbox" id="n-instant"><span><b>Azonnali értesítés</b><span>Ha új, jól illeszkedő felhívás jelenik meg, vagy egy mentett felhívás keretének 80%-a elfogyott. Legfeljebb napi egy levél.</span></span></label>' +
        '<p class="small" id="n-msg" role="status" style="min-height:1.5em;margin:8px 0 0"></p></section>';
      h += '<section class="card"><h2>Naptár</h2><p class="muted">A mentett felhívások határidői egy önmagát frissítő naptárban (Google, Outlook, Apple). A linket ne ossza meg — aki ismeri, látja a mentett határidőit.</p><div class="copy-row"><input id="cal-url" readonly value="Betöltés…" aria-label="Naptár-link"><button class="btn btn-ghost btn-sm" type="button" data-act="cal-copy">Másolás</button></div><p class="small" style="margin-top:8px"><button class="btn btn-quiet btn-sm" type="button" data-act="cal-rotate">Új link (a régi megszűnik)</button></p></section>';
      h += '<section class="card"><h2>Adatok</h2><p class="muted">Letöltheti a böngészőben tárolt adatait (profil, mentések, vázlatok).</p><button class="btn btn-ghost" type="button" data-act="export">Adataim letöltése (JSON)</button><p style="margin-top:var(--s4)"><button class="btn btn-ghost" type="button" data-act="signout">Kijelentkezés</button></p></section>';
      h += '<section class="card danger-zone"><h2>Fiók törlése</h2><p class="muted">Törli a fiókját, a profilját, a mentéseit és a vázlatait. A konzultációs kérések személyes adatait anonimizáljuk (az állapotukat a partnerrel való elszámolás miatt megőrizzük). Nem visszavonható.</p><button class="btn btn-danger" type="button" data-act="delete-account">Fiók végleges törlése</button><p class="small" id="del-msg" role="alert" style="margin-top:8px"></p></section>';
    } else {
      h += '<section class="card"><h2>Értesítések és fiók</h2><p class="muted">Értesítésekhez, naptár-linkhez és a mentések szinkronizálásához ingyenes fiók kell.</p><a class="btn btn-primary" href="signup.html">Ingyenes regisztráció</a> <a class="btn btn-ghost" href="login.html">Belépés</a></section>';
    }
    h += '</div>';
    return h;
  };
  AFTER.beallitasok = async function () {
    if (!S.user) return;
    var c = window.gp.client;
    try {
      await c.from('notif_prefs').upsert({ user_id: S.user.id }, { onConflict: 'user_id', ignoreDuplicates: true });
      var r = await c.from('notif_prefs').select('weekly_enabled, frequency').eq('user_id', S.user.id).maybeSingle();
      if (r.data) { $('#n-weekly').checked = !!r.data.weekly_enabled; $('#n-freq').value = r.data.frequency || 'heti'; }
      var r2 = await c.from('notif_prefs').select('instant_enabled').eq('user_id', S.user.id).maybeSingle();
      if (r2.data) $('#n-instant').checked = !!r2.data.instant_enabled;
      var r3 = await c.from('notif_prefs').select('calendar_token').eq('user_id', S.user.id).maybeSingle();
      $('#cal-url').value = r3.data && r3.data.calendar_token ? (CFG.functionsUrl + '/calendar?t=' + r3.data.calendar_token) : 'A naptár-link hamarosan elérhető.';
    } catch (e) {}
    var save = async function () {
      var msg = $('#n-msg'); msg.textContent = 'Mentés…';
      var a = await c.from('notif_prefs').update({ weekly_enabled: $('#n-weekly').checked, frequency: $('#n-freq').value }).eq('user_id', S.user.id);
      var b = await c.from('notif_prefs').update({ instant_enabled: $('#n-instant').checked }).eq('user_id', S.user.id);
      msg.textContent = a.error || b.error ? 'A mentés nem sikerült. Kérjük, próbálja újra.' : 'Mentve.';
    };
    ['n-weekly', 'n-freq', 'n-instant'].forEach(function (id) { $('#' + id).addEventListener('change', save); });
  };

  // ---------------------------------------------------------------- detail
  var CHANGE_HU = { new: 'Felkerült a listára', deadline: 'Határidő módosult', keret: 'A keretösszeg módosult', 'szabad-keret': 'A szabad keret változott', removed: 'Lekerült a listáról', page: 'A hivatalos oldal tartalma változott', 'deadline-official': 'Új határidő a hivatalos oldalon' };
  function changeText(c) {
    var v = function (x) { return x == null || x === '' ? '—' : typeof x === 'number' && /keret/.test(c.type) ? ft(x) : isDate(x) ? huDate(x) : String(x); };
    return (CHANGE_HU[c.type] || 'Változás') + (c.from != null || c.to != null ? ': ' + v(c.from) + ' → ' + v(c.to) : '');
  }
  var TAG_HU = { consortium: 'Nemzetközi konzorcium szükséges', women_led: 'Nők által alapított vagy vezetett cégeknek', youth_founder: 'Fiatal alapítóknak', jobseeker: 'Álláskeresők vállalkozásindításához', research_led: 'Kutatóhely a pályázó vagy a vezető partner', rnd_project: 'K+F / innovációs projekt a támogatás tárgya', deeptech: 'Mélytechnológiai (deep-tech) innováció', farmer: 'Mezőgazdasági termelőknek', fisheries: 'Halászati / akvakultúra-vállalkozásoknak', forestry: 'Erdőgazdálkodóknak', tourism_ntak: 'NTAK-regisztrált turisztikai szolgáltatóknak', restaurant: 'Vendéglátóhelyeknek', social_enterprise: 'Társadalmi vállalkozásoknak', cluster_manager: 'Akkreditált klasztermenedzsment-szervezeteknek', employer: 'Alkalmazottat foglalkoztató cégeknek', hires_disadvantaged: 'Célcsoportból felvett munkavállaló bérére', bank_loan: 'Bankon / hitelközvetítőn keresztül igényelhető' };
  var lastFocus = null;
  function openDetail(id) {
    var g = byId(id);
    if (!g) { toast('Ez a felhívás már nem szerepel a nyitott felhívások között.'); if (location.hash.indexOf('#/palyazat/') === 0) history.replaceState(null, '', '#/palyazatok'); return; }
    lastFocus = document.activeElement;
    var m = matchOf(g), d = days(g.deadline), saved = S.bookmarks.has(g.id), url = safeUrl(g.url), pub = publicUrl(g), sum = S.summaries[g.id];
    $('#drawer-eyebrow').textContent = g.code || g.issuer || '';
    var tags = '<div class="tags"><span class="tag brand">' + (g.scope === 'eu' ? 'EU / nemzetközi' : 'Hazai') + '</span><span class="tag">' + esc(TYPE_HU[g.type] || g.type || '') + '</span>' + (d !== null ? '<span class="tag' + (d <= 14 ? ' signal' : '') + '">Határidő: ' + esc(huDate(g.deadline)) + ' · ' + d + ' nap</span>' : '<span class="tag">Folyamatos beadás</span>') + '</div>';
    var h = tags + '<h2 class="title" id="drawer-title">' + esc(g.title) + '</h2>' +
      '<span class="stamp">Forrás: <b>' + esc(g.source || 'hivatalos oldal') + '</b> · ellenőrizve: ' + esc(g.lastChecked || g.verifiedAt || (S.meta.updatedAt || '').slice(0, 10)) + '</span>';
    // verdict
    if (m && m.personal) {
      var v = VERDICT[m.verdict];
      h += '<section class="verdict-box ' + v[0] + '" aria-label="Jogosultság"><div class="verdict-head"><span class="sc">' + m.score + '</span><b>' + esc(v[1]) + '</b>' + (m.group === 'consortium' ? '<span class="muted">Konzorciumi felhívás — partnerek kellenek.</span>' : '') + '</div><ul class="checks">' +
        m.checks.map(function (c) { return '<li class="' + esc(c.status) + '"><span class="mark" aria-hidden="true">' + SYM[c.status] + '</span><span class="what">' + esc(c.label) + '</span><span class="why">' + esc(c.reason) + '</span></li>'; }).join('') + '</ul>' +
        (AIPMatch.missingFields(S.profile).length ? '<p class="small" style="margin:10px 0 0"><a href="onboarding.html">Hiányzó adatok megadása</a> — kevesebb „?” marad.</p>' : '') + '</section>';
    } else {
      h += '<div class="callout" style="margin-top:var(--s5)"><p><b>Jogosult erre a cége?</b> Adja meg a cége adatait, és pontonként megmutatjuk.</p><a class="btn btn-primary" href="onboarding.html">Cégprofil megadása</a></div>';
    }
    h += '<div class="actions"><button class="btn btn-ghost btn-sm" type="button" data-bm="' + esc(g.id) + '" aria-pressed="' + saved + '">' + (saved ? 'Mentve' : 'Mentés') + '</button>' +
      (isDate(g.deadline) ? '<button class="btn btn-ghost btn-sm" type="button" data-ics="' + esc(g.id) + '">Naptárba</button>' : '') +
      (url ? '<a class="btn btn-ghost btn-sm" href="' + esc(url) + '" target="_blank" rel="noopener">Hivatalos oldal ↗</a>' : '') +
      '<button class="btn btn-ghost btn-sm" type="button" data-draft="' + esc(g.id) + '">Pályázat-vázlat</button>' +
      (pub ? '<a class="btn btn-quiet btn-sm" href="' + esc(pub) + '" target="_blank" rel="noopener">Megosztható oldal</a>' : '') + '</div>';
    // facts
    var rows = [['Kiíró', g.issuer], ['Felhívás kódja', g.code], ['Összeg', g.amount], ['Támogatási arány', g.rate], ['Teljes keret', g.keret > 0 ? ft(g.keret) + (typeof g.remaining === 'number' ? ' · még szabad: ' + ft(Math.max(0, g.remaining)) : '') : ''], ['Beadási határidő', huDate(g.deadline)], ['Beadás kezdete', isDate(g.windowOpen) ? huDate(g.windowOpen) : ''], ['Cégméret', (g.sizeClasses || []).join(', ')], ['Régió', (g.regions || []).length ? g.regions.join(', ') : g.scope === 'eu' ? 'EU-s program' : 'Országos']];
    h += '<h3>Alapadatok</h3><table class="facts">' + rows.filter(function (r) { return r[1]; }).map(function (r) { return '<tr><th scope="row">' + r[0] + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    if (g.note) h += '<h3>Röviden</h3><p>' + esc(g.note) + '</p>';
    var req = g.requires || {}, ev = g.requiresEvidence || {};
    var reqItems = Object.keys(req).filter(function (k) { return req[k] !== false && (TAG_HU[k] || k === 'startup_max_years' || k === 'min_revenue_huf'); }).map(function (k) {
      var label = k === 'startup_max_years' ? 'Legfeljebb ' + Number(req[k]) + ' éves cégeknek' : k === 'min_revenue_huf' ? 'Legalább ' + ft(Number(req[k])) + ' árbevétel' : TAG_HU[k];
      return '<li><b>' + esc(label) + '</b>' + (ev[k] ? '<span class="q">„' + esc(ev[k]) + '”</span>' : '') + '</li>';
    });
    if (reqItems.length) h += '<h3>Ki pályázhat?</h3><ul class="req">' + reqItems.join('') + '</ul>';
    if (sum && Array.isArray(sum.sections) && sum.sections.length) {
      h += '<h3>A felhívás röviden</h3><div class="sum">' + sum.sections.map(function (s) { return '<h4>' + esc(s.title) + '</h4><ul>' + (s.items || []).map(function (it) { return '<li>' + esc(it.text) + '<span class="q">„' + esc(it.quote) + '”</span></li>'; }).join('') + '</ul>'; }).join('') + '</div><p class="muted small">AI-összefoglaló a <a href="' + esc(safeUrl(sum.sourceUrl)) + '" target="_blank" rel="noopener">hivatalos szövegből</a>; minden pont alatt a szó szerinti idézet.</p>';
    }
    var ch = S.changes[g.id] || [];
    if (ch.length) h += '<h3>Mi változott?</h3><ul class="log">' + ch.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).slice(0, 10).map(function (c) { return '<li><time>' + esc(huDate(c.date)) + '</time><span>' + esc(changeText(c)) + '</span></li>'; }).join('') + '</ul>';
    h += leadBox(g);
    h += '<div class="notice warn" style="margin-top:var(--s6)">Tájékoztató adatok. Beadás előtt mindig a hivatalos felhívás és annak módosításai az irányadók.</div>';
    $('#drawer-body').innerHTML = h;
    $('#drawer').hidden = false; $('#scrim').hidden = false; document.body.style.overflow = 'hidden';
    $('#drawer').scrollTop = 0;
    $('#drawer-close').focus();
    if (location.hash !== '#/palyazat/' + encodeURIComponent(g.id)) history.pushState(null, '', '#/palyazat/' + encodeURIComponent(g.id));
    mountTurnstile();
    track('call-opened');
  }
  function closeDetail(silent) {
    if ($('#drawer').hidden) return;
    $('#drawer').hidden = true; $('#scrim').hidden = true; document.body.style.overflow = '';
    if (!silent && location.hash.indexOf('#/palyazat/') === 0) history.pushState(null, '', '#/' + (S.view || 'palyazatok'));
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }

  // ---- consultation request
  function leadBox(g) {
    var p = S.profile || {}, partner = CFG.partnerPublic ? esc(CFG.partnerName) : 'pályázatíró partnerünk';
    return '<section class="lead-box" id="lead-box"><h3>Díjmentes konzultáció</h3><p class="muted">Ha pályázna, ' + partner + ' 2 munkanapon belül felveszi Önnel a kapcsolatot, és megnézi, érdemes-e beadni. Nem kötelez semmire.</p>' +
      '<form id="lead-form" data-grant="' + esc(g.id) + '" novalidate>' +
      '<div class="row2"><div class="field"><label for="ld-name">Név <span class="req" style="color:var(--danger)">*</span></label><input id="ld-name" autocomplete="name" value="' + esc(p.contact_name || (S.user && S.user.name) || '') + '"></div>' +
      '<div class="field"><label for="ld-company">Cégnév</label><input id="ld-company" autocomplete="organization" value="' + esc(p.company || '') + '"></div></div>' +
      '<div class="row2"><div class="field"><label for="ld-email">E-mail <span style="color:var(--danger)">*</span></label><input id="ld-email" type="email" autocomplete="email" value="' + esc((S.user && S.user.email) || p.email || '') + '"></div>' +
      '<div class="field"><label for="ld-phone">Telefon <span style="color:var(--danger)">*</span></label><input id="ld-phone" type="tel" autocomplete="tel" value="' + esc(p.phone || '') + '"></div></div>' +
      '<div class="field"><label for="ld-msg">Röviden a tervezett projektről <span class="muted">(nem kötelező)</span></label><textarea id="ld-msg" maxlength="2000" placeholder="Pl. új gyártósor, kb. 40 M Ft, jövő tavasszal indulna.">' + esc(p.notes || '') + '</textarea></div>' +
      '<label class="check" style="margin-bottom:var(--s4)"><input type="checkbox" id="ld-consent"><span>Hozzájárulok, hogy az AIpályázó a fenti adataimat és a jogosultsági ellenőrzés eredményét továbbítsa a pályázatíró partnernek a kapcsolatfelvétel céljából. <a href="adatvedelem.html" target="_blank" rel="noopener">Részletek</a></span></label>' +
      '<div id="ts-box" style="margin-bottom:var(--s3)"></div>' +
      '<p class="form-error" id="ld-err" role="alert" hidden></p>' +
      '<button class="btn btn-primary" type="submit" id="ld-btn">Konzultációt kérek</button></form></section>';
  }
  var tsToken = '';
  function mountTurnstile() {
    tsToken = '';
    if (!CFG.turnstileSiteKey || !$('#ts-box')) return;
    var render = function () { try { window.turnstile.render('#ts-box', { sitekey: CFG.turnstileSiteKey, language: 'hu', callback: function (t) { tsToken = t; } }); } catch (e) {} };
    if (window.turnstile) return render();
    if (!document.getElementById('ts-script')) { var s = document.createElement('script'); s.id = 'ts-script'; s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.onload = render; document.head.appendChild(s); }
  }
  async function submitLead(form) {
    var g = byId(form.getAttribute('data-grant')); if (!g) return;
    var err = $('#ld-err'), btn = $('#ld-btn'); err.hidden = true;
    var v = function (id) { return ($('#' + id).value || '').trim(); };
    var name = v('ld-name'), email = v('ld-email').toLowerCase(), phone = v('ld-phone');
    var bad = [];
    if (name.length < 2) bad.push(['ld-name', 'Adja meg a nevét.']);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad.push(['ld-email', 'Adjon meg egy érvényes e-mail-címet.']);
    if (phone.replace(/\D/g, '').length < 6) bad.push(['ld-phone', 'Adja meg a telefonszámát — ezen keresi Önt a pályázatíró.']);
    if (!$('#ld-consent').checked) bad.push(['ld-consent', 'A továbbításhoz a hozzájárulása szükséges.']);
    if (CFG.turnstileSiteKey && !tsToken) bad.push(['ts-box', 'Kérjük, igazolja, hogy nem robot.']);
    if (bad.length) { err.textContent = bad[0][1]; err.hidden = false; var el = $('#' + bad[0][0]); if (el && el.focus) el.focus(); return; }
    var m = matchOf(g), p = S.profile || {};
    var attr = window.AIPAttr && AIPAttr.get();
    var body = { attribution: attr ? { source: attr.source, campaign: attr.campaign, medium: attr.medium } : undefined, grantId: g.id, grantTitle: g.title, name: name, email: email, phone: phone, company: v('ld-company'), message: v('ld-msg'), consent: true, turnstileToken: tsToken || undefined,
      match: m && m.personal ? { score: m.score, verdict: m.verdict, checks: m.checks.map(function (c) { return { key: c.key, status: c.status, reason: c.reason, label: c.label }; }), profile: { company: p.company, employees: p.employees, site_region: p.site_region, teaor: p.teaor, years_operating: p.years_operating } } : undefined };
    btn.disabled = true; btn.textContent = 'Küldés…';
    var res = null, status = 0;
    try {
      var token = null;
      if (S.user) { try { token = (await window.gp.client.auth.getSession()).data.session.access_token; } catch (e) {} }
      var anon = typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '';
      var r = await fetch(CFG.functionsUrl + '/lead-submit', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: 'Bearer ' + (token || anon) }, body: JSON.stringify(body) });
      status = r.status; res = await r.json().catch(function () { return {}; });
    } catch (e) { status = 0; }
    btn.disabled = false; btn.textContent = 'Konzultációt kérek';
    if (status === 200 && res && res.ok) {
      var leads = lsGet('grantpilot:leads', []); leads.push({ ref: res.ref, grantId: g.id, grantTitle: g.title, ts: Date.now() }); lsSet('grantpilot:leads', leads);
      $('#lead-box').innerHTML = '<div class="lead-done" role="status"><b>Köszönjük, megkaptuk.</b><span class="ref">' + esc(res.ref || '') + '</span><span>' + (res.duplicate ? 'Erre a felhívásra már korábban is kért konzultációt; a meglévő kérését kezeljük.' : 'Pályázatíró partnerünk 2 munkanapon belül felveszi Önnel a kapcsolatot. A visszaigazolást e-mailben is elküldtük.') + '</span></div>';
      track('lead-sent');
      return;
    }
    var msg = status === 429 ? 'Rövid időn belül túl sok kérés érkezett erről a címről. Kérjük, próbálja később, vagy írjon nekünk.'
      : status === 403 ? 'A robotszűrő nem engedte át a kérést. Kérjük, próbálja újra.'
      : status === 400 ? 'Kérjük, ellenőrizze a megadott adatokat' + (res && res.field ? ' (' + esc(res.field) + ')' : '') + '.'
      : 'A kérést most nem sikerült elküldeni.';
    var mail = 'mailto:info@aipalyazo.hu?subject=' + encodeURIComponent('Konzultációs kérés: ' + g.title) + '&body=' + encodeURIComponent('Név: ' + name + '\nE-mail: ' + email + '\nTelefon: ' + phone + '\nFelhívás: ' + g.title + ' (' + (g.code || g.id) + ')');
    err.innerHTML = esc(msg) + ' Írhat nekünk közvetlenül is: <a href="' + esc(mail) + '">info@aipalyazo.hu</a>';
    err.hidden = false;
    if (window.turnstile && CFG.turnstileSiteKey) try { window.turnstile.reset('#ts-box'); tsToken = ''; } catch (e) {}
  }

  // ---------------------------------------------------------------- ics
  function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/[;,]/g, function (m) { return '\\' + m; }).replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '\\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); }
  function icsFold(line) { var out = []; while (line.length > 73) { out.push(line.slice(0, 73)); line = ' ' + line.slice(73); } out.push(line); return out.join('\r\n'); }
  function downloadICS(list, filename) {
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AIpalyazo//Hataridok//HU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:AIpályázó határidők'], n = 0;
    list.forEach(function (g) {
      if (!isDate(g.deadline)) return;
      var next = new Date(g.deadline + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
      var link = 'https://aipalyazo.hu/aipalyazo/portal.html?grant=' + encodeURIComponent(g.id);
      L.push('BEGIN:VEVENT', 'UID:' + String(g.id).replace(/[^A-Za-z0-9._-]/g, '_') + '@aipalyazo.hu', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + g.deadline.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + next.toISOString().slice(0, 10).replace(/-/g, ''),
        'SUMMARY:' + icsEscape('Pályázati határidő: ' + g.title), 'DESCRIPTION:' + icsEscape((g.amount ? 'Összeg: ' + g.amount + '\n' : '') + 'Hivatalos oldal: ' + (safeUrl(g.url) || '—') + '\nAIpályázó: ' + link + '\nA határidőt mindig ellenőrizze a hivatalos kiírásban.'), 'URL:' + link,
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape('2 hét múlva lejár: ' + g.title), 'TRIGGER:-P14D', 'END:VALARM', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape('3 nap múlva lejár: ' + g.title), 'TRIGGER:-P3D', 'END:VALARM', 'END:VEVENT');
      n++;
    });
    L.push('END:VCALENDAR');
    if (!n) { toast('Nincs letölthető határidő (a folyamatos beadású felhívásoknak nincs dátuma).'); return; }
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([L.map(icsFold).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' })); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-open],[data-bm],[data-ics],[data-draft],[data-act],[data-scope],[data-cat],[data-need],[data-more],[data-draft-open],[data-draft-del]');
    if (!t) return;
    if (t.hasAttribute('data-open')) { e.preventDefault(); openDetail(t.getAttribute('data-open')); return; }
    if (t.hasAttribute('data-bm')) { e.preventDefault(); toggleBookmark(t.getAttribute('data-bm')); if (t.closest('.actions')) t.textContent = S.bookmarks.has(t.getAttribute('data-bm')) ? 'Mentve' : 'Mentés'; return; }
    if (t.hasAttribute('data-ics')) { var g = byId(t.getAttribute('data-ics')); if (g) downloadICS([g], 'aipalyazo-hatarido.ics'); return; }
    if (t.hasAttribute('data-draft')) { closeDetail(true); makeDraft(t.getAttribute('data-draft')); return; }
    if (t.hasAttribute('data-scope')) { e.preventDefault(); S.list.scope = t.getAttribute('data-scope'); S.list.page = 1; if (S.view !== 'palyazatok') { location.hash = '#/palyazatok'; } else render(); return; }
    if (t.hasAttribute('data-cat')) { S.list.cat = t.getAttribute('data-cat'); S.list.page = 1; $$('.catpills button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); renderList(); return; }
    if (t.hasAttribute('data-need')) { S.list.q = ''; var q = t.getAttribute('data-need'); var inp = $('#needs-q'); if (inp) inp.value = q; needsSearch(q); return; }
    if (t.hasAttribute('data-more')) { S.list.page++; renderList(); return; }
    if (t.hasAttribute('data-draft-open')) { currentDraft = lsGet(DRAFTS_KEY, []).filter(function (d) { return d.id === t.getAttribute('data-draft-open'); })[0] || null; render(); return; }
    if (t.hasAttribute('data-draft-del')) { if (confirm('Biztosan törli ezt a vázlatot?')) { lsSet(DRAFTS_KEY, lsGet(DRAFTS_KEY, []).filter(function (d) { return d.id !== t.getAttribute('data-draft-del'); })); render(); } return; }
    var act = t.getAttribute('data-act');
    if (act === 'signout') return signOut();
    if (act === 'ics-saved') return downloadICS(S.feed.filter(function (g) { return S.bookmarks.has(g.id); }), 'aipalyazo-mentett-hataridok.ics');
    if (act === 'draft-make') { var id = $('#draft-pick').value; if (!id) { toast('Válasszon felhívást.'); return; } return makeDraft(id); }
    if (act === 'draft-back') { currentDraft = null; return render(); }
    if (act === 'draft-print') return window.print();
    if (act === 'draft-save') { $$('[data-sec]').forEach(function (el) { currentDraft.sections[+el.getAttribute('data-sec')].body = el.innerHTML; }); var ds = lsGet(DRAFTS_KEY, []).filter(function (d) { return d.id !== currentDraft.id; }); currentDraft.ts = Date.now(); ds.push(currentDraft); lsSet(DRAFTS_KEY, ds); toast('Vázlat mentve ebben a böngészőben.'); return; }
    if (act === 'cal-copy') { var ci = $('#cal-url'); ci.select(); try { await navigator.clipboard.writeText(ci.value); toast('Link másolva.'); } catch (x) { document.execCommand('copy'); } return; }
    if (act === 'cal-rotate') { if (!confirm('Új naptár-linket kér? A régi link azonnal megszűnik.')) return; try { var rr = await window.gp.client.rpc('rotate_calendar_token'); if (rr.error) throw rr.error; render(); toast('Új naptár-link elkészült.'); } catch (x) { toast('Most nem sikerült új linket kérni.'); } return; }
    if (act === 'export') { var data = { exportedAt: new Date().toISOString(), profile: S.profile, bookmarks: Array.from(S.bookmarks), drafts: lsGet(DRAFTS_KEY, []), leads: lsGet('grantpilot:leads', []) }; var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'aipalyazo-adataim.json'; document.body.appendChild(a); a.click(); a.remove(); return; }
    if (act === 'delete-account') return deleteAccount();
  });
  document.addEventListener('submit', function (e) { if (e.target && e.target.id === 'lead-form') { e.preventDefault(); submitLead(e.target); } });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (!$('#drawer').hidden) closeDetail(); else setRail(false); }
    if (e.key === 'Tab' && !$('#drawer').hidden) {
      var f = $$('#drawer a[href], #drawer button:not([disabled]), #drawer input, #drawer select, #drawer textarea, #drawer [tabindex]:not([tabindex="-1"])').filter(function (x) { return x.offsetParent; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  $('#drawer-close').addEventListener('click', function () { closeDetail(); });
  $('#scrim').addEventListener('click', function () { closeDetail(); });
  $('#rail-toggle').addEventListener('click', function () { setRail(!$('#rail').classList.contains('open')); });
  $('#rail-scrim').addEventListener('click', function () { setRail(false); });
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', function () { if (location.hash.indexOf('#/palyazat/') !== 0) closeDetail(true); });

  async function deleteAccount() {
    var msg = $('#del-msg');
    if (!confirm('Biztosan véglegesen törli a fiókját? Ez nem visszavonható.')) return;
    msg.textContent = 'Törlés folyamatban…';
    var res = null, status = 0;
    try {
      var s = (await window.gp.client.auth.getSession()).data.session;
      var r = await fetch(CFG.functionsUrl + '/delete-user', { method: 'POST', headers: { Authorization: 'Bearer ' + s.access_token, apikey: typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '', 'Content-Type': 'application/json' } });
      status = r.status; res = await r.json().catch(function () { return {}; });
    } catch (e) { status = 0; }
    if (status === 200 && res && res.ok) {
      msg.textContent = 'Fiók véglegesen törölve.';
      setTimeout(signOut, 1200);
    } else if (status === 500 && res && res.dataDeleted) {
      msg.textContent = 'Személyes adatait töröltük, de a bejelentkezési fiók törlése nem sikerült. Kérjük, próbálja újra később, vagy írjon az info@aipalyazo.hu címre.';
    } else {
      msg.textContent = 'A fiók törlése nem sikerült, adatai nem törlődtek teljesen. Kérjük, próbálja újra, vagy írjon az info@aipalyazo.hu címre.';
    }
  }

  // ---------------------------------------------------------------- boot
  (async function boot() {
    // ?grant=<id> links (e-mails, public pages) become #/palyazat/<id>
    try {
      var qs = new URLSearchParams(location.search), gid = qs.get('grant');
      if (gid) history.replaceState(null, '', location.pathname + '#/palyazat/' + encodeURIComponent(gid));
    } catch (e) {}
    render();
    await loadData();
    S.ready = true;
    updateShell();
    route();
    await resolveUser();
    updateShell();
    if (!$('#drawer').hidden) { var id = parseHash().id; render(); if (id) openDetail(id); } else render();
  })();
})();
