/* AIpályázó — grant search (browser + Node).
   - accent-insensitive: "gep" finds "gép", "palyazat" finds "pályázat"
   - word-start matching that tolerates Hungarian endings: "gépek", "gépre" → "gép…";
     short words (< 5 letters) only match a whole word plus a short ending ("autó" ≠ "automation")
   - rare words count more than common ones (IDF): "szálláshely fejlesztés" is driven by "szálláshely";
     very generic words (fejlesztés, rendszer, vállalkozás…) are ignored when other words exist
   - everyday words expand to the official wording ("napelem" → "napenergia", "fotovoltaikus",
     "energiahatékonyság"); an expansion-only match always ranks below a direct match
   - one-letter typos are fixed for words of 5+ letters ("napelm" → "napelem")
   - call codes: "DIMOP Plusz 1.2.3" matches DIMOP_PLUSZ-1.2.3/A-24 and /B-24 only
   - "vissza nem térítendő" is a filter on the support type, not a text search. */
(function (root) {
  'use strict';
  function fold(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9+]+/g, ' ').trim();
  }
  var STOP = { a: 1, az: 1, es: 1, egy: 1, de: 1, hogy: 1, is: 1, meg: 1, mar: 1, nem: 1, van: 1, lesz: 1, kell: 1, for: 1, the: 1, and: 1, of: 1, to: 1, in: 1, szeretnek: 1, szeretnenk: 1, akarok: 1, akarunk: 1, vennek: 1, vennenk: 1, palyazat: 1, palyazatok: 1, palyazatot: 1, palyazni: 1, forras: 1, forrast: 1, keresek: 1, kb: 1, uj: 1, ujabb: 1, plusz: 1, milyen: 1, mire: 1, hol: 1, hogyan: 1, vagy: 1, ra: 1, re: 1, ban: 1, ben: 1, nak: 1, nek: 1, sok: 1 };
  // generic words: dropped when the query has any other word (alone they still search)
  var GENERIC = /^(fejleszt|rendszer|tamogat|program|projekt|ceg$|cegek|cegem|cegnek|cegunk|vallalkoz|kkv|lehetoseg|beszerzes$|celu$|celra$|szamara$)/;
  // programme names: only these (or tokens with digits) get the high weight of the code field
  var PROG = { ginop: 1, dimop: 1, kehop: 1, top: 1, vinop: 1, mahop: 1, kap: 1, efop: 1, ikop: 1, vekop: 1, tff: 1, eu4health: 1, horizon: 1, eic: 1, life: 1, eit: 1, erasmus: 1, interreg: 1, cef: 1, crea: 1, cerv: 1, digital: 0, eurostars: 1, eureka: 1, rrf: 1, kfi: 1, nkfih: 1 };
  // everyday word (folded) → [official wording, weight]; '=' prefix: whole word (+ short ending) only
  var CONCEPTS = [
    [/^(gep|eszkoz|berendez|cnc|eszterg|marogep|szerszam|gyartosor|robot|hegeszt)/, [['gepbeszerz', 1], ['eszkozbeszerz', 1], ['=gep', 0.9], ['gyartosor', 0.9], ['technologiafejleszt', 0.8], ['=technologia', 0.7], ['=lizing', 0.6], ['beruhazasi hitel', 0.5], ['eszkoz', 0.5]]],
    [/^(traktor|kombajn|munkagep|mezogazdasagi gep|erogep)/, [['mezogazdasagi gep', 1], ['agrar', 0.9], ['mezogazdasag', 0.8], ['gepbeszerz', 0.6], ['=gep', 0.5], ['=lizing', 0.4], ['beruhazasi hitel', 0.4]]],
    [/^(jarmu|targonc|kamion|teherauto|kisteher|furgon)/, [['jarmu', 1], ['gepjarmu', 1], ['lizing', 0.6]]],
    [/^(napelem|napkollektor|fotovolt|naperomu|napenerg|pv$)/, [['napelem', 1], ['napenerg', 1], ['fotovolt', 1], ['naperomu', 1], ['photovolt', 0.6], ['=pv', 0.6], ['solar', 0.5], ['energiahatekony', 0.7], ['megujulo energ', 0.6], ['energetika', 0.5]]],
    [/^(energi|aram$|aramar|futes|hoszivatty|szigetel|rezsi|klima|energiahatekony)/, [['energiahatekony', 1], ['energetika', 0.8], ['hoszivatty', 0.8], ['szigetel', 0.8], ['megujulo energ', 0.6], ['energ', 0.4]]],
    [/^(akkumulator|tarolo|energiatarol)/, [['energiatarol', 1], ['akkumulator', 1], ['tarolo', 0.6]]],
    [/^(tolto|elektromos|emobil|e mobil|villanyauto|ev$)/, [['tolto', 1], ['charging', 1], ['e mobil', 1], ['emobil', 1], ['elektromobil', 1], ['elektromos', 0.8], ['electric vehicle', 0.8]]],
    [/^(web|honlap|online|webshop|webaruhaz|digital|szoftver|app$|applikac|alkalmazas|automatiz|crm$|erp$|felho|kiberbiz|informatik|it$|ikt$|mi$|ai$|mesterseges)/, [['digitaliz', 1], ['digitalis', 0.9], ['webaruhaz', 1], ['e kereskedel', 1], ['szoftver', 0.8], ['informatik', 0.8], ['=ikt', 0.8], ['kiberbiz', 0.7]]],
    [/^(telephely|csarnok|ingatlan|epit|uzem$|uzemcsarnok|raktar|bovit|felujit|iroda|muhely)/, [['telephely', 1], ['csarnok', 1], ['ingatlan', 0.8], ['raktar', 0.8], ['felujit', 0.6], ['kapacitasbovit', 0.6]]],
    [/^(kepz|oktat|tanfolyam|trening|betanit|kompetenc|skill)/, [['kepz', 1], ['oktat', 0.8], ['skill', 0.8], ['training', 0.8]]],
    [/^(export|kulfold|kulpiac|kivitel|nemzetkoziesed)/, [['export', 1], ['kulpiac', 1], ['kulfoldi piac', 1], ['nemzetkoziesed', 0.8]]],
    [/^(kutat|innovac|prototip|termekfejleszt|szabadalom|k\+f|kf$|kfi$|labor)/, [['k+f', 1], ['kutatas fejleszt', 1], ['=kfi', 1], ['kutat', 0.7], ['innovac', 0.7], ['prototip', 0.7]]],
    [/^(startup|indulo|kezdo|alapit|fiatal vallalkoz)/, [['startup', 1], ['start up', 1], ['indulo vallalkoz', 1], ['kezdo vallalkoz', 1], ['vallalkozova val', 0.8], ['inkubac', 0.6], ['accelerat', 0.6]]],
    [/^(munkaero|alkalmazott|munkatars|felvetel|ber$|berek|bert|foglalkoztat|munkahely|dolgozo|gyakornok)/, [['foglalkoztat', 1], ['munkahely', 1], ['bertamogat', 1], ['munkaero', 0.8]]],
    [/^(mezogazd|gazda|allat|noveny|bor$|borasz|szolo|elelmiszer|kerteszet|agrar|meheszet)/, [['mezogazd', 1], ['agrar', 1], ['gazdalkod', 0.8], ['elelmiszer', 0.8], ['termelo', 0.5]]],
    [/^(hal$|halak|halat|halas|halasz|halgazd|haltenyeszt|haltermel|halfeldolg|akvakult|horgasz)/, [['halasz', 1], ['halgazd', 1], ['halfeldolg', 1], ['haltermel', 1], ['akvakult', 1], ['=hal', 0.8], ['mahop', 0.8]]],
    [/^(no|noi|nok|nonek|noknek|women|female|holgy|anya|anyak)$/, [['=noi', 1], ['=nok', 1], ['women', 1], ['female', 1], ['woman', 1]]],
    [/^(szalloda|panzio|vendeghaz|szallas|etterem|turiz|turist|kemping|gasztro|vendeglat|apartman)/, [['turiszt', 1], ['turizmus', 0.8], ['szallashely', 1], ['=szallas', 0.8], ['vendeglat', 1], ['=ntak', 0.8], ['=kth', 0.6]]],
    [/^(hitel|kolcson|lizing|finansz)/, [['hitel', 1], ['kolcson', 1], ['lizing', 0.8]]],
    [/^(befektet|toke$|tokebe|kockazati)/, [['tokeprogram', 1], ['tokebefektet', 1], ['kockazati toke', 1]]],
    [/^(garancia|kezesseg)/, [['garanci', 1], ['kezes', 1]]]
  ];
  // everyday words the feed may not contain, used for one-letter typo fixes
  var KNOWN = ['napelem', 'napelemes', 'napkollektor', 'hoszivattyu', 'szigeteles', 'webshop', 'webaruhaz', 'honlap', 'digitalizacio', 'szoftver', 'traktor', 'kombajn', 'gepbeszerzes', 'eszkozbeszerzes', 'toltoallomas', 'elektromos', 'szallashely', 'vendeghaz', 'panzio', 'export', 'startup', 'innovacio', 'kutatas', 'energiahatekonysag', 'foglalkoztatas', 'bertamogatas', 'munkahelyteremtes', 'halaszat', 'akvakultura', 'mezogazdasag', 'telephely', 'csarnok', 'kepzes', 'hitel', 'lizing', 'garancia'];
  var GRANTISH = /^(grant|wage-subsidy|loan\+grant|grant\+equity)$/;

  // ---------- query parsing
  function parse(q) {
    var f = fold(q), type = null, code = null;
    if (/\bvissza nem terit\w*|\bvisszaterites nelkul\w*|\bvissza nem fizetend\w*/.test(f)) { type = 'grant'; f = f.replace(/\bvissza nem terit\w*|\bvisszaterites nelkul\w*|\bvissza nem fizetend\w*/g, ' '); }
    var words = f.split(' ').filter(Boolean);
    // code: programme name followed by digit groups ("ginop plusz 1 2 3", "kap rd06")
    for (var i = 0; i < words.length; i++) {
      if (!PROG[words[i]]) continue;
      var parts = [words[i]], j = i + 1;
      while (j < words.length && (words[j] === 'plusz' || /^[a-z]{0,3}\d+[a-z]?$/.test(words[j]) || (/^[a-z]$/.test(words[j]) && parts.length > 1))) { if (words[j] !== 'plusz') parts.push(words[j]); j++; }
      if (parts.length > 1 && /\d/.test(parts.slice(1).join(''))) { code = parts.join('.'); words.splice(i, j - i); break; }
    }
    var toks = words.filter(function (t) { return t && t.length >= 2 && !STOP[t]; });
    var specific = toks.filter(function (t) { return !GENERIC.test(t); });
    if (specific.length || code || type) toks = specific;
    var seen = {};
    toks = toks.filter(function (t) { if (seen[t]) return false; seen[t] = 1; return true; });
    return { tokens: toks, code: code, type: type };
  }
  function tokens(q) { return parse(q).tokens; }
  function active(q) { var p = parse(q); return !!(p.tokens.length || p.code || p.type); }
  function codeKey(s) { return fold(s).split(' ').filter(function (w) { return w && w !== 'plusz'; }).join('.'); }
  function codeHit(key, code) { return !!key && ('.' + codeKey(code) + '.').indexOf('.' + key + '.') === 0; }

  // ---------- word matching
  // stem: at least 5 letters, otherwise the whole word (+ a short Hungarian ending)
  function stem(t) { return t.length <= 5 ? t : t.slice(0, Math.max(5, t.length - 2)); }
  // a short word may only carry a Hungarian ending: "gép" → "gépek", "gépre"; "nő" ≠ "noise", "pv" ≠ "pvrk"
  var ENDING = /^(|k|t|i|a|e|s|ek|ok|ak|at|et|ot|re|ra|ba|be|ban|ben|bol|rol|tol|nak|nek|nal|nel|val|vel|hoz|hez|ert|ig|ja|je|ai|ei|ul|kat|ket|ket|es|as|os|on|en|ek|knek|kat|eket|okat|akat|ekre|okra)$/;
  var ENDING2 = /^(|k|i|t|ik|ket|knek|nek|re|ra)$/; // two-letter words: "nő" → "nők", not "novel"
  function shortHit(w, t) { return w.indexOf(t) === 0 && (t.length <= 2 ? ENDING2 : ENDING).test(w.slice(t.length)); }
  // quality of the best match of token t in a word list: 1 full, .7 stem, .4 inside a compound, 0 none
  function wordMatch(words, t) {
    var best = 0, st = stem(t), short = t.length < 5;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (short) { if (shortHit(w, t)) return 1; continue; }
      if (w.indexOf(t) === 0) return 1;
      if (w.indexOf(st) === 0) best = Math.max(best, 0.7);
      else if (best < 0.4 && w.length > st.length + 2 && w.indexOf(st) > 0) best = 0.4;
    }
    return best;
  }
  function exMatch(f, e) {
    if (e.charAt(0) === '=') { var x = e.slice(1); for (var i = 0; i < f.words.length; i++) { if (shortHit(f.words[i], x)) return true; } return false; }
    if (e.indexOf(' ') > 0) return f.joined.indexOf(' ' + e) >= 0;
    for (var k = 0; k < f.words.length; k++) if (f.words[k].indexOf(e) === 0) return true;
    return false;
  }
  function expand(t) { var out = []; CONCEPTS.forEach(function (c) { if (c[0].test(t)) out = out.concat(c[1]); }); return out; }
  function isCodeTok(t) { return /\d/.test(t) || PROG[t] === 1; }

  // fields: [[text, weight, kind?], ...]; kind 'code' = code field
  function prepare(fields) {
    return fields.map(function (f) { var words = fold(f[0]).split(' '); return { w: f[1], code: f[2] === 'code', words: words, joined: ' ' + words.join(' ') }; });
  }
  // per-token match: { d: direct strength, e: expansion strength }
  function tokMatch(t, prepared, ex) {
    var d = 0, e = 0;
    prepared.forEach(function (f) {
      var w = f.code ? (isCodeTok(t) ? f.w : 1) : f.w, q = wordMatch(f.words, t);
      if (q) d = Math.max(d, 4 + w * q);
    });
    if (!d && ex.length) prepared.forEach(function (f) {
      var w = f.code ? 1 : f.w;
      ex.forEach(function (x) { if (exMatch(f, x[0])) e = Math.max(e, w * 0.25 * x[1]); });
    });
    return { d: d, e: e };
  }
  // single document, no rarity weighting (kept for matchText and older callers)
  function score(q, prepared) {
    var p = parse(q), toks = p.tokens; if (!toks.length) return { score: 0, all: false, matched: 0, of: 0 };
    var total = 0, matched = 0;
    toks.forEach(function (t) { var m = tokMatch(t, prepared, expand(t)); var s = m.d || m.e; if (s) { matched++; total += s; } });
    return { score: total + (matched === toks.length ? 100 : 0), all: matched === toks.length, matched: matched, of: toks.length };
  }
  function grantFields(g, extra) {
    return [[g.title, 6], [g.code, 8, 'code'], [g.cat, 4], [g.issuer, 2], [g.note, 2], [g.amount, 1], [(g.regions || []).join(' '), 1], [g.type, 1], [extra || '', 1]];
  }
  var cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function prepGrant(g, extraText) {
    var x = extraText ? extraText(g) || '' : '';
    var c = cache && cache.get(g);
    if (c && c.x === x && c.t === g.title && c.n === g.note) return c.p;
    var p = prepare(grantFields(g, x));
    if (cache) cache.set(g, { x: x, t: g.title, n: g.note, p: p });
    return p;
  }

  // one-letter typo (substitution, insertion, deletion, swap)
  function within1(a, b) {
    if (a === b) return true;
    var la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
    var i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
    if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }
  function correct(t, docs) {
    var freq = {};
    KNOWN.forEach(function (w) { if (w[0] === t[0]) freq[w] = 1e6; });
    docs.forEach(function (p) { p.forEach(function (f) { f.words.forEach(function (w) { if (w.length >= 5 && w[0] === t[0]) freq[w] = (freq[w] || 0) + 1; }); }); });
    var words = Object.keys(freq), lens = [t.length + 1, t.length, t.length - 1];
    for (var l = 0; l < lens.length; l++) {
      var best = null, bf = 0;
      words.forEach(function (w) {
        if (w.length < lens[l]) return;
        var pre = w.slice(0, lens[l]);
        if (pre !== t && within1(t, pre) && freq[w] > bf) { best = pre; bf = freq[w]; }
      });
      if (best) return best;
    }
    return null;
  }

  // returns [{ g, s }] best first; keeps calls matching at least half of the words
  function rank(q, grants, extraText) {
    var p = parse(q);
    if (!p.tokens.length && !p.code && !p.type) return grants.map(function (g) { return { g: g, s: 0 }; });
    var pool = grants;
    if (p.type) pool = pool.filter(function (g) { return GRANTISH.test(g.type || '') && !/\bnem vissza nem terit/.test(fold(g.note)); });
    if (p.code) {
      var hits = pool.filter(function (g) { return codeHit(p.code, g.code) || fold(g.title).indexOf(p.code.replace(/\./g, ' ')) >= 0; });
      if (hits.length) {
        if (!p.tokens.length) return hits.map(function (g) { return { g: g, s: 1000 + (codeHit(p.code, g.code) ? 10 : 0) }; }).sort(function (a, b) { return b.s - a.s; });
        pool = hits;
      } else {
        // unknown number: fall back to the programme name
        p.tokens.unshift(p.code.split('.')[0]);
        p.code = null;
      }
    }
    var toks = p.tokens;
    if (!toks.length) return pool.map(function (g) { return { g: g, s: 1 + (g.scope === 'eu' ? 0 : 0.5) + (g.type === 'grant' ? 0.2 : 0) }; }).sort(function (a, b) { return b.s - a.s; });
    var docs = pool.map(function (g) { return prepGrant(g, extraText); });
    var N = pool.length || 1;
    // typo fix: a 5+ letter word that matches nothing at all is replaced by its closest feed word
    toks = toks.map(function (t) {
      if (t.length < 5 || expand(t).length) return t;
      var ex = [];
      for (var i = 0; i < docs.length; i++) if (tokMatch(t, docs[i], ex).d) return t;
      return correct(t, docs) || t;
    });
    var exs = toks.map(expand);
    var M = docs.map(function (d) { return toks.map(function (t, i) { return tokMatch(t, d, exs[i]); }); });
    // rarity: tokens found in few calls weigh more
    var idf = toks.map(function (t, i) {
      var df = 0, de = 0;
      M.forEach(function (row) { if (row[i].d) df++; else if (row[i].e) de++; });
      return 1 + Math.log((N + 1) / (1 + (df || de)));
    });
    var out = [], n = toks.length;
    pool.forEach(function (g, k) {
      var total = 0, matched = 0, direct = 0;
      M[k].forEach(function (m, i) { var s = m.d || m.e; if (s) { matched++; total += s * idf[i]; if (m.d) direct++; } });
      if (!matched || matched * 2 < n) return;
      var s = total + (matched === n ? 2 : 0) + (g.scope === 'eu' ? 0 : 1.5);
      if (p.code) s += 1000;
      out.push({ g: g, s: Math.round(s * 100) / 100, direct: direct === n });
    });
    return out.sort(function (a, b) { return b.s - a.s; });
  }
  // relevant results only (needs finder): direct matches above `ratio` of the best direct hit, plus
  // expansion matches above half of the best expansion hit — no fixed top-N, so a long relevant tail stays
  function relevant(ranked, ratio) {
    var r = ratio || 0.2, topD = 0, topE = 0;
    ranked.forEach(function (x) { if (x.direct === false) topE = Math.max(topE, x.s); else topD = Math.max(topD, x.s); });
    return ranked.filter(function (x) { return x.direct === false ? x.s >= topE * 0.65 : x.s >= topD * r; });
  }
  // simple yes/no for a block of text (public list filter): all words must match
  function matchText(q, text) {
    var p = parse(q);
    if (p.code && ('.' + codeKey(text) + '.').indexOf('.' + p.code + '.') < 0) return false;
    if (p.type) { var ft = fold(text); if (!/vissza nem terit/.test(ft) && /\b(hitel|kolcson|lizing|tokebefektet|tokeprogram|kockazati toke|garancia|kezesseg)/.test(ft)) return false; }
    if (!p.tokens.length) return true;
    return score(q, prepare([[text, 1]])).all;
  }

  var api = { fold: fold, tokens: tokens, parse: parse, active: active, rank: rank, relevant: relevant, score: score, prepare: prepare, matchText: matchText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
