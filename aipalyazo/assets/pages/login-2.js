/* login.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
(function () {
  var form = document.getElementById('login-form'), btn = document.getElementById('login-btn');
  var q = new URLSearchParams(location.search);
  if (q.get('password_reset') === '1') show('error-msg', 'Új jelszó beállítva. Most már beléphet vele.', 'ok');
  window.addEventListener('gp-ready', async function () {
    if (justSignedOut()) { sessionStorage.removeItem('gp_just_signed_out'); return; }
    var res = await window.gp.client.auth.getUser();
    if (res.data && res.data.user) location.replace('portal.html');
  });
  document.getElementById('google-btn').addEventListener('click', async function () {
    try {
      var r = await withClient(function (c) { return c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname.replace(/login\.html$/, 'portal.html'), queryParams: { prompt: 'select_account' } } }); });
      if (r.error) throw r.error;
    } catch (e) { show('error-msg', 'A Google-belépés nem sikerült. Kérjük, próbálja újra, vagy lépjen be e-mail-címmel.'); }
  });
  document.getElementById('forgot').addEventListener('click', async function (ev) {
    ev.preventDefault();
    var email = document.getElementById('email').value.trim().toLowerCase();
    if (!email) { show('error-msg', 'Írja be az e-mail-címét, majd kattintson újra az „Elfelejtette a jelszavát?” linkre.'); document.getElementById('email').focus(); return; }
    try {
      var r = await withClient(function (c) { return c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname.replace(/login\.html$/, 'reset-password.html') }); });
      if (r.error) throw r.error;
      show('error-msg', 'Ha ezzel a címmel van fiók, elküldtük a jelszó-visszaállító levelet a(z) ' + email + ' címre.', 'ok');
    } catch (e) { show('error-msg', 'A levelet most nem sikerült elküldeni. Kérjük, próbálja újra néhány perc múlva.'); }
  });
  form.addEventListener('submit', async function (e) {
    e.preventDefault(); hide('error-msg');
    var email = document.getElementById('email').value.trim().toLowerCase(), pw = document.getElementById('password').value;
    if (!email || !pw) { show('error-msg', 'Adja meg az e-mail-címét és a jelszavát.'); return; }
    btn.disabled = true; btn.textContent = 'Belépés…';
    try {
      var r = await withClient(function (c) { return c.auth.signInWithPassword({ email: email, password: pw }); });
      if (!r.error && r.data.session) {
        var del = await window.gp.checkDeletedAccount();
        if (del.deleted) { await window.gp.client.auth.signOut({ scope: 'local' }); show('error-msg', 'Ez a fiók törölve lett. Új fiókhoz regisztráljon másik e-mail-címmel, vagy írjon az info@aipalyazo.hu címre.'); }
        else { location.replace('portal.html'); return; }
      } else {
        var m = r.error && r.error.message || '';
        show('error-msg', /Email not confirmed/i.test(m) ? 'Az e-mail-címét még nem erősítette meg. Nézze meg a postafiókját (a spam mappát is).' : 'Hibás e-mail-cím vagy jelszó.');
      }
    } catch (e2) { show('error-msg', 'A belépés most nem sikerült. Kérjük, próbálja újra.'); }
    btn.disabled = false; btn.textContent = 'Belépés';
    document.getElementById('password').value = '';
  });
})();
