// =========================================================================
// AIpályázó — lead-digest Edge Function (daily cron)
// =========================================================================
// Called daily 07:10 UTC by .github/workflows/lead-digest.yml with
// header x-cron-secret: <CRON_SECRET>.
//   (a) retries the partner notification for leads with notified_at IS NULL
//       and notify_attempts < 5 (same at-most-once claim as lead-submit);
//   (b) on Mondays (Budapest time) — or when the body is {"weekly": true} —
//       sends LEAD_NOTIFY_TO a table of the last 7 days' leads plus every lead
//       the partner received more than 2 working days ago and still hasn't
//       reported on (status new/sent), flagged, with the status links again;
//   (c) purges deleted_emails hashes older than 180 days.
//
// Deploy:  supabase functions deploy lead-digest --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// Secrets: CRON_SECRET, RESEND_API_KEY, LEAD_NOTIFY_TO, LEAD_STATUS_SECRET
// =========================================================================
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { budapestDate, budapestDateTime, esc, jsonResponse, makeEnv } from '../_shared/http.ts';
import { type LeadRow, type LeadStore, supabaseLeadStore } from '../_shared/lead-store.ts';
import { type Mailer, MAX_NOTIFY_ATTEMPTS, notifyOperator, parseRecipients, resendMailer, statusLinks } from '../_shared/lead-mail.ts';
import { STATUS_LABELS, timingSafeEqual as timingSafeEqualStr } from '../_shared/lead-token.ts';

export type Deps = {
  env?: Record<string, string | undefined>;
  store?: LeadStore;
  mailer?: Mailer;
  purge?: () => Promise<number>;
  now?: () => Date;
};

const DAY = 86400e3;

/** Day of week (0 = Sunday) of a YYYY-MM-DD calendar date. */
const weekday = (ymd: string) => new Date(ymd + 'T12:00:00Z').getUTCDay();

/**
 * Mon–Fri days that passed after the Budapest calendar day of `from`, up to
 * and including the day of `to` (public holidays are not modelled).
 * Created Monday → Tuesday = 1, Wednesday = 2, Thursday = 3.
 */
export function workingDaysBetween(from: Date, to: Date): number {
  let d = new Date(budapestDate(from) + 'T12:00:00Z');
  const end = budapestDate(to);
  let n = 0;
  for (let guard = 0; guard < 4000; guard++) {
    d = new Date(d.getTime() + DAY);
    const ymd = d.toISOString().slice(0, 10);
    if (ymd > end) break;
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) n++;
  }
  return n;
}

export const OVERDUE_WORKING_DAYS = 2;

export function isOverdue(l: LeadRow, now: Date): boolean {
  return (l.status === 'new' || l.status === 'sent') && !!l.notified_at &&
    workingDaysBetween(new Date(l.notified_at), now) > OVERDUE_WORKING_DAYS;
}

