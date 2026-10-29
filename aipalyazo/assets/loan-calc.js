// Széchenyi Mikrohitel MAX+ törlesztő-kalkulátor (utmutato/szechenyi-mikrohitel-max.html).
// Fix 3,0% éves kamat, havi törlesztés; a türelmi idő alatt csak kamatot kell fizetni.
(function () {
  var form = document.getElementById('loan-calc');
  if (!form) return;
  var out = document.getElementById('loan-out');
  var fmt = function (n) { return Math.round(n).toLocaleString('hu-HU') + ' Ft'; };
  function calc() {
    var P = Math.max(0, +form.amount.value || 0) * 1e6;
    var n = Math.min(120, Math.max(13, Math.round(+form.term.value || 0)));
    var g = Math.min(24, Math.max(0, Math.round(+form.grace.value || 0)), n - 1);
    var rate = 0.03 / 12;
    var m = n - g;
    var annuity = P * rate / (1 - Math.pow(1 + rate, -m));
    var interestOnly = P * rate;
    var total = interestOnly * g + annuity * m;
    if (!P) { out.innerHTML = '<p>Adja meg a hitelösszeget.</p>'; return; }
    out.innerHTML =
      (g ? '<p>Türelmi idő alatt (' + g + ' hónap): <b>' + fmt(interestOnly) + '</b> / hó (csak kamat)</p>' : '') +
      '<p>Havi törlesztő' + (g ? ' utána (' + m + ' hónap)' : '') + ': <b class="big">' + fmt(annuity) + '</b></p>' +
      '<p>Összes visszafizetés: <b>' + fmt(total) + '</b> · ebből kamat: <b>' + fmt(total - P) + '</b></p>';
  }
  form.addEventListener('input', calc);
  form.addEventListener('submit', function (e) { e.preventDefault(); calc(); });
  calc();
})();
