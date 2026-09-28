// =========================================================================
// AIpályázó — delete-user Edge Function
// =========================================================================
// GDPR Art. 17 — erases the calling user's account. Every step is checked;
// the answer says exactly how far it got:
//
//   1 block    sha256(lower(email)) → deleted_emails (stops silent re-creation
//              via Google OAuth; purged after 180 days)
//   2 leads    consultation requests of this user (by user_id OR e-mail):
//              personal data erased, row kept for commission accounting
//              (lead_ref, grant, status, dates)
//   3 data     bookmarks, drafts, notif_prefs, alert_log, ai_usage deleted;
//              profile scrubbed to the '__DELETED__' sentinel
//   4 account  auth.users row deleted (profile cascades)
//
//   200 {ok:true}
//   401 {error:'unauthorized'}
//   500 {error:'delete_failed', step:'block'|'leads'|'data'|'account', dataDeleted:boolean}
//        dataDeleted=true  → steps 1–3 done, only the login itself remains
//        dataDeleted=false → nothing or only part of the personal data was erased
//   Safe to call again after a failure (every step is idempotent).
//
// Deploy (JWT verification ON — default):
//   supabase functions deploy delete-user --project-ref kacnvchwfwvpkkyhyupb
// =========================================================================
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearer, corsHeaders, emailHash, jsonResponse, makeEnv } from '../_shared/http.ts';

export const DELETED_NAME = 'Törölt felhasználó';
export const DELETED_EMAIL = 'torolt@deleted.invalid';
export const USER_TABLES = ['bookmarks', 'drafts', 'notif_prefs', 'alert_log', 'ai_usage'];

export type Ops = {
  blockEmail(hash: string): Promise<void>;
  anonymizeLeads(userId: string, email: string | null): Promise<void>;
  deleteUserData(userId: string): Promise<void>;
  deleteAuthUser(userId: string): Promise<void>;
};
export type Deps = {
  env?: Record<string, string | undefined>;
  getUser?: (jwt: string) => Promise<{ id: string; email?: string | null } | null>;
  ops?: Ops;
};

const ok = <T>(r: { error: any; data?: T }, what: string) => {
  if (r.error) throw new Error(`${what}: ${r.error.code ?? ''} ${r.error.message ?? r.error}`);
  return r.data;
};

export function supabaseOps(admin: any): Ops {
  const scrubbed = { user_id: null, name: DELETED_NAME, email: DELETED_EMAIL, phone: null, company: null, message: null, match_snapshot: null, ip_hash: null, status_note: null };
  return {
    async blockEmail(hash) {
      ok(await admin.from('deleted_emails').upsert({ email_hash: hash, reason: 'user_requested' }, { onConflict: 'email_hash', ignoreDuplicates: true }), 'deleted_emails');
    },
    async anonymizeLeads(userId, email) {
      ok(await admin.from('leads').update(scrubbed).eq('user_id', userId), 'leads by user');
      if (email) ok(await admin.from('leads').update(scrubbed).eq('email', email.trim().toLowerCase()), 'leads by email');
    },
    async deleteUserData(userId) {
      for (const t of USER_TABLES) ok(await admin.from(t).delete().eq('user_id', userId), t);
      ok(await admin.from('profiles').update({
        display_name: '__DELETED__', email: `deleted-${userId}@aipalyazo.hu`, phone: null, company: null, industry: null,
        industries: null, employees: null, revenue: null, location: null, site_region: null, years_operating: null,
        legal_form: null, public_debt_free: null, own_funds: null, in_difficulty: null, teaor: null, categories: null, rnd: null, women_led: null,
      }).eq('id', userId), 'profiles');
    },
    async deleteAuthUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(`auth: ${error.message}`);
    },
  };
}

export async function handler(req: Request, deps: Deps = {}): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'));
  const reply = (b: unknown, s = 200) => jsonResponse(b, s, cors);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const env = makeEnv(deps.env);
  const jwt = bearer(req);
  if (!jwt) return reply({ error: 'unauthorized' }, 401);
  let admin: any = null;
  const getAdmin = () => admin ??= createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const getUser = deps.getUser ?? (async (t: string) => {
    const { data, error } = await getAdmin().auth.getUser(t);
    return error ? null : data?.user ?? null;
  });
  let user: { id: string; email?: string | null } | null = null;
  try { user = await getUser(jwt); } catch { user = null; }
  if (!user) return reply({ error: 'unauthorized' }, 401);

  const ops = deps.ops ?? supabaseOps(getAdmin());
  const email = user.email ?? null;
  let step: 'block' | 'leads' | 'data' | 'account' = 'block';
  try {
    if (email) await ops.blockEmail(await emailHash(email));
    step = 'leads';
    await ops.anonymizeLeads(user.id, email);
    step = 'data';
    await ops.deleteUserData(user.id);
    step = 'account';
    await ops.deleteAuthUser(user.id);
  } catch (e) {
    console.error('[delete-user] failed at', step, String(user.id).slice(0, 8), String(e).slice(0, 200));
    return reply({ error: 'delete_failed', step, dataDeleted: step === 'account' }, 500);
  }
  console.log('[delete-user] deleted', String(user.id).slice(0, 8));
  return reply({ ok: true });
}

if (import.meta.main) Deno.serve((req) => handler(req));
