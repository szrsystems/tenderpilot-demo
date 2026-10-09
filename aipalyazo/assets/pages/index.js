/* index.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
(function () {
  'use strict';
  var TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  var FEED = [], SLUGS = {};
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function days(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? Math.round((Date.parse(d) - Date.parse(TODAY)) / 864e5) : null; }
  function huDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d.slice(0, 4) + '. ' + d.slice(5, 7) + '. ' + d.slice(8, 10) + '.' : 'folyamatos'; }
  function ft(n) { return n >= 1e9 ? (n / 1e9).toFixed(0) + ' Mrd Ft' : Math.round(n / 1e6) + ' M Ft'; }
  function pageUrl(g) { return SLUGS[g.id] ? 'palyazat/' + encodeURIComponent(SLUGS[g.id]) + '.html' : 'portal.html?grant=' + encodeURIComponent(g.id); }
  var TYPE = { grant: 'vissza nem térítendő', loan: 'hitel', 'loan+grant': 'hitel + támogatás', equity: 'tőkebefektetés', guarantee: 'garancia', 'wage-subsidy': 'bértámogatás', 'in-kind': 'szolgáltatás', 'grant+equity': 'támogatás + tőke' };

  function card(g, extra) {
    var C = window.AIPCards;
    return '<article class="gcard"><div class="gc-head">' + C.srcTag(g) + '<div class="gc-main"><a class="gc-title" href="' + pageUrl(g) + '">' + esc(g.title) + '</a><div class="gc-sub">' + esc([g.code, g.issuer].filter(Boolean).join(' · ')) + '</div><div class="badges">' + C.badges(g, { today: TODAY }) + '</div></div><div class="gc-side"><div><div class="gc-amt-label">Támogatás</div><div class="gc-amt">' + esc(g.amount || '—') + '</div></div></div></div>' + C.bars(g, { today: TODAY }) + (extra || '') + '</article>';
  }

  Promise.all([
    fetch('grants_live.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : []; }),
    fetch('grants-meta.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
    fetch('palyazat/pages.json').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
  ]).then(function (res) {
    FEED = (Array.isArray(res[0]) ? res[0] : []).filter(function (g) { var d = days(g.deadline); return d === null || d >= 0; });
    Object.keys(res[2] || {}).forEach(function (slug) { var m = res[2][slug]; if (m && m.id && !m.closedAt) SLUGS[m.id] = slug; });
    figures(res[1] || {});
    ruler();
  }).catch(function () { $('[data-asof]').textContent = 'Az adatok most nem tölthetők be. Próbálja újra később.'; });

  function figures(meta) {
    var hu = FEED.filter(function (g) { return g.scope !== 'eu'; });
    var soon = FEED.filter(function (g) { var d = days(g.deadline); return d !== null && d <= 30; });
    var budget = hu.reduce(function (s, g) { return s + (typeof g.remaining === 'number' && g.remaining > 0 ? g.remaining : 0); }, 0);
    $('[data-fig="open"]').textContent = FEED.length;
    $('[data-fig="hu"]').textContent = hu.length;
    $('[data-fig="soon"]').textContent = soon.length;
    $('[data-fig="budget"]').textContent = budget ? ft(budget) : '—';
    var at = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    $('[data-asof]').textContent = 'Frissítve: ' + (at || TODAY) + ' · Forrás: palyazat.gov.hu, EU Funding & Tenders, kiírói oldalak';
  }

  // ---- quick check ----
  $('#quick').addEventListener('submit', function (e) {
    e.preventDefault();
    var p = { company: 'gyors-ellenorzes', industries: [$('#q-sector').value], employees: $('#q-emp').value, years_operating: $('#q-years').value, site_region: $('#q-region').value };
    var err = $('#q-err');
    if (!p.industries[0] || !p.employees || !p.years_operating || !p.site_region) { err.hidden = false; return; }
    err.hidden = true;
    if (!FEED.length || !window.AIPMatch) { $('#results').hidden = false; $('#results').innerHTML = '<p class="notice warn">Az adatok még töltődnek — próbálja újra pár másodperc múlva.</p>'; return; }
    var rows = FEED.map(function (g) { return { g: g, m: AIPMatch.match(g, p, TODAY) }; }).filter(function (x) { return x.m.eligible; });
    // Verdict first, then score; a domestic call wins only a tie (+3).
    var rank = function (x) { return (x.m.verdict === 'APPLY' ? 1000 : 0) + (x.m.group === 'hazai' ? 3 : 0) + x.m.score; };
    var single = rows.filter(function (x) { return x.m.group !== 'consortium'; }).sort(function (a, b) { return rank(b) - rank(a); });
    var good = single.filter(function (x) { return x.m.verdict === 'APPLY'; });
    var grants = good.filter(function (x) { return /grant|wage/.test(x.g.type) && x.g.type !== 'grant+equity' || x.g.type === 'loan+grant'; });
    var consortium = rows.length - single.length;
    try { localStorage.setItem('aip:quick', JSON.stringify(p)); } catch (e2) {}
    if (window.aipTrack) aipTrack('quick-check');
    var html = '<p class="result-sum"><b>' + good.length + '</b> felhívás illik jól a cégéhez' + (grants.length ? ', ebből <b>' + grants.length + '</b> vissza nem térítendő vagy kombinált' : '') + '.' + (consortium ? ' <span class="muted">További ' + consortium + ' nemzetközi konzorciumi felhívás külön listában.</span>' : '') + '</p>';
    html += '<div class="gcards">' + single.slice(0, 4).map(function (x) {
      var marks = x.m.checks.filter(function (c) { return ['ok', 'fail', 'unknown', 'warn'].indexOf(c.status) >= 0; }).slice(0, 6).map(function (c) {
        var sym = { ok: '✓', fail: '✗', unknown: '?', warn: '!' }[c.status];
        return '<span class="' + c.status + '">' + sym + ' ' + esc(c.label) + '</span>';
      }).join('');
      return card(x.g, '<div class="marks">' + marks + '</div>');
    }).join('') + '</div>';
    html += '<div class="results-foot"><a class="btn btn-primary" href="signup.html?from=quick">Teljes lista, értesítések — ingyenes regisztráció</a><p class="tiny muted" style="margin:0">A „?” pontokat a teljes profilban tudja pontosítani (TEÁOR, köztartozás, önerő). Adószám alapján a cégadatokat kitöltjük.</p></div>';
    var box = $('#results'); box.innerHTML = html; box.hidden = false;
    box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  });

  // ---- next deadlines (simple list) ----
  function ruler() {
    var items = FEED.filter(function (g) { var d = days(g.deadline); return d !== null && d >= 0 && d <= 90 && !(window.AIPMatch && AIPMatch.isConsortium(g)); })
      .sort(function (a, b) { return a.deadline.localeCompare(b.deadline); });
    var pick = items.filter(function (g) { return g.scope !== 'eu'; }).slice(0, 3).concat(items.filter(function (g) { return g.scope === 'eu'; }).slice(0, 2))
      .sort(function (a, b) { return a.deadline.localeCompare(b.deadline); });
    $('#next-deadlines').innerHTML = pick.length ? pick.map(function (g) { return card(g); }).join('') : '<p class="muted" style="text-align:center">Nincs határidő a következő 90 napban.</p>';
  }
})();
