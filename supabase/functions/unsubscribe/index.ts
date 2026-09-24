// =========================================================================
// AIpályázó — unsubscribe Edge Function
// =========================================================================
// Turns the weekly e-mail off for the notif_prefs row that owns a given
// unsubscribe_token. No login needed: the token itself (a random UUID that
// only appears in that user's own e-mails) is the proof.
//
// Two callers:
//   1. Mail clients' one-click unsubscribe (RFC 8058):
//        POST /functions/v1/unsubscribe?t=<token>
//        body: List-Unsubscribe=One-Click   (form-encoded)
//   2. The site's leiratkozas.html page:
//        POST /functions/v1/unsubscribe   body: {"t":"<token>","action":"off"|"on"}
//      ("on" lets someone who clicked by mistake re-subscribe.)
//   Optional kind=instant (query ?kind=instant or body "kind":"instant")
//   switches the instant alerts instead of the weekly e-mail.
//
// GET is deliberately NOT supported: link scanners and mail previewers
// fetch GET links automatically and would unsubscribe people by accident.
//
// Deploy (no JWT — the link is opened by people who are not signed in):
//   supabase functions deploy unsubscribe --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// =========================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ORIGINS = [
  'https://aipalyazo.hu',
  'https://www.aipalyazo.hu',
  'https://szrsystems.github.io',
  'https://tenderpilot.onrender.com',
];
function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (origin: string | null, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json(origin, { error: 'method_not_allowed' }, 405);

  // Token: query string (one-click) or JSON body (site page).
  const url = new URL(req.url);
  let token = url.searchParams.get('t') ?? '';
  let action: 'off' | 'on' = 'off';
  let kind: 'weekly' | 'instant' = url.searchParams.get('kind') === 'instant' ? 'instant' : 'weekly';
  const ctype = req.headers.get('content-type') ?? '';
  if (ctype.includes('application/json')) {
    try {
      const body = await req.json();
      if (typeof body?.t === 'string') token = body.t;
      if (body?.action === 'on') action = 'on';
      if (body?.kind === 'instant') kind = 'instant';
    } catch { /* fall through with query token */ }
  }
  token = token.trim();
  if (!UUID_RE.test(token)) return json(origin, { error: 'invalid_token' }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const patch = kind === 'instant'
    ? { instant_enabled: action === 'on' }
    : action === 'on'
      ? { weekly_enabled: true }
      : { weekly_enabled: false, urgent_enabled: false };
  const { error } = await admin
    .from('notif_prefs')
    .update(patch)
    .eq('unsubscribe_token', token);
  if (error) return json(origin, { error: 'update_failed' }, 500);
  // Same answer whether or not the token exists: don't reveal valid tokens.
  return json(origin, kind === 'instant' ? { ok: true, kind, instant_enabled: action === 'on' } : { ok: true, kind, weekly_enabled: action === 'on' });
});
