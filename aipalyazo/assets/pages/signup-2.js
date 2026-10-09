/* signup.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
(function () {
  function checkMatch() {
    var p1 = document.getElementById('password').value, p2 = document.getElementById('password2').value, hint = document.getElementById('pw-hint'), i2 = document.getElementById('password2');
    if (!p2) { hint.textContent = ''; hint.className = 'field-hint'; i2.classList.remove('mismatch'); return; }
    if (p1 !== p2) { hint.textContent = 'A két jelszó nem egyezik.'; hint.className = 'field-hint error'; i2.classList.add('mismatch'); }
    else { hint.textContent = 'A két jelszó egyezik.'; hint.className = 'field-hint'; i2.classList.remove('mismatch'); }
  }
  document.getElementById('password').addEventListener('input', checkMatch);
  document.getElementById('password2').addEventListener('input', checkMatch);
  window.addEventListener('gp-ready', async function () {
    if (justSignedOut()) { sessionStorage.removeItem('gp_just_signed_out'); return; }
    var r = await window.gp.client.auth.getUser();
    if (r.data && r.data.user) location.replace('portal.html');
  });
  document.getElementById('google-btn').addEventListener('click', async function () {
    try {
      var r = await withClient(function (c) { return c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname.replace(/signup\.html$/, 'onboarding.html'), queryParams: { prompt: 'select_account' } } }); });
      if (r.error) throw r.error;
    } catch (e) { show('error-msg', 'A Google-regisztráció nem sikerült. Kérjük, próbálja újra, vagy regisztráljon e-mail-címmel.'); }
  });
  document.getElementById('signup-form').addEventListener('submit', async function (ev) {
    ev.preventDefault(); hide('error-msg');
    var v = function (id) { return (document.getElementById(id).value || '').trim(); };
    var name = v('name'), company = v('company'), email = v('email').toLowerCase(), phone = v('phone'), pw = document.getElementById('password').value, pw2 = document.getElementById('password2').value;
    if (!name) { show('error-msg', 'Adja meg a nevét.'); document.getElementById('name').focus(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { show('error-msg', 'Adjon meg egy érvényes e-mail-címet.'); document.getElementById('email').focus(); return; }
    if (pw.length < 8) { show('error-msg', 'A jelszó legalább 8 karakter legyen.'); document.getElementById('password').focus(); return; }
    if (pw !== pw2) { show('error-msg', 'A két jelszó nem egyezik.'); document.getElementById('password2').focus(); return; }
    if (!document.getElementById('gdpr').checked) { show('error-msg', 'A regisztrációhoz fogadja el az adatkezelési tájékoztatót és az ÁSZF-et.'); return; }
    var btn = document.getElementById('submit-btn'); btn.disabled = true; btn.textContent = 'Fiók létrehozása…';
    try {
      var r = await withClient(function (c) { return c.auth.signUp({ email: email, password: pw, options: { data: { full_name: name, company: company, phone: phone }, emailRedirectTo: location.origin + location.pathname.replace(/signup\.html$/, 'confirm-email.html') } }); });
      if (r.error) throw r.error;
      try {
        var prev = JSON.parse(localStorage.getItem('grantpilot:profile') || '{}');
        localStorage.setItem('grantpilot:profile', JSON.stringify(Object.assign(prev, { contact_name: name, company: company || prev.company || '', email: email, phone: phone })));
      } catch (e) {}
      if (window.aipTrack) aipTrack('signup');
      if (r.data.user && !r.data.session) location.replace('confirm-email.html?email=' + encodeURIComponent(email));
      else location.replace('onboarding.html');
    } catch (e) {
      var m = (e && e.message) || '';
      show('error-msg', /already registered|already exists|User already/i.test(m) ? 'Ezzel az e-mail-címmel már van fiók. Lépjen be, vagy kérjen új jelszót.' : 'A regisztráció most nem sikerült. Kérjük, próbálja újra.');
      btn.disabled = false; btn.textContent = 'Fiók létrehozása';
    }
  });
})();
