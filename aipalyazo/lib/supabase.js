// =========================================================================
// AIpályázó — Supabase client (browser, public)
// =========================================================================
// The anon key embedded here is SAFE to publish. RLS policies on the
// database enforce per-row access. NEVER paste the service_role key here.
// =========================================================================

const SUPABASE_URL = 'https://kacnvchwfwvpkkyhyupb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthY252Y2h3Znd2cGtreWh5dXBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NzQwNDEsImV4cCI6MjA5NjE1MDA0MX0.ajkwWvyPP-ENAnOXmokvBQ-1PP0So-qoZg4DJmsPob0';

// Load the supabase-js client from CDN — single global `supabase` object.
// We attach our configured client as `window.gp` (AIpályázó namespace).
async function ensureSupabase() {
    if (window.supabase) return window.supabase;
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/dist/umd/supabase.min.js';
        // Subresource Integrity: pin the exact byte content of the CDN file so a
        // compromised/altered CDN response can't inject code. Hash is for the
        // pinned @2.45.0 UMD build — recompute if the version above changes.
        s.integrity = 'sha384-NNePyabYRaJyedI6EQAY7SV5Z8/0sQkuQ5WVfhKm0H+j0KSugkI2ZMNzw/QtzAWz';
        s.crossOrigin = 'anonymous';
        s.onload = () => resolve(window.supabase);
        s.onerror = () => reject(new Error('Failed to load Supabase SDK'));
        document.head.appendChild(s);
    });
}

// Sign-out guard — if the URL has ?signed_out=1, NUKE every possible auth
// storage key BEFORE the Supabase SDK initialises. Without this, an in-flight
// auto-refresh on another tab can write the session back into localStorage and
// the bounce-out logic on login.html/signup.html would re-log the user in.
function gpForceClearAuthStorage() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (k === 'grantpilot-auth' ||
                k.startsWith('grantpilot-auth.') ||
                k.startsWith('sb-') ||
                k.includes('-auth-token') ||
                k.startsWith('gp_migrated_')) {
                keys.push(k);
            }
        }
        keys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
        sessionStorage.removeItem('gp_auth_token');
        sessionStorage.removeItem('gp_user_email');
        sessionStorage.removeItem('gp_auth_time');
        console.log('[gp] forced clear, removed', keys.length, 'localStorage keys:', keys);
    } catch (e) { console.warn('[gp] force clear failed', e); }
}

const _signedOutFlag = (new URLSearchParams(location.search)).get('signed_out') === '1';
if (_signedOutFlag) {
    gpForceClearAuthStorage();
    // Strip the query param so a refresh doesn't keep triggering this guard.
    try { if (history && history.replaceState) history.replaceState(null, '', location.pathname); } catch (e) {}
}

// Initialise the client and expose helpers on window.gp.
(async function init() {
    const supa = await ensureSupabase();
    const client = supa.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            // If we just signed out, DON'T let the SDK read an OAuth fragment
            // (#access_token=...) and re-create a session.
            detectSessionInUrl: !_signedOutFlag,
            storage: window.localStorage,
            storageKey: 'grantpilot-auth'
        }
    });

    // Belt-and-suspenders: if signed_out, also call SDK signOut after init so
    // any in-memory state is cleared and onAuthStateChange fires.
    if (_signedOutFlag) {
        try { await client.auth.signOut({ scope: 'local' }); } catch (e) {}
    }

    // Helper: get tier of current user. Returns 'anonymous' | 'pro'.
    // AIpályázó is fully free: every signed-in user has full ('pro') access.
    // (The old paid 'basic' vs 'pro' split + Paddle billing was removed.)
    async function getTier() {
        const { data: { user } } = await client.auth.getUser();
        if (!user) return 'anonymous';
        return 'pro';
    }

    // Helper: get the full user-with-tier row.
    async function getUserProfile() {
        const { data: { user } } = await client.auth.getUser();
        if (!user) return null;
        const { data } = await client
            .from('user_with_tier')
            .select('*')
            .eq('id', user.id)
            .single();
        return data;
    }

    // Helper: sign out and redirect to landing.
    async function signOut(redirectTo) {
        await client.auth.signOut();
        // Also clear any legacy demo session tokens
        try {
            sessionStorage.removeItem('gp_auth_token');
            sessionStorage.removeItem('gp_user_email');
            sessionStorage.removeItem('gp_auth_time');
        } catch (e) {}
        window.location.replace(redirectTo || 'index.html');
    }

    // Helper: check if the authenticated user's profile is flagged as deleted
    // OR their email appears in the persistent deleted_emails ban list (which
    // survives cascade deletes when a Google OAuth user re-creates an account).
    async function checkDeletedAccount() {
        const { data: { user } } = await client.auth.getUser();
        if (!user) return { deleted: false };
        // Primary check: the persistent deleted_emails table. This catches
        // OAuth re-signups that create fresh profiles with the old email.
        if (user.email) {
            try {
                const { data: del } = await client
                    .from('deleted_emails')
                    .select('email')
                    .eq('email', user.email.toLowerCase())
                    .maybeSingle();
                if (del && del.email) return { deleted: true, reason: 'deleted_emails' };
            } catch (e) { /* table might not exist yet — fall through */ }
        }
        // Secondary check: profile sentinel (works for password accounts where
        // the cascade delete didn't run because the auth.users row is still there).
        const { data, error } = await client
            .from('profiles')
            .select('display_name, email')
            .eq('id', user.id)
            .single();
        if (error || !data) return { deleted: false };
        const isDeleted =
            data.display_name === '__DELETED__' ||
            (typeof data.email === 'string' && data.email.startsWith('deleted-'));
        return { deleted: isDeleted };
    }

    // Helper: require auth — redirect to login if not signed in.
    async function requireAuth(loginUrl) {
        const { data: { user } } = await client.auth.getUser();
        if (!user) {
            window.location.replace((loginUrl || 'login.html') + '?next=' + encodeURIComponent(location.pathname));
            return null;
        }
        return user;
    }

    window.gp = { client, getTier, getUserProfile, signOut, requireAuth, checkDeletedAccount };

    // Notify the page that the client is ready.
    window.dispatchEvent(new CustomEvent('gp-ready'));
})();
