// Data access for public.leads, used by lead-submit / lead-digest /
// lead-status / admin-leads. Functions take a LeadStore (tests pass an
// in-memory fake); supabaseLeadStore() is the real service-role backend.
// deno-lint-ignore-file no-explicit-any

import type { LeadStatus } from './lead-token.ts';

export type MatchCheck = { key: string; status: string; reason: string; label?: string };
export type MatchSnapshot = {
  score?: number | null;
  verdict?: string | null;
  checks?: MatchCheck[];
  profile?: Record<string, string>;
  grant?: { code?: string | null; deadline?: string | null; url?: string | null; fromFeed: boolean };
  titleFromClient?: boolean;
};

export type LeadRow = {
  id: string;
  lead_ref: string;
  created_at: string;
  user_id?: string | null;
  grant_id: string;
  grant_title: string | null;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string | null;
  match_snapshot: MatchSnapshot | null;
  status: LeadStatus;
  status_note?: string | null;
  status_updated_at?: string | null;
  notified_at: string | null;
  notify_attempts: number;
  notify_error?: string | null;
  utm_source?: string | null;
  utm_campaign?: string | null;
  utm_medium?: string | null;
};

export type NewLead = {
  user_id: string | null;
  grant_id: string;
  grant_title: string | null;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string | null;
  match_snapshot: MatchSnapshot;
  ip_hash: string | null;
  utm_source?: string | null;
  utm_campaign?: string | null;
  utm_medium?: string | null;
};

export type NotifyStore = {
  claimNotify(id: string): Promise<boolean>;
  markNotified(id: string): Promise<void>;
  markNotifyFailed(id: string, error: string): Promise<void>;
};

export type LeadStore = NotifyStore & {
  findDuplicate(email: string, grantId: string, sinceIso: string): Promise<{ lead_ref: string; user_id: string | null } | null>;
  countByEmail(email: string, sinceIso: string): Promise<number>;
  countByIp(ipHash: string, sinceIso: string): Promise<number>;
  /** all leads created since — global flood guard */
  countSince(sinceIso: string): Promise<number>;
  insert(row: NewLead): Promise<LeadRow>;
  /** notified_at null, attempts below max, oldest first */
  listUnnotified(maxAttempts: number, limit: number): Promise<LeadRow[]>;
  listCreatedSince(sinceIso: string): Promise<LeadRow[]>;
  listByStatus(statuses: LeadStatus[], limit: number): Promise<LeadRow[]>;
  /** false when no lead has that ref; 'locked' when the lead is already paid (final) */
  setStatusByRef(ref: string, status: LeadStatus, note?: string | null): Promise<boolean | 'locked'>;
  setStatusById(id: string, status: LeadStatus, note?: string | null): Promise<LeadRow | null>;
  page(opts: { limit: number; offset: number; status?: LeadStatus | null }): Promise<{ rows: LeadRow[]; total: number }>;
};

export const LEAD_COLS =
  'id, lead_ref, created_at, user_id, grant_id, grant_title, name, email, phone, company, message, match_snapshot, status, status_note, status_updated_at, notified_at, notify_attempts, notify_error, utm_source, utm_campaign, utm_medium';

function check<T>(res: { data: T; error: any }): T {
  if (res.error) throw new Error(`db: ${res.error.code ?? ''} ${res.error.message ?? res.error}`.slice(0, 200));
  return res.data;
}

export function supabaseLeadStore(admin: any): LeadStore {
  const leads = () => admin.from('leads');
  return {
    async findDuplicate(email, grantId, since) {
      const rows = check(await leads().select('lead_ref, user_id').eq('email', email).eq('grant_id', grantId)
        .gte('created_at', since).order('created_at', { ascending: false }).limit(1)) as any[];
      return rows?.[0] ?? null;
    },
    async countByEmail(email, since) {
      const r = await leads().select('id', { count: 'exact', head: true }).eq('email', email).gte('created_at', since);
      check(r);
      return r.count ?? 0;
    },
    async countByIp(ipHash, since) {
      const r = await leads().select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', since);
      check(r);
      return r.count ?? 0;
    },
    async countSince(since) {
      const r = await leads().select('id', { count: 'exact', head: true }).gte('created_at', since);
      check(r);
      return r.count ?? 0;
    },
    async insert(row) {
      // lead_ref comes from the column default; retry on the (1 in 10^9) collision.
      for (let attempt = 0; ; attempt++) {
        const r = await leads().insert(row).select(LEAD_COLS).single();
        if (r.error && r.error.code === '23505' && /lead_ref/.test(r.error.message ?? '') && attempt < 3) continue;
        return check(r) as LeadRow;
      }
    },
    async claimNotify(id) {
      return check(await admin.rpc('claim_lead_notify', { p_id: id })) === true;
    },
    async markNotified(id) {
      check(await leads().update({ notified_at: new Date().toISOString(), notify_error: null, notify_locked_until: null }).eq('id', id));
      check(await leads().update({ status: 'sent' }).eq('id', id).eq('status', 'new'));
    },
    async markNotifyFailed(id, error) {
      check(await leads().update({ notify_error: error.slice(0, 500), notify_locked_until: null }).eq('id', id));
    },
    async listUnnotified(maxAttempts, limit) {
      return check(await leads().select(LEAD_COLS).is('notified_at', null).lt('notify_attempts', maxAttempts)
        .order('created_at', { ascending: true }).limit(limit)) as LeadRow[];
    },
    async listCreatedSince(since) {
      return check(await leads().select(LEAD_COLS).gte('created_at', since)
        .order('created_at', { ascending: false }).limit(500)) as LeadRow[];
    },
    async listByStatus(statuses, limit) {
      return check(await leads().select(LEAD_COLS).in('status', statuses)
        .order('created_at', { ascending: true }).limit(limit)) as LeadRow[];
    },
    async setStatusByRef(ref, status, note) {
      const patch: Record<string, unknown> = { status };
      if (note != null) patch.status_note = note;
      // 'paid' is final: an old e-mailed link must not overwrite commission state.
      const rows = check(await leads().update(patch).eq('lead_ref', ref).neq('status', 'paid').select('id')) as any[];
      if ((rows?.length ?? 0) > 0) return true;
      const exists = check(await leads().select('id').eq('lead_ref', ref).limit(1)) as any[];
      return (exists?.length ?? 0) > 0 ? 'locked' : false;
    },
    async setStatusById(id, status, note) {
      const patch: Record<string, unknown> = { status };
      if (note != null) patch.status_note = note;
      const rows = check(await leads().update(patch).eq('id', id).select(LEAD_COLS)) as LeadRow[];
      return rows?.[0] ?? null;
    },
    async page({ limit, offset, status }) {
      let q = leads().select(LEAD_COLS, { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (status) q = q.eq('status', status);
      const r = await q;
      // PostgREST answers an offset past the end with PGRST103, not an empty page.
      if (r.error?.code === 'PGRST103') return { rows: [], total: r.count ?? 0 };
      return { rows: (check(r) as LeadRow[]) ?? [], total: r.count ?? 0 };
    },
  };
}
