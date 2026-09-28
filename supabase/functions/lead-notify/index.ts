// =========================================================================
// AIpályázó — lead-notify (RETIRED 2026-09-28)
// =========================================================================
// Replaced by `lead-submit`, which stores the lead AND sends both e-mails
// server-side. This stub stays deployed only so that old cached portal pages
// get a clear answer; it never sends anything.
//
// Deploy the stub:   supabase functions deploy lead-notify --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// or remove it:      supabase functions delete lead-notify --project-ref kacnvchwfwvpkkyhyupb
// =========================================================================
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

export function handler(req: Request): Response {
  const cors = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  return jsonResponse({ error: 'gone', use: 'lead-submit' }, 410, cors);
}

if (import.meta.main) Deno.serve(handler);
