/* lead-status.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
(function () {
    // Opened from the status links in a lead notification
    // (?ref=L-XXXXXX&s=<status>&t=<token>). The page never changes anything
    // on load: mail scanners open links automatically, so a person has to
    // press the button. The token is checked server-side (lead-status).
    var API = 'https://kacnvchwfwvpkkyhyupb.supabase.co/functions/v1/lead-status';
    var LABELS = {
        contacted: 'Felvették a kapcsolatot',
        applied: 'Pályázat beadva',
        won: 'Nyertes pályázat',
        lost: 'Nem valósult meg',
        spam: 'Spam / érvénytelen'
    };
    var qs = new URLSearchParams(location.search);
    var ref = (qs.get('ref') || '').trim().toUpperCase();
    var status = (qs.get('s') || '').trim();
    var token = (qs.get('t') || '').trim().toLowerCase();
    var $ = function (id) { return document.getElementById(id); };

    function show(id) {
        ['step-confirm', 'step-done', 'step-bad'].forEach(function (s) { $(s).classList.toggle('hidden', s !== id); });
    }
    function msg(text, kind) {
        var m = $('msg');
        m.textContent = text || '';
        m.className = 'msg' + (text ? ' show ' + kind : '');
    }

    if (!/^L-[A-Z2-7]{6}$/.test(ref) || !LABELS.hasOwnProperty(status) || !/^[0-9a-f]{32}$/.test(token)) { show('step-bad'); return; }

    document.querySelectorAll('[data-ref]').forEach(function (el) { el.textContent = ref; });
    document.querySelectorAll('[data-label]').forEach(function (el) {
        el.textContent = LABELS[status];
        if (status === 'lost' || status === 'spam') el.classList.add('bad');
    });
    document.title = 'Igény ' + ref + ' — ' + LABELS[status] + ' — AIpályázó';
    show('step-confirm');
    // Keep the token out of the address bar / history once read.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}

    $('btn-save').addEventListener('click', async function () {
        var btn = this;
        btn.disabled = true; msg('');
        try {
            var note = $('note').value.trim();
            var r = await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(note ? { ref: ref, s: status, t: token, note: note } : { ref: ref, s: status, t: token })
            });
            if (r.status === 403 || r.status === 404) { show('step-bad'); return; }
            if (r.status === 409) { msg('Ez a kérés már lezárult (kifizetve), az állapota ezzel a linkkel nem módosítható.', 'err'); return; }
            if (!r.ok) throw new Error('HTTP ' + r.status);
            show('step-done');
        } catch (e) {
            msg('A mentés nem sikerült. Kérjük, próbálja újra, vagy írjon az info@aipalyazo.hu címre.', 'err');
        } finally {
            btn.disabled = false;
        }
    });
})();
