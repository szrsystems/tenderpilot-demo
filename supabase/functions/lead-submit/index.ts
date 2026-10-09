// =========================================================================
// AIpályázó — lead-submit Edge Function
// =========================================================================
// The only way a consultation request ("lead") enters the database. Replaces
// the browser's direct INSERT into public.leads + the lead-notify call.
//
//   POST { grantId, grantTitle?, name, email, phone?, company?, message?,
//          consent: true, turnstileToken?,
//          match?: { score, verdict, checks: [{key, status, reason, label?}],
//                    profile: {company, employees, site_region, teaor, years_operating} } }
//   Authorization: Bearer <user JWT>   (optional → leads.user_id)
//
//   200 {ok:true, ref}                   stored (+ e-mails attempted)
//   200 {ok:true, ref, duplicate:true}   same e-mail + grant in the last 24 h; nothing sent
//   400 {error:'invalid', field}
//   403 {error:'captcha_failed'}         only when TURNSTILE_SECRET is set
//   429 {error:'rate_limited'}           3 / e-mail / 24 h, 10 / IP / hour
//   500 {error:'server'}
//
// Deploy:  supabase functions deploy lead-submit --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// Secrets: RESEND_API_KEY, LEAD_NOTIFY_TO (comma list), LEAD_STATUS_SECRET,
//          LEAD_SALT, TURNSTILE_SECRET (optional), PARTNER_NAME (optional),
//          GRANTS_URL (optional)
// =========================================================================
// deno-lint-ignore-file no-explicit-any

import '../_shared/phone.js';
const normalizePhone: (s: string) => string | null = (globalThis as any).AIPPhone.normalizePhone;
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  bearer, CONTROL_CHARS, CONTROL_OR_NEWLINE, corsHeaders, jsonResponse, makeEnv, readJsonObject, sha256Hex,
} from '../_shared/http.ts';
import { createGrantFeed, type GrantFeed } from '../_shared/grants.ts';
import { type LeadStore, type MatchCheck, type MatchSnapshot, supabaseLeadStore } from '../_shared/lead-store.ts';
import { type Mailer, notifyOperator, parseRecipients, PARTNER_NAME_DEFAULT, requesterEmail, resendMailer } from '../_shared/lead-mail.ts';

// global1h is a flood brake, not a quota: a partner campaign can bring a burst
// of real requests, so it is high and configurable (LEAD_GLOBAL_HOURLY_CAP).
export const LIMITS = { perEmail24h: 3, perIp1h: 20, global1h: 300 };
const TAG_RE = /^[a-z0-9._-]{1,60}$/;
function tag(v: unknown): string | null { const s = typeof v === 'string' ? v.trim().toLowerCase() : ''; return TAG_RE.test(s) ? s : null; }
const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CHECK_STATUSES = new Set(['ok', 'fail', 'unknown', 'warn', 'neutral']);
const PROFILE_CAPS: Record<string, number> = { company: 200, employees: 40, site_region: 80, teaor: 20, years_operating: 20 };

export type Deps = {
  env?: Record<string, string | undefined>;
  store?: LeadStore;
  /** JWT → user id, null when absent/invalid (anonymous lead). */
  getUserId?: (jwt: string) => Promise<string | null>;
  grants?: GrantFeed;
  mailer?: Mailer;
  fetch?: typeof fetch;
  now?: () => Date;
};

type Clean = {
  grantId: string; grantTitle: string; name: string; email: string; phone: string | null;
  company: string | null; message: string | null; turnstileToken: string; match: MatchSnapshot;
  attribution: { source: string | null; campaign: string | null; medium: string | null };
};

class Invalid extends Error { constructor(public field: string) { super(field); } }

function str(body: Record<string, unknown>, field: string, { min = 0, max, required = false, multiline = false }:
  { min?: number; max: number; required?: boolean; multiline?: boolean }): string | null {
  const v = body[field];
  if (v == null || v === '') { if (required) throw new Invalid(field); return null; }
  if (typeof v !== 'string') throw new Invalid(field);
  const s = v.trim();
  if (!s) { if (required) throw new Invalid(field); return null; }
  if (s.length < min || s.length > max) throw new Invalid(field);
  if ((multiline ? CONTROL_CHARS : CONTROL_OR_NEWLINE).test(s)) throw new Invalid(field);
  return s;
}
const cap = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

