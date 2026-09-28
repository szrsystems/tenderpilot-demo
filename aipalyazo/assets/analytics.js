/* Cookie-free page counting (GoatCounter). No cookies, no personal data, so no
   consent banner is needed. Inactive until GC_CODE is set. */
(function () {
  var GC_CODE = ''; // e.g. 'aipalyazo' → https://aipalyazo.goatcounter.com
  if (!GC_CODE || /localhost|127\.0\.0\.1/.test(location.hostname)) { window.aipTrack = function () {}; return; }
  window.goatcounter = { endpoint: 'https://' + GC_CODE + '.goatcounter.com/count', no_onload: false };
  var s = document.createElement('script');
  s.async = true; s.src = 'https://gc.zgo.at/count.v4.js'; s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
  // Funnel events: aipTrack('lead-sent')
  window.aipTrack = function (name) {
    try { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: 'event/' + name, title: name, event: true }); } catch (e) {}
  };
})();
