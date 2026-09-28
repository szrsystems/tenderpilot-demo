/* AIpályázó — tiny shared behaviour for the public pages (no dependencies). */
(function () {
  'use strict';
  // Mobile menu
  var btn = document.querySelector('[data-menu-toggle]');
  var nav = document.getElementById('mobile-nav');
  if (btn && nav) {
    btn.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  // Signed-in users: header shows "Portál" instead of sign-up (session kept by supabase-js in localStorage)
  try {
    var signedIn = Object.keys(localStorage).some(function (k) { return /^sb-.*-auth-token$/.test(k); });
    if (signedIn) {
      document.querySelectorAll('[data-guest]').forEach(function (el) { el.hidden = true; });
      document.querySelectorAll('[data-member]').forEach(function (el) { el.hidden = false; });
    }
  } catch (e) { /* storage blocked: stay in guest mode */ }
})();
