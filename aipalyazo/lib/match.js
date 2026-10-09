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
  // Forestry words count as a topic match only for a forestry / agricultural
  // main activity (TEÁOR 01–02), not for every food processor.
  var FOREST_RE = /erdő|erdész|fásít|\bforest/i;
  var FOREST_DIVS = [1, 2];
  // Calls that only make sense for one sector: a company outside it is not
  // eligible. `divs`: the TEÁOR divisions that qualify, when the profile has one.
  var SECTOR_ONLY = [
    { re: /halász|akvakult|halfeldolg|halgazd|\bfish|aquacult/i, need: ['Agriculture'], divs: [3, 10], label: 'halászat / akvakultúra' },
    { re: FOREST_RE, need: ['Agriculture'], divs: FOREST_DIVS, label: 'erdőgazdálkodás' },
    { re: /ültetvény|gazdaságátad|termelői csoport|őstermel|agrár.*kártya|agrár.*hitel|mezőgazdasági termel/i, need: ['Agriculture'], label: 'mezőgazdasági termelés' },
    { re: /élelmiszeripar|élelmiszer-feldolg|\bTÉSZ\b|food process/i, need: ['Agriculture', 'Food'], divs: [1, 2, 3, 10, 11, 12], soft: ['Manufacturing', 'Retail'], label: 'élelmiszeripar' },
    { re: /geoterm|földhő/i, need: ['HVAC'], soft: ['Manufacturing', 'Construction'], label: 'geotermikus energia' },
    { re: /turisztikai kártya|szálláshely|vendéglát/i, need: ['Tourism', 'Restaurant'], label: 'turizmus / vendéglátás' },
    { re: /előadó-művész|performing arts|kulturális örökség|cultural heritage/i, need: ['Education', 'General'], label: 'kultúra' },
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
  var HARD = ['size', 'region', 'years', 'jobseeker', 'startup', 'women_led', 'revenue', 'employer', 'farmer', 'fisheries', 'forestry', 'tourism_ntak', 'restaurant', 'youth_founder', 'rnd'];
  var TIER_LABEL = { micro: 'mikrovállalkozás', small: 'kisvállalkozás', mid: 'középvállalkozás', large: 'nagyvállalkozás' };
  // Call text that says "SMEs only" / text that says larger firms may apply too.
  var KKV_TEXT = /\bKKV|\bSMEs?\b|SME's|mikro-, kis- és közép|kis- és középvállal/i;
  var OPEN_TEXT = /nagyvállal|nagyobb (?:cég|vállal)|mid-?cap|bárki|\d{3,}\s*fő|\d{3,}\s*fős/i;
  var closedYears = { '0': 0, '1': 1, '2': 2, '3-5': 3, '5+': 5 };

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

  // ---- the individual checks ---------------------------------------------
  function checkSize(g, p) {
    var emp = p && p.employees, tier = sizeTier(emp), legacy = emp === '100+';
    var big = tier === 'large' || legacy;
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
    if (!tier && !legacy) return r('unknown', 'Adja meg a létszámot a profilban.');
    if (big) {
      if (nagy) return r('ok', 'Nagyvállalkozás is pályázhat.');
      if (legacy) return kozep ? r('unknown', 'Csak KKV-k (250 fő alatt) pályázhatnak. ' + ASK) : r('fail', 'Csak mikro- és kisvállalkozások pályázhatnak.');
      if (generic && !saysKkv) return r('unknown', 'A felhívás a KKV-kat nevesíti — nagyvállalatként ellenőrizze a felhívásban.');
      return r('fail', 'Csak mikro-, kis- és középvállalkozások (KKV) pályázhatnak — nagyvállalat nem.');
    }
    if (generic) return r('ok', 'A felhívás nem korlátozza a cégméretet.');
    var ok = (tier === 'micro' && mikro) || (tier === 'small' && kis) || (tier === 'mid' && (kozep || nagy));
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
    return regs.indexOf(site) >= 0
      ? { key: 'region', label: 'Helyszín', status: 'ok', reason: site + ' jogosult (' + desc + ').' }
      : { key: 'region', label: 'Helyszín', status: 'fail', reason: site + ' nem jogosult — csak: ' + desc + '.' };
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
        // 'General' (other services) fits a cultural call, but is too broad to count as a strong match.
        if (hit) return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'Ágazati felhívás (' + s.label + '), illik a tevékenységéhez.', bonus: inds.some(function (x) { return x !== 'General' && s.need.indexOf(x) >= 0; }) ? 22 : 8 };
        if (s.soft && inds.some(function (x) { return s.soft.indexOf(x) >= 0; })) return { key: 'sector', label: 'Tevékenység', status: 'warn', reason: 'Csak ' + s.label + ' területen — ha Ön ilyen tevékenységet folytat, jogosult.' };
        return { key: 'sector', label: 'Tevékenység', status: 'fail', reason: 'Csak ' + s.label + ' területen működőknek.' };
      }
    }
    if (!inds.length) return { key: 'sector', label: 'Tevékenység', status: 'unknown', reason: 'Adja meg a tevékenységi kört a profilban.' };
    var match = inds.some(function (x) { return x !== 'General' && INDUSTRY_RE[x] && INDUSTRY_RE[x].test(text); })
      || (inds.indexOf('Agriculture') >= 0 && (div === null || FOREST_DIVS.indexOf(div) >= 0) && FOREST_RE.test(text));
    var interest = p && Array.isArray(p.categories) && p.categories.indexOf(g.cat) >= 0;
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
    var have = p ? closedYears[p.years_operating] : undefined;
    if (have === undefined) return { key: 'years', label: 'Működési idő', status: 'unknown', reason: 'Legalább ' + need + ' lezárt üzleti év kell.' };
    return have >= need
      ? { key: 'years', label: 'Működési idő', status: 'ok', reason: 'Megvan a szükséges ' + need + ' lezárt év.' }
      : { key: 'years', label: 'Működési idő', status: 'fail', reason: 'Legalább ' + need + ' lezárt üzleti év kell.' };
  }

  function checkBasics(g, p) {
    if (!p) return null;
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
    if (p.in_difficulty === 'igen') return { key: 'basics', label: 'Alapfeltételek', status: 'fail', reason: 'Nehéz helyzetű vállalkozás nem kaphat támogatást.' };
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
    var have = p ? closedYears[p.years_operating] : undefined;
    var div = teaorDivision(p && p.teaor);
    var DIVS = { farmer: [1, 2, 3], fisheries: [3], forestry: [2] };
    function sectorGate(key, label, need, reason) {
      if (!r[key]) return;
      if (!known) { out.push({ key: key, label: 'Célcsoport', status: 'unknown', reason: reason }); return; }
      var hit = inds.some(function (x) { return need.indexOf(x) >= 0; });
      // With a TEÁOR code we can tell a crop farm from a fish farm or a forestry;
      // without one, a sector requirement stays unconfirmed.
      if (hit && DIVS[key] && div === null) { out.push({ key: key, label: 'Célcsoport', status: 'unknown', reason: reason + ' Adja meg a TEÁOR főtevékenységet a profilban.' }); return; }
      if (hit && DIVS[key]) hit = DIVS[key].indexOf(div) >= 0;
      out.push(hit ? { key: key, label: 'Célcsoport', status: 'ok', reason: reason, bonus: 14 } : { key: key, label: 'Célcsoport', status: 'fail', reason: 'Csak ' + label + ' pályázhat.' });
    }
    if (isConsortium(g)) {
      // Medium and large companies join international consortia routinely;
      // for a micro or small firm it is a real hurdle.
      var t = sizeTier(p && p.employees);
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
      var e = p && p.employees, er = EMP_RANGE[e];
      var nm = String(g.note || '').match(/(?:min\.?|legalább)\s*(\d+)\s*fő/i), minEmp = nm ? +nm[1] : 0;
      if (!er) out.push({ key: 'employer', label: 'Foglalkoztatás', status: 'unknown', reason: minEmp ? 'Legalább ' + minEmp + ' fős létszám kell.' : 'Alkalmazottakat foglalkoztató cégeknek.' });
      else if (minEmp > 1) {
        out.push(er[1] < minEmp ? { key: 'employer', label: 'Foglalkoztatás', status: 'fail', reason: 'Legalább ' + minEmp + ' fős létszám kell.' }
          : er[0] >= minEmp ? { key: 'employer', label: 'Foglalkoztatás', status: 'ok', reason: 'Megvan a legalább ' + minEmp + ' fős létszám.' }
          : { key: 'employer', label: 'Foglalkoztatás', status: 'unknown', reason: 'Legalább ' + minEmp + ' fős létszám kell — határeset, ellenőrizze.' });
      } else {
        out.push(e === '1' ? { key: 'employer', label: 'Foglalkoztatás', status: 'warn', reason: 'Alkalmazott kell — egyszemélyes cégnek csak felvétel után.' }
          : { key: 'employer', label: 'Foglalkoztatás', status: 'ok', reason: 'Van alkalmazottja.' });
      }
    }
    if (r.hires_disadvantaged) out.push({ key: 'hires', label: 'Foglalkoztatás', status: 'neutral', reason: 'Célcsoportból (pl. fiatal, álláskereső) felvett munkavállaló bérére jár.' });
    if (typeof r.min_revenue_huf === 'number') {
      var rev = p && p.revenue;
      var need = r.min_revenue_huf, fmt = need >= 1e9 ? (need / 1e9) + ' Mrd Ft' : Math.round(need / 1e6) + ' M Ft';
      out.push(!(rev in REV_MAX) ? { key: 'revenue', label: 'Árbevétel', status: 'unknown', reason: 'Legalább ' + fmt + ' éves árbevétel kell.' }
        : REV_MAX[rev] < need ? { key: 'revenue', label: 'Árbevétel', status: 'fail', reason: 'Legalább ' + fmt + ' éves árbevétel kell.' }
        : REV_MIN[rev] >= need ? { key: 'revenue', label: 'Árbevétel', status: 'ok', reason: 'Megvan a legalább ' + fmt + ' árbevétel.' }
        : { key: 'revenue', label: 'Árbevétel', status: 'unknown', reason: 'Legalább ' + fmt + ' árbevétel kell — határeset.' });
    }
    if (r.bank_loan) out.push({ key: 'bank', label: 'Igénylés', status: 'neutral', reason: 'Bankon / hitelközvetítőn keresztül igényelhető, hitelbírálattal.' });
    return out;
  }

  function checkApplicant(g) {
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
    var p = profile && (profile.company || profile.employees || industriesOf(profile).length) ? profile : null;
    var req = checkRequires(g, p);
    var covered = {}; req.forEach(function (c) { if (['farmer', 'fisheries', 'forestry', 'tourism_ntak', 'restaurant'].indexOf(c.key) >= 0) covered.sector = true; });
    var sector = checkSector(g, p);
    // A tag-based target-group check replaces the keyword sector guess when it
    // decides the same question (and is more reliable).
    if (covered.sector && sector && (sector.status === 'fail' || sector.status === 'unknown' || sector.status === 'warn')) sector = null;
    var checks = [checkSize(g, p), checkRegion(g, p), sector, checkTeaor(g, p), checkYears(g, p), checkBasics(g, p)].concat(req, [checkApplicant(g), checkMoney(g, p), checkTiming(g, today)])
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
      var typeB = { 'grant': 6, 'wage-subsidy': 2, 'loan+grant': 4, 'grant+equity': 4, 'in-kind': 2 }[g.type] || 0;
      if (g.type === 'equity') typeB = (closedYears[p.years_operating] <= 2 || industriesOf(p).indexOf('IT') >= 0) ? 3 : -3;
      var d = daysUntil(g.deadline, today);
      score = 60 + bonus + typeB + (g.scope !== 'eu' ? 4 : -4) + (d === null || d >= 21 ? 2 : 0) - warns * 9 - unknown * 3;
      if (fails) score = Math.min(30, 30 - (fails - 1) * 8);
    }
    score = Math.max(5, Math.min(99, Math.round(score)));
    var verdict = !p ? 'REVIEW' : fails ? 'SKIP' : score >= 75 ? 'APPLY' : score >= 55 ? 'REVIEW' : 'SKIP';
    var group = isConsortium(g) ? 'consortium' : g.scope === 'eu' ? 'eu' : 'hazai';
    // A consortium call is a top recommendation only for a medium or large
    // company (they join international consortia routinely), and an R&D call
    // only when the company said it plans R&D.
    var rq = g.requires || {};
    var tier = sizeTier(p && p.employees);
    var consortiumCap = group === 'consortium' && tier !== 'large' && tier !== 'mid';
    if (verdict === 'APPLY' && (consortiumCap || !topical || hardUnknown || noMoney || ((rq.rnd_project || rq.deeptech) && !(p && p.rnd === 'igen')))) {
      verdict = 'REVIEW';
      score = Math.min(score, 74);
    }
    return { score: score, verdict: verdict, eligible: !fails, personal: !!p, checks: checks, group: group };
  }

  // Profile fields the matching uses, and which are still empty.
  var NEEDED = [
    ['employees', 'Létszám'], ['site_region', 'Megvalósítás régiója'], ['teaor', 'TEÁOR főtevékenység'],
    ['years_operating', 'Lezárt üzleti évek'], ['public_debt_free', 'Köztartozásmentesség'],
    ['in_difficulty', 'Nehéz helyzetű-e'], ['own_funds', 'Önerő'], ['rnd', 'Tervez-e K+F / innovációs projektet'],
  ];
  function missingFields(p) {
    return NEEDED.filter(function (f) { return !p || !p[f[0]] || (f[0] === 'employees' && p.employees === '100+'); })
      .map(function (f) { return { key: f[0], label: f[0] === 'employees' && p && p.employees === '100+' ? 'Létszám pontosítása (101–249 fő vagy 250 fő felett)' : f[1] }; });
  }

  var api = { match: match, sizeTier: sizeTier, teaorIndustries: teaorIndustries, missingFields: missingFields, isConsortium: isConsortium, ALL_REGIONS: ALL_REGIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
