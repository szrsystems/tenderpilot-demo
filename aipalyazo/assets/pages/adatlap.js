/* adatlap.html — detailed eligibility sheet (DFT model). Renders the form
 * from lib/elig-schema.js, keeps the answers in profile.elig (browser) and
 * profiles.elig (server), and shows live how the matches change. */
(function () {
  'use strict';
  var EL = window.AIPElig, M = window.AIPMatch;
  var $ = function (id) { return document.getElementById(id); };
  var TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var profile = lsGet('grantpilot:profile') || {};
  var E = Object.assign({}, profile.elig || lsGet('aip:elig') || {});
  var FEED = [], user = null, dirty = false;
  if (!Array.isArray(E.fin)) E.fin = [{}, {}];
  while (E.fin.length < 2) E.fin.push({});
  if (!Array.isArray(E.links)) E.links = [];

  // sensible defaults from the short profile (shown, saved only if kept)
  function defaults() {
    var lf = profile.legal_form;
    if (!E.org_type && lf) E.org_type = lf === 'EV' ? 'egyeni_vallalkozo' : lf === 'Szövetkezet' ? 'szovetkezet' : lf === 'Egyéb' ? '' : 'gazdasagi_tarsasag';
    if (!E.project_postcode) { var m = String(profile.location || '').match(/\b(\d{4})\b/); if (m) { E.project_postcode = m[1]; if (!E.project_city) E.project_city = String(profile.location).replace(m[0], '').replace(/[,]/g, ' ').trim().split(/\s{2,}|,/)[0] || ''; } }
  }

  // ---------------------------------------------------------------- render
  function control(f) {
    var v = E[f.id], id = 'e_' + f.id;
    if (f.type === 'sel') return '<select id="' + id + '" data-k="' + f.id + '"><option value="">Válasszon…</option>' + f.opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (v === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    if (f.type === 'date') return '<input type="date" id="' + id + '" data-k="' + f.id + '" value="' + esc(v || '') + '" max="' + TODAY + '">';
    if (f.type === 'num') return '<div class="unit"><input type="text" inputmode="decimal" id="' + id + '" data-k="' + f.id + '" value="' + esc(v || '') + '"><span>' + esc(f.unit) + '</span></div>';
    return '<input type="text" id="' + id + '" data-k="' + f.id + '" value="' + esc(Array.isArray(v) ? v.join(', ') : (v || '')) + '"' + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + '>';
  }
  function fieldHtml(f) {
    if (f.type === 'checks') {
      var sel = Array.isArray(E[f.id]) ? E[f.id] : [];
      return '<fieldset class="field" style="grid-column:1/-1;border:0;padding:0;margin:0 0 var(--s4)"><legend class="label">' + esc(f.label) + '</legend><div class="checks">' +
        f.opts.map(function (o) { return '<label><input type="checkbox" data-multi="' + f.id + '" value="' + esc(o[0]) + '"' + (sel.indexOf(o[0]) >= 0 ? ' checked' : '') + '><span>' + esc(o[1]) + '</span></label>'; }).join('') +
        '<label class="none"><input type="checkbox" data-none="' + f.none + '"' + (E[f.none] === true ? ' checked' : '') + '><span>' + esc(f.noneLabel) + '</span></label></div></fieldset>';
    }
    if (f.type === 'fin') {
      var ths = '<thead><tr><th></th><th>Utolsó lezárt év</th><th>Előző év</th></tr></thead>';
      var rows = EL.FIN_ROWS.map(function (r) {
        return '<tr><th scope="row">' + esc(r[1]) + (r[2] !== 'fő' ? '' : ' <small>' + esc(r[2]) + '</small>') + '</th>' + [0, 1].map(function (i) { return '<td><input type="text" inputmode="' + (r[0] === 'year' ? 'numeric' : 'decimal') + '" data-fin="' + i + '" data-c="' + r[0] + '" value="' + esc((E.fin[i] || {})[r[0]] || '') + '" aria-label="' + esc(r[1] + ' — ' + (i ? 'előző év' : 'utolsó lezárt év')) + '"' + (r[0] === 'year' ? ' placeholder="' + (new Date().getFullYear() - 1 - i) + '"' : '') + '></td>'; }).join('') + '</tr>';
      }).join('');
      return '<div style="grid-column:1/-1;overflow-x:auto"><table class="fin">' + ths + '<tbody>' + rows + '</tbody></table><p class="hint">Az összegek ezer forintban (eFt), ahogy a beszámolóban szerepelnek. Negatív értéket mínuszjellel írjon (pl. −1200).</p><div class="calc" id="calc-fin" hidden></div></div>';
    }
    if (f.type === 'links') {
      return '<div style="grid-column:1/-1"><div id="links"></div><p><button class="btn btn-ghost btn-sm" type="button" id="link-add">+ Vállalkozás hozzáadása</button></p>' +
        '<label class="check"><input type="checkbox" data-none="links_none"' + (E.links_none === true ? ' checked' : '') + '><span>Nincs 25%-os vagy nagyobb tulajdoni kapcsolat más vállalkozással</span></label>' +
        '<p class="hint">Csak a 25%-os vagy nagyobb részesedéseket adja meg. Magánszemély tulajdonost nem kell felsorolni, csak ha más cégekben is 50% felett tulajdonos.</p><div class="calc" id="calc-group" hidden></div></div>';
    }
    return '<div class="field"><label for="e_' + f.id + '">' + esc(f.label) + '</label>' + control(f) + (f.hint ? '<p class="hint">' + esc(f.hint) + '</p>' : '') + '</div>';
  }
  function linksHtml() {
    return E.links.map(function (l, i) {
      return '<div class="link-row"><div class="link-grid">' + EL.LINK_COLS.map(function (c) {
        var v = l[c[0]] == null ? '' : l[c[0]], ctl;
        if (c[2] === 'sel') ctl = '<select data-link="' + i + '" data-c="' + c[0] + '"><option value="">—</option>' + c[3].map(function (o) { return '<option value="' + o[0] + '"' + (v === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
        else ctl = '<input type="text"' + (c[2] === 'num' ? ' inputmode="decimal"' : '') + ' data-link="' + i + '" data-c="' + c[0] + '" value="' + esc(v) + '">';
        return '<div' + (c[0] === 'name' ? ' class="wide"' : '') + '><label>' + esc(c[1]) + '</label>' + ctl + '</div>';
      }).join('') + '</div><button class="link-del" type="button" data-del="' + i + '">Törlés</button></div>';
    }).join('');
  }
  function render() {
    $('al-form').innerHTML = EL.SECTIONS.map(function (s) {
      return '<section class="sec" id="s-' + s.id + '"><div class="sec-head"><h2>' + esc(s.title) + '</h2><span class="sec-count" data-count="' + s.id + '"></span></div><p class="sec-lede">' + esc(s.lede) + '</p><div class="grid2">' + s.fields.map(fieldHtml).join('') + '</div></section>';
    }).join('');
    $('links').innerHTML = linksHtml();
    $('side-nav').innerHTML = EL.SECTIONS.map(function (s) { return '<li data-nav="' + s.id + '"><a href="#s-' + s.id + '">' + esc(s.title) + '</a><span></span></li>'; }).join('');
  }

  // ---------------------------------------------------------------- state
  function onInput(ev) {
    var t = ev.target;
    if (t.dataset.k) { E[t.dataset.k] = t.value; }
    else if (t.dataset.multi) {
      var k = t.dataset.multi;
      E[k] = Array.prototype.slice.call(document.querySelectorAll('[data-multi="' + k + '"]:checked')).map(function (x) { return x.value; });
      var f = EL.SECTIONS.reduce(function (a, s) { return a.concat(s.fields); }, []).filter(function (x) { return x.id === k; })[0];
      if (E[k].length && f && f.none) { E[f.none] = false; var n = document.querySelector('[data-none="' + f.none + '"]'); if (n) n.checked = false; }
    } else if (t.dataset.none) {
      E[t.dataset.none] = t.checked;
      if (t.checked && t.dataset.none === 'proceedings_none') { E.proceedings = []; document.querySelectorAll('[data-multi="proceedings"]').forEach(function (x) { x.checked = false; }); }
      if (t.checked && t.dataset.none === 'links_none') { E.links = []; $('links').innerHTML = ''; }
    } else if (t.dataset.fin) { E.fin[+t.dataset.fin][t.dataset.c] = t.value; }
    else if (t.dataset.link) { E.links[+t.dataset.link][t.dataset.c] = t.value; }
    else return;
    dirty = true; $('save-status').textContent = 'Nem mentett módosítás';
    refresh();
  }
  function onClick(ev) {
    var t = ev.target;
    if (t.id === 'link-add') {
      if (E.links.length >= EL.MAX_LINKS) return;
      E.links.push({ rel: 'tulajdonos' }); E.links_none = false;
      var n = document.querySelector('[data-none="links_none"]'); if (n) n.checked = false;
      $('links').innerHTML = linksHtml(); dirty = true; refresh();
      var last = document.querySelector('[data-link="' + (E.links.length - 1) + '"][data-c="name"]'); if (last) last.focus();
    } else if (t.dataset && t.dataset.del != null) {
      E.links.splice(+t.dataset.del, 1); $('links').innerHTML = linksHtml(); dirty = true; refresh();
    }
  }

  // live feedback: completeness, computed values, matches
  var timer = null;
  function refresh() {
    var c = EL.completeness(EL.clean(E));
    $('prog-bar').style.width = c.pct + '%';
    $('prog-text').textContent = c.done + ' / ' + c.total + ' kérdés megválaszolva (' + c.pct + '%)';
    EL.SECTIONS.forEach(function (s) {
      var p = c.per[s.id], txt = p.done + '/' + p.total, full = p.done === p.total;
      var a = document.querySelector('[data-count="' + s.id + '"]'); if (a) { a.textContent = txt; a.classList.toggle('full', full); }
      var li = document.querySelector('[data-nav="' + s.id + '"]'); if (li) { li.querySelector('span').textContent = txt; li.classList.toggle('full', full); }
    });
    clearTimeout(timer); timer = setTimeout(computeAndMatch, 150);
  }
  function computeAndMatch() {
    if (!M) return;
    var base = Object.assign({}, profile, { company: profile.company || 'x' });
    var d = M.derive(Object.assign({}, base, { elig: EL.clean(E) }), TODAY);
    var TL = { micro: 'mikrovállalkozás', small: 'kisvállalkozás', mid: 'középvállalkozás', large: 'nagyvállalkozás (nem KKV)' };
    var cf = $('calc-fin'), parts = [];
    if (d._tier) parts.push('Cégméret az EU-s KKV-definíció szerint: <b>' + TL[d._tier] + '</b> (' + esc(d._tierBasis) + ').');
    if (typeof d._years === 'number') parts.push('Lezárt, teljes üzleti évek: <b>' + d._years + '</b>.');
    if (d._difficultyCalc) parts.push('<b>Figyelem:</b> a saját tőke a jegyzett tőke felénél kisebb — ez „nehéz helyzetű vállalkozást” jelent, amely a legtöbb támogatásból kizár.');
    else if (typeof d._equity === 'number' && d._equity < 0) parts.push('<b>Figyelem:</b> negatív saját tőke — hazai támogatás így nem adható.');
    if (cf) { cf.innerHTML = parts.join(' '); cf.hidden = !parts.length; }
    var cg = $('calc-group');
    if (cg) {
      var linked = (E.links || []).filter(function (l) { return +String(l.pct || '').replace(',', '.') >= 25; });
      cg.hidden = !linked.length;
      cg.innerHTML = linked.length ? (linked.length + ' kapcsolt / partnervállalkozás számít bele a KKV-méretbe.' + (d._tier ? ' Csoportszintű besorolás: <b>' + TL[d._tier] + '</b>.' : ' A besoroláshoz töltse ki a létszámot és az árbevételt vagy a mérlegfőösszeget (itt és a beszámoló adatainál).')) : '';
    }
    if (!FEED.length) return;
    var before = 0, after = 0, excluded = 0;
    FEED.forEach(function (g) {
      var a = M.match(g, base, TODAY), b = M.match(g, Object.assign({}, base, { elig: EL.clean(E) }), TODAY);
      if (a.verdict === 'APPLY') before++;
      if (b.verdict === 'APPLY') after++;
      if (a.eligible && !b.eligible) excluded++;
    });
    $('impact').hidden = !(profile.company || profile.employees);
    $('impact-apply').textContent = after;
    $('impact-label').textContent = 'felhívás illik jól';
    $('impact-sub').textContent = (after === 0 && before === 0 ? 'Most nincs olyan nyitott felhívás, amelyre egyértelműen jogosult és a témája is illik. A portálon az „Érdemes megnézni” jelölésűeket nézze át.' : 'Az adatlap nélkül: ' + before + '.') + (excluded ? ' Az adatlap alapján ' + excluded + ' felhívás kiesett, mert nem felel meg a feltételeinek.' : '');
  }

  // ---------------------------------------------------------------- save
  async function save() {
    var clean = EL.clean(E);
    profile.elig = clean; lsSet('grantpilot:profile', profile); lsSet('aip:elig', clean);
    var btn = $('save-btn'); btn.disabled = true; btn.textContent = 'Mentés…';
    var msg = 'Mentve ebben a böngészőben.';
    if (user) {
      var r = await window.gp.client.from('profiles').update({ elig: clean, elig_updated_at: new Date().toISOString() }).eq('id', user.id).then(function (x) { return x; }, function (e) { return { error: e }; });
      msg = r.error ? 'A szerverre most nem sikerült menteni (a böngészőben megvan). Próbálja újra.' : 'Mentve.';
      if (r.error) console.warn('[aip] elig save failed', r.error);
    }
    btn.disabled = false; btn.textContent = 'Mentés';
    dirty = false; $('save-status').textContent = msg;
    if (window.aipTrack) aipTrack('elig-saved');
  }

  // ---------------------------------------------------------------- boot
  defaults(); render(); refresh();
  var form = $('al-form');
  form.addEventListener('input', onInput); form.addEventListener('change', onInput); form.addEventListener('click', onClick);
  $('save-btn').addEventListener('click', save);
  // "Back" with unsaved changes: save first instead of a browser "leave page?" prompt
  $('back-btn').addEventListener('click', async function (ev) { if (!dirty) return; ev.preventDefault(); await save(); location.href = 'portal.html'; });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  fetch('grants_live.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : []; }).then(function (a) {
    FEED = (Array.isArray(a) ? a : []).filter(function (g) { return !/^\d{4}-\d{2}-\d{2}$/.test(g.deadline || '') || g.deadline >= TODAY; });
    computeAndMatch();
  }).catch(function () {});

  (async function () {
    await new Promise(function (r) { if (window.gp) return r(); window.addEventListener('gp-ready', function () { r(); }, { once: true }); setTimeout(r, 3000); });
    if (!window.gp || !window.gp.client) { $('guest-note').hidden = false; return; }
    try {
      var u = (await window.gp.client.auth.getUser()).data.user;
      if (!u) { $('guest-note').hidden = false; return; }
      user = u;
      var prof = window.gp.getUserProfile ? await window.gp.getUserProfile() : null;
      if (prof) {
        ['company', 'industry', 'industries', 'employees', 'revenue', 'location', 'site_region', 'years_operating', 'legal_form', 'public_debt_free', 'own_funds', 'in_difficulty', 'teaor', 'categories', 'rnd', 'women_led', 'tax_regime', 'group_member', 'public_owner', 'de_minimis', 'insolvency']
          .forEach(function (k) { if (prof[k] != null && prof[k] !== '') profile[k] = prof[k]; });
        if (prof.elig && typeof prof.elig === 'object' && !dirty) {
          E = Object.assign({}, prof.elig);
          if (!Array.isArray(E.fin)) E.fin = []; while (E.fin.length < 2) E.fin.push({});
          if (!Array.isArray(E.links)) E.links = [];
        }
        defaults(); render(); refresh();
      }
    } catch (e) { console.warn('[aip] adatlap session failed', e); }
  })();
})();
