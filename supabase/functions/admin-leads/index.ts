// =========================================================================
// AIpályázó — admin-leads Edge Function
// =========================================================================
// Returns ALL consultation leads (name, email, phone, grant, time) — but ONLY
// to the admin. The caller must be signed in (Supabase Auth) AND their e-mail
// must equal ADMIN_EMAIL. leads are otherwise RLS-locked (anon insert, no read),
// so this service-role read is the only way to see them, and it's e-mail-gated.
//
// Deploy:
//   supabase functions deploy admin-leads --project-ref kacnvchwfwvpkkyhyupb
// Secret (optional — defaults to oliver.szephelyi@gmail.com):
//   supabase secrets set ADMIN_EMAIL=oliver.szephelyi@gmail.com --project-ref kacnvchwfwvpkkyhyupb
// =========================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_EMAIL = (Deno.env.get('ADMIN_EMAIL') ?? 'oliver.szephelyi@gmail.com').toLowerCase();

// Reflect the caller's origin — the admin app lives on a separate host (Render).
// Security is the admin JWT + e-mail check below, not CORS.
function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (origin: string | null, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json(origin, { error: 'unauthorized' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json(origin, { error: 'unauthorized' }, 401);
  if ((user.email ?? '').toLowerCase() !== ADMIN_EMAIL) return json(origin, { error: 'forbidden' }, 403);

  const { data, error } = await admin
    .from('leads')
    .select('id, created_at, name, email, phone, grant_id, grant_title')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return json(origin, { error: 'query_failed', detail: error.message }, 500);

  return json(origin, { leads: data ?? [], count: (data ?? []).length });
});
