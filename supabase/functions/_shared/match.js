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
  // title, category and eligibility note).
  var INDUSTRY_RE = {
    IT: /digit|informatik|szoftver|adat|kiberbiztons|mesterséges intelligencia|\bAI\b|\bIKT\b|startup|software|cyber|data/i,
    HVAC: /energi|épületgépész|fűtés|hűtés|hőszivatty|napelem|geoterm|megújuló|energy|heat/i,
    Construction: /épít|felújít|infrastruktúr|construction|building|renovation/i,
    Manufacturing: /gyárt|\bipar|ipari|gépbeszerz|eszközbeszerz|termelés|manufactur|industr|robot|materials?/i,
    Healthcare: /egészség|orvos|gyógy|health|medical|diagnos/i,
    Restaurant: /vendéglát|étterem|gasztronóm|turisz|restaurant|food service/i,
    Tourism: /turiz|szálláshely|vendég|touris/i,
    Agriculture: /mezőgazd|agrár|gazd|élelmiszer|erdő|halász|akvakult|kertész|állattart|ültetvény|farm|agri|food|forest|fish/i,
    Retail: /kereskede|bolt|webáruház|e-kereskedelem|retail|commerce/i,
    Education: /oktat|képz|tanul|education|training|skill/i,
    General: /./,
  };
  // Calls that only make sense for one sector: a company outside it is not eligible.
  var SECTOR_ONLY = [
    { re: /halász|akvakult|halfeldolg|halgazd|\bfish|aquacult/i, need: ['Agriculture'], label: 'halászat / akvakultúra' },
    { re: /erdő|erdősít|fásít|\bforest/i, need: ['Agriculture'], label: 'erdőgazdálkodás' },
    { re: /ültetvény|gazdaságátad|termelői csoport|őstermel|agrár.*kártya|agrár.*hitel|mezőgazdasági termel/i, need: ['Agriculture'], label: 'mezőgazdasági termelés' },
    { re: /élelmiszeripar|élelmiszer-feldolg|\bTÉSZ\b|food process/i, need: ['Agriculture', 'Food'], soft: ['Manufacturing', 'Retail'], label: 'élelmiszeripar' },
    { re: /geoterm|földhő/i, need: ['HVAC'], soft: ['Manufacturing', 'Construction'], label: 'geotermikus energia' },
    { re: /turisztikai kártya|szálláshely|vendéglát/i, need: ['Tourism', 'Restaurant'], label: 'turizmus / vendéglátás' },
    { re: /előadó-művész|performing arts|kulturális örökség|cultural heritage/i, need: ['Education', 'General'], label: 'kultúra' },
  ];

  function sizeTier(emp) {
    if (['1', '1-5', '6-10'].indexOf(emp) >= 0) return 'micro';
    if (['11-25', '26-50'].indexOf(emp) >= 0) return 'small';
    if (['51-100', '100+'].indexOf(emp) >= 0) return 'mid';
    return null;
  }
  var TIER_LABEL = { micro: 'mikrovállalkozás', small: 'kisvállalkozás', mid: 'középvállalkozás' };
  var closedYears = { '0': 0, '1': 1, '2': 2, '3-5': 3, '5+': 5 };

  function daysUntil(dateStr, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
    return Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  }

  // TEÁOR (NACE) main activity → 2-digit division → our industry buckets.
  function teaorDivision(t) {
    var m = String(t || '').match(/\b(\d{2})(?:[.\s]?\d{1,2})?\b/);
    return m ? +m[1] : null;
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
    var tier = sizeTier(p && p.employees);
    var cls = (g.sizeClasses || []).map(function (s) { return String(s).toLowerCase(); });
    if (!tier) return { key: 'size', label: 'Cégméret', status: 'unknown', reason: 'Adja meg a létszámot a profilban.' };
    if (!cls.length || cls.some(function (s) { return s === 'vállalkozás' || s === 'egyéb vállalkozás'; })) {
      return { key: 'size', label: 'Cégméret', status: 'ok', reason: 'A felhívás nem korlátozza a cégméretet.' };
    }
    var ok = (tier === 'micro' && cls.some(function (s) { return s.indexOf('mikro') >= 0; }))
      || (tier === 'small' && cls.some(function (s) { return s.indexOf('kisvállalkoz') >= 0; }))
      || (tier === 'mid' && cls.some(function (s) { return s.indexOf('középvállalkoz') >= 0 || s.indexOf('nagyvállalkoz') >= 0; }));
    return ok
      ? { key: 'size', label: 'Cégméret', status: 'ok', reason: 'Pályázhat ' + TIER_LABEL[tier] + 'ként.' }
      : { key: 'size', label: 'Cégméret', status: 'fail', reason: TIER_LABEL[tier] + ' nem szerepel a jogosultak között.' };
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
    var text = [g.title, g.cat, g.note].join(' ');
    var inds = industriesOf(p);
    for (var i = 0; i < SECTOR_ONLY.length; i++) {
      var s = SECTOR_ONLY[i];
      if (s.re.test(text)) {
        if (!inds.length) return { key: 'sector', label: 'Tevékenység', status: 'unknown', reason: 'Ágazati felhívás (' + s.label + ').' };
        var hit = inds.some(function (x) { return s.need.indexOf(x) >= 0; });
        if (hit) return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'Ágazati felhívás (' + s.label + '), illik a tevékenységéhez.', bonus: 22 };
        if (s.soft && inds.some(function (x) { return s.soft.indexOf(x) >= 0; })) return { key: 'sector', label: 'Tevékenység', status: 'warn', reason: 'Csak ' + s.label + ' területen — ha Ön ilyen tevékenységet folytat, jogosult.' };
        return { key: 'sector', label: 'Tevékenység', status: 'fail', reason: 'Csak ' + s.label + ' területen működőknek.' };
      }
    }
    if (!inds.length) return { key: 'sector', label: 'Tevékenység', status: 'unknown', reason: 'Adja meg a tevékenységi kört a profilban.' };
    var match = inds.some(function (x) { return x !== 'General' && INDUSTRY_RE[x] && INDUSTRY_RE[x].test(text); });
    var interest = p && Array.isArray(p.categories) && p.categories.indexOf(g.cat) >= 0;
    if (match) return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'A felhívás témája illik a tevékenységéhez.', bonus: interest ? 22 : 18 };
    if (interest) return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'Az Ön által megjelölt témakörbe esik.', bonus: 8 };
    // Broad Hungarian business-development money (Széchenyi Kártya, MFB,
    // digitalisation, energy efficiency) suits almost any active company.
    if (g.scope !== 'eu' && (['KKV fejlesztés', 'Digitális átalakulás', 'Energiahatékonyság', 'Munkahelyteremtés'].indexOf(g.cat) >= 0
        || ['loan', 'loan+grant', 'guarantee'].indexOf(g.type) >= 0)) {
      return { key: 'sector', label: 'Tevékenység', status: 'ok', reason: 'Általános vállalkozásfejlesztési forrás — bármely ágazatnak.', bonus: 10 };
    }
    return { key: 'sector', label: 'Tevékenység', status: 'neutral', reason: 'Témája nem kapcsolódik közvetlenül a tevékenységéhez.' };
  }

  function checkYears(g, p) {
    var m = String(g.note || '').match(/(?:min\.?\s*|legalább\s*)?(\d)\s*lezárt/i);
    if (!m) return null;
    var need = +m[1];
    var have = p ? closedYears[p.years_operating] : undefined;
    if (have === undefined) return { key: 'years', label: 'Működési idő', status: 'unknown', reason: 'Legalább ' + need + ' lezárt üzleti év kell.' };
    return have >= need
      ? { key: 'years', label: 'Működési idő', status: 'ok', reason: 'Megvan a szükséges ' + need + ' lezárt év.' }
      : { key: 'years', label: 'Működési idő', status: 'fail', reason: 'Legalább ' + need + ' lezárt üzleti év kell.' };
  }

  function checkBasics(g, p) {
    if (!p) return null;
    var stateAid = g.scope !== 'eu' && ['grant', 'loan', 'loan+grant', 'wage-subsidy'].indexOf(g.type) >= 0;
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

  function checkApplicant(g) {
    if (g.scope === 'eu' && g.singleApplicant === false) return { key: 'applicant', label: 'Pályázói kör', status: 'warn', reason: 'Nemzetközi konzorcium kell (partnerek más országokból).' };
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
    var checks = [checkSize(g, p), checkRegion(g, p), checkSector(g, p), checkTeaor(g, p), checkYears(g, p), checkBasics(g, p), checkApplicant(g), checkMoney(g, p), checkTiming(g, today)]
      .filter(Boolean);
    var fails = checks.filter(function (c) { return c.status === 'fail'; }).length;
    var warns = checks.filter(function (c) { return c.status === 'warn'; }).length;
    var unknown = checks.filter(function (c) { return c.status === 'unknown'; }).length;
    var bonus = checks.reduce(function (s, c) { return s + (c.bonus || 0); }, 0);
    var score;
    if (!p) {
      // No profile: only how actionable the call is (single applicant, time, budget).
      score = 70 - warns * 10;
    } else {
      // Base + how well the topic fits (sector bonus) + what kind of money it is
      // (non-repayable ranks above loans) + domestic first + time to prepare,
      // minus hurdles. APPLY (≥75) in practice needs a topic match.
      var typeB = { 'grant': 6, 'wage-subsidy': 6, 'loan+grant': 4, 'grant+equity': 4, 'in-kind': 2 }[g.type] || 0;
      if (g.type === 'equity') typeB = (closedYears[p.years_operating] <= 2 || industriesOf(p).indexOf('IT') >= 0) ? 3 : -3;
      var d = daysUntil(g.deadline, today);
      score = 60 + bonus + typeB + (g.scope !== 'eu' ? 4 : -4) + (d === null || d >= 21 ? 2 : 0) - warns * 9 - unknown * 3;
      if (fails) score = Math.min(30, 30 - (fails - 1) * 8);
    }
    score = Math.max(5, Math.min(99, Math.round(score)));
    var verdict = !p ? 'REVIEW' : fails ? 'SKIP' : score >= 75 ? 'APPLY' : score >= 55 ? 'REVIEW' : 'SKIP';
    return { score: score, verdict: verdict, eligible: !fails, personal: !!p, checks: checks };
  }

  // Profile fields the matching uses, and which are still empty.
  var NEEDED = [
    ['employees', 'Létszám'], ['site_region', 'Megvalósítás régiója'], ['teaor', 'TEÁOR főtevékenység'],
    ['years_operating', 'Lezárt üzleti évek'], ['public_debt_free', 'Köztartozásmentesség'],
    ['in_difficulty', 'Nehéz helyzetű-e'], ['own_funds', 'Önerő'],
  ];
  function missingFields(p) {
    return NEEDED.filter(function (f) { return !p || !p[f[0]]; }).map(function (f) { return { key: f[0], label: f[1] }; });
  }

  var api = { match: match, sizeTier: sizeTier, teaorIndustries: teaorIndustries, missingFields: missingFields, ALL_REGIONS: ALL_REGIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
