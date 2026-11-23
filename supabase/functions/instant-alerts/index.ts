// =========================================================================
// AIpályázó — instant-alerts Edge Function (opt-in, daily)
// =========================================================================
// Called by the daily GitHub job right after the feed is rebuilt, with the
// new feed and its change list in the body (no race with site deploys):
//   POST { grants: [...grants_live.json], changes: [...grants-meta.changes] }
//   header x-cron-secret: <CRON_SECRET>
// For every user with notif_prefs.instant_enabled = true:
//   • NEW calls the company is eligible for (same matcher as the portal, score ≥75 = "Érdemes pályázni")
//   • SAVED calls whose official budget just passed 80% committed
// One e-mail per user per day at most; alert_log prevents repeats.
//
// Deploy: supabase functions deploy instant-alerts --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// Secrets: RESEND_API_KEY, CRON_SECRET (already set for weekly-digest).
// =========================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/hu-favoured.js';
import '../_shared/match.js';
import { timingSafeEqual } from '../_shared/lead-token.ts';
const AIPMatch = (globalThis as any).AIPMatch;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const PORTAL = 'https://aipalyazo.hu/aipalyazo/portal.html';
const UNSUB_PAGE = 'https://aipalyazo.hu/aipalyazo/leiratkozas.html';
const UNSUB_API = `${SUPABASE_URL}/functions/v1/unsubscribe`;
const FROM = 'AIpályázó <noreply@aipalyazo.hu>';
const MIN_SCORE = 75; // = the portal's "Érdemes pályázni" verdict — instant mails must be strong fits only

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const ft = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} Mrd Ft` : `${Math.round(n / 1e6)} M Ft`;

// Calls whose committed share crossed 80% in this run.
export function budgetCrossings(grants: any[], changes: any[]) {
  const byId = new Map(grants.map((g) => [g.id, g]));
  const out: any[] = [];
  for (const c of changes || []) {
    if (c.type !== 'szabad-keret') continue;
    const g = byId.get(c.id);
    if (!g || !(g.keret > 0)) continue;
    const before = 1 - Number(c.from) / g.keret, after = 1 - Number(c.to) / g.keret;
    if (before < 0.8 && after >= 0.8) out.push(g);
  }
  return out;
}

function row(g: any, extra: string) {
  return `<tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
    <a href="${PORTAL}?grant=${encodeURIComponent(g.id)}" style="font-size:14px;font-weight:700;color:#111827;text-decoration:none;">${esc(g.title)}</a>
    <div style="font-size:12px;color:#15803d;margin-top:2px;">${esc(extra)}</div>
    <div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(g.amount)} · határidő: ${esc(g.deadline)}</div></td></tr>`;
}

function emailHtml(name: string, fresh: any[], budget: any[], token: string) {
  const unsub = `${UNSUB_PAGE}?t=${encodeURIComponent(token)}&k=instant`;
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;padding:28px 16px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;"><tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;border:1px solid #dcfce7;">
    <tr><td style="background:#15803d;padding:18px 28px;"><span style="font-size:20px;font-weight:800;color:#fff;">AI<span style="color:#bbf7d0;">pályázó</span></span></td></tr>
    <tr><td style="padding:26px 28px;">
      <p style="margin:0 0 14px;font-size:14px;color:#374151;">${name ? `Tisztelt ${esc(name)}!` : 'Tisztelt Felhasználónk!'}</p>
      ${fresh.length ? `<h2 style="margin:0 0 6px;font-size:17px;color:#111827;">Új felhívás, amelyre cége jogosult lehet</h2><table width="100%" cellpadding="0" cellspacing="0">${fresh.map((x) => row(x.g, x.why)).join('')}</table>` : ''}
      ${budget.length ? `<h2 style="margin:20px 0 6px;font-size:17px;color:#b45309;">Fogy a keret egy mentett felhívásnál</h2><table width="100%" cellpadding="0" cellspacing="0">${budget.map((g) => row(g, `A keret több mint 80%-át már lekötötték — szabad: ${ft(g.remaining)}.`)).join('')}</table>` : ''}
      <div style="margin-top:22px;"><a href="${PORTAL}" style="display:inline-block;background:#15803d;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 24px;border-radius:10px;">Megnyitás a portálon</a></div>
    </td></tr>
    <tr><td style="padding:14px 28px;background:#f9fafb;border-top:1px solid #f3f4f6;font-size:12px;color:#6b7280;line-height:1.6;">
      Ezt az értesítést azért kapja, mert bekapcsolta az azonnali értesítéseket. · <a href="${unsub}" style="color:#15803d;">Azonnali értesítések kikapcsolása</a>
    </td></tr></table></td></tr></table>`;
}

