/* AIpályázó — campaign attribution (first touch, 90 days).
   A partner link like ?utm_source=dft&utm_campaign=okt-2026 is remembered in
   this browser, then sent with the sign-up profile and every consultation
   request, so each lead can be traced to the campaign it came from.
   Only short [a-z0-9._-] tags are kept; nothing personal is stored here. */
(function (root) {
  'use strict';
  var KEY = 'aip:src', TTL = 90 * 864e5, RE = /^[a-z0-9._-]{1,60}$/;
  function clean(v) { v = String(v || '').trim().toLowerCase(); return RE.test(v) ? v : null; }
  function get() {
    try {
      var x = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!x || !x.source || Date.now() - Date.parse(x.at) > TTL) return null;
      return x;
    } catch (e) { return null; }
  }
  function capture() {
    try {
      var q = new URLSearchParams(location.search);
      var source = clean(q.get('utm_source') || q.get('ref'));
      if (!source || get()) return; // first touch wins
      localStorage.setItem(KEY, JSON.stringify({ source: source, campaign: clean(q.get('utm_campaign')), medium: clean(q.get('utm_medium')), at: new Date().toISOString() }));
    } catch (e) { /* storage blocked: no attribution */ }
  }
  capture();
  root.AIPAttr = { get: get, capture: capture };
})(typeof window !== 'undefined' ? window : this);
