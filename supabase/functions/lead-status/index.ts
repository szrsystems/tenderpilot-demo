// =========================================================================
// AIpályázó — lead-status Edge Function
// =========================================================================
// The grant-writer partner reports what happened with a lead by clicking a
// signed link in the lead e-mail → aipalyazo/lead-status.html → confirm
// button → this function. Nothing changes on page load (mail scanners).
//
//   POST { ref: 'L-XXXXXX', s: 'contacted'|'applied'|'won'|'lost'|'spam', t: <32 hex>, note? }
//   t = first 32 hex of HMAC-SHA256(LEAD_STATUS_SECRET, ref + '|' + s)
//
//   200 {ok:true, ref, status}   400 {error:'invalid', field}   403 {error:'invalid_token'}
//   404 {error:'not_found'}      503 {error:'not_configured'}   500 {error:'server'}
//
// Deploy:  supabase functions deploy lead-status --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// Secret:  LEAD_STATUS_SECRET (same value lead-submit / lead-digest sign with)
// =========================================================================
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { CONTROL_CHARS, corsHeaders, jsonResponse, makeEnv, readJsonObject } from '../_shared/http.ts';
import { type LeadStore, supabaseLeadStore } from '../_shared/lead-store.ts';
import { LINK_STATUSES, type LinkStatus, REF_RE, TOKEN_RE, verifyStatusToken } from '../_shared/lead-token.ts';

export type Deps = {
  env?: Record<string, string | undefined>;
  store?: Pick<LeadStore, 'setStatusByRef'>;
};

export async function handler(req: Request, deps: Deps = {}): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'));
  const reply = (b: unknown, s = 200) => jsonResponse(b, s, cors);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const env = makeEnv(deps.env);
  const secret = env('LEAD_STATUS_SECRET') ?? '';
  if (!secret) return reply({ error: 'not_configured' }, 503);

  const body = await readJsonObject(req, 8 * 1024);
  if (!body) return reply({ error: 'invalid', field: 'body' }, 400);
  const ref = typeof body.ref === 'string' ? body.ref.trim().toUpperCase() : '';
  const s = typeof body.s === 'string' ? body.s.trim() : '';
  const t = typeof body.t === 'string' ? body.t.trim().toLowerCase() : '';
  if (!REF_RE.test(ref)) return reply({ error: 'invalid', field: 'ref' }, 400);
  if (!(LINK_STATUSES as readonly string[]).includes(s)) return reply({ error: 'invalid', field: 's' }, 400);
  if (!TOKEN_RE.test(t)) return reply({ error: 'invalid', field: 't' }, 400);
  let note: string | null = null;
  if (body.note != null && body.note !== '') {
    if (typeof body.note !== 'string' || body.note.length > 1000 || CONTROL_CHARS.test(body.note)) return reply({ error: 'invalid', field: 'note' }, 400);
    note = body.note.trim() || null;
  }

  if (!(await verifyStatusToken(secret, ref, s, t))) return reply({ error: 'invalid_token' }, 403);

  try {
    const store = deps.store ?? supabaseLeadStore(createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }) as any);
    const found = await store.setStatusByRef(ref, s as LinkStatus, note);
    if (!found) return reply({ error: 'not_found' }, 404);
    return reply({ ok: true, ref, status: s });
  } catch (e) {
    console.error('[lead-status] update failed', String(e).slice(0, 200));
    return reply({ error: 'server' }, 500);
  }
}

if (import.meta.main) Deno.serve((req) => handler(req));