// One Resend batch call sends up to 100 e-mails (rate limit: 2 calls/s), so a
// page of PAGE users = 1 batch call + 3 database queries, whatever the size.
const PAGE_MAX = 100;
type Mail = { to: string; subject: string; html: string; token: string };
async function resendBatch(mails: Mail[]) {
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(mails.map((m) => ({ from: FROM, to: [m.to], subject: m.subject, html: m.html, headers: { 'List-Unsubscribe': `<${UNSUB_API}?t=${m.token}&kind=instant>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }))),
  });
  if (!r.ok) throw new Error(`resend ${r.status}`);
}

// Paged: the caller (daily GitHub job) repeats the call with `offset = next`
// until `next` is null, so 10 or 10 000 opted-in users both finish well
// inside the edge-function time limit.
export async function handler(req: Request, deps: { admin?: any; sendBatch?: (mails: Mail[]) => Promise<void>; today?: string } = {}) {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!CRON_SECRET || !timingSafeEqual(req.headers.get('x-cron-secret') ?? '', CRON_SECRET)) return new Response('forbidden', { status: 403 });
  let body: any;
  try { body = await req.json(); } catch { return new Response('bad_json', { status: 400 }); }
  const grants: any[] = Array.isArray(body?.grants) ? body.grants : [];
  const changes: any[] = Array.isArray(body?.changes) ? body.changes : [];
  const offset = Math.max(0, Math.floor(Number(body?.offset) || 0));
  const page = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(body?.limit) || PAGE_MAX)));
  const today = deps.today || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  const newIds = new Set(changes.filter((c) => c.type === 'new').map((c) => c.id));
  // Safety: a first run / rebuilt feed marks everything "new" — never mail that.
  const bootstrap = newIds.size > 40;
  const fresh = bootstrap ? [] : grants.filter((g) => newIds.has(g.id));
  const crossed = budgetCrossings(grants, changes);
  if (!fresh.length && !crossed.length) return Response.json({ ok: true, sent: 0, next: null, reason: bootstrap ? 'bootstrap (too many new)' : 'nothing new' });

  const admin = deps.admin || createClient(SUPABASE_URL, SERVICE_ROLE);
  const sendBatch = deps.sendBatch || resendBatch;

  const { data: users, error } = await admin.from('notif_prefs')
    .select('user_id, unsubscribe_token, recipient_email, profiles(email, display_name, company, industry, industries, categories, employees, site_region, years_operating, public_debt_free, in_difficulty, own_funds, teaor, revenue, rnd, women_led, tax_regime, group_member, public_owner, de_minimis, insolvency, location, legal_form)')
    .eq('instant_enabled', true)
    .order('user_id')
    .range(offset, offset + page - 1);
  if (error) return Response.json({ error: 'query_failed' }, { status: 500 });
  const list: any[] = users || [];
  const next = list.length === page ? offset + page : null;
  const ids = list.map((u) => u.user_id);

  // per-user matches (pure CPU, no I/O)
  const crossedIds = crossed.map((g) => g.id);
  const plans = list.map((u) => {
    const p = u.profiles;
    const to = u.recipient_email || (p && p.email);
    if (!p || !to || !u.unsubscribe_token) return null;
    const matches = fresh.map((g) => ({ g, m: AIPMatch.match(g, p, today) }))
      .filter((x) => x.m.eligible && x.m.personal && x.m.score >= MIN_SCORE)
      .map((x) => ({ g: x.g, why: (x.m.checks.find((c: any) => c.key === 'sector' && c.status === 'ok') || {}).reason || 'Illeszkedik a cégprofiljához.' }));
    return { u, p, to, matches };
  });

  // bookmarks + alert_log for the whole page in two queries
  const saved = new Map<string, Set<string>>();
  if (crossedIds.length && ids.length) {
    const { data: bm } = await admin.from('bookmarks').select('user_id, grant_id').in('user_id', ids).in('grant_id', crossedIds);
    for (const b of bm || []) { if (!saved.has(b.user_id)) saved.set(b.user_id, new Set()); saved.get(b.user_id)!.add(b.grant_id); }
  }
  const allIds = [...new Set([...fresh.map((g) => g.id), ...crossedIds])];
  const done = new Set<string>();
  if (ids.length && allIds.length) {
    const { data: logged } = await admin.from('alert_log').select('user_id, grant_id, kind').in('user_id', ids).in('grant_id', allIds);
    for (const l of logged || []) done.add(`${l.user_id}|${l.grant_id}|${l.kind}`);
  }

  let skipped = 0;
  const mails: Mail[] = [];
  const logs: any[] = [];
  for (const plan of plans) {
    if (!plan) { skipped++; continue; }
    const { u, p, to, matches } = plan;
    const mine = saved.get(u.user_id);
    const budget = mine ? crossed.filter((g) => mine.has(g.id)) : [];
    const newM = matches.filter((x) => !done.has(`${u.user_id}|${x.g.id}|new`)).slice(0, 8); // never twice
    const newB = budget.filter((g) => !done.has(`${u.user_id}|${g.id}|budget`));
    if (!newM.length && !newB.length) { skipped++; continue; }
    const subject = newM.length ? `Új, Önnek megfelelő pályázat: ${newM[0].g.title.slice(0, 60)}${newM.length > 1 ? ` (+${newM.length - 1})` : ''}` : 'Fogy a keret egy mentett pályázatnál';
    mails.push({ to, subject, html: emailHtml(p.display_name, newM, newB, u.unsubscribe_token), token: u.unsubscribe_token });
    logs.push(...newM.map((x) => ({ user_id: u.user_id, grant_id: x.g.id, kind: 'new' })), ...newB.map((g) => ({ user_id: u.user_id, grant_id: g.id, kind: 'budget' })));
  }

  let sent = 0, failed = 0;
  if (mails.length) {
    try {
      await sendBatch(mails);
      // logged only after a successful send: a failed page is retried tomorrow
      const { error: logErr } = await admin.from('alert_log').insert(logs);
      if (logErr) console.error('alert_log insert failed', String(logErr.message).slice(0, 120));
      sent = mails.length;
    } catch (e) {
      console.error('instant alert batch failed', String(e).slice(0, 120));
      failed = mails.length;
    }
  }
  return Response.json({ ok: true, sent, skipped, failed, next, newCalls: fresh.length, budgetCrossings: crossed.length });
}

if (import.meta.main) Deno.serve((req) => handler(req));
