/* reset-password.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
async function withClient(fn) {
    if (!window.gp) await new Promise(r => window.addEventListener('gp-ready', r, { once: true }));
    return fn(window.gp.client);
}

const msgEl = document.getElementById('msg');
const btn = document.getElementById('submit-btn');
const leadEl = document.getElementById('lead-text');

function showMsg(text, kind) {
    msgEl.textContent = text;
    msgEl.className = 'msg show ' + kind;
}

// On load: check that the URL contains a Supabase recovery token. If not, the
// user landed here outside the email-link flow → show a hint.
window.addEventListener('gp-ready', async () => {
    // Supabase v2 sets the session automatically via detectSessionInUrl when the
    // URL hash contains the recovery tokens. Wait a tick for that to settle.
    setTimeout(async () => {
        try {
            const { data: { session } } = await window.gp.client.auth.getSession();
            if (!session) {
                leadEl.textContent = 'A jelszó-visszaállító link lejárt vagy érvénytelen. Kérjen újat a bejelentkezés oldalon.';
                showMsg('Ez a link már nem érvényes. Kérjen új jelszó-visszaállító levelet a belépés oldalon.', 'error');
                btn.disabled = true;
            }
        } catch (e) {}
    }, 200);
});

document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw1 = document.getElementById('pw1').value;
    const pw2 = document.getElementById('pw2').value;
    msgEl.classList.remove('show');

    if (pw1 !== pw2) {
        showMsg('A két jelszó nem egyezik.', 'error');
        return;
    }
    if (pw1.length < 8) {
        showMsg('A jelszó legalább 8 karakter legyen.', 'error');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Mentés…';

    try {
        const { error } = await withClient(c => c.auth.updateUser({ password: pw1 }));
        if (error) throw error;
        showMsg('Új jelszó beállítva ✓ — átirányítjuk a bejelentkezésre…', 'success');
        // Sign out so the user gets a clean login flow with the new password.
        try { await withClient(c => c.auth.signOut({ scope: 'local' })); } catch (e) {}
        setTimeout(() => { window.location.replace('login.html?password_reset=1'); }, 1500);
    } catch (err) {
        showMsg('A jelszót most nem sikerült beállítani. Kérjük, próbálja újra, vagy kérjen új levelet.', 'error');
        btn.disabled = false;
        btn.textContent = 'Jelszó beállítása';
    }
});