function cleanMatch(m: unknown): MatchSnapshot {
  if (m == null) return {};
  if (typeof m !== 'object' || Array.isArray(m)) throw new Invalid('match');
  const o = m as Record<string, any>;
  const out: MatchSnapshot = {};
  if (o.score != null) {
    const n = Number(o.score);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Invalid('match');
    out.score = Math.round(n * 10) / 10;
  }
  if (o.verdict != null) out.verdict = cap(o.verdict, 20);
  if (o.checks != null) {
    if (!Array.isArray(o.checks)) throw new Invalid('match');
    out.checks = o.checks.slice(0, 20).filter((c: any) => c && typeof c === 'object').map((c: any): MatchCheck => {
      const status = String(c.status ?? '');
      const r: MatchCheck = { key: cap(c.key, 40), status: CHECK_STATUSES.has(status) ? status : 'unknown', reason: cap(c.reason, 400) };
      if (c.label) r.label = cap(c.label, 60);
      return r;
    });
  }
  if (o.profile != null) {
    if (typeof o.profile !== 'object' || Array.isArray(o.profile)) throw new Invalid('match');
    const p: Record<string, string> = {};
    for (const [k, n] of Object.entries(PROFILE_CAPS)) {
      const v = o.profile[k];
      if (v != null && v !== '' && (typeof v === 'string' || typeof v === 'number')) p[k] = cap(v, n);
    }
    out.profile = p;
  }
  return out;
}

export function validate(body: Record<string, unknown>): Clean {
  if (body.consent !== true) throw new Invalid('consent');
  const grantId = str(body, 'grantId', { min: 1, max: 200, required: true })!;
  const name = str(body, 'name', { min: 2, max: 120, required: true })!;
  const email = str(body, 'email', { max: 254, required: true })!.toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Invalid('email');
  const rawPhone = str(body, 'phone', { max: 40 });
  // A real Hungarian (or international +..) number, stored in one format.
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) throw new Invalid('phone');
  const company = str(body, 'company', { max: 200 });
  const message = str(body, 'message', { max: 2000, multiline: true });
  // Only a fallback when the id is not in the feed → truncate, don't reject.
  const grantTitle = typeof body.grantTitle === 'string' ? cap(body.grantTitle, 300) : '';
  const t = body.turnstileToken;
  if (t != null && (typeof t !== 'string' || t.length > 2048)) throw new Invalid('turnstileToken');
  // Campaign tags are optional and never block a request: bad values are dropped.
  const a = body.attribution && typeof body.attribution === 'object' ? body.attribution as Record<string, unknown> : {};
  const attribution = { source: tag(a.source), campaign: tag(a.campaign), medium: tag(a.medium) };
  if (!attribution.source) { attribution.campaign = null; attribution.medium = null; }
  return { grantId, grantTitle, name, email, phone, company, message, turnstileToken: (t as string) || '', match: cleanMatch(body.match), attribution };
}

export function clientIp(req: Request): string | null {
  // Prefer headers the platform sets itself; the first X-Forwarded-For entry
  // is client-controlled when a proxy appends. Anything that doesn't look like
  // an IP is treated as "unknown" (a shared bucket), never as "no limit".
  const xff = req.headers.get('x-forwarded-for');
  const ip = (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? (xff ? xff.split(',')[0] : '')).trim();
  if (!IP_RE.test(ip)) return null;
  // IPv6: one subscriber usually owns a whole /64, so rate-limit per /64 prefix.
  if (ip.includes(':')) return ipv6Prefix64(ip);
  return ip;
}

export function randomRef(): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', b = crypto.getRandomValues(new Uint8Array(6));
  return 'L-' + [...b].map((x) => A[x % 32]).join('');
}

