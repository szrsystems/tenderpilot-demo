// =========================================================================
// AIpályázó — admin-leads Edge Function
// =========================================================================
// Lead list + status updates for the operator. The caller must be signed in
// (Supabase Auth), have a CONFIRMED e-mail, and that e-mail must be in the
// ADMIN_EMAILS secret (comma list, case-insensitive). No secret → nobody.
//
//   GET  ?limit=100&offset=0&status=won        → {leads, count, total, limit, offset}
//   POST {limit?, offset?, status?}              → same (supabase.functions.invoke)
//   POST {action:'update_status', id | ref, status, note?}
//                                                → {ok:true, lead}
//   limit: 1–500 (default 100)
//
// Deploy:  supabase functions deploy admin-leads --project-ref kacnvchwfwvpkkyhyupb
// Secret:  supabase secrets set ADMIN_EMAILS=a@x.hu,b@y.hu --project-ref kacnvchwfwvpkkyhyupb
// =========================================================================
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearer, CONTROL_CHARS, jsonResponse, makeEnv, readJsonObject } from '../_shared/http.ts';
import { type LeadStore, supabaseLeadStore } from '../_shared/lead-store.ts';
import { ALL_STATUSES, type LeadStatus, REF_RE } from '../_shared/lead-token.ts';

export type AdminUser = { id: string; email?: string | null; email_confirmed_at?: string | null };
export type Deps = {
  env?: Record<string, string | undefined>;
  getUser?: (jwt: string) => Promise<AdminUser | null>;
  store?: Pick<LeadStore, 'page' | 'setStatusById'> & { idByRef?: (ref: string) => Promise<string | null> };
};

// Reflect the caller's origin — the admin app lives on a separate host.
// Security is the admin JWT + e-mail allow-list, not CORS (no cookies).
function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  };
}

export function adminEmails(v: string | undefined): Set<string> {
  return new Set(String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isStatus = (s: unknown): s is LeadStatus => typeof s === 'string' && (ALL_STATUSES as readonly string[]).includes(s);

function paging(src: { limit?: unknown; offset?: unknown; status?: unknown }) {
  const limit = src.limit == null || src.limit === '' ? 100 : Number(src.limit);
  const offset = src.offset == null || src.offset === '' ? 0 : Number(src.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return { error: 'limit' as const };
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return { error: 'offset' as const };
  const status = src.status == null || src.status === '' ? null : src.status;
  if (status !== null && !isStatus(status)) return { error: 'status' as const };
  return { limit, offset, status };
}

export async function handler(req: Request, deps: Deps = {}): Promise<Response> {
  const origin = req.headers.get('origin');
  const reply = (b: unknown, s = 200) => jsonResponse(b, s, cors(origin));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });
  if (req.method !== 'GET' && req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const env = makeEnv(deps.env);
  const jwt = bearer(req);
  if (!jwt) return reply({ error: 'unauthorized' }, 401);

  let admin: any = null;
  const getAdmin = () => admin ??= createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const getUser = deps.getUser ?? (async (t: string) => {
    const { data, error } = await getAdmin().auth.getUser(t);
    return error ? null : (data?.user as AdminUser) ?? null;
  });

  let user: AdminUser | null = null;
  try { user = await getUser(jwt); } catch { user = null; }
  if (!user) return reply({ error: 'unauthorized' }, 401);
  const allowed = adminEmails(env('ADMIN_EMAILS'));
  if (!user.email_confirmed_at || !user.email || !allowed.has(user.email.toLowerCase())) return reply({ error: 'forbidden' }, 403);

  try {
    const store = deps.store ?? Object.assign(supabaseLeadStore(getAdmin()), {
      idByRef: async (ref: string) => {
        const { data, error } = await getAdmin().from('leads').select('id').eq('lead_ref', ref).maybeSingle();
        if (error) throw new Error(error.message);
        return data?.id ?? null;
      },
    });

    let params: Record<string, unknown>;
    if (req.method === 'GET') {
      params = Object.fromEntries(new URL(req.url).searchParams);
    } else {
      const text = await req.text();
      if (!text.trim()) params = {};
      else {
        const parsed = await readJsonObject(new Request('http://body', { method: 'POST', body: text }), 16 * 1024);
        if (!parsed) return reply({ error: 'invalid', field: 'body' }, 400);
        params = parsed;
      }
    }

    if (params.action === 'update_status') {
      if (!isStatus(params.status)) return reply({ error: 'invalid', field: 'status' }, 400);
      let note: string | null = null;
      if (params.note != null && params.note !== '') {
        if (typeof params.note !== 'string' || params.note.length > 1000 || CONTROL_CHARS.test(params.note)) return reply({ error: 'invalid', field: 'note' }, 400);
        note = params.note.trim();
      }
      let id: string | null = null;
      if (typeof params.id === 'string' && UUID_RE.test(params.id)) id = params.id;
      else if (typeof params.ref === 'string' && REF_RE.test(params.ref.toUpperCase()) && store.idByRef) id = await store.idByRef(params.ref.toUpperCase());
      else return reply({ error: 'invalid', field: 'id' }, 400);
      if (!id) return reply({ error: 'not_found' }, 404);
      const lead = await store.setStatusById(id, params.status, note);
      if (!lead) return reply({ error: 'not_found' }, 404);
      console.log('[admin-leads] status', lead.lead_ref, '→', params.status, 'by', user.id);
      return reply({ ok: true, lead });
    }
    if (params.action != null && params.action !== 'list') return reply({ error: 'invalid', field: 'action' }, 400);

    const p = paging(params);
    if ('error' in p) return reply({ error: 'invalid', field: p.error }, 400);
    const { rows, total } = await store.page({ limit: p.limit, offset: p.offset, status: p.status as LeadStatus | null });
    return reply({ leads: rows, count: rows.length, total, limit: p.limit, offset: p.offset });
  } catch (e) {
    console.error('[admin-leads] failed', String(e).slice(0, 300));
    return reply({ error: 'server' }, 500);
  }
}

if (import.meta.main) Deno.serve((req) => handler(req));
