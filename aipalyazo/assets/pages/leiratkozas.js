/* leiratkozas.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
(function () {
    // Called by the "Leiratkozás" link in the weekly digest (?t=<token>).
    // The page never unsubscribes on load: mail scanners open links
    // automatically, so the person has to press the button.
    var API = 'https://kacnvchwfwvpkkyhyupb.supabase.co/functions/v1/unsubscribe';
    var qs = new URLSearchParams(location.search);
    var token = (qs.get('t') || '').trim();
    var kind = qs.get('k') === 'instant' ? 'instant' : 'weekly';
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var $ = function (id) { return document.getElementById(id); };

    function show(id) {
        ['step-confirm', 'step-done', 'step-bad'].forEach(function (s) { $(s).classList.toggle('hidden', s !== id); });
    }
    function msg(text, kind) {
        var m = $('msg');
        m.textContent = text || '';
        m.className = 'msg' + (text ? ' show ' + kind : '');
    }
    async function send(action, btn) {
        btn.disabled = true; msg('');
        try {
            var r = await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ t: token, action: action, kind: kind })
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            if (action === 'off') { show('step-done'); }
            else { msg(kind === 'instant' ? 'Az azonnali értesítések újra bekapcsolva.' : 'Újra feliratkozott a heti összefoglalóra.', 'ok'); $('btn-on').classList.add('hidden'); }
        } catch (e) {
            msg('A művelet nem sikerült. Kérjük, próbálja újra, vagy írjon az info@aipalyazo.hu címre.', 'err');
        } finally {
            btn.disabled = false;
        }
    }

    if (!UUID_RE.test(token)) { show('step-bad'); return; }
    if (kind === 'instant') {
        document.querySelector('[data-t="h"]').textContent = 'Azonnali értesítések kikapcsolása';
        document.querySelector('[data-t="p"]').textContent = 'A megerősítés után nem küldünk több azonnali értesítést új felhívásokról és fogyó keretekről. A heti összefoglaló (ha be van kapcsolva) és a fiókja megmarad.';
        document.querySelector('[data-t="done"]').textContent = 'Az azonnali értesítéseket kikapcsoltuk. A portál Beállítások menüjében bármikor újra bekapcsolhatja.';
        document.title = 'Azonnali értesítések kikapcsolása — AIpályázó';
    }
    // Keep the token out of the address bar / history once read.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    $('btn-off').addEventListener('click', function () { send('off', this); });
    $('btn-on').addEventListener('click', function () { send('on', this); });
})();
