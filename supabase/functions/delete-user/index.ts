// =========================================================================
// AIpályázó — delete-user Edge Function
// =========================================================================
// GDPR Article 17 (right to erasure) — fully deletes the authenticated user's
// account, including the auth.users row, which requires the service_role key.
//
// Frontend (portal.html → deleteAccount) already wipes user-owned rows
// (bookmarks, drafts, leads, notif_prefs). This function does the final
// auth.users deletion that the user can't do themselves.
//
// Deploy:
//   supabase functions deploy delete-user
// (Default — uses JWT verification, so the user must be authenticated.)
// =========================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  // Authenticate the caller — get their user_id from the bearer token.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'missing auth' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const jwt = authHeader.slice('Bearer '.length);

  // Use a user-scoped client to verify the JWT and get the user_id.
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'invalid auth' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Check for active subscription — refuse if Pro is active, force cancel first.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  try {
    const { data: subs } = await adminClient
      .from('subscriptions')
      .select('status')
      .eq('user_id', user.id);
    const hasActive = (subs || []).some(s => ['active', 'trialing', 'past_due'].includes(s.status));
    if (hasActive) {
      return new Response(JSON.stringify({
        error: 'active_subscription',
        message: 'Aktív Pro előfizetés van — előbb mondja le a Beállítások / Csomag menüpontban.'
      }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  } catch (e) {
    console.warn('[delete-user] subscription check failed (proceeding)', e);
  }

  // Authoritatively add the email to the persistent ban list BEFORE deleting
  // auth.users. The frontend's own insert fails on the success path (its RLS
  // check reads auth.users, which is gone once we delete the row), so this
  // server-side write via service role is what actually blocks re-registration
  // (incl. fresh Google-OAuth signups that reuse the email).
  if (user.email) {
    try {
      await adminClient.from('deleted_emails').upsert(
        { email: user.email.toLowerCase(), user_id: user.id, reason: 'user_requested' },
        { onConflict: 'email' }
      );
    } catch (e) {
      console.warn('[delete-user] deleted_emails upsert failed', e);
    }
  }

  // Wipe user-owned rows (defensive — frontend already does this, but make sure)
  const tables = ['bookmarks', 'drafts', 'leads', 'notif_prefs', 'subscriptions'];
  for (const t of tables) {
    try {
      await adminClient.from(t).delete().eq('user_id', user.id);
    } catch (e) {
      console.warn(`[delete-user] failed to wipe ${t}:`, e);
    }
  }
  // profiles row: cascade deletes when auth.users is deleted (FK ON DELETE CASCADE)

  // Final step — delete the auth.users row.
  const { error: delErr } = await adminClient.auth.admin.deleteUser(user.id);
  if (delErr) {
    console.error('[delete-user] auth.admin.deleteUser failed', delErr);
    return new Response(JSON.stringify({
      error: 'delete_failed',
      message: delErr.message
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  console.log('[delete-user] deleted user', user.id);
  return new Response(JSON.stringify({ ok: true, deleted_user_id: user.id }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});
