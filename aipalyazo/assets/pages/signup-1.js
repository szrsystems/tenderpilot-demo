/* signup.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
async function withClient(fn) {
    if (!window.gp) await new Promise(function (r) { window.addEventListener('gp-ready', r, { once: true }); });
    return fn(window.gp.client);
}
function show(id, text, kind) { var el = document.getElementById(id); el.className = 'msg notice ' + (kind || 'err') + ' show'; el.textContent = text; }
function hide(id) { var el = document.getElementById(id); if (el) el.className = 'msg'; }
function justSignedOut() { return (new URLSearchParams(location.search)).get('signed_out') === '1' || sessionStorage.getItem('gp_just_signed_out') === '1'; }
