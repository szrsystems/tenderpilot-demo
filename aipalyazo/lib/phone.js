/* AIpályázó — phone number check and normalisation (browser + Node + Deno).
   Accepts real Hungarian numbers in any common spelling (+36 30 123 4567,
   06-30/123-4567, 06 1 234 5678, +36 22 123 456) and foreign numbers in
   international form (+49 …, 8–15 digits). Returns the number in one tidy
   format, or null when it is not a valid number. */
(function (root) {
  'use strict';
  var MOBILE = { '20': 1, '21': 1, '30': 1, '31': 1, '50': 1, '70': 1 }; // 7-digit subscriber numbers (21 = location-independent)
  function group(d, sizes) { var out = [], i = 0; sizes.forEach(function (n) { out.push(d.slice(i, i + n)); i += n; }); return out.join(' '); }
  function normalizePhone(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s || s.length > 30 || /[^0-9+\s()./-]/.test(s)) return null;
    var plus = s.charAt(0) === '+';
    var d = s.replace(/\D/g, '');
    if (!plus && /^00/.test(d)) { plus = true; d = d.slice(2); }
    var nat = null;
    if (plus && /^36/.test(d)) nat = d.slice(2);
    else if (!plus && /^06/.test(d)) nat = d.slice(2);
    else if (!plus && /^36/.test(d) && d.length >= 10) nat = d.slice(2);
    if (nat !== null) {
      if (/^1\d{7}$/.test(nat)) return '+36 1 ' + group(nat.slice(1), [3, 4]);           // Budapest
      var area = nat.slice(0, 2), rest = nat.slice(2);
      if (MOBILE[area] && /^\d{7}$/.test(rest)) return '+36 ' + area + ' ' + group(rest, [3, 4]); // mobile
      if (/^[2-9][0-9]$/.test(area) && !MOBILE[area] && /^\d{6}$/.test(rest)) return '+36 ' + area + ' ' + group(rest, [3, 3]); // landline
      return null;
    }
    if (plus && /^[1-9]\d{7,14}$/.test(d)) return '+' + d;                               // foreign, E.164
    return null;
  }
  var api = { normalizePhone: normalizePhone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPPhone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
