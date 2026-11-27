/* =========================================================================
 * Pályázati Értesítő — detailed eligibility sheet ("Részletes adatlap")
 * The fields follow DFT-Hungária's eligibility data model v2 (Kocsis Péter,
 * 2026-11), sections 1–10 plus de minimis, transparency and the planned
 * project. Field ids are the model's own ids, so DFT can read the answers
 * one to one. Everything is optional; the answers are stored in
 * profiles.elig (JSON) and read by lib/match.js (derive()).
 *
 * Not asked on purpose (computed instead): org type flags from the legal
 * form, district / county / region / Budapest / Pest / favoured district from
 * the postcode, SME size class and group-level figures from the link table,
 * sector flags (agriculture, fisheries, tourism, finance…) from the TEÁOR
 * codes, EBITDA, agricultural revenue share.
 * Not asked at all: application-stage documents (land registry, permits,
 * EPTK history, ownership chain tree) — the grant writer collects those.
 * ========================================================================= */
(function (root) {
  'use strict';
  var YN = [['igen', 'Igen'], ['nem', 'Nem']];
  var NY = [['nem', 'Nem'], ['igen', 'Igen']];

  var SECTIONS = [
    { id: 'alap', title: 'Alapadatok', lede: 'A cég kora és státusza: sok felhívás lezárt üzleti éveket és aktív működést kér.', fields: [
      { id: 'company_reg_no', label: 'Cégjegyzékszám / nyilvántartási szám', type: 'text', ph: 'pl. 01-09-123456', hint: 'Egyéni vállalkozónál az EV-nyilvántartási szám.' },
      { id: 'founded_date', label: 'Alapítás (bejegyzés) dátuma', type: 'date', hint: 'Ebből számoljuk a lezárt, teljes üzleti éveket.', uses: true },
      { id: 'company_status', label: 'Működés státusza', type: 'sel', opts: [['aktiv', 'Aktív'], ['szunetel', 'Tevékenység szünetel'], ['torles_alatt', 'Törlés alatt'], ['megszunt', 'Megszűnt']], uses: true },
      { id: 'has_hungarian_presence', label: 'Székhely', type: 'sel', opts: [['hu_seat', 'Magyarországi székhely'], ['eea_branch', 'EGT-s székhely, magyarországi fiókteleppel'], ['other', 'Egyéb külföldi']], uses: true },
      { id: 'vat_status', label: 'ÁFA-státusz', type: 'sel', opts: [['afa_alany', 'ÁFA-alany'], ['alanyi_mentes', 'Alanyi adómentes'], ['egyeb', 'Egyéb']], hint: 'Ettől függ, hogy az ÁFA elszámolható költség-e.' },
    ] },
    { id: 'szervezet', title: 'Szervezet és tulajdon', lede: 'A szervezettípus és a köztulajdon aránya dönti el, hogy KKV-nak számít-e a cég.', fields: [
      { id: 'org_type', label: 'Szervezettípus', type: 'sel', opts: [['gazdasagi_tarsasag', 'Gazdasági társaság (Kft., Bt., Zrt. stb.)'], ['egyeni_vallalkozo', 'Egyéni vállalkozó'], ['szovetkezet', 'Szövetkezet'], ['nonprofit', 'Nonprofit szervezet'], ['koltsegvetesi', 'Költségvetési szerv'], ['kulfoldi_fioktelep', 'Külföldi vállalkozás magyarországi fióktelepe'], ['egyeb', 'Egyéb']], uses: true },
      { id: 'gfo_code', label: 'GFO-kód', type: 'text', ph: 'pl. 113', hint: 'A statisztikai számjel 13–15. számjegye. Egyes felhívások konkrét GFO-listát adnak meg.' },
      { id: 'state_ownership_pct', label: 'Állami tulajdon', type: 'num', unit: '%', uses: true },
      { id: 'municipal_ownership_pct', label: 'Önkormányzati tulajdon', type: 'num', unit: '%', uses: true, hint: 'Együtt 25% felett a cég nem minősül KKV-nak.' },
    ] },
    { id: 'csoport', title: 'Kapcsolt és partnervállalkozások', lede: 'A KKV-méretet csoportszinten kell számolni: 25–50% részesedésnél arányosan, 50% felett teljes egészében.', fields: [
      { id: 'links', label: 'Más vállalkozással fennálló tulajdoni kapcsolatok', type: 'links', uses: true },
    ] },
    { id: 'penzugy', title: 'Beszámoló adatai', lede: 'Az utolsó két lezárt üzleti év a beszámolóból (e-beszamolo.im.gov.hu), ezer forintban.', fields: [
      { id: 'fin', label: 'Pénzügyi adatok', type: 'fin', uses: true },
      { id: 'current_headcount', label: 'Jelenlegi létszám', type: 'num', unit: 'fő', hint: 'Ha még nincs lezárt éve, ezt használjuk.' },
    ] },
    { id: 'tevekenyseg', title: 'Tevékenységek (TEÁOR’25)', lede: 'Sok hazai felhívás csak felsorolt TEÁOR-kódokra szól. 2025-től a TEÁOR’25 kódok az irányadók.', fields: [
      { id: 'all_teaor', label: 'Összes bejegyzett tevékenység', type: 'codes', ph: 'pl. 6201, 6202, 7022', hint: 'A főtevékenységet a cégprofilban adja meg. Vesszővel elválasztva.', uses: true },
      { id: 'teaor_reg_date', label: 'A főtevékenység bejegyzésének dátuma', type: 'date' },
      { id: 'project_teaor', label: 'A fejlesztéssel érintett tevékenység', type: 'codes', ph: 'pl. 2562', hint: 'Ha a projekt nem a főtevékenységet fejleszti.', uses: true },
    ] },
    { id: 'helyszin', title: 'Megvalósítás helye', lede: 'A projekt helye dönti el a régiót, a kedvezményezett járást és a támogatási intenzitást, nem a székhely.', fields: [
      { id: 'project_postcode', label: 'A megvalósítás helyének irányítószáma', type: 'text', ph: 'pl. 3600', uses: true },
      { id: 'project_city', label: 'Település', type: 'text', uses: true },
      { id: 'project_site_type', label: 'A helyszín', type: 'sel', opts: [['szekhely', 'A székhely'], ['telephely', 'Bejegyzett telephely'], ['fioktelep', 'Bejegyzett fióktelep'], ['meg_nincs', 'Még nincs bejegyezve']] },
      { id: 'project_site_reg_date', label: 'A telephely bejegyzésének dátuma', type: 'date', hint: 'Egyes felhívásoknál legalább 60 nappal a beadás előtt be kell jegyezni.', uses: true },
      { id: 'registered_address_date', label: 'A székhely bejegyzésének dátuma', type: 'date' },
      { id: 'settlement_pop', label: 'A település lakosságszáma', type: 'sel', opts: [['<1000', '1000 fő alatt'], ['1000-5000', '1000–5000 fő'], ['5000-10000', '5000–10 000 fő'], ['10000-50000', '10 000–50 000 fő'], ['50000+', '50 000 fő felett']], hint: 'Pl. a Magyar Falu Program kistelepüléseknek szól.', uses: true },
      { id: 'is_szvz', label: 'Szabad vállalkozási zónában van?', type: 'sel', opts: [['igen', 'Igen'], ['nem', 'Nem'], ['nem_tudom', 'Nem tudom']], uses: true },
    ] },
    { id: 'jogi', title: 'Jogi helyzet', lede: 'Ezek bármelyike szinte minden felhívásból kizár.', fields: [
      { id: 'proceedings', label: 'Folyamatban van vagy érinti a céget', type: 'checks', none: 'proceedings_none', noneLabel: 'Egyik sem', opts: [['in_voluntary_dissolution', 'Végelszámolás'], ['in_liquidation', 'Felszámolás'], ['in_bankruptcy', 'Csődeljárás'], ['in_forced_strike_off', 'Kényszertörlés'], ['being_struck_off', 'Törlési eljárás'], ['enforcement_ongoing', 'Végrehajtás'], ['in_restructuring', 'Szerkezetátalakítás (reorganizáció)'], ['court_disqualification', 'Bírósági eltiltás a támogatásoktól'], ['director_disqualification', 'A vezető tisztségviselő eltiltása']], uses: true },
      { id: 'koma_member', label: 'Szerepel a köztartozásmentes adózói adatbázisban (KOMA)?', type: 'sel', opts: YN },
      { id: 'under_enforcement', label: 'Folyik NAV-végrehajtás a cég ellen?', type: 'sel', opts: NY, uses: true },
    ] },
    { id: 'megfeleles', title: 'Munkaügy és átláthatóság', lede: 'Hazai forrásból csak rendezett munkaügyi kapcsolatokkal rendelkező, átlátható szervezet kaphat támogatást.', fields: [
      { id: 'orderly_labor_relations', label: 'Rendezettek a munkaügyi kapcsolatok?', type: 'sel', opts: YN, hint: 'Pl. nincs jogerős bírság be nem jelentett foglalkoztatásért az elmúlt 2 évben.', uses: true },
      { id: 'undeclared_worker_decision', label: 'Volt be nem jelentett foglalkoztatás miatti határozat (2 éven belül)?', type: 'sel', opts: NY, uses: true },
      { id: 'equal_treatment_exclusion', label: 'Ki van zárva egyenlő bánásmód megsértése miatt?', type: 'sel', opts: NY, uses: true },
      { id: 'transparency_ok', label: 'Átlátható szervezetnek minősül?', type: 'sel', opts: YN, hint: 'Ismert tulajdonosi szerkezet, a tényleges tulajdonos megnevezhető.', uses: true },
      { id: 'is_offshore_owner', label: 'Van tulajdonosa nem együttműködő (offshore) államban?', type: 'sel', opts: NY, uses: true },
    ] },
    { id: 'tamogatasok', title: 'Korábbi támogatások', lede: 'A de minimis keret 3 év alatt legfeljebb 300 ezer euró, a kapcsolt vállalkozásokkal együtt.', fields: [
      { id: 'de_minimis_used_3y', label: 'Az elmúlt 3 évben kapott de minimis támogatás', type: 'num', unit: '€', hint: 'A támogatói okiratokon szerepel (támogatástartalom).', uses: true },
      { id: 'in_maintenance_period', label: 'Van fenntartási időszakban lévő korábbi projekt?', type: 'sel', opts: NY },
      { id: 'repayment_obligation', label: 'Van lejárt visszafizetési kötelezettség korábbi támogatásból?', type: 'sel', opts: NY, uses: true },
      { id: 'has_active_application', label: 'Van folyamatban lévő pályázata?', type: 'sel', opts: NY },
    ] },
    { id: 'projekt', title: 'Tervezett fejlesztés', lede: 'Ha már tudja, mit szeretne: a projekt adataiból látszik, mekkora támogatás reális.', fields: [
      { id: 'investment_purpose', label: 'A fejlesztés célja', type: 'sel', opts: [['eszkoz', 'Eszköz- vagy gépbeszerzés'], ['ingatlan', 'Ingatlan építése / felújítása'], ['digitalis', 'Digitalizáció, szoftver'], ['energia', 'Energetika, napelem'], ['kf', 'Kutatás-fejlesztés, innováció'], ['kepzes', 'Képzés'], ['piac', 'Piacra jutás, export'], ['munkahely', 'Munkahelyteremtés'], ['egyeb', 'Egyéb']] },
      { id: 'project_total_cost', label: 'A projekt teljes költsége', type: 'num', unit: 'M Ft', uses: true },
      { id: 'requested_aid_amount', label: 'Igényelt támogatás', type: 'num', unit: 'M Ft', uses: true },
      { id: 'own_contribution', label: 'Rendelkezésre álló önerő', type: 'num', unit: 'M Ft' },
      { id: 'project_planned_start', label: 'Tervezett kezdés', type: 'date' },
      { id: 'investment_started', label: 'Történt már megrendelés, szerződéskötés vagy előlegfizetés?', type: 'sel', opts: NY, hint: 'A legtöbb támogatásnál a projekt nem kezdődhet meg a beadás előtt.', uses: true },
      { id: 'asset_new_or_used', label: 'Új vagy használt eszköz?', type: 'sel', opts: [['uj', 'Új'], ['hasznalt', 'Használt'], ['vegyes', 'Vegyes'], ['nincs', 'Nincs eszközbeszerzés']], uses: true },
      { id: 'has_real_estate_dev', label: 'Van ingatlanfejlesztés?', type: 'sel', opts: NY },
      { id: 'project_new_jobs', label: 'Vállalt új munkahelyek', type: 'num', unit: 'fő' },
    ] },
  ];

  // Two closed years; amounts in thousand Ft, as in the annual report.
  var FIN_ROWS = [
    ['year', 'Üzleti év', 'év'],
    ['net_revenue', 'Nettó árbevétel', 'eFt'],
    ['total_assets', 'Mérlegfőösszeg', 'eFt'],
    ['equity', 'Saját tőke', 'eFt'],
    ['share_capital', 'Jegyzett tőke', 'eFt'],
    ['profit_after_tax', 'Adózott eredmény', 'eFt'],
    ['ebit', 'Üzemi (üzleti) eredmény', 'eFt'],
    ['depreciation', 'Értékcsökkenés', 'eFt'],
    ['export_revenue', 'Exportárbevétel', 'eFt'],
    ['personnel_costs', 'Személyi jellegű ráfordítások', 'eFt'],
    ['agri_revenue', 'Ebből mezőgazdasági árbevétel', 'eFt'],
    ['avg_stat_headcount', 'Átlagos statisztikai létszám', 'fő'],
  ];
  var LINK_COLS = [
    ['name', 'Vállalkozás neve', 'text'],
    ['rel', 'Kapcsolat', 'sel', [['tulajdonos', 'Tulajdonosunk'], ['leany', 'Mi vagyunk a tulajdonosa'], ['kozos', 'Közös tulajdonos (magánszemély) cége']]],
    ['pct', 'Részesedés, %', 'num'],
    ['headcount', 'Létszám, fő', 'num'],
    ['revenue', 'Árbevétel, M Ft', 'num'],
    ['assets', 'Mérlegfőösszeg, M Ft', 'num'],
  ];
  var MAX_LINKS = 12;

  function rowFilled(x) { return !!x && typeof x === 'object' && Object.keys(x).some(function (k) { return k !== 'rel' && k !== 'kind' && x[k] !== '' && x[k] != null; }); }
  function filled(v) {
    if (v == null || v === '') return false;
    if (typeof v === 'object' && !Array.isArray(v)) return rowFilled(v);
    if (Array.isArray(v)) return v.some(function (x) { return typeof x === 'object' ? rowFilled(x) : x !== '' && x != null; });
    return true;
  }
  // How much of each section is answered (a section with a "none" answer,
  // e.g. "no proceedings" / "no links", counts as answered).
  function completeness(e) {
    e = e || {};
    var total = 0, done = 0, per = {};
    SECTIONS.forEach(function (s) {
      var t = 0, d = 0;
      s.fields.forEach(function (f) {
        t++;
        var ok = filled(e[f.id]) || (f.none && e[f.none] === true) || (f.type === 'links' && e.links_none === true);
        if (ok) d++;
      });
      per[s.id] = { done: d, total: t }; total += t; done += d;
    });
    return { done: done, total: total, pct: total ? Math.round(done * 100 / total) : 0, per: per };
  }

  // Drop empty values and clamp sizes before saving (the database allows 24 kB).
  function clean(e) {
    var out = {};
    Object.keys(e || {}).forEach(function (k) {
      var v = e[k];
      if (k === 'links') { v = (Array.isArray(v) ? v : []).filter(filled).slice(0, MAX_LINKS).map(function (r) { var o = {}; LINK_COLS.forEach(function (c) { if (r[c[0]] !== '' && r[c[0]] != null) o[c[0]] = String(r[c[0]]).slice(0, 120); }); o.kind = 'ceg'; return o; }); if (!v.length) return; }
      else if (k === 'fin') { v = (Array.isArray(v) ? v : []).slice(0, 2).map(function (r) { var o = {}; FIN_ROWS.forEach(function (c) { var x = r && r[c[0]]; if (x !== '' && x != null) o[c[0]] = String(x).replace(/[−–]/g, '-').replace(/[^\d,.\-]/g, '').slice(0, 16); }); return o; }); if (!v.some(filled)) return; }
      else if (Array.isArray(v)) { v = v.map(function (x) { return String(x).slice(0, 60); }).slice(0, 20); if (!v.length) return; }
      else if (typeof v === 'boolean') { if (!v) return; }
      else { v = String(v == null ? '' : v).trim().slice(0, 300); if (!v) return; }
      out[k] = v;
    });
    return out;
  }

  var api = { SECTIONS: SECTIONS, FIN_ROWS: FIN_ROWS, LINK_COLS: LINK_COLS, MAX_LINKS: MAX_LINKS, completeness: completeness, clean: clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPElig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