export function ipv6Prefix64(ip: string): string {
  const [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const full = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => (x || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

async function verifyTurnstile(secret: string, token: string, ip: string | null, doFetch: typeof fetch): Promise<boolean> {
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    const r = await doFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: form, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false;
    const j = await r.json();
    // the token must come from our own site (a key reused elsewhere is rejected)
    return j?.success === true && (!j.hostname || /(^|\.)aipalyazo\.hu$/.test(String(j.hostname)));
  } catch (e) {
    console.error('[lead-submit] turnstile unreachable', String(e).slice(0, 120));
    return false; // fail closed
  }
}

export async function handler(req: Request, deps: Deps = {}): Promise<Response> {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, cors);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const env = makeEnv(deps.env);
  const doFetch = deps.fetch ?? fetch;
  const now = (deps.now ?? (() => new Date()))();

  const body = await readJsonObject(req, 64 * 1024);
  if (!body) return reply({ error: 'invalid', field: 'body' }, 400);
  let v: Clean;
  try { v = validate(body); } catch (e) {
    if (e instanceof Invalid) return reply({ error: 'invalid', field: e.field }, 400);
    throw e;
  }

  const ip = clientIp(req);
  const turnstileSecret = env('TURNSTILE_SECRET');
  if (turnstileSecret && !(await verifyTurnstile(turnstileSecret, v.turnstileToken, ip, doFetch))) {
    return reply({ error: 'captcha_failed' }, 403);
  }

  try {
    let admin: any = null;
    const getAdmin = () => admin ??= createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const store = deps.store ?? supabaseLeadStore(getAdmin());

    const day = new Date(now.getTime() - 24 * 3600e3).toISOString();
    const hour = new Date(now.getTime() - 3600e3).toISOString();
    const ipHash = await sha256Hex(`${ip ?? 'unknown'}|${env('LEAD_SALT') || env('SUPABASE_SERVICE_ROLE_KEY') || 'nosalt'}`);
    if ((await store.countByIp(ipHash, hour)) >= LIMITS.perIp1h) return reply({ error: 'rate_limited' }, 429);
    const globalCap = parseInt(env('LEAD_GLOBAL_HOURLY_CAP') ?? '', 10) > 0 ? parseInt(env('LEAD_GLOBAL_HOURLY_CAP')!, 10) : LIMITS.global1h;
    if ((await store.countSince(hour)) >= globalCap) {
      console.error('[lead-submit] global hourly cap reached — possible flood');
      return reply({ error: 'rate_limited' }, 429);
    }

    // Optional signed-in user. The browser sends the anon key when signed out,
    // which simply doesn't resolve to a user.
    let userId: string | null = null;
    const jwt = bearer(req);
    if (jwt) {
      const getUserId = deps.getUserId ?? (async (t: string) => {
        const { data } = await getAdmin().auth.getUser(t);
        return data?.user?.id ?? null;
      });
      try { userId = await getUserId(jwt); } catch { userId = null; }
    }

    // Duplicate (same e-mail + call within 24 h): nothing new is stored or sent.
    // The ref is only echoed to the signed-in owner, so knowing someone's
    // e-mail doesn't reveal which calls they asked about.
    const dup = await store.findDuplicate(v.email, v.grantId, day);
    // Same answer shape for everyone, so the reply doesn't reveal who asked about what;
    // the signed-in owner of the earlier request still gets its reference.
    if (dup) {
      if (userId && dup.user_id === userId) return reply({ ok: true, ref: dup.lead_ref, duplicate: true });
      // Strangers get a reply indistinguishable from a fresh request (a random,
      // unused reference), so the form can't be used to probe who asked about what.
      return reply({ ok: true, ref: randomRef() });
    }
    if ((await store.countByEmail(v.email, day)) >= LIMITS.perEmail24h) return reply({ error: 'rate_limited' }, 429);

    // Official grant data from the feed; the client title is only a fallback.
    const grants = deps.grants ?? createGrantFeed({ url: env('GRANTS_URL') || undefined, fetch: doFetch });
    let grant = null;
    try { grant = await grants.byId(v.grantId); } catch (e) { console.warn('[lead-submit] grant feed unavailable', String(e).slice(0, 120)); }
    const snapshot: MatchSnapshot = { ...v.match };
    let title: string | null;
    if (grant) {
      title = cap(grant.title, 300);
      snapshot.grant = { code: grant.code ? cap(grant.code, 80) : null, deadline: grant.deadline ? cap(grant.deadline, 40) : null, url: grant.url ? cap(grant.url, 500) : null, fromFeed: true };
    } else {
      title = v.grantTitle || null;
      snapshot.grant = { fromFeed: false };
      snapshot.titleFromClient = true;
    }

    const lead = await store.insert({
      user_id: userId, grant_id: v.grantId, grant_title: title, name: v.name, email: v.email,
      phone: v.phone, company: v.company, message: v.message, match_snapshot: snapshot, ip_hash: ipHash,
      utm_source: v.attribution.source, utm_campaign: v.attribution.campaign, utm_medium: v.attribution.medium,
    });

    const mailer = deps.mailer ?? resendMailer(env('RESEND_API_KEY') ?? '', doFetch);
    const hasMail = !!deps.mailer || !!env('RESEND_API_KEY');
    if (!hasMail) {
      console.error('[lead-submit] RESEND_API_KEY not set — lead stored, no e-mail sent', lead.lead_ref);
    } else {
      await notifyOperator(lead, {
        store, mailer, recipients: parseRecipients(env('LEAD_NOTIFY_TO') || 'info@aipalyazo.hu'),
        statusSecret: env('LEAD_STATUS_SECRET'),
      });
      try {
        const m = requesterEmail(lead, env('PARTNER_NAME') || PARTNER_NAME_DEFAULT);
        await mailer({ to: [lead.email], ...m, idempotencyKey: `lead-${lead.id}-confirm` });
      } catch (e) {
        console.error('[lead-submit] confirmation e-mail failed', lead.lead_ref, String(e).slice(0, 160));
      }
    }
    return reply({ ok: true, ref: lead.lead_ref });
  } catch (e) {
    console.error('[lead-submit] server error', String(e).slice(0, 300));
    return reply({ error: 'server' }, 500);
  }
}

if (import.meta.main) Deno.serve((req) => handler(req));