async function weeklyHtml(recent: LeadRow[], overdue: LeadRow[], undelivered: LeadRow[], now: Date, statusSecret?: string) {
  const th = (t: string) => `<th align="left" style="padding:6px 8px;border-bottom:2px solid #e5e7eb;font-size:12px;color:#6b7280;">${esc(t)}</th>`;
  const td = (h: string, extra = '') => `<td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;vertical-align:top;${extra}">${h}</td>`;
  const overdueIds = new Set(overdue.map((l) => l.id));
  const who = (l: LeadRow) => `${esc(l.company || l.match_snapshot?.profile?.company || '—')}<br><span style="color:#6b7280;">${esc(l.name)} · ${esc(l.email)}${l.phone ? ' · ' + esc(l.phone) : ''}</span>`;
  const table = (rows: string) => `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>`;

  const recentRows = recent.map((l) => `<tr>${td(`<b>${esc(l.lead_ref)}</b>`)}${td(esc(budapestDateTime(new Date(l.created_at))))}${td(esc(l.grant_title || l.grant_id))}${td(who(l))}${td(esc(STATUS_LABELS[l.status] ?? l.status) + (overdueIds.has(l.id) ? ' <b style="color:#b91c1c;">⚠</b>' : '') + (l.notified_at ? '' : ' <span style="color:#b45309;">(nincs továbbítva)</span>'))}</tr>`).join('');

  const overdueRows: string[] = [];
  for (const l of overdue) {
    const links = await statusLinks(l.lead_ref, statusSecret);
    const days = workingDaysBetween(new Date(l.notified_at!), now);
    const actions = links
      ? [['contacted', 'Kapcsolat megvolt'], ['applied', 'Beadva'], ['won', 'Nyert'], ['lost', 'Nem valósult meg'], ['spam', 'Spam']]
        .map(([s, t]) => `<a href="${esc(links[s as keyof typeof links])}" style="color:#15803d;">${esc(t)}</a>`).join(' · ')
      : '';
    overdueRows.push(`<tr style="background:#fef2f2;">${td(`<b>${esc(l.lead_ref)}</b>`)}${td(`${days} munkanap`)}${td(esc(l.grant_title || l.grant_id))}${td(who(l))}${td(actions)}</tr>`);
  }
  const undeliveredRows = undelivered.map((l) => `<tr>${td(`<b>${esc(l.lead_ref)}</b>`)}${td(esc(budapestDateTime(new Date(l.created_at))))}${td(esc(l.grant_title || l.grant_id))}${td(who(l))}${td(esc(l.notify_error === 'legacy_pre_pipeline' ? 'régi rendszerből — kézzel továbbítandó' : (l.notify_error || '').slice(0, 120)))}</tr>`).join('');

  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:900px;color:#111827;">
<h2 style="margin:0 0 4px;font-size:18px;">Heti lead-összesítő</h2>
<p style="margin:0 0 18px;font-size:13px;color:#6b7280;">${esc(budapestDate(now))} · elmúlt 7 nap: ${recent.length} igény · visszajelzésre vár: ${overdue.length}</p>
<h3 style="margin:18px 0 6px;font-size:15px;color:#b91c1c;">⚠ Visszajelzésre vár (több mint ${OVERDUE_WORKING_DAYS} munkanapja továbbítva)</h3>
${overdue.length ? table(`<tr>${th('Hivatkozás')}${th('Eltelt')}${th('Felhívás')}${th('Igénylő')}${th('Státusz megadása')}</tr>${overdueRows.join('')}`) : '<p style="font-size:13px;color:#6b7280;">Nincs ilyen igény.</p>'}
<h3 style="margin:22px 0 6px;font-size:15px;">Az elmúlt 7 nap igényei</h3>
${recent.length ? table(`<tr>${th('Hivatkozás')}${th('Beérkezett')}${th('Felhívás')}${th('Igénylő')}${th('Státusz')}</tr>${recentRows}`) : '<p style="font-size:13px;color:#6b7280;">Nem érkezett új igény.</p>'}
${undelivered.length ? `<h3 style="margin:22px 0 6px;font-size:15px;color:#b45309;">Nem sikerült automatikusan továbbítani (elmúlt 30 nap)</h3>${table(`<tr>${th('Hivatkozás')}${th('Beérkezett')}${th('Felhívás')}${th('Igénylő')}${th('Hiba')}</tr>${undeliveredRows}`)}` : ''}
</div>`;
}

export async function handler(req: Request, deps: Deps = {}): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  const env = makeEnv(deps.env);
  const cronSecret = env('CRON_SECRET') ?? '';
  if (!cronSecret || !timingSafeEqualStr(req.headers.get('x-cron-secret') ?? '', cronSecret)) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  let body: any = {};
  try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch { return jsonResponse({ error: 'bad_json' }, 400); }

  const now = (deps.now ?? (() => new Date()))();
  let admin: any = null;
  const getAdmin = () => admin ??= createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const store = deps.store ?? supabaseLeadStore(getAdmin());
  const mailer = deps.mailer ?? resendMailer(env('RESEND_API_KEY') ?? '');
  const recipients = parseRecipients(env('LEAD_NOTIFY_TO'));
  const statusSecret = env('LEAD_STATUS_SECRET');
  const out: Record<string, unknown> = { ok: true };

  try {
    // (a) retries
    const retry = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
    if (recipients.length) {
      for (const lead of await store.listUnnotified(MAX_NOTIFY_ATTEMPTS, 50)) {
        retry.attempted++;
        const r = await notifyOperator(lead, { store, mailer, recipients, statusSecret });
        if (r === 'sent') retry.sent++; else if (r === 'failed') retry.failed++; else retry.skipped++;
      }
    }
    out.retry = recipients.length ? retry : 'no_recipients';

    // (b) weekly summary
    const weekly = body?.weekly === true || weekday(budapestDate(now)) === 1;
    if (weekly && recipients.length) {
      const recent = await store.listCreatedSince(new Date(now.getTime() - 7 * DAY).toISOString());
      const open = await store.listByStatus(['new', 'sent'], 500);
      const overdue = open.filter((l) => isOverdue(l, now));
      const cutoff = new Date(now.getTime() - 30 * DAY).toISOString();
      const undelivered = open.filter((l) => !l.notified_at && l.created_at >= cutoff && l.notify_attempts >= MAX_NOTIFY_ATTEMPTS);
      const html = await weeklyHtml(recent, overdue, undelivered, now, statusSecret);
      try {
        await mailer({
          to: recipients,
          subject: `[AIpályázó] Heti lead-összesítő — ${recent.length} új, ${overdue.length} visszajelzésre vár`,
          html,
          idempotencyKey: `lead-weekly-${budapestDate(now)}`,
        });
        out.weekly = { sent: true, recent: recent.length, overdue: overdue.length, undelivered: undelivered.length };
      } catch (e) {
        console.error('[lead-digest] weekly mail failed', String(e).slice(0, 200));
        out.weekly = { sent: false };
        out.ok = false;
      }
    } else {
      out.weekly = weekly ? 'no_recipients' : 'not_today';
    }
  } catch (e) {
    console.error('[lead-digest] failed', String(e).slice(0, 300));
    return jsonResponse({ ok: false, error: 'server' }, 500);
  }

  // (c) deleted_emails retention
  try {
    const purge = deps.purge ?? (async () => {
      const { data, error } = await getAdmin().rpc('purge_deleted_emails');
      if (error) throw new Error(error.message);
      return Number(data) || 0;
    });
    out.purged = await purge();
  } catch (e) {
    console.error('[lead-digest] purge_deleted_emails failed', String(e).slice(0, 200));
    out.purged = 'failed';
  }
  return jsonResponse(out, out.ok ? 200 : 502);
}

if (import.meta.main) Deno.serve((req) => handler(req));
