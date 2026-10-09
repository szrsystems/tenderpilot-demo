/* onboarding.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
(function () {
  'use strict';
  var TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  var FEED = [];
  var $ = function (id) { return document.getElementById(id); };
  var val = function (id) { var el = $(id); return el ? (el.value || '').trim() : ''; };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var FIELD_IDS = { employees: 'f_employees', site_region: 'f_site_region', teaor: 'f_teaor', years_operating: 'f_years', public_debt_free: 'f_public_debt', in_difficulty: 'f_difficulty', own_funds: 'f_own_funds', rnd: 'f_rnd' };

  function checked(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel + ' input:checked')).map(function (c) { return c.value; }); }
  function draft() {
    return {
      company: val('f_company') || 'x', industries: checked('#f_industries'), employees: val('f_employees'), site_region: val('f_site_region'),
      teaor: val('f_teaor'), years_operating: val('f_years'), public_debt_free: val('f_public_debt'), in_difficulty: val('f_difficulty'),
      own_funds: val('f_own_funds'), rnd: val('f_rnd'), women_led: val('f_women_led'), revenue: val('f_revenue'), categories: checked('#f_categories')
    };
  }

  // ---------- live preview ----------
  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(preview, 120); }
  function preview() {
    var p = draft();
    refreshMissing(false);
    if (!FEED.length || !window.AIPMatch) return;
    if (!p.industries.length && !p.employees) { $('pv-count').textContent = '—'; $('pv-list').innerHTML = '<p class="muted small">Adja meg a tevékenységet és a létszámot, és itt azonnal látja, mi illik a cégéhez.</p>'; return; }
    var rows = FEED.map(function (g) { return { g: g, m: AIPMatch.match(g, p, TODAY) }; }).filter(function (x) { return x.m.eligible && x.m.group !== 'consortium'; });
    var rank = function (x) { return (x.m.verdict === 'APPLY' ? 1000 : 0) + (x.m.group === 'hazai' ? 3 : 0) + x.m.score; };
    rows.sort(function (a, b) { return rank(b) - rank(a); });
    var good = rows.filter(function (x) { return x.m.verdict === 'APPLY'; });
    $('pv-count').textContent = good.length;
    $('pv-label').textContent = good.length === 1 ? 'felhívás illik jól' : 'felhívás illik jól';
    $('pv-list').innerHTML = rows.slice(0, 3).map(function (x) {
      var marks = x.m.checks.filter(function (c) { return c.status !== 'neutral'; }).slice(0, 4).map(function (c) { return '<span class="' + c.status + '">' + ({ ok: '✓', fail: '✗', unknown: '?', warn: '!' }[c.status]) + ' ' + esc(c.label) + '</span>'; }).join('');
      return '<div class="pv-item"><div class="pv-title">' + esc(x.g.title) + '</div><div class="pv-marks">' + marks + '</div></div>';
    }).join('') || '<p class="muted small">Ezekkel az adatokkal most nincs jól illeszkedő felhívás. A „?” pontok kitöltése sokat változtathat.</p>';
  }
  fetch('grants_live.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : []; }).then(function (a) {
    FEED = (Array.isArray(a) ? a : []).filter(function (g) { return !/^\d{4}-\d{2}-\d{2}$/.test(g.deadline || '') || g.deadline >= TODAY; });
    preview();
  }).catch(function () {});

  function refreshMissing(highlight) {
    var missing = window.AIPMatch ? AIPMatch.missingFields(draft()) : [];
    Object.keys(FIELD_IDS).forEach(function (k) { var el = $(FIELD_IDS[k]); if (el) el.classList.remove('need-fill'); });
    var box = $('missing-box');
    if (!missing.length) { box.hidden = true; return; }
    if (highlight) missing.forEach(function (f) { var el = $(FIELD_IDS[f.key]); if (el) el.classList.add('need-fill'); });
    box.innerHTML = '<b>A pontos ellenőrzéshez még hiányzik:</b><ul>' + missing.map(function (f) { return '<li>' + esc(f.label) + '</li>'; }).join('') + '</ul>';
    box.hidden = false;
  }
  document.addEventListener('input', schedule);
  document.addEventListener('change', schedule);

  // ---------- TEÁOR → industries ----------
  $('f_teaor').addEventListener('input', function () {
    var inds = window.AIPMatch ? AIPMatch.teaorIndustries(val('f_teaor')) : [];
    var map = { Food: 'Manufacturing' };
    var boxes = Array.prototype.slice.call(document.querySelectorAll('#f_industries input'));
    if (inds.length && !boxes.some(function (b) { return b.checked; })) inds.forEach(function (i) { var b = boxes.filter(function (x) { return x.value === (map[i] || i); })[0]; if (b) b.checked = true; });
  });

  // ---------- tax number lookup ----------
  function markFromNav(id) {
    var el = $(id); var label = el && el.closest('.field') && el.closest('.field').querySelector('label');
    if (label && !label.querySelector('.from-nav')) label.insertAdjacentHTML('beforeend', ' <span class="tag brand from-nav">NAV</span>');
  }
  $('taxbox-btn').addEventListener('click', async function () {
    var input = $('f_taxnumber'), msg = $('taxbox-msg'), btn = this;
    var digits = input.value.replace(/\D/g, '');
    msg.className = 'hint';
    if (!(digits.length === 8 || digits.length === 11)) { msg.textContent = 'Adjon meg 8 vagy 11 számjegyű adószámot (pl. 12345678-1-12).'; msg.className = 'hint error'; input.focus(); return; }
    if (!window.gp || !window.gp.client || !signedInUser) { msg.innerHTML = 'A NAV-os kitöltéshez <a href="login.html">jelentkezzen be</a>. Az adatokat kézzel is megadhatja.'; msg.className = 'hint error'; return; }
    btn.disabled = true; btn.textContent = 'Keresés…';
    try {
      var r = await window.gp.client.functions.invoke('company-lookup', { body: { taxNumber: digits } });
      var data = r.data;
      if (r.error || !data) throw new Error('lookup');
      if (!data.found) { msg.textContent = 'Ezzel az adószámmal nem találtunk érvényes adózót a NAV nyilvántartásában. Ellenőrizze a számot, vagy töltse ki kézzel.'; msg.className = 'hint error'; return; }
      var set = function (id, v) { var el = $(id); if (el && v) { el.value = v; markFromNav(id); } };
      set('f_company', data.name);
      set('f_location', [data.postalCode, data.city ? data.city.charAt(0) + data.city.slice(1).toLowerCase() : ''].filter(Boolean).join(' '));
      if (data.legalForm) set('f_legal', data.legalForm);
      if (data.region && !val('f_site_region')) set('f_site_region', data.region);
      try { sessionStorage.setItem('aip:tax', digits.slice(0, 8)); } catch (e) {}
      msg.textContent = 'Kitöltöttük: cégnév, székhely, cégforma' + (data.region ? ', régió (a székhely alapján — ha máshol fejleszt, módosítsa)' : '') + '. A többi adatot a NAV nem teszi közzé.';
      if (window.aipTrack) aipTrack('tax-lookup');
      preview();
    } catch (e) {
      msg.textContent = 'A gyorskitöltés most nem érhető el. Kérjük, töltse ki az adatokat kézzel.'; msg.className = 'hint error';
    } finally { btn.disabled = false; btn.textContent = 'Kitöltés'; }
  });

  // ---------- steps ----------
  var LABELS = { 1: ['Mutassa be a cégét', 'Ezekből dől el, mely felhívásokra jogosult. Adószám alapján a NAV-tól kitöltjük, amit lehet — a többit Ön adja meg.'], 2: ['Pontosítsa a feltételeket', 'Minél több pontot tud, annál kevesebb „?” marad az ellenőrzésben.'], 3: ['Hogyan értesítsük?', 'Csak akkor írunk, ha Ön kéri.'] };
  function go(n) {
    if (n === 2 && !$('step-1').hidden) {
      var ok = val('f_company') && checked('#f_industries').length && val('f_employees');
      $('s1-err').hidden = !!ok;
      if (!ok) { ['f_company', 'f_employees'].forEach(function (id) { $(id).classList.toggle('invalid', !val(id)); }); $('f_industries').classList.toggle('invalid', !checked('#f_industries').length); return; }
    }
    ['step-1', 'step-2', 'step-3'].forEach(function (id, i) { $(id).hidden = i + 1 !== n; $('prog-' + (i + 1)).className = i + 1 < n ? 'done' : i + 1 === n ? 'active' : ''; });
    $('step-label').textContent = n + ' / 3';
    $('ob-title').textContent = LABELS[n][0]; $('ob-lede').textContent = LABELS[n][1];
    refreshMissing(n === 2);
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  document.querySelectorAll('[data-next]').forEach(function (b) { b.addEventListener('click', function () { go(+b.getAttribute('data-next')); }); });

  // ---------- prefill ----------
  function fill(p) {
    if (!p) return;
    var setv = function (id, v) { var el = $(id); if (el && v != null && v !== '' && !el.value) el.value = v; };
    setv('f_company', p.company); setv('f_employees', p.employees); setv('f_years', p.years_operating); setv('f_site_region', p.site_region);
    setv('f_teaor', p.teaor); setv('f_public_debt', p.public_debt_free); setv('f_difficulty', p.in_difficulty); setv('f_own_funds', p.own_funds);
    setv('f_rnd', p.rnd); setv('f_women_led', p.women_led); setv('f_revenue', p.revenue); setv('f_legal', p.legal_form); setv('f_location', p.location);
    setv('f_name', p.contact_name || p.display_name); setv('f_email', p.email); setv('f_phone', p.phone); setv('f_notes', p.notes); setv('f_past', p.past_grants);
    var inds = Array.isArray(p.industries) && p.industries.length ? p.industries : (p.industry ? [p.industry] : []);
    document.querySelectorAll('#f_industries input').forEach(function (b) { if (inds.indexOf(b.value) >= 0) b.checked = true; });
    (p.categories || []).forEach(function (c) { var b = document.querySelector('#f_categories input[value="' + c + '"]'); if (b) b.checked = true; });
  }
  try { fill(JSON.parse(localStorage.getItem('grantpilot:profile') || 'null')); } catch (e) {}
  try { fill(JSON.parse(localStorage.getItem('aip:quick') || 'null')); } catch (e) {}

  // ---------- session ----------
  var signedInUser = null;
  (async function () {
    await new Promise(function (r) { if (window.gp) return r(); window.addEventListener('gp-ready', function () { r(); }, { once: true }); setTimeout(r, 2500); });
    if (!window.gp || !window.gp.client) return;
    try {
      var u = (await window.gp.client.auth.getUser()).data.user;
      if (!u) return;
      if (window.gp.checkDeletedAccount) {
        var del = await window.gp.checkDeletedAccount().catch(function () { return { deleted: false }; });
        if (del.deleted) { try { await window.gp.client.auth.signOut({ scope: 'local' }); } catch (e) {} location.replace('login.html?signed_out=1'); return; }
      }
      signedInUser = u;
      $('f_email_wrap').hidden = true; $('f_email').value = u.email || '';
      $('f_phone_req').hidden = false;
      try { if (window.gp.getUserProfile) fill(await window.gp.getUserProfile()); } catch (e) {}
      try {
        var np = await window.gp.client.from('notif_prefs').select('weekly_enabled, instant_enabled').eq('user_id', u.id).maybeSingle();
        if (np.data) { var w = document.querySelector('#f_channels input[value=weekly]'), i = document.querySelector('#f_channels input[value=instant]'); if (w) w.checked = !!np.data.weekly_enabled; if (i) i.checked = !!np.data.instant_enabled; }
      } catch (e) {}
      $('consent-wrap').hidden = true; $('f_gdpr').checked = true; // accepted at sign-up
      preview();
    } catch (e) {}
  })();

  // ---------- save ----------
  async function syncProfile(data) {
    if (!signedInUser) return true;
    var c = window.gp.client;
    var patch = { display_name: data.contact_name, company: data.company, industry: data.industry, industries: data.industries, employees: data.employees, revenue: data.revenue, location: data.location, site_region: data.site_region, years_operating: data.years_operating, legal_form: data.legal_form, public_debt_free: data.public_debt_free, own_funds: data.own_funds, in_difficulty: data.in_difficulty, teaor: data.teaor, categories: data.categories, phone: data.phone };
    Object.keys(patch).forEach(function (k) { if (patch[k] === '' || patch[k] == null) delete patch[k]; });
    var r = await c.from('profiles').update(patch).eq('id', signedInUser.id);
    if (r.error) { console.warn('[gp] profile save failed', r.error); return false; }
    var v2 = {}; if (data.rnd) v2.rnd = data.rnd; if (data.women_led) v2.women_led = data.women_led;
    if (Object.keys(v2).length) { var r2 = await c.from('profiles').update(v2).eq('id', signedInUser.id); if (r2.error) console.info('[gp] v2 profile fields not saved (migration pending)'); }
    var a = window.AIPAttr && AIPAttr.get(); if (a) { try { await c.from('profiles').update({ acq_source: a.source, acq_campaign: a.campaign, acq_medium: a.medium, acq_at: a.at }).eq('id', signedInUser.id); } catch (eA) {} } // first touch only; the database keeps the first value
    var np = await c.from('notif_prefs').upsert({ user_id: signedInUser.id, weekly_enabled: data.channels.indexOf('weekly') >= 0 }, { onConflict: 'user_id' });
    if (np.error) console.warn('[gp] notif_prefs save failed', np.error);
    var ni = await c.from('notif_prefs').update({ instant_enabled: data.channels.indexOf('instant') >= 0 }).eq('user_id', signedInUser.id);
    if (ni.error) console.info('[gp] instant_enabled not saved (migration pending)');
    return true;
  }
  $('submit-btn').addEventListener('click', async function () {
    var err = $('s3-err'); err.hidden = true;
    var need = [];
    if (!val('f_name')) need.push('f_name');
    if (!signedInUser && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val('f_email'))) need.push('f_email');
    if (signedInUser && !val('f_phone')) need.push('f_phone');
    if (val('f_phone')) { var np = window.AIPPhone && AIPPhone.normalizePhone(val('f_phone')); if (!np) { $('f_phone').classList.add('invalid'); err.textContent = 'Adjon meg érvényes telefonszámot, például +36 30 123 4567 vagy 06 1 234 5678.'; err.hidden = false; $('f_phone').focus(); return; } $('f_phone').value = np; }
    need.forEach(function (id) { $(id).classList.add('invalid'); });
    if (need.length) { err.textContent = 'Töltse ki a csillaggal jelölt mezőket.'; err.hidden = false; $(need[0]).focus(); return; }
    if (!$('f_gdpr').checked) { err.textContent = 'Fogadja el az adatkezelési tájékoztatót és az ÁSZF-et.'; err.hidden = false; return; }
    var inds = checked('#f_industries');
    var data = Object.assign(draft(), {
      company: val('f_company'), industries: inds, industry: inds[0] || '', legal_form: val('f_legal'), location: val('f_location'),
      channels: checked('#f_channels'), past_grants: val('f_past'), notes: val('f_notes'), contact_name: val('f_name'), email: val('f_email'), phone: val('f_phone'),
      gdpr_consent: true, gdpr_consent_ts: new Date().toISOString(), submitted: new Date().toISOString()
    });
    try { localStorage.setItem('grantpilot:profile', JSON.stringify(data)); localStorage.removeItem('aip:quick'); } catch (e) {}
    var btn = this; btn.disabled = true; btn.textContent = 'Mentés…';
    var ok = await syncProfile(data).catch(function () { return false; });
    btn.disabled = false; btn.textContent = 'Profil mentése';
    if (!ok) { err.textContent = 'A profilt most nem sikerült elmenteni a szerverre (a böngészőjében megvan). Kérjük, próbálja újra.'; err.hidden = false; return; }
    if (window.aipTrack) aipTrack('profile-done');
    ['step-1', 'step-2', 'step-3'].forEach(function (id) { $(id).hidden = true; });
    $('step-success').hidden = false;
    if (signedInUser) { setTimeout(function () { location.replace('portal.html'); }, 900); }
    else {
      $('done-title').textContent = 'A profilt elmentettük ebben a böngészőben.';
      $('done-text').textContent = 'Hozzon létre ingyenes fiókot, hogy értesítést kaphasson és más eszközön is elérje.';
      $('done-link').textContent = 'Fiók létrehozása'; $('done-link').href = 'signup.html?from=onboarding';
    }
  });
  window.__obGo = go;
})();
