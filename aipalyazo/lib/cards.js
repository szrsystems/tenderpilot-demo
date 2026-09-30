/* AIpályázó — shared pieces of a grant card (browser + Node).
   Issuer tag, status badges, and the two bars: free budget and time left.
   Returns HTML strings; every value from the feed is escaped here. */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || ''); }
  function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
  function huDate(d) { return isDate(d) ? d.slice(0, 4) + '. ' + d.slice(5, 7) + '. ' + d.slice(8, 10) + '.' : ''; }
  function ft(n) {
    if (!(n > 0)) return '0 Ft';
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 1).replace('.', ',') + ' Mrd Ft';
    if (n >= 1e6) return Math.round(n / 1e6) + ' M Ft';
    return Math.round(n / 1e3) + ' E Ft';
  }

  // Short issuer tag shown in the coloured square.
  var TAGS = [
    [/palyazat\.gov\.hu/, 'SZT'], [/kap\.gov\.hu/, 'KAP'], [/mfb\.hu/, 'MFB'], [/kavosz/, 'KAV'], [/kth\.hu/, 'KTH'],
    [/nkfih/, 'NKFI'], [/nfsz|munka\.hu/, 'NFSZ'], [/bkik|mkik/, 'KIK'], [/exim/, 'EXIM'], [/hepa/, 'HEPA'], [/hiventures/, 'HIV'],
    [/garantiqa/, 'GAR'], [/avhga/, 'AVHGA'], [/eurekanetwork/, 'EUR'], [/eurohpc/, 'HPC'], [/\beit|eit[a-z-]*\.eu/, 'EIT'],
    [/esa\.int|esa-bic/, 'ESA'], [/raiffeisen/, 'RAI'], [/unicredit/, 'UNI'], [/euipo/, 'IP'], [/ec\.europa\.eu|europa\.eu/, 'EU'], [/nlnet|ngi\./, 'NGI'], [/visegrad/, 'V4']
  ];
  function srcTag(g) {
    var s = String(g.source || g.issuer || '').toLowerCase(), t = '';
    for (var i = 0; i < TAGS.length; i++) if (TAGS[i][0].test(s)) { t = TAGS[i][1]; break; }
    if (!t) t = (s.replace(/^www\./, '').replace(/[^a-z]/g, '').slice(0, 3) || 'P').toUpperCase();
    var kind = g.scope === 'eu' ? 'eu' : /loan|guarantee|equity/.test(g.type || '') ? 'fin' : 'hu';
    return '<span class="src-tag ' + kind + '" aria-hidden="true">' + esc(t) + '</span>';
  }

  var TYPE_HU = { grant: 'Vissza nem térítendő', loan: 'Hitel', 'loan+grant': 'Hitel + támogatás', equity: 'Tőkebefektetés', guarantee: 'Garancia', 'wage-subsidy': 'Bértámogatás', 'in-kind': 'Szolgáltatás', 'grant+equity': 'Támogatás + tőke' };

  // bar widths as classes in 5% steps (no inline styles: keeps a strict CSP possible)
  function w(pct) { return 'p' + Math.max(0, Math.min(100, Math.round(pct / 5) * 5)); }
  function budget(g) {
    var total = typeof g.keret === 'number' && g.keret > 0 ? g.keret : null;
    var left = typeof g.remaining === 'number' ? Math.max(0, g.remaining) : null;
    if (!total || left === null) return null;
    return { total: total, left: Math.min(left, total), pct: Math.round(Math.min(left, total) / total * 100) };
  }

  // opts: { today: 'YYYY-MM-DD', isNew: bool, consortium: bool }
  function badges(g, opts) {
    opts = opts || {};
    var out = [], d = isDate(g.deadline) ? daysBetween(opts.today, g.deadline) : null, b = budget(g);
    if (opts.isNew) out.push('<span class="badge new">Új</span>');
    if (d !== null && d <= 14) out.push('<span class="badge red">' + (d <= 0 ? 'Ma jár le' : d === 1 ? 'Holnap jár le' : 'Sürgős · ' + d + ' nap') + '</span>');
    else if (d !== null && d <= 30) out.push('<span class="badge amber">Hamarosan lejár · ' + d + ' nap</span>');
    if (b && b.left === 0) out.push('<span class="badge red">Keret lekötve</span>');
    else if (b && b.pct <= 25) out.push('<span class="badge amber">Keret fogyóban</span>');
    if (TYPE_HU[g.type]) out.push('<span class="badge ' + (/grant|wage/.test(g.type) && !/equity/.test(g.type) ? 'green' : 'gray') + '">' + esc(TYPE_HU[g.type]) + '</span>');
    if (g.cat) out.push('<span class="badge gray">' + esc(g.cat) + '</span>');
    if (opts.consortium) out.push('<span class="badge blue">EU · konzorcium</span>');
    else if (g.scope === 'eu') out.push('<span class="badge blue">EU</span>');
    return out.join('');
  }

  function bars(g, opts) {
    opts = opts || {};
    var h = '', b = budget(g);
    if (b) {
      var cls = b.left === 0 ? 'red' : b.pct <= 25 ? 'amber' : 'green';
      h += '<div class="gbar"><div class="gbar-top"><span>Szabad keret</span><b class="' + cls + '">' + esc(ft(b.left)) + (b.left === 0 ? '<span class="of"> · keret lekötve</span>' : '<span class="of"> / ' + esc(ft(b.total)) + '</span>') + '</b></div>' +
        '<div class="track" role="img" aria-label="Szabad keret: ' + b.pct + '%"><i class="' + cls + ' ' + w(b.left > 0 ? Math.max(b.pct, 5) : 100) + '"></i></div></div>';
    }
    if (isDate(g.deadline)) {
      var d = daysBetween(opts.today, g.deadline);
      var span = isDate(g.windowOpen) ? Math.max(1, daysBetween(g.windowOpen, g.deadline)) : Math.max(d, 180);
      var pct = Math.max(3, Math.min(100, Math.round(d / span * 100)));
      var c2 = d <= 14 ? 'red' : d <= 30 ? 'amber' : 'green';
      h += '<div class="gbar"><div class="gbar-top"><span>Beadási határidő</span><b class="' + c2 + '">' + esc(huDate(g.deadline)) + '<span class="of"> · ' + (d <= 0 ? 'ma' : d === 1 ? 'holnap' : 'még ' + d + ' nap') + '</span></b></div>' +
        '<div class="track" role="img" aria-label="Hátralévő idő: ' + d + ' nap"><i class="' + c2 + ' ' + w(Math.max(pct, 5)) + '"></i></div></div>';
    } else {
      h += '<div class="gbar"><div class="gbar-top"><span>Beadási határidő</span><b class="green">Nincs fix határidő<span class="of"> · folyamatos, a keret kimerüléséig</span></b></div><div class="track"><i class="soft p100"></i></div></div>';
    }
    return '<div class="gbars' + (b ? '' : ' one') + '">' + h + '</div>';
  }

  var api = { esc: esc, srcTag: srcTag, badges: badges, bars: bars, budget: budget, ft: ft, TYPE_HU: TYPE_HU };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPCards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
