/* confirm-email.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
const email = (new URLSearchParams(location.search)).get('email') || '';
document.getElementById('email-display').textContent = email || '(az e-mail amellyel regisztráltál)';

const msgEl = document.getElementById('msg');
const statusEl = document.getElementById('auto-status');
function showMsg(text, kind) {
    msgEl.textContent = text;
    msgEl.className = 'msg show ' + kind;
}

async function withClient(fn) {
    if (!window.gp) await new Promise(r => window.addEventListener('gp-ready', r, { once: true }));
    return fn(window.gp.client);
}

// Magic-link flow: the user clicks the link in their email → returns here
// with an access_token in the URL hash → lib/supabase.js detects it and
// creates a session → we detect the session and bounce to portal.html.
window.addEventListener('gp-ready', async () => {
    // Give detectSessionInUrl a tick to process the URL hash
    setTimeout(async () => {
        try {
            const { data: { session } } = await window.gp.client.auth.getSession();
            if (session && session.user) {
                statusEl.style.display = 'none';
                showMsg('Sikeres megerősítés ✓ — továbblépünk a cégprofilhoz…', 'success');
                setTimeout(() => { location.replace('onboarding.html'); }, 1200);
            }
        } catch (e) { /* no session yet, user hasn't clicked link */ }
    }, 300);
});

// Also poll periodically — if user clicks the link in another tab/window,
// the session might be set in another tab. Re-check every 3 sec for 5 min.
let pollCount = 0;
const pollInterval = setInterval(async () => {
    pollCount++;
    if (pollCount > 100) { clearInterval(pollInterval); return; }
    if (!window.gp || !window.gp.client) return;
    try {
        const { data: { session } } = await window.gp.client.auth.getSession();
        if (session && session.user) {
            clearInterval(pollInterval);
            statusEl.style.display = 'none';
            showMsg('Megerősítés érzékelve ✓ — továbblépünk a cégprofilhoz…', 'success');
            setTimeout(() => { location.replace('onboarding.html'); }, 1200);
        }
    } catch (e) {}
}, 3000);

async function resendCode() {
    if (!email) { showMsg('Hiányzik az e-mail cím.', 'error'); return; }
    const link = document.getElementById('resend-link');
    link.textContent = 'Küldés…'; link.style.pointerEvents = 'none';
    try {
        const { error } = await withClient(c => c.auth.resend({ type: 'signup', email }));
        if (error) throw error;
        showMsg('Új megerősítő e-mailt küldtünk. Nézze meg a postafiókját (a spam mappát is).', 'success');
    } catch (e) {
        // Supabase returns these errors in English — translate the common ones.
        const raw = (e && e.message) || '';
        const sec = raw.match(/after\s+(\d+)\s+seconds/i);
        let hu;
        if (/security purposes/i.test(raw) && sec) hu = `Biztonsági okból csak ${sec[1]} másodperc múlva kérhetsz újabb e-mailt.`;
        else if (/rate limit/i.test(raw)) hu = 'Túl sok kérés rövid időn belül — kérlek, próbáld újra pár perc múlva.';
        else if (/already.*(registered|confirmed)/i.test(raw)) hu = 'Ez az e-mail-cím már meg van erősítve — jelentkezz be.';
        else hu = raw || 'ismeretlen hiba';
        showMsg('Új e-mail küldése sikertelen: ' + hu, 'error');
    } finally {
        setTimeout(() => {
            link.textContent = 'Új levél küldése'; link.style.pointerEvents = '';
        }, 3000);
    }
}
