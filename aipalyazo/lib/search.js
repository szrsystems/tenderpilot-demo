/* AIpályázó — grant search (browser + Node).
   - accent-insensitive: "gep" finds "gép", "palyazat" finds "pályázat"
   - word-start matching that tolerates Hungarian endings: "gépek", "gépre" → "gép…"
   - everyday words expand to the official wording: "napelem" also finds
     "megújuló energia", "webshop" finds "digitalizáció", "gép" finds "eszközbeszerzés"
   - several words: calls matching all of them rank first, partial matches follow. */
(function (root) {
  'use strict';
  function fold(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9+]+/g, ' ').trim();
  }
  var STOP = { a: 1, az: 1, es: 1, egy: 1, de: 1, hogy: 1, is: 1, meg: 1, mar: 1, nem: 1, van: 1, lesz: 1, kell: 1, for: 1, the: 1, and: 1, of: 1, szeretnek: 1, szeretnenk: 1, akarok: 1, akarunk: 1, vennek: 1, vennenk: 1, ceg: 1, cegnek: 1, cegunk: 1, palyazat: 1, palyazatok: 1, tamogatas: 1, tamogatast: 1, forras: 1, forrast: 1, keresek: 1, kb: 1, uj: 1, ujabb: 1 };
  // everyday word (folded stem) → words used in official calls (folded stems)
  var CONCEPTS = [
    [/^(gep|eszkoz|berendez|cnc|eszterg|szerszam|jarmu|targonc|kamion|traktor|gyartosor|robot)/, ['eszkoz', 'gep', 'gepbeszerz', 'technolog', 'beruhaz', 'lizing', 'gyartosor']],
    [/^(napelem|napkollektor|energi|aram|futes|hoszivatty|szigetel|rezsi|akkumulator|tarolo|megujulo|klima)/, ['energ', 'napelem', 'megujul', 'hoszivatty', 'szigetel', 'geoterm']],
    [/^(web|honlap|online|webshop|webaruhaz|digital|szoftver|app|alkalmaz|automatiz|crm|erp|felho|kiberbiz)/, ['digital', 'szoftver', 'informatik', 'webaruhaz', 'kiberbiz']],
    [/^(telephely|csarnok|ingatlan|epit|uzem|raktar|bovit|felujit|iroda|muhely)/, ['telephely', 'ingatlan', 'csarnok', 'raktar', 'felujit', 'kapacitasbovit']],
    [/^(kepz|oktat|tanfolyam|trening|betanit|kompetenc|skill)/, ['kepz', 'oktat', 'skill', 'training']],
    [/^(export|kulfold|kulpiac|kivitel|piacra)/, ['export', 'kulpiac', 'piacra']],
    [/^(kutat|innovac|prototip|termekfejleszt|szabadalom|k+f|kf|labor)/, ['kutat', 'innovac', 'k+f', 'prototip']],
    [/^(startup|indulo|kezdo|alapit)/, ['startup', 'indulo', 'kezdo vallalkoz', 'vallalkozova val', 'accelerat']],
    [/^(munkaero|alkalmazott|munkatars|felvetel|ber|foglalkoztat|munkahely|dolgozo|gyakornok)/, ['foglalkoztat', 'munkahely', 'bertamogat', 'munkaero']],
    [/^(mezogazd|gazda|allat|noveny|bor|elelmiszer|kerteszet|agrar|meheszet)/, ['mezogazd', 'agrar', 'gazdalkod', 'elelmiszer', 'termelo']],
    [/^(szalloda|panzio|vendeghaz|szallas|etterem|turiz|kemping|gasztro|vendeglat)/, ['turiz', 'szallashely', 'vendeglat', 'etterm', 'kth']],
    [/^(hitel|kolcson|lizing|finansz)/, ['hitel', 'kolcson', 'lizing']],
    [/^(befektet|toke|kockazati)/, ['tokeprogram', 'tokebefektet', 'kockazati toke']],
    [/^(garancia|kezesseg)/, ['garanci', 'kezes']]
  ];
  function tokens(q) { return fold(q).split(' ').filter(function (t) { return t && t.length >= 2 && !STOP[t]; }); }
  // stem: the first 4–6 characters are enough for Hungarian word starts
  function stem(t) { return t.length <= 4 ? t : t.slice(0, Math.max(4, Math.min(6, t.length - 2))); }
  function expand(t) { var out = []; CONCEPTS.forEach(function (c) { if (c[0].test(t)) out = out.concat(c[1]); }); return out; }
  function hasWordStart(words, s) { for (var i = 0; i < words.length; i++) if (words[i].indexOf(s) === 0) return true; return false; }

  // fields: [[text, weight], ...]
  function prepare(fields) { return fields.map(function (f) { return { w: f[1], words: fold(f[0]).split(' ') }; }); }
  function score(q, prepared) {
    var toks = tokens(q); if (!toks.length) return { score: 0, all: false, matched: 0 };
    var total = 0, matched = 0;
    toks.forEach(function (t) {
      var st = stem(t), best = 0;
      prepared.forEach(function (f) {
        if (hasWordStart(f.words, st)) best = Math.max(best, f.w);
        else if (t.length >= 5 && f.words.join(' ').indexOf(st) >= 0) best = Math.max(best, f.w * 0.4); // inside a compound word
      });
      if (!best) { var ex = expand(t); prepared.forEach(function (f) { var joined = ' ' + f.words.join(' '); ex.forEach(function (e) { if (e.indexOf(' ') > 0 ? joined.indexOf(' ' + e) >= 0 : hasWordStart(f.words, e)) best = Math.max(best, f.w * 0.3); }); }); }
      if (best) { matched++; total += best; }
    });
    return { score: total + (matched === toks.length ? 100 : 0), all: matched === toks.length, matched: matched, of: toks.length };
  }
  function grantFields(g, extra) {
    return [[g.title, 6], [g.code, 8], [g.cat, 4], [g.issuer, 2], [g.note, 2], [g.amount, 1], [(g.regions || []).join(' '), 1], [g.type, 1], [extra || '', 1]];
  }
  // returns [{ g, s }] best first; keeps calls matching at least half of the words
  function rank(q, grants, extraText) {
    var n = tokens(q).length; if (!n) return grants.map(function (g) { return { g: g, s: 0 }; });
    var out = [];
    grants.forEach(function (g) {
      var r = score(q, prepare(grantFields(g, extraText ? extraText(g) : '')));
      if (r.matched && (r.all || r.matched * 2 >= n)) out.push({ g: g, s: r.score + (g.scope === 'eu' ? 0 : 1.5) });
    });
    return out.sort(function (a, b) { return b.s - a.s; });
  }
  // simple yes/no for a block of text (public list filter): all words must match
  function matchText(q, text) { var r = score(q, prepare([[text, 1]])); return !tokens(q).length || r.all; }

  var api = { fold: fold, tokens: tokens, rank: rank, score: score, prepare: prepare, matchText: matchText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
