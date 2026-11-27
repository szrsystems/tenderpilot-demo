/* =========================================================================
 * AIpályázó — grant ↔ company matching (shared by the portal and the
 * weekly-digest e-mail; the copy in supabase/functions/_shared/match.js must
 * stay byte-identical — a test enforces it).
 *
 * Every grant is checked against the company profile point by point. Each
 * check says ✓ / ! / ✗ / ? with a plain-Hungarian reason, so the user sees
 * exactly WHY a call fits or doesn't — no black-box "AI score".
 *   ✗ (fail)    = the company is not eligible → score capped at 30
 *   !  (warn)   = possible, but a real hurdle (consortium, 1 Mrd minimum…)
 *   ?  (unknown)= the profile or the call data doesn't tell → neutral
 * ========================================================================= */
(function (root) {
  'use strict';

  var ALL_REGIONS = ['Budapest', 'Pest', 'Közép-Dunántúl', 'Nyugat-Dunántúl', 'Dél-Dunántúl', 'Észak-Magyarország', 'Észak-Alföld', 'Dél-Alföld'];

  // Activity keywords per onboarding industry (matched against the call's
  // title and eligibility note — NOT its category: the automatic EU category
  // labels such as „Digitális átalakulás” would make every call match IT).
  // A Hungarian word start is written (?:^|[^a-zà-ű]) because \b does not
  // treat accented letters as letters.
  var INDUSTRY_RE = {
    IT: /digit|informatik|szoftver|\badat|kiberbiztons|mesterséges intelligencia|\bAI\b|\bIKT\b|mélytech|deep-?tech|kvantum|\bquantum|\bcloud\b|\bsoftware|\bcyber|\bdata\b/i,
    HVAC: /energi|épületgépész|fűtés|hűtés|hőszivatty|napelem|geoterm|megújuló|\benergy|\bheat(?:ing|\b|-)|\bsolar|\brenewable/i,
    Construction: /(?:^|[^a-zà-ű])(?:épít|épület)|építőipar|felújít|útépít|mélyép|magasép|\bconstruction|\brenovation/i,
    Manufacturing: /gyárt|\bipar|gépbeszerz|termelőkapacit|\bmanufactur|\bindustr|\brobot|\bmaterials?\b/i,
    Healthcare: /egészség|(?:^|[^a-zà-ű])orvos|gyógyít|gyógyszer|gyógyász|kórház|\bhealth|\bmedic|diagnos/i,
    Restaurant: /vendéglát|étterem|gasztronóm|turisz|cukrász|\brestaurant|food service/i,
    Tourism: /turiz|turiszt|szálláshely|vendégház|vendéglát|panzió|szálloda|\bhotel|\btouris/i,
    Agriculture: /mezőgazd|(?:^|[^a-zà-ű])gazdálkod|agrár|élelmiszer|halász|akvakult|kertész|állattart|ültetvény|\bfarm|\bagri|\bfood\b|\bfish/i,
    Retail: /kereskedelm|(?:^|[^a-zà-ű])bolt|webáruház|webshop|e-kereskedelem|\bretail|\be-?commerce/i,
    Education: /oktatás|oktatási|képzés|képzési|(?:^|[^a-zà-ű])tanulók|\beducation|\btraining|\bskills?\b/i,
    General: /./,
  };
  // EU titles say "digital" / "data" about almost anything: for an EU call an
  // IT topic match needs a specific word.
  var EU_STRICT = { IT: /szoftver|kiberbiztons|mesterséges intelligencia|\bAI\b|\bsoftware|\bcyber|\bcloud\b|\bquantum|kvantum|\bIKT\b|\bICT\b|deep-?tech|mélytech/i };
  // Forestry words count as a topic match only for a forestry / agricultural
  // main activity (TEÁOR 01–02), not for every food processor.
  var FOREST_RE = /erdő|erdész|fásít|\bforest/i;
  var FOREST_DIVS = [1, 2];
  // Calls that only make sense for one sector: a company outside it is not
  // eligible. `divs`: the TEÁOR divisions that qualify, when the profile has one.
  var SECTOR_ONLY = [
    { re: /halász|akvakult|halfeldolg|halgazd|\bfish|aquacult/i, need: ['Agriculture'], divs: [3, 10], label: 'halászat / akvakultúra' },
    { re: FOREST_RE, need: ['Agriculture'], divs: FOREST_DIVS, label: 'erdőgazdálkodás' },
    // orchards / vineyards (perennial crops, TEÁOR 0121–0129)
    { re: /ültetvény|gyümölcsös|szőlőültet|\borchard/i, need: ['Agriculture'], codes: ['012', '015'], label: 'ültetvény (gyümölcs, szőlő)' },
    { re: /gazdaságátad|termelői csoport|őstermel|agrár.*kártya|agrár.*hitel|mezőgazdasági termel/i, need: ['Agriculture'], label: 'mezőgazdasági termelés' },
    { re: /élelmiszeripar|élelmiszer-feldolg|\bTÉSZ\b|food process/i, need: ['Agriculture', 'Food'], divs: [10, 11, 12], soft: ['Manufacturing', 'Retail'], label: 'élelmiszeripar (feldolgozás)' },
    // condominium developers only
    { re: /társasház/i, need: ['Construction'], label: 'lakóingatlan-fejlesztés (társasház)' },
    { re: /geoterm|földhő/i, need: ['HVAC'], soft: ['Manufacturing', 'Construction'], label: 'geotermikus energia' },
    { re: /turisztikai kártya|szálláshely|vendéglát/i, need: ['Tourism', 'Restaurant'], label: 'turizmus / vendéglátás' },
    { re: /előadó-művész|performing arts|kulturális örökség|cultural heritage/i, need: ['Education', 'General'], label: 'kultúra' },
    // livestock farming (dairy, cattle, pig, poultry, sheep, animal welfare)
    { re: /tejtermel|szarvasmarh|állatjólét|állattart|sertéstart|baromfitart|juhtart|kecsketart|\blivestock|animal welfare/i, need: ['Agriculture'], codes: ['014', '015'], label: 'állattartás' },
    // Common Agricultural Policy (KAP) money: mostly farmers, sometimes rural firms
    { re: /\bKAP\b|KAP Stratégiai Terv|KAP ST\b|agrár-erdészeti|vidékfejleszt/i, need: ['Agriculture'], soft: ['Food', 'Manufacturing', 'Tourism', 'Restaurant', 'Retail', 'General', 'Construction', 'HVAC', 'IT', 'Healthcare', 'Education'], label: 'agrár / vidékfejlesztés (KAP)' },
  ];

  // Employee-count options of the profile form. '100+' is the old top option
  // (before 101–249 / 250+ existed): it can be a medium or a large company,
  // so its size tier is unknown.
  var EMP_RANGE = { '1': [1, 1], '1-5': [2, 5], '6-10': [6, 10], '11-25': [11, 25], '26-50': [26, 50], '51-100': [51, 100], '101-249': [101, 249], '250+': [250, Infinity], '100+': [100, Infinity] };
  function sizeTier(emp) {
    if (['1', '1-5', '6-10'].indexOf(emp) >= 0) return 'micro';
    if (['11-25', '26-50'].indexOf(emp) >= 0) return 'small';
    if (['51-100', '101-249'].indexOf(emp) >= 0) return 'mid';
    if (emp === '250+') return 'large';
    return null;
  }
  var GENERIC_BONUS = 3;   // "general business money" — a tiebreak, not a match
  var BONUS_CAP = 22;      // all fit bonuses together
  // Checks whose 'unknown' blocks an APPLY verdict (stays REVIEW at most).
  var HARD = ['basics', 'size', 'region', 'years', 'jobseeker', 'startup', 'women_led', 'revenue', 'employer', 'farmer', 'fisheries', 'forestry', 'tourism_ntak', 'restaurant', 'youth_founder', 'rnd', 'kata',
    'status', 'presence', 'org', 'compliance', 'equity', 'sole_trader', 'headcount', 'teaor_codes', 'szvz', 'settlement', 'incentive'];
  var TIER_LABEL = { micro: 'mikrovállalkozás', small: 'kisvállalkozás', mid: 'középvállalkozás', large: 'nagyvállalkozás' };
  // Call text that says "SMEs only" / text that says larger firms may apply too.
  var KKV_TEXT = /\bKKV|\bSMEs?\b|SME's|mikro-, kis- és közép|kis- és középvállal/i;
  var OPEN_TEXT = /nagyvállal|nagyobb (?:cég|vállal)|mid-?cap|bárki|\d{3,}\s*fő|\d{3,}\s*fős/i;
  var closedYears = { '0': 0, '1': 1, '2': 2, '3-5': 3, '5+': 5 };
  // Closed business years: exact from the founding date (detailed sheet) when
  // known, otherwise the band from the short profile.
  function yearsOf(p) { return p && typeof p._years === 'number' ? p._years : (p ? closedYears[p.years_operating] : undefined); }

  function daysUntil(dateStr, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
    return Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  }

  // TEÁOR (NACE) main activity → 2-digit division → our industry buckets.
  // "6201", "62.01", "620104", "6201 Számítógépes programozás" → 62.
  // A year label such as "2025: 6201" is skipped, never read as division 20.
  function teaorDivision(t) {
    var s = String(t || '').trim();
    if (/^\d{2}$/.test(s)) return +s > 0 ? +s : null;
    var re = /(^|[^\d])(\d{2})\.?(\d{2})(\d{0,2})(?!\d)(\s*[:\/])?/g, m;
    while ((m = re.exec(s))) {
      if (m[5]) continue; // "2025:" — a label, not the code
      if (+m[2] > 0) return +m[2];
    }
    return null;
  }
  function teaorIndustries(t) {
    var d = teaorDivision(t);
    if (d === null) return [];
    if (d <= 3) return ['Agriculture'];
    if (d >= 10 && d <= 12) return ['Manufacturing', 'Food'];
    if (d >= 5 && d <= 33) return ['Manufacturing'];
    if (d === 35) return ['HVAC'];
    if (d >= 41 && d <= 43) return ['Construction'];
    if (d >= 45 && d <= 47) return ['Retail'];
    if (d === 55) return ['Tourism'];
    if (d === 56) return ['Restaurant'];
    if (d >= 58 && d <= 63) return ['IT'];
    if (d === 85) return ['Education'];
    if (d >= 86 && d <= 88) return ['Healthcare'];
    return ['General'];
  }
  function industriesOf(p) {
    if (!p) return [];
    var list = Array.isArray(p.industries) && p.industries.length ? p.industries.slice() : (p.industry ? [p.industry] : []);
    teaorIndustries(p.teaor).forEach(function (x) { if (list.indexOf(x) < 0) list.push(x); });
    return list;
  }


  // ---- detailed company sheet (DFT eligibility model) ----------------------
  // profile.elig holds the optional detailed answers (adatlap.html). derive()
  // turns them into exact values the checks use; the short profile is the
  // fallback for anything not given there.
  var TODAY_REF = new Date().toISOString().slice(0, 10);
  var EUR_HUF = 400;        // conversion for EU thresholds (SME size, de minimis); deliberately round
  var DM_CAP = 300000;      // de minimis ceiling, EUR / 3 years (Reg. 2023/2831)
  function num(x) {
    if (typeof x === 'number') return isFinite(x) ? x : null;
    var s = String(x == null ? '' : x).replace(/[\s ]/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return +s;
  }
  function fmtHuf(v) { var a = Math.abs(v); return (v < 0 ? '−' : '') + (a >= 1e9 ? (Math.round(a / 1e8) / 10 + ' Mrd Ft').replace('.', ',') : a >= 1e6 ? Math.round(a / 1e6) + ' M Ft' : Math.round(a / 1e3) + ' ezer Ft'); }
  function fmtEur(v) { return v >= 1e6 ? (Math.round(v / 1e5) / 10 + ' M €').replace('.', ',') : Math.round(v / 1000) + ' ezer €'; }
  function digits(c) { return String(c == null ? '' : c).replace(/\D/g, ''); }
  function codeList(x) { return (Array.isArray(x) ? x : String(x || '').split(/[,;\s]+/)).map(digits).filter(function (c) { return c.length >= 2 && c.length <= 6; }); }
  function codeHit(mine, tags) {
    return mine.some(function (c) { return tags.some(function (t) { return c.indexOf(t) === 0 || (c.length >= 4 && t.indexOf(c) === 0); }); });
  }
  // EU SME definition (Annex I, Reg. 651/2014): headcount AND (turnover OR balance sheet).
  function euTier(h, turnEur, bsEur) {
    function fin(cap) { return (turnEur != null && turnEur <= cap) || (bsEur != null && bsEur <= cap); }
    if (h < 10 && fin(2e6)) return 'micro';
    if (h < 50 && fin(10e6)) return 'small';
    if (h < 250 && ((turnEur != null && turnEur <= 50e6) || (bsEur != null && bsEur <= 43e6))) return 'mid';
    return 'large';
  }
  var PROC_LABEL = { in_voluntary_dissolution: 'végelszámolás', in_liquidation: 'felszámolás', in_bankruptcy: 'csődeljárás', in_forced_strike_off: 'kényszertörlés', being_struck_off: 'törlési eljárás', enforcement_ongoing: 'végrehajtás', in_restructuring: 'szerkezetátalakítás' };
  var POP_BAND = { '<1000': [0, 999], '1000-5000': [1000, 4999], '5000-10000': [5000, 9999], '10000-50000': [10000, 49999], '50000+': [50000, Infinity] };

  function derive(p, today) {
    var e = p && p.elig;
    if (!e || typeof e !== 'object') return p;
    var q = {}; for (var k in p) q[k] = p[k];
    today = today || new Date().toISOString().slice(0, 10);
    var f0 = (Array.isArray(e.fin) && e.fin[0]) || {};
    var th = function (v) { var n = num(v); return n === null ? null : n * 1000; }; // the sheet asks in thousand Ft (as in the annual report)
    // company age: closed full calendar years since founding
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.founded_date || '') && e.founded_date <= today) {
      var fy = +e.founded_date.slice(0, 4), firstFull = e.founded_date.slice(5) === '01-01' ? fy : fy + 1;
      q._years = Math.max(0, (+today.slice(0, 4) - 1) - firstFull + 1);
    }
    var hc = num(f0.avg_stat_headcount); if (hc === null) hc = num(e.current_headcount);
    if (hc !== null) q._headcount = hc;
    var rev = th(f0.net_revenue), bs = th(f0.total_assets);
    if (rev !== null) q._revenue = rev;
    // linked (>50%) and partner (25–50%) enterprises, counted per the EU SME rules
    var links = Array.isArray(e.links) ? e.links : [], gh = 0, gr = 0, gb = 0, incomplete = false, nLinked = 0;
    links.forEach(function (l) {
      var pct = num(l && l.pct); if (!l || l.kind === 'szemely' || pct === null || pct < 25) return;
      var share = pct > 50 ? 1 : pct / 100; nLinked++;
      var lh = num(l.headcount), lr = num(l.revenue), lb = num(l.assets);
      if (lh === null || (lr === null && lb === null)) incomplete = true;
      gh += (lh || 0) * share; gr += (lr || 0) * 1e6 * share; gb += (lb || 0) * 1e6 * share;
    });
    var pub = (num(e.state_ownership_pct) || 0) + (num(e.municipal_ownership_pct) || 0);
    if (num(e.state_ownership_pct) !== null || num(e.municipal_ownership_pct) !== null) q.public_owner = pub >= 25 ? 'igen' : 'nem';
    if (e.links_none === true || links.length) q.group_member = nLinked ? 'igen' : 'nem';
    if (q.public_owner === 'igen') { q._tier = 'large'; q._tierBasis = 'állami / önkormányzati tulajdon 25% felett'; }
    else if (hc !== null && (rev !== null || bs !== null) && !incomplete) {
      q._tier = euTier(hc + gh, rev === null ? null : (rev + gr) / EUR_HUF, bs === null ? null : (bs + gb) / EUR_HUF);
      q._tierBasis = nLinked ? 'csoportszintű létszám és pénzügyi adatok alapján' : 'létszám és beszámoló alapján';
    }
    // proceedings → insolvency
    var procs = Array.isArray(e.proceedings) ? e.proceedings : [];
    var hardProcs = procs.filter(function (x) { return PROC_LABEL[x] && x !== 'in_restructuring'; });
    if (hardProcs.length) { q.insolvency = 'igen'; q._procs = hardProcs.map(function (x) { return PROC_LABEL[x]; }); }
    else if (e.proceedings_none === true && !q.insolvency) q.insolvency = 'nem';
    // equity, firm in difficulty (EU definition, simplified: half the share capital lost)
    var eq = th(f0.equity), sc = th(f0.share_capital);
    if (eq !== null) q._equity = eq;
    if (sc !== null) q._shareCapital = sc;
    if (eq !== null && sc > 0 && eq < sc / 2 && q.legal_form !== 'EV' && !(typeof q._years === 'number' && q._years < 3)) { q.in_difficulty = 'igen'; q._difficultyCalc = true; }
    var ebit = th(f0.ebit); if (ebit !== null) q._ebit = ebit;
    var exp = th(f0.export_revenue); if (exp !== null) q._export = exp;
    var agri = th(f0.agri_revenue); if (agri !== null && rev > 0) q._agriShare = agri / rev;
    // de minimis used (EUR) and the planned project
    var dm = num(e.de_minimis_used_3y);
    if (dm !== null) { q._dmUsed = dm; q.de_minimis = dm <= 0 ? 'nincs' : dm < 100000 ? '<100k' : dm <= 250000 ? '100k-250k' : '250k+'; }
    var reqM = num(e.requested_aid_amount), costM = num(e.project_total_cost);
    if (reqM !== null) { q._requested = reqM * 1e6; q._requestedEur = reqM * 1e6 / EUR_HUF; }
    if (costM !== null) q._projectCost = costM * 1e6;
    // where the project is carried out decides region and favoured-district status
    var pc = digits(e.project_postcode).slice(0, 4);
    if (pc.length === 4) {
      q._projectLocation = pc + ' ' + (e.project_city || '');
      var G = root.AIPGeo, reg = G && G.regionOf(pc);
      if (reg) q.site_region = reg;
    }
    q._teaors = codeList([q.teaor].concat(codeList(e.all_teaor)));
    q._projectTeaor = codeList(e.project_teaor);
    q._e = e;
    return q;
  }

  // ---- the individual checks ---------------------------------------------
  function checkSize(g, p) {
    var emp = p && p.employees, exact = p && p._tier, tier = exact || sizeTier(emp), legacy = !exact && emp === '100+';
    // 25%+ state / municipal ownership: never an SME, whatever the headcount.
    var publicOwned = !!(p && p.public_owner === 'igen');
    var big = tier === 'large' || legacy || publicOwned;
    var cls = (g.sizeClasses || []).map(function (s) { return String(s).toLowerCase(); });
    function has(re) { return cls.some(function (s) { return re.test(s); }); }
    var nagy = has(/nagyvállalkoz/), kozep = has(/középvállalkoz/), kis = has(/kisvállalkoz/), mikro = has(/mikro/);
    var generic = has(/^(egyéb )?vállalkozás$/);
    var txt = [g.title, g.note].join(' ');
    var saysKkv = !isConsortium(g) && KKV_TEXT.test(txt) && !OPEN_TEXT.test(txt);
    function r(status, reason) { return { key: 'size', label: 'Cégméret', status: status, reason: reason }; }
    var ASK = 'Pontosítsa a létszámot a profilban (101–249 fő vagy 250 fő felett).';
    if (!cls.length || (generic && !nagy && !kozep && !kis && !mikro)) {
      if (big && saysKkv) return r('unknown', 'A leírás szerint KKV-knak szól — nagyvállalatként ellenőrizze a felhívásban.' + (legacy ? ' ' + ASK : ''));
      return r('ok', 'A felhívás nem korlátozza a cégméretet.');
    }
    if (!tier && !legacy && !publicOwned) return r('unknown', 'Adja meg a létszámot a profilban.');
    if (publicOwned && !nagy) return r('fail', 'Állami / önkormányzati 25%-os vagy nagyobb tulajdon mellett a cég nem minősül KKV-nak.');
    if (big) {
      if (nagy) return r('ok', 'Nagyvállalkozás is pályázhat.');
      if (legacy) return kozep ? r('unknown', 'Csak KKV-k (250 fő alatt) pályázhatnak. ' + ASK) : r('fail', 'Csak mikro- és kisvállalkozások pályázhatnak.');
      if (generic && !saysKkv) return r('unknown', 'A felhívás a KKV-kat nevesíti — nagyvállalatként ellenőrizze a felhívásban.');
      return r('fail', 'Csak mikro-, kis- és középvállalkozások (KKV) pályázhatnak — nagyvállalat nem.');
    }
    if (generic) return r('ok', 'A felhívás nem korlátozza a cégméretet.');
    var ok = (tier === 'micro' && mikro) || (tier === 'small' && kis) || (tier === 'mid' && (kozep || nagy));
    // Linked / partner enterprises: the SME size is counted for the whole group.
    if (ok && exact) return r('ok', 'Pályázhat ' + TIER_LABEL[tier] + 'ként (' + p._tierBasis + ').');
    if (ok && p && p.group_member === 'igen' && !nagy) return r('unknown', 'Cégcsoport tagjaként a KKV-méretet a kapcsolt és partnervállalkozásokkal együtt kell számolni — ellenőrizze.');
    return ok ? r('ok', 'Pályázhat ' + TIER_LABEL[tier] + 'ként.') : r('fail', TIER_LABEL[tier] + ' nem szerepel a jogosultak között.');
  }

  function checkRegion(g, p) {
    var regs = Array.isArray(g.regions) ? g.regions : [];
    var site = (p && p.site_region) || '';
    if (!regs.length) {
      return g.regionNote
        ? { key: 'region', label: 'Helyszín', status: 'unknown', reason: g.regionNote }
        : { key: 'region', label: 'Helyszín', status: 'ok', reason: 'Országos felhívás.' };
    }
    var desc = regs.length === 7 && regs.indexOf('Budapest') < 0 ? 'Budapesten kívül' : regs.join(', ');
    if (!site || site === 'Több') return { key: 'region', label: 'Helyszín', status: 'unknown', reason: 'Csak itt: ' + desc + '. Adja meg a beruházás helyét a profilban.' };
    if (regs.indexOf(site) < 0) return { key: 'region', label: 'Helyszín', status: 'fail', reason: site + ' nem jogosult — csak: ' + desc + '.' };
    // Some calls are limited to counties inside a region (e.g. the JTF counties).
    var cs = Array.isArray(g.counties) ? g.counties : [];
    if (cs.length) {
      var G = root.AIPGeo, loc = (p && (p._projectLocation || p.location)) || '';
      var m = String(loc).match(/\b(\d{4})\b/), county = G && m ? G.countyOf(m[1]) : null;
      var list = cs.join(', ');
      if (!county) return { key: 'region', label: 'Helyszín', status: 'unknown', reason: 'Csak ' + list + ' vármegyében. Adja meg a megvalósítás helyének irányítószámát.' };
      return cs.indexOf(county) >= 0
        ? { key: 'region', label: 'Helyszín', status: 'ok', reason: county + ' vármegye jogosult (' + list + ').' }
        : { key: 'region', label: 'Helyszín', status: 'fail', reason: county + ' vármegye nem jogosult — csak: ' + list + '.' };
    }
    return { key: 'region', label: 'Helyszín', status: 'ok', reason: site + ' jogosult (' + desc + ').' };
  }

  function checkSector(g, p) {
    var text = [g.title, g.note].join(' ');
    var inds = industriesOf(p);
    var div = teaorDivision(p && p.teaor);
    for (var i = 0; i < SECTOR_ONLY.length; i++) {
      var s = SECTOR_ONLY[i];
      if (s.re.test(text)) {
        if (!inds.length) return { key: 'sector', label: 'Tevékenység', status: 'unknown', reason: 'Ágazati felhívás (' + s.label + ').', hard: true };
        var hit = inds.some(function (x) { return s.need.indexOf(x) >= 0; });
        // With a TEÁOR code we can tell a crop farm from a fish farm or a forestry;
        // without one the sector requirement cannot be confirmed.
        if (hit && s.divs && div === null) return { key: 'sector', label: 'Tevékenység', status: 'unknown', reason: 'Ágazati felhívás (' + s.label + ') — adja meg a TEÁOR főtevékenységet a profilban.', hard: true };
        if (hit && s.divs) hit = s.divs.indexOf(div) >= 0;
        // Livestock vs. crops vs. orchards are all division 01: decide on the 4-digit code.
        if (hit && s.codes) {
          var c4 = digits(p && p.teaor);
          if (c4.length < 3) return { key: 'sector', label: 'Tevékenység', status: 'unknown', reason: 'Ágazati felhívás (' + s.label + ') — adja meg a 4 jegyű TEÁOR főtevékenységet a profilban.', hard: true, specific: true };
          if (!s.codes.some(function (pre) { return c4.indexOf(pre) === 0; })) return { key: 'sector', label: 'Tevékenység', status: 'fail', reason: 'Csak ' + s.label + ' területen működőknek.', specific: true };
        }
        // 'General' (other services) fits a cultural call, but is too broad to count as a strong match.
        if (hit) return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'Ágazati felhívás (' + s.label + '), illik a tevékenységéhez.', bonus: inds.some(function (x) { return x !== 'General' && s.need.indexOf(x) >= 0; }) ? 22 : 8 };
        if (s.soft && inds.some(function (x) { return s.soft.indexOf(x) >= 0; })) return { key: 'sector', label: 'Tevékenység', status: 'warn', reason: 'Csak ' + s.label + ' területen — ha Ön ilyen tevékenységet folytat, jogosult.' };
        return { key: 'sector', label: 'Tevékenység', status: 'fail', reason: 'Csak ' + s.label + ' területen működőknek.' };
      }
    }
    if (!inds.length) return { key: 'sector', label: 'Tevékenység', status: 'unknown', reason: 'Adja meg a tevékenységi kört a profilban.' };
    var match = inds.some(function (x) { var re = g.scope === 'eu' && EU_STRICT[x] ? EU_STRICT[x] : INDUSTRY_RE[x]; return x !== 'General' && re && re.test(text); })
      || (inds.indexOf('Agriculture') >= 0 && (div === null || FOREST_DIVS.indexOf(div) >= 0) && FOREST_RE.test(text));
    var interest = p && Array.isArray(p.categories) && p.categories.indexOf(g.cat) >= 0;
    // Loans, guarantees and equity are general-purpose money: a keyword in their
    // name ("digitalizációs", "innovációs") is not a real sector fit.
    var finance = ['loan', 'guarantee', 'equity'].indexOf(g.type) >= 0;
    if (match && finance) return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'Általános finanszírozási termék, a témája érinti a tevékenységét.', bonus: 8 };
    if (match) return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'A felhívás témája illik a tevékenységéhez.', bonus: interest ? 22 : 18 };
    if (interest) return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'Az Ön által megjelölt témakörbe esik.', bonus: 8 };
    // Broad Hungarian business-development money (Széchenyi Kártya, MFB,
    // digitalisation, energy efficiency) suits almost any active company — but
    // only as a small plus: without a real topic match it stays REVIEW.
    if (g.scope !== 'eu' && (['KKV fejlesztés', 'Digitális átalakulás', 'Energiahatékonyság', 'Munkahelyteremtés'].indexOf(g.cat) >= 0
        || ['loan', 'loan+grant', 'guarantee'].indexOf(g.type) >= 0)) {
      return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'Általános vállalkozásfejlesztési forrás — bármely ágazatnak.', bonus: GENERIC_BONUS };
    }
    return { key: 'sector', label: 'Tevékenység', status: 'neutral', reason: 'Témája nem kapcsolódik közvetlenül a tevékenységéhez.' };
  }

  function checkYears(g, p) {
    var m = String(g.note || '').match(/(?:^|[\s(.,;])(\d|egy|két|kettő|három|négy|öt)\s*(?:teljes\s+)?lezárt/i);
    if (!m) return null;
    var WORD = { egy: 1, 'két': 2, 'kettő': 2, 'három': 3, 'négy': 4, 'öt': 5 };
    var need = /\d/.test(m[1]) ? +m[1] : WORD[m[1].toLowerCase()];
    var have = yearsOf(p);
    if (have === undefined) return { key: 'years', label: 'Működési idő', status: 'unknown', reason: 'Legalább ' + need + ' lezárt üzleti év kell.' };
    return have >= need
      ? { key: 'years', label: 'Működési idő', status: 'ok', reason: 'Megvan a szükséges ' + need + ' lezárt év.' }
      : { key: 'years', label: 'Működési idő', status: 'fail', reason: 'Legalább ' + need + ' lezárt üzleti év kell.' };
  }

  function checkBasics(g, p) {
    if (!p) return null;
    if (p.insolvency === 'igen') return { key: 'basics', label: 'Alapfeltételek', status: 'fail', reason: (p._procs && p._procs.length ? p._procs.join(', ') + ' alatt' : 'Csőd-, felszámolási, végelszámolási vagy végrehajtási eljárás alatt') + ' álló cég nem pályázhat.' };
    if (g.scope === 'eu') {
      // EU money is not Hungarian state aid, but nearly every EU call also
      // excludes applicants with tax debt or in financial difficulty.
      if (p.public_debt_free === 'nem') return { key: 'basics', label: 'Alapfeltételek', status: 'warn', reason: 'Köztartozás mellett az EU-s felhívások többsége is kizárja a pályázót.' };
      if (p.in_difficulty === 'igen') return { key: 'basics', label: 'Alapfeltételek', status: 'warn', reason: 'Nehéz helyzetű vállalkozást az EU-s felhívások többsége is kizár.' };
      return null;
    }
    var stateAid = ['grant', 'loan', 'loan+grant', 'wage-subsidy', 'guarantee'].indexOf(g.type) >= 0;
    if (!stateAid) return null;
    if (p.public_debt_free === 'nem') return { key: 'basics', label: 'Alapfeltételek', status: 'fail', reason: 'Köztartozás mellett nem adható állami támogatás.' };
    if (p.in_difficulty === 'igen') return { key: 'basics', label: 'Alapfeltételek', status: 'fail', reason: p._difficultyCalc ? 'A beszámoló szerint a saját tőke a jegyzett tőke felénél kisebb: ez „nehéz helyzetű vállalkozás”, amely nem kaphat támogatást.' : 'Nehéz helyzetű vállalkozás nem kaphat támogatást.' };
    if (p.public_debt_free === 'igen' && p.in_difficulty === 'nem') return { key: 'basics', label: 'Alapfeltételek', status: 'ok', reason: 'Köztartozásmentes, nem nehéz helyzetű.' };
    return { key: 'basics', label: 'Alapfeltételek', status: 'unknown', reason: 'Köztartozásmentesség és „nehéz helyzet” ellenőrizendő.' };
  }

  // Main activities most Hungarian state-aid calls exclude.
  function checkTeaor(g, p) {
    var d = teaorDivision(p && p.teaor);
    if (d === null || g.scope === 'eu' || ['grant', 'loan', 'loan+grant', 'wage-subsidy'].indexOf(g.type) < 0) return null;
    if ([64, 65, 66, 68, 92].indexOf(d) >= 0) {
      return { key: 'teaor', label: 'Főtevékenység', status: 'warn', reason: 'Pénzügyi, ingatlan- és szerencsejáték-tevékenység sok felhívásból ki van zárva — ellenőrizze a felhívásban.' };
    }
    return null;
  }

  // ---- eligibility tags on the call ("requires", from the official text) ----
  var REV_MAX = { '<50M': 50e6, '50M-200M': 200e6, '200M-500M': 500e6, '500M-1Mrd': 1e9, '1Mrd-3Mrd': 3e9, '3Mrd-10Mrd': 10e9, '10Mrd+': Infinity };
  var REV_MIN = { '<50M': 0, '50M-200M': 50e6, '200M-500M': 200e6, '500M-1Mrd': 500e6, '1Mrd-3Mrd': 1e9, '3Mrd-10Mrd': 3e9, '10Mrd+': 10e9 };
  function isConsortium(g) { return !!((g.requires && g.requires.consortium) || (g.scope === 'eu' && g.singleApplicant === false)); }
  function checkRequires(g, p) {
    var r = g.requires || {};
    var out = [];
    var inds = industriesOf(p);
    var known = inds.length > 0;
    var have = yearsOf(p);
    var div = teaorDivision(p && p.teaor);
    var DIVS = { farmer: [1, 2, 3], fisheries: [3], forestry: [2] };
    function sectorGate(key, label, need, reason) {
      if (!r[key]) return;
      if (!known && !(key === 'farmer' && p && p._agriShare >= 0.5)) { out.push({ key: key, label: 'Célcsoport', status: 'unknown', reason: reason }); return; }
      var hit = inds.some(function (x) { return need.indexOf(x) >= 0; });
      // With a TEÁOR code we can tell a crop farm from a fish farm or a forestry;
      // without one, a sector requirement stays unconfirmed.
      if (hit && DIVS[key] && div === null) { out.push({ key: key, label: 'Célcsoport', status: 'unknown', reason: reason + ' Adja meg a TEÁOR főtevékenységet a profilban.' }); return; }
      if (hit && DIVS[key]) hit = DIVS[key].indexOf(div) >= 0;
      if (key === 'farmer' && p && p._agriShare >= 0.5) hit = true;
      out.push(hit ? { key: key, label: 'Célcsoport', status: 'ok', reason: reason, bonus: 14 } : { key: key, label: 'Célcsoport', status: 'fail', reason: 'Csak ' + label + ' pályázhat.' });
    }
    if (isConsortium(g)) {
      // Medium and large companies join international consortia routinely;
      // for a micro or small firm it is a real hurdle.
      var t = (p && p._tier) || sizeTier(p && p.employees);
      out.push(t === 'large' || t === 'mid'
        ? { key: 'consortium', label: 'Pályázói kör', status: 'neutral', reason: 'Nemzetközi konzorcium kell (partnerek más országokból) — nagyobb cégként partnerként vagy vezetőként csatlakozhat.' }
        : { key: 'consortium', label: 'Pályázói kör', status: 'warn', reason: 'Nemzetközi konzorcium kell (partnerek más országokból).' });
    }
    if (r.cluster_manager) out.push({ key: 'cluster_manager', label: 'Pályázói kör', status: 'fail', reason: 'Csak akkreditált klasztermenedzsment-szervezetek pályázhatnak.' });
    if (r.research_led) out.push({ key: 'research_led', label: 'Pályázói kör', status: 'warn', reason: 'Kutatóhely (egyetem, kutatóintézet) a pályázó vagy a vezető partner.' });
    if (r.jobseeker) {
      out.push(have === undefined ? { key: 'jobseeker', label: 'Célcsoport', status: 'unknown', reason: 'Álláskeresők vállalkozásindítását támogatja.' }
        : have >= 1 ? { key: 'jobseeker', label: 'Célcsoport', status: 'fail', reason: 'Álláskeresők új vállalkozására szól, működő cégnek nem.' }
        : { key: 'jobseeker', label: 'Célcsoport', status: 'unknown', reason: 'Csak ha a vállalkozást álláskeresőként indítja.' });
    }
    if (typeof r.startup_max_years === 'number') {
      out.push(have === undefined ? { key: 'startup', label: 'Cég kora', status: 'unknown', reason: 'Legfeljebb ' + r.startup_max_years + ' éves cégeknek.' }
        : have <= r.startup_max_years ? { key: 'startup', label: 'Cég kora', status: 'ok', reason: 'Legfeljebb ' + r.startup_max_years + ' éves cégeknek — megfelel.' }
        : { key: 'startup', label: 'Cég kora', status: 'fail', reason: 'Csak legfeljebb ' + r.startup_max_years + ' éves cégeknek.' });
    }
    if (r.women_led) {
      var w = p && p.women_led;
      out.push(w === 'igen' ? { key: 'women_led', label: 'Célcsoport', status: 'ok', reason: 'Nők által alapított / vezetett cégeknek — megfelel.' }
        : w === 'nem' ? { key: 'women_led', label: 'Célcsoport', status: 'fail', reason: 'Csak nők által alapított / vezetett cégeknek.' }
        : { key: 'women_led', label: 'Célcsoport', status: 'unknown', reason: 'Nők által alapított / vezetett cégeknek szól.' });
    }
    if (r.youth_founder) out.push({ key: 'youth_founder', label: 'Célcsoport', status: 'unknown', reason: 'Fiatal alapítóknak szól — ellenőrizze a korhatárt a felhívásban.' });
    if (r.rnd_project || r.deeptech) {
      var rd = p && p.rnd;
      var what = r.deeptech ? 'Mélytechnológiai (deep-tech) innováció' : 'K+F / innovációs projekt';
      out.push(rd === 'igen' ? { key: 'rnd', label: 'Projekt típusa', status: 'ok', reason: what + ' — Ön tervez ilyet.', bonus: 6 }
        : rd === 'nem' ? { key: 'rnd', label: 'Projekt típusa', status: 'fail', reason: what + ' a támogatás tárgya; Ön nem tervez ilyet.' }
        : { key: 'rnd', label: 'Projekt típusa', status: 'unknown', reason: what + ' a támogatás tárgya.' });
    }
    sectorGate('farmer', 'mezőgazdasági termelők', ['Agriculture'], 'Mezőgazdasági termelőknek (pl. őstermelő, agrárvállalkozás).');
    sectorGate('fisheries', 'halászati / akvakultúra-vállalkozások', ['Agriculture'], 'Halászati / akvakultúra-vállalkozásoknak.');
    sectorGate('forestry', 'erdőgazdálkodók', ['Agriculture'], 'Erdőgazdálkodóknak.');
    sectorGate('tourism_ntak', 'NTAK-regisztrált turisztikai szolgáltatók', ['Tourism', 'Restaurant'], 'NTAK-regisztrált turisztikai szolgáltatóknak.');
    sectorGate('restaurant', 'vendéglátóhelyek', ['Restaurant'], 'Vendéglátóhelyeknek (étterem, cukrászda).');
    if (r.social_enterprise) out.push({ key: 'social_enterprise', label: 'Célcsoport', status: 'warn', reason: 'Társadalmi vállalkozásoknak szól.' });
    if (r.employer) {
      var e = p && p.employees, er = p && typeof p._headcount === 'number' ? [p._headcount, p._headcount] : EMP_RANGE[e];
      var nm = String(g.note || '').match(/(?:min\.?|legalább)\s*(\d+)\s*fő/i), minEmp = nm ? +nm[1] : 0;
      if (!er) out.push({ key: 'employer', label: 'Foglalkoztatás', status: 'unknown', reason: minEmp ? 'Legalább ' + minEmp + ' fős létszám kell.' : 'Alkalmazottakat foglalkoztató cégeknek.' });
      else if (minEmp > 1) {
        out.push(er[1] < minEmp ? { key: 'employer', label: 'Foglalkoztatás', status: 'fail', reason: 'Legalább ' + minEmp + ' fős létszám kell.' }
          : er[0] >= minEmp ? { key: 'employer', label: 'Foglalkoztatás', status: 'ok', reason: 'Megvan a legalább ' + minEmp + ' fős létszám.' }
          : { key: 'employer', label: 'Foglalkoztatás', status: 'unknown', reason: 'Legalább ' + minEmp + ' fős létszám kell — határeset, ellenőrizze.' });
      } else {
        out.push((er && er[1] < 1) || e === '1' ? { key: 'employer', label: 'Foglalkoztatás', status: 'warn', reason: 'Alkalmazott kell — egyszemélyes cégnek csak felvétel után.' }
          : { key: 'employer', label: 'Foglalkoztatás', status: 'ok', reason: 'Van alkalmazottja.' });
      }
    }
    if (r.hires_disadvantaged) out.push({ key: 'hires', label: 'Foglalkoztatás', status: 'neutral', reason: 'Célcsoportból (pl. fiatal, álláskereső) felvett munkavállaló bérére jár.' });
    if (typeof r.min_revenue_huf === 'number') {
      var rev = p && p.revenue;
      var need = r.min_revenue_huf, fmt = need >= 1e9 ? (need / 1e9) + ' Mrd Ft' : Math.round(need / 1e6) + ' M Ft';
      out.push(p && typeof p._revenue === 'number' ? (p._revenue >= need ? { key: 'revenue', label: 'Árbevétel', status: 'ok', reason: 'Megvan a legalább ' + fmt + ' árbevétel (' + fmtHuf(p._revenue) + ').' } : { key: 'revenue', label: 'Árbevétel', status: 'fail', reason: 'Legalább ' + fmt + ' éves árbevétel kell — az utolsó lezárt évben ' + fmtHuf(p._revenue) + ' volt.' })
        : !(rev in REV_MAX) ? { key: 'revenue', label: 'Árbevétel', status: 'unknown', reason: 'Legalább ' + fmt + ' éves árbevétel kell.' }
        : REV_MAX[rev] < need ? { key: 'revenue', label: 'Árbevétel', status: 'fail', reason: 'Legalább ' + fmt + ' éves árbevétel kell.' }
        : REV_MIN[rev] >= need ? { key: 'revenue', label: 'Árbevétel', status: 'ok', reason: 'Megvan a legalább ' + fmt + ' árbevétel.' }
        : { key: 'revenue', label: 'Árbevétel', status: 'unknown', reason: 'Legalább ' + fmt + ' árbevétel kell — határeset.' });
    }
    if (r.bank_loan) out.push({ key: 'bank', label: 'Igénylés', status: 'neutral', reason: 'Bankon / hitelközvetítőn keresztül igényelhető, hitelbírálattal.' });
    if (r.no_kata) {
      var tx = p && p.tax_regime, lf = p && p.legal_form;
      // Since 2022 only sole traders can be KATA taxpayers.
      if (tx === 'kata') out.push({ key: 'kata', label: 'Adózási forma', status: 'fail', reason: 'KATA-s vállalkozás nem pályázhat.' });
      else if (tx) out.push({ key: 'kata', label: 'Adózási forma', status: 'ok', reason: 'KATA-sok nem pályázhatnak — Ön nem KATA-s.' });
      else if (!lf || lf === 'EV') out.push({ key: 'kata', label: 'Adózási forma', status: 'unknown', reason: 'KATA-s vállalkozás nem pályázhat — adja meg az adózási formát a profilban.' });
    }
    if (r.de_minimis) {
      var dm = p && p.de_minimis;
      if (p && typeof p._dmUsed === 'number') {
        var left = DM_CAP - p._dmUsed, ask = p._requestedEur;
        out.push(left <= 0 ? { key: 'de_minimis', label: 'De minimis keret', status: 'fail', reason: 'De minimis támogatás: 3 év alatt legfeljebb 300 ezer € — az Ön kerete elfogyott.' }
          : typeof ask === 'number' && ask > left ? { key: 'de_minimis', label: 'De minimis keret', status: 'warn', reason: 'Szabad de minimis keret kb. ' + fmtEur(left) + ', a tervezett támogatás (' + fmtEur(ask) + ') ennél több.' }
          : left < 30000 ? { key: 'de_minimis', label: 'De minimis keret', status: 'warn', reason: 'Már csak kb. ' + fmtEur(left) + ' szabad de minimis kerete van.' }
          : { key: 'de_minimis', label: 'De minimis keret', status: 'ok', reason: 'De minimis támogatás — szabad kerete kb. ' + fmtEur(left) + '.' });
      } else out.push(dm === '250k+' ? { key: 'de_minimis', label: 'De minimis keret', status: 'warn', reason: 'Csekély összegű (de minimis) támogatás: 3 év alatt legfeljebb 300 ezer € — az Ön kerete nagyrészt elfogyott.' }
        : dm === '100k-250k' ? { key: 'de_minimis', label: 'De minimis keret', status: 'neutral', reason: 'De minimis támogatás: 3 év alatt legfeljebb 300 ezer € — még van szabad kerete, de számolja ki pontosan.' }
        : dm === 'nincs' || dm === '<100k' ? { key: 'de_minimis', label: 'De minimis keret', status: 'ok', reason: 'De minimis támogatás — van szabad kerete.' }
        : { key: 'de_minimis', label: 'De minimis keret', status: 'neutral', reason: 'Csekély összegű (de minimis) támogatás: 3 év alatt legfeljebb 300 ezer € adható — ellenőrizze a szabad keretét.' });
    }
    if (r.favoured_district) {
      var F = root.AIPFav, byProject = !!(p && p._projectLocation), fs = F && p && (p._projectLocation || p.location) ? F.statusOfLocation(p._projectLocation || p.location) : 'unknown';
      out.push(fs === 'yes' ? { key: 'favoured', label: 'Kedvezményezett térség', status: 'ok', reason: 'Kedvezményezett járásban — a ' + (byProject ? 'megvalósítás helye' : 'székhely') + ' alapján megfelel.', bonus: 8 }
        : fs === 'no' && byProject ? { key: 'favoured', label: 'Kedvezményezett térség', status: 'fail', reason: 'Csak kedvezményezett járásban megvalósuló fejlesztés pályázhat; a megadott megvalósítási hely nem ilyen.' }
        : fs === 'no' ? { key: 'favoured', label: 'Kedvezményezett térség', status: 'warn', reason: 'Csak kedvezményezett járásban megvalósuló fejlesztés pályázhat; a székhely nem ilyen — telephelyen megvalósítva még lehetséges.' }
        : { key: 'favoured', label: 'Kedvezményezett térség', status: 'unknown', reason: 'Csak kedvezményezett járásban megvalósuló fejlesztés pályázhat — adja meg a székhely irányítószámát.' });
    }

    // ---- tags from the DFT model (detailed sheet) ----
    var E = (p && p._e) || {};
    if (r.no_sole_trader) {
      var ev = p && (p.legal_form === 'EV' || E.org_type === 'egyeni_vallalkozo');
      out.push(ev ? { key: 'sole_trader', label: 'Cégforma', status: 'fail', reason: 'Egyéni vállalkozó nem pályázhat.' }
        : p && (p.legal_form || E.org_type) ? { key: 'sole_trader', label: 'Cégforma', status: 'ok', reason: 'Egyéni vállalkozók nem pályázhatnak — Ön nem az.' }
        : { key: 'sole_trader', label: 'Cégforma', status: 'unknown', reason: 'Egyéni vállalkozó nem pályázhat — adja meg a cégformát.' });
    }
    if (typeof r.min_headcount === 'number') {
      var mh = r.min_headcount, hc2 = p && typeof p._headcount === 'number' ? [p._headcount, p._headcount] : EMP_RANGE[p && p.employees];
      out.push(!hc2 ? { key: 'headcount', label: 'Létszám', status: 'unknown', reason: 'Legalább ' + mh + ' fő átlagos statisztikai létszám kell.' }
        : hc2[0] >= mh ? { key: 'headcount', label: 'Létszám', status: 'ok', reason: 'Megvan a legalább ' + mh + ' fős átlagos létszám.' }
        : hc2[1] < mh ? { key: 'headcount', label: 'Létszám', status: 'fail', reason: 'Legalább ' + mh + ' fő átlagos statisztikai létszám kell.' }
        : { key: 'headcount', label: 'Létszám', status: 'unknown', reason: 'Legalább ' + mh + ' fő átlagos statisztikai létszám kell — adja meg a pontos létszámot az adatlapon.' });
    }
    if (typeof r.min_closed_years === 'number') {
      var ny = r.min_closed_years;
      out.push(have === undefined ? { key: 'years', label: 'Működési idő', status: 'unknown', reason: 'Legalább ' + ny + ' lezárt, teljes üzleti év kell.' }
        : have >= ny ? { key: 'years', label: 'Működési idő', status: 'ok', reason: 'Megvan a szükséges ' + ny + ' lezárt üzleti év.' }
        : { key: 'years', label: 'Működési idő', status: 'fail', reason: 'Legalább ' + ny + ' lezárt, teljes üzleti év kell.' });
    }
    if (Array.isArray(r.teaor_codes) && r.teaor_codes.length) {
      var want = codeList(r.teaor_codes), shown = r.teaor_codes.slice(0, 6).join(', ') + (r.teaor_codes.length > 6 ? '…' : '');
      var mine = p && p._projectTeaor && p._projectTeaor.length ? p._projectTeaor : (p && p._teaors) || codeList(p && p.teaor);
      out.push(!mine.length ? { key: 'teaor_codes', label: 'TEÁOR', status: 'unknown', reason: 'Csak ezekre a tevékenységekre: ' + shown + '. Adja meg a TEÁOR-kódjait.' }
        : codeHit(mine, want) ? { key: 'teaor_codes', label: 'TEÁOR', status: 'ok', reason: 'A felhívásban felsorolt tevékenység (' + shown + ') — egyezik.', bonus: 10 }
        : { key: 'teaor_codes', label: 'TEÁOR', status: 'warn', cap: true, reason: 'A felhívás ezekre a TEÁOR-kódokra szól: ' + shown + ' — az Ön kódjai nem szerepelnek köztük (ellenőrizze TEÁOR’25 szerint).' });
    }
    if (Array.isArray(r.excluded_teaor) && r.excluded_teaor.length) {
      var mine2 = (p && p._projectTeaor && p._projectTeaor.length ? p._projectTeaor : []).concat(codeList(p && p.teaor));
      if (mine2.length && codeHit(mine2, codeList(r.excluded_teaor))) out.push({ key: 'teaor_codes', label: 'TEÁOR', status: 'fail', reason: 'Az Ön (fő- vagy projekt-) tevékenysége a felhívásból kizárt TEÁOR-ok között van.' });
    }
    if (r.szvz) {
      out.push(E.is_szvz === 'igen' ? { key: 'szvz', label: 'Szabad vállalkozási zóna', status: 'ok', reason: 'Szabad vállalkozási zónában — megfelel.', bonus: 8 }
        : E.is_szvz === 'nem' ? { key: 'szvz', label: 'Szabad vállalkozási zóna', status: 'fail', reason: 'Csak szabad vállalkozási zónában (SZVZ) megvalósuló fejlesztés pályázhat.' }
        : { key: 'szvz', label: 'Szabad vállalkozási zóna', status: 'unknown', reason: 'Csak szabad vállalkozási zónában (SZVZ) — adja meg az adatlapon.' });
    }
    if (typeof r.max_settlement_pop === 'number') {
      var band = POP_BAND[E.settlement_pop], lim = r.max_settlement_pop;
      out.push(!band ? { key: 'settlement', label: 'Település mérete', status: 'unknown', reason: 'Csak ' + lim + ' lakos alatti településen.' }
        : band[1] < lim ? { key: 'settlement', label: 'Település mérete', status: 'ok', reason: lim + ' lakos alatti település — megfelel.', bonus: 8 }
        : band[0] >= lim ? { key: 'settlement', label: 'Település mérete', status: 'fail', reason: 'Csak ' + lim + ' lakos alatti településen megvalósuló fejlesztés pályázhat.' }
        : { key: 'settlement', label: 'Település mérete', status: 'unknown', reason: 'Csak ' + lim + ' lakos alatti településen — határeset, ellenőrizze.' });
    }
    if (typeof r.premises_min_days === 'number') {
      var rd = E.project_site_reg_date || E.registered_address_date;
      var age = /^\d{4}-\d{2}-\d{2}$/.test(rd || '') ? daysUntil(TODAY_REF, rd) : null; // today − registration date
      out.push(age === null ? { key: 'premises', label: 'Telephely', status: 'unknown', reason: 'A megvalósítás helyének legalább ' + r.premises_min_days + ' nappal a beadás előtt bejegyzettnek kell lennie.' }
        : age >= r.premises_min_days ? { key: 'premises', label: 'Telephely', status: 'ok', reason: 'A telephely elég régóta be van jegyezve.' }
        : { key: 'premises', label: 'Telephely', status: 'warn', reason: 'A telephelynek legalább ' + r.premises_min_days + ' nappal a beadás előtt bejegyzettnek kell lennie — most ' + age + ' napos.' });
    }
    if (r.export) {
      out.push(p && typeof p._export === 'number' ? (p._export > 0 ? { key: 'export', label: 'Export', status: 'ok', reason: 'Exportárbevétele van.', bonus: 8 } : { key: 'export', label: 'Export', status: 'warn', reason: 'Exportáló cégeknek szól; Önnek nincs exportárbevétele.' })
        : { key: 'export', label: 'Export', status: 'unknown', reason: 'Exportáló vagy exportra készülő cégeknek.' });
    }
    if (r.positive_equity && p && typeof p._equity === 'number') {
      out.push(p._equity >= 0 ? { key: 'equity', label: 'Saját tőke', status: 'ok', reason: 'A saját tőke nem negatív.' } : { key: 'equity', label: 'Saját tőke', status: 'fail', reason: 'Negatív saját tőkével nem lehet pályázni.' });
    }
    if (r.equity_vs_capital && p && typeof p._equity === 'number' && typeof p._shareCapital === 'number') {
      out.push(p._equity >= p._shareCapital ? { key: 'equity', label: 'Saját tőke', status: 'ok', reason: 'A saját tőke eléri a jegyzett tőkét.' } : { key: 'equity', label: 'Saját tőke', status: 'fail', reason: 'A saját tőkének el kell érnie a jegyzett tőkét (' + fmtHuf(p._shareCapital) + ').' });
    }
    if (r.aid_max_equity && p && typeof p._equity === 'number' && typeof p._requested === 'number' && p._requested > p._equity) {
      out.push({ key: 'limit', label: 'Támogatás felső határa', status: 'warn', reason: 'A támogatás legfeljebb a saját tőke összege (' + fmtHuf(Math.max(0, p._equity)) + ') lehet.' });
    }
    if (typeof r.project_max_revenue_pct === 'number' && p && typeof p._revenue === 'number' && typeof p._projectCost === 'number' && p._projectCost > p._revenue * r.project_max_revenue_pct / 100) {
      out.push({ key: 'limit', label: 'Projektméret', status: 'warn', reason: 'A projekt legfeljebb az árbevétel ' + r.project_max_revenue_pct + '%-a (' + fmtHuf(p._revenue * r.project_max_revenue_pct / 100) + ') lehet.' });
    }
    if (typeof r.loan_max_ebit_x === 'number' && p && typeof p._ebit === 'number' && typeof p._requested === 'number' && p._requested > p._ebit * r.loan_max_ebit_x) {
      out.push({ key: 'limit', label: 'Hitel felső határa', status: 'warn', reason: 'A kölcsön legfeljebb az üzemi eredmény ' + r.loan_max_ebit_x + '-szerese (' + fmtHuf(Math.max(0, p._ebit * r.loan_max_ebit_x)) + ') lehet.' });
    }
    if (r.not_started && E.investment_started === 'igen') out.push({ key: 'incentive', label: 'Projekt kezdése', status: 'fail', reason: 'A projekt nem kezdődhet meg a kérelem beadása előtt (megrendelés, szerződés, előleg) — Önnél már megkezdődött.' });
    if (r.new_assets_only && E.asset_new_or_used === 'hasznalt') out.push({ key: 'assets', label: 'Eszközök', status: 'fail', reason: 'Csak új eszköz beszerzése támogatható.' });
    return out;
  }


  // Universal rules of Hungarian state aid that the detailed sheet answers
  // (company status, legal presence, labour-law and transparency rules,
  // incentive effect). Unanswered questions add nothing: they are the same
  // for every call and would only push every score down.
  function checkDetail(g, p) {
    var E = p && p._e; if (!E) return [];
    var out = [], hu = g.scope !== 'eu';
    var stateAid = ['grant', 'loan', 'loan+grant', 'wage-subsidy', 'guarantee'].indexOf(g.type) >= 0;
    if (E.company_status === 'megszunt' || E.company_status === 'torles_alatt') out.push({ key: 'status', label: 'Cég státusza', status: 'fail', reason: 'Megszűnt vagy törlés alatt álló cég nem pályázhat.' });
    else if (E.company_status === 'szunetel') out.push({ key: 'status', label: 'Cég státusza', status: 'fail', reason: 'Szüneteltetett tevékenységgel nem lehet pályázni.' });
    if (hu && E.has_hungarian_presence === 'other') out.push({ key: 'presence', label: 'Székhely', status: 'fail', reason: 'Magyarországi székhely vagy (EGT-s cégnél) magyarországi fióktelep kell.' });
    if (hu && E.org_type === 'koltsegvetesi') out.push({ key: 'org', label: 'Szervezettípus', status: 'fail', reason: 'Költségvetési szerv nem pályázhat vállalkozásoknak szóló felhívásra.' });
    else if (hu && stateAid && E.org_type === 'nonprofit') out.push({ key: 'org', label: 'Szervezettípus', status: 'warn', reason: 'A vállalkozásfejlesztési felhívások többsége csak gazdasági társaságoknak és egyéni vállalkozóknak szól.' });
    if (hu && stateAid) {
      var bad = [];
      if (E.orderly_labor_relations === 'nem' || E.undeclared_worker_decision === 'igen') bad.push('nem rendezettek a munkaügyi kapcsolatok');
      if (E.equal_treatment_exclusion === 'igen') bad.push('egyenlő bánásmód megsértése miatti kizárás');
      if (E.transparency_ok === 'nem' || E.is_offshore_owner === 'igen') bad.push('nem minősül átlátható szervezetnek');
      if (E.repayment_obligation === 'igen') bad.push('korábbi támogatásból visszafizetési kötelezettség');
      var pr = Array.isArray(E.proceedings) ? E.proceedings : [];
      if (pr.indexOf('court_disqualification') >= 0) bad.push('bírósági eltiltás');
      if (pr.indexOf('director_disqualification') >= 0) bad.push('a vezető tisztségviselő eltiltása');
      if (E.under_enforcement === 'igen') bad.push('NAV-végrehajtás');
      var answered = E.orderly_labor_relations && E.transparency_ok;
      if (bad.length) out.push({ key: 'compliance', label: 'Megfelelőség', status: 'fail', reason: 'Állami támogatás nem adható: ' + bad.join(', ') + '.' });
      else if (answered) out.push({ key: 'compliance', label: 'Megfelelőség', status: 'ok', reason: 'Rendezett munkaügyi kapcsolatok, átlátható szervezet.' });
      if (typeof p._equity === 'number' && p._equity < 0 && !(g.requires && g.requires.positive_equity)) out.push({ key: 'equity', label: 'Saját tőke', status: 'fail', reason: 'Negatív saját tőkével nem adható állami támogatás.' });
    } else if (!hu && typeof p._equity === 'number' && p._equity < 0) {
      out.push({ key: 'equity', label: 'Saját tőke', status: 'warn', reason: 'Negatív saját tőke mellett a pénzügyi alkalmasság kérdéses.' });
    }
    var grantish = hu && ['grant', 'loan+grant'].indexOf(g.type) >= 0, rq = g.requires || {};
    if (grantish && E.investment_started === 'igen' && !rq.not_started) out.push({ key: 'incentive', label: 'Projekt kezdése', status: 'warn', cap: true, reason: 'Vissza nem térítendő támogatásnál a projekt általában nem kezdődhet meg a beadás előtt — Önnél már megkezdődött.' });
    if (grantish && E.asset_new_or_used === 'hasznalt' && !rq.new_assets_only) out.push({ key: 'assets', label: 'Eszközök', status: 'warn', reason: 'A legtöbb felhívás csak új eszköz beszerzését támogatja.' });
    return out;
  }

  function checkApplicant(g) {
    if (/projekttársaság/i.test(g.note || '')) return { key: 'applicant', label: 'Pályázói kör', status: 'warn', cap: true, reason: 'Csak erre a célra létrehozott projekttársaság igényelheti.' };
    if (/támogatói okirattal rendelkez|okirattal rendelkező kedvezményezett|már támogatásban részesült/i.test(g.note || '')) return { key: 'applicant', label: 'Pályázói kör', status: 'warn', cap: true, reason: 'Csak annak, akinek már van erre vonatkozó támogatói döntése (okirata).' };
    if (/LEADER együttműköd|helyi akciócsoport|\bHACS\b/i.test([g.title, g.note].join(' '))) return { key: 'applicant', label: 'Pályázói kör', status: 'warn', cap: true, reason: 'Elsősorban helyi akciócsoportok (HACS) és partnereik pályázhatnak.' };
    if (/csak minősített|kizárólag|csak .*szervezet|szűk kör|engedély szükséges|koncesszió|MGFÜ-regisztráció/i.test(g.note || '')) return { key: 'applicant', label: 'Pályázói kör', status: 'warn', reason: g.note };
    if (/nagyvállalat|1 Mrd Ft-os minimum|minimum miatt/i.test(g.note || '')) return { key: 'applicant', label: 'Pályázói kör', status: 'warn', reason: 'A gyakorlatban nagy projektekhez / nagyobb cégeknek.' };
    return null;
  }

  function checkMoney(g, p) {
    if (g.keret > 0 && typeof g.remaining === 'number' && g.remaining <= 0) return { key: 'money', label: 'Keret', status: 'warn', reason: 'A keretet már lekötötték — csak várólistás esély.' };
    if (p && p.own_funds === 'nem' && ['grant', 'loan+grant'].indexOf(g.type) >= 0 && g.scope !== 'eu') return { key: 'money', label: 'Önerő', status: 'warn', reason: 'A legtöbb támogatáshoz önerő kell; hitel lehet jobb választás.' };
    return null;
  }

  function checkTiming(g, today) {
    var d = daysUntil(g.deadline, today);
    var w = daysUntil(g.windowOpen, today);
    if (w !== null && w > 0) return { key: 'timing', label: 'Határidő', status: 'ok', reason: w + ' nap múlva nyílik — van idő felkészülni.' };
    if (d === null) return { key: 'timing', label: 'Határidő', status: 'ok', reason: 'Folyamatosan igényelhető.' };
    if (d < 7) return { key: 'timing', label: 'Határidő', status: 'warn', reason: 'Csak ' + d + ' nap van hátra — nagyon szoros.' };
    if (d < 21) return { key: 'timing', label: 'Határidő', status: 'warn', reason: d + ' nap van hátra.' };
    return { key: 'timing', label: 'Határidő', status: 'ok', reason: d + ' nap van hátra.' };
  }

  // ---- overall -----------------------------------------------------------
  function match(g, profile, today) {
    today = today || new Date().toISOString().slice(0, 10);
    TODAY_REF = today;
    var p = profile && (profile.company || profile.employees || industriesOf(profile).length) ? derive(profile, today) : null;
    var req = checkRequires(g, p);
    var covered = {}; req.forEach(function (c) { if (['farmer', 'fisheries', 'forestry', 'tourism_ntak', 'restaurant'].indexOf(c.key) >= 0) covered.sector = true; });
    var sector = checkSector(g, p);
    // A tag-based target-group check replaces the keyword sector guess when it
    // decides the same question (and is more reliable).
    if (covered.sector && sector && !sector.specific && (sector.status === 'fail' || sector.status === 'unknown' || sector.status === 'warn')) sector = null;
    var checks = [checkSize(g, p), checkRegion(g, p), sector, checkTeaor(g, p), (g.requires && typeof g.requires.min_closed_years === 'number') ? null : checkYears(g, p), checkBasics(g, p)].concat(checkDetail(g, p), req, [checkApplicant(g), checkMoney(g, p), checkTiming(g, today)])
      .filter(Boolean);
    var fails = checks.filter(function (c) { return c.status === 'fail'; }).length;
    var warns = checks.filter(function (c) { return c.status === 'warn'; }).length;
    var unknown = checks.filter(function (c) { return c.status === 'unknown'; }).length;
    // Bonuses do not stack without limit (a perfect topic fit must not hide
    // the hurdles), and APPLY needs a real topic / target-group match — the
    // small generic "any business" bonus is not one.
    var bonus = Math.min(BONUS_CAP, checks.reduce(function (s, c) { return s + (c.bonus || 0); }, 0));
    var topical = checks.some(function (c) { return c.status === 'ok' && c.bonus > GENERIC_BONUS; });
    // An open hard requirement (size, region, target group, company age,
    // revenue, sector…) means we cannot recommend applying yet.
    var hardUnknown = checks.some(function (c) { return c.status === 'unknown' && (c.hard || HARD.indexOf(c.key) >= 0); });
    var noMoney = g.keret > 0 && typeof g.remaining === 'number' && g.remaining <= 0;
    var score;
    if (!p) {
      // No profile: only how actionable the call is (single applicant, time, budget).
      score = 70 - warns * 10;
    } else {
      // Base + how well the topic fits (sector bonus) + what kind of money it is
      // (non-repayable ranks above loans) + domestic first + time to prepare,
      // minus hurdles. APPLY (≥75) in practice needs a topic match.
      var typeB = { 'grant': 6, 'wage-subsidy': 2, 'loan+grant': 4, 'grant+equity': 4, 'in-kind': 2, 'loan': -4, 'guarantee': -6 }[g.type] || 0;
      if (g.type === 'equity') typeB = (yearsOf(p) <= 2 || industriesOf(p).indexOf('IT') >= 0) ? 3 : -3;
      var d = daysUntil(g.deadline, today);
      // Strict on purpose (2026-11-25): a high score means "very likely
      // eligible and a real fit", so every open question costs more.
      // Small, real differences instead of ties: time to prepare, money left,
      // and a call written for exactly this company size.
      var timeB = d === null ? 1 : d > 45 ? 3 : d >= 21 ? 1 : 0;
      var share = g.keret > 0 && typeof g.remaining === 'number' ? g.remaining / g.keret : null;
      var moneyB = share === null ? 0 : share < 0.15 ? -3 : share > 0.5 ? 1 : 0;
      var tierNow = p._tier || sizeTier(p.employees);
      var sizeB = tierNow && (g.sizeClasses || []).some(function (c) { return String(c).toLowerCase().indexOf({ micro: 'mikro', small: 'kisvállalkoz', mid: 'középvállalkoz', large: 'nagyvállalkoz' }[tierNow]) >= 0; }) && (g.sizeClasses || []).length < 4 ? 2 : 0;
      score = 56 + bonus + typeB + (g.scope !== 'eu' ? 4 : -4) + timeB + moneyB + sizeB - warns * 10 - unknown * 6;
      // ineligible: 30 at most, but keep a little of the fit so the order means something
      if (fails) score = Math.min(30, 24 - (fails - 1) * 8 + Math.round(Math.max(0, Math.min(90, score)) / 15));
    }
    score = Math.max(5, Math.min(99, Math.round(score)));
    var verdict = !p ? 'REVIEW' : fails ? 'SKIP' : score >= 75 ? 'APPLY' : score >= 55 ? 'REVIEW' : 'SKIP';
    var group = isConsortium(g) ? 'consortium' : g.scope === 'eu' ? 'eu' : 'hazai';
    // A consortium call is a top recommendation only for a medium or large
    // company (they join international consortia routinely), and an R&D call
    // only when the company said it plans R&D.
    var rq = g.requires || {};
    var tier = (p && p._tier) || sizeTier(p && p.employees);
    var consortiumCap = group === 'consortium' && tier !== 'large' && tier !== 'mid';
    // EU programme money is almost always an R&D / innovation project in
    // English with a heavy application: a top recommendation only for
    // companies that said they plan one.
    // Medium and large companies run EU projects routinely, so the cap is for
    // micro and small firms only (decided Oct 2026: big firms are key leads).
    var euNoRnd = g.scope === 'eu' && !(p && p.rnd === 'igen') && tier !== 'large' && tier !== 'mid';
    // EU cascade (FSTP) calls with no stated money are never a top recommendation.
    var capped = checks.some(function (c) { return c.cap; }) || (g.scope === 'eu' && !g.amount && !(g.keret > 0) && /kaszkád|FSTP|cascade/i.test(g.title || ''));
    if (verdict === 'APPLY' && (capped || consortiumCap || euNoRnd || !topical || hardUnknown || noMoney || ((rq.rnd_project || rq.deeptech) && !(p && p.rnd === 'igen')))) {
      verdict = 'REVIEW';
      score = Math.min(score, 74);
    }
    // EU programme / consortium calls a micro or small firm would rarely win
    // must not outrank realistic domestic options.
    if (p && !fails && (consortiumCap || euNoRnd) && score > 64) score = 60 + Math.min(4, Math.round((score - 64) / 6));
    return { score: score, verdict: verdict, eligible: !fails, personal: !!p, checks: checks, group: group };
  }

  // Profile fields the matching uses, and which are still empty.
  var NEEDED = [
    ['employees', 'Létszám'], ['site_region', 'Megvalósítás régiója'], ['teaor', 'TEÁOR főtevékenység'],
    ['years_operating', 'Lezárt üzleti évek'], ['public_debt_free', 'Köztartozásmentesség'],
    ['in_difficulty', 'Nehéz helyzetű-e'], ['insolvency', 'Csőd-, felszámolási vagy végrehajtási eljárás'], ['own_funds', 'Önerő'], ['rnd', 'Tervez-e K+F / innovációs projektet'],
  ];
  function missingFields(p) {
    return NEEDED.filter(function (f) { return !p || !p[f[0]] || (f[0] === 'employees' && p.employees === '100+'); })
      .map(function (f) { return { key: f[0], label: f[0] === 'employees' && p && p.employees === '100+' ? 'Létszám pontosítása (101–249 fő vagy 250 fő felett)' : f[1] }; });
  }

  var api = { match: match, derive: derive, euTier: euTier, EUR_HUF: EUR_HUF, sizeTier: sizeTier, teaorIndustries: teaorIndustries, missingFields: missingFields, isConsortium: isConsortium, ALL_REGIONS: ALL_REGIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
