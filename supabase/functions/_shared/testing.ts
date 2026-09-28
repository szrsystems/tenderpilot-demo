// Test doubles shared by the edge-function tests (not imported by any function).
import nodeAssert from 'node:assert/strict';
import type { GrantFeed, Grant } from './grants.ts';
import type { LeadRow, LeadStore, NewLead } from './lead-store.ts';
import type { MailMessage, Mailer } from './lead-mail.ts';
import type { LeadStatus } from './lead-token.ts';

export type MemLead = LeadRow & { ip_hash: string | null; notify_locked_until: number | null };

export function memStore(seed: Partial<MemLead>[] = [], clock: () => number = Date.now) {
  const rows: MemLead[] = [];
  let n = 0;
  const add = (p: Partial<MemLead>): MemLead => {
    n++;
    const r: MemLead = {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      lead_ref: 'L-' + Array.from({ length: 6 }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Math.floor(n / 32 ** (5 - i)) % 32]).join(''),
      created_at: new Date(clock()).toISOString(),
      user_id: null, grant_id: 'g', grant_title: null, name: 'Teszt Elek', email: 'x@example.com',
      phone: null, company: null, message: null, match_snapshot: null, status: 'new',
      status_note: null, status_updated_at: null, notified_at: null, notify_attempts: 0, notify_error: null,
      ip_hash: null, notify_locked_until: null, ...p,
    };
    rows.push(r);
    return r;
  };
  seed.forEach(add);
  const since = (iso: string) => (r: MemLead) => r.created_at >= iso;
  const store: LeadStore & { rows: MemLead[]; failInsert?: boolean } = {
    rows,
    async findDuplicate(email, grantId, s) {
      const r = rows.filter(since(s)).filter((x) => x.email === email && x.grant_id === grantId).at(-1);
      return r ? { lead_ref: r.lead_ref, user_id: r.user_id ?? null } : null;
    },
    async countByEmail(email, s) { return rows.filter(since(s)).filter((x) => x.email === email).length; },
    async countByIp(h, s) { return rows.filter(since(s)).filter((x) => x.ip_hash === h).length; },
    async countSince(s) { return rows.filter(since(s)).length; },
    async insert(row: NewLead) {
      if (store.failInsert) throw new Error('db down: secret internals');
      return { ...add(row as Partial<MemLead>) };
    },
    async claimNotify(id) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.notified_at || r.notify_attempts >= 5 || (r.notify_locked_until && r.notify_locked_until > clock())) return false;
      r.notify_attempts++; r.notify_locked_until = clock() + 300_000;
      return true;
    },
    async markNotified(id) {
      const r = rows.find((x) => x.id === id)!;
      r.notified_at = new Date(clock()).toISOString(); r.notify_error = null; r.notify_locked_until = null;
      if (r.status === 'new') r.status = 'sent';
    },
    async markNotifyFailed(id, err) { const r = rows.find((x) => x.id === id)!; r.notify_error = err; r.notify_locked_until = null; },
    async listUnnotified(max, limit) { return rows.filter((r) => !r.notified_at && r.notify_attempts < max).slice(0, limit).map((r) => ({ ...r })); },
    async listCreatedSince(s) { return rows.filter(since(s)).map((r) => ({ ...r })); },
    async listByStatus(st, limit) { return rows.filter((r) => st.includes(r.status)).slice(0, limit).map((r) => ({ ...r })); },
    async setStatusByRef(ref, status, note) {
      const r = rows.find((x) => x.lead_ref === ref);
      if (!r) return false;
      if (r.status === 'paid') return 'locked';
      setStatus(r, status, note);
      return true;
    },
    async setStatusById(id, status, note) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      setStatus(r, status, note);
      return { ...r };
    },
    async page({ limit, offset, status }) {
      const all = rows.filter((r) => !status || r.status === status).slice().reverse();
      return { rows: all.slice(offset, offset + limit), total: all.length };
    },
  };
  function setStatus(r: MemLead, status: LeadStatus, note?: string | null) {
    if (r.status !== status) r.status_updated_at = new Date(clock()).toISOString();
    r.status = status;
    if (note != null) r.status_note = note;
  }
  return store;
}

export function memMailer(opts: { failFor?: (m: MailMessage) => boolean } = {}) {
  const sent: MailMessage[] = [];
  const mailer: Mailer & { sent: MailMessage[] } = Object.assign(async (m: MailMessage) => {
    if (opts.failFor?.(m)) throw new Error('resend 500 boom');
    sent.push(m);
  }, { sent });
  return mailer;
}

export function staticFeed(list: Grant[], opts: { fail?: boolean } = {}): GrantFeed {
  return {
    async all() { if (opts.fail) throw new Error('feed down'); return list; },
    async byId(id) { if (opts.fail) throw new Error('feed down'); return list.find((g) => g.id === id) ?? null; },
  };
}

// Minimal assert helpers on node:assert (jsr:@std/assert is not reachable from every CI/sandbox).
export function assert(v: unknown, msg?: string): asserts v { nodeAssert.ok(v, msg); }
export function assertEquals<T>(a: T, b: T, msg?: string) { nodeAssert.deepStrictEqual(a, b, msg); }
export function assertMatch(s: string, re: RegExp, msg?: string) { nodeAssert.match(s, re, msg); }
export function assertStringIncludes(s: string, part: string, msg?: string) {
  nodeAssert.ok(s.includes(part), msg ?? `expected to include ${JSON.stringify(part)}`);
}
