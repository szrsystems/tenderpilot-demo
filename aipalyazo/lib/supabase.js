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

    // Helper: get tier of current user. Returns 'anonymous' | 'basic' | 'pro'.
    async function getTier() {
        const { data: { user } } = await client.auth.getUser();
        if (!user) return 'anonymous';
        const { data, error } = await client
            .from('user_with_tier')
            .select('tier, subscription_status, current_period_end')
            .eq('id', user.id)
            .single();
        if (error || !data) return 'basic'; // safe default
        // Pro means the row reports pro AND subscription is active.
        if (data.tier === 'pro' && ['trialing','active'].includes(data.subscription_status)) {
            return 'pro';
        }
        return 'basic';
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

    // Helper: require auth — redirect to login if not signed in.
    async function requireAuth(loginUrl) {
        const { data: { user } } = await client.auth.getUser();
        if (!user) {
            window.location.replace((loginUrl || 'login.html') + '?next=' + encodeURIComponent(location.pathname));
            return null;
        }
        return user;
    }

    window.gp = { client, getTier, getUserProfile, signOut, requireAuth };

    // Notify the page that the client is ready.
    window.dispatchEvent(new CustomEvent('gp-ready'));
})();
