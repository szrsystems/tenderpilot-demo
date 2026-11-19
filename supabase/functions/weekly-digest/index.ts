// =========================================================================
// AIpályázó — weekly-digest Edge Function
// =========================================================================
// For every user who has the weekly e-mail report enabled AND a filled-in
// cégprofil, this matches the live grant list to their profile and sends a
// personalised Hungarian summary via Resend (from noreply@aipalyazo.hu).
//
// Triggered by a GitHub Actions cron (weekly). Protected by a shared secret:
// the caller must send  x-cron-secret: <CRON_SECRET>.
//
// Deploy:
//   supabase functions deploy weekly-digest --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// Secrets:
//   supabase secrets set RESEND_API_KEY=re_xxx --project-ref kacnvchwfwvpkkyhyupb
//   supabase secrets set CRON_SECRET=<random>  --project-ref kacnvchwfwvpkkyhyupb
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// =========================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';
// Same point-by-point matcher as the portal (byte-identical copy, test-enforced).
import '../_shared/match.js';
import { timingSafeEqual } from '../_shared/lead-token.ts';
const AIPMatch = (globalThis as any).AIPMatch;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
// The live daily feed — NOT grants.json (the old 300-item demo bundle).
const GRANTS_URL = 'https://aipalyazo.hu/aipalyazo/grants_live.json';
const UNSUB_PAGE = 'https://aipalyazo.hu/aipalyazo/leiratkozas.html';
const UNSUB_API = `${SUPABASE_URL}/functions/v1/unsubscribe`;
const PORTAL_URL = 'https://aipalyazo.hu/aipalyazo/portal.html';
const FROM = 'AIpályázó <noreply@aipalyazo.hu>';

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// Recompute score + days exactly like the portal does on load.
function prepGrants(raw: any[]) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out: any[] = [];
  for (const g of raw) {
    let days = 90, expired = false;
    // "Folyamatos" = rolling product (loan, open-ended programme): no deadline.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(g.deadline || ''))) days = 365;
    else try {
      const dl = new Date(g.deadline); dl.setHours(0, 0, 0, 0);
      const delta = Math.ceil((dl.getTime() - today.getTime()) / 86400000);
      expired = delta < 0; days = Math.max(0, delta);
    } catch { /* keep defaults */ }
    if (expired) continue;
    const f = g.factors || {};
    const dF = days <= 7 ? 35 : days <= 14 ? 50 : days <= 30 ? 65 : days <= 60 ? 80 : days <= 120 ? 90 : 95;
    const score = Math.round((((f.size || 0) * 25 + (f.industry || 0) * 25 + (f.location || 0) * 20 + dF * 15 + (f.preference || 0) * 15) / 100) * 10) / 10;
    out.push({ ...g, days, score });
  }
  return out;
}

function grantRow(g: any) {
  const urgent = g.days <= 14;
  return `<tr>
    <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
      <div style="font-size:14px;font-weight:700;color:#111827;">${esc(g.title)}</div>
      ${g.why ? `<div style="font-size:12px;color:#15803d;margin-top:2px;">${esc(g.why)}</div>` : ''}
      <div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(g.cat)} · ${esc(g.amount)} · határidő: ${esc(g.deadline)}${g.days >= 365 && !/^\d/.test(String(g.deadline)) ? '' : ` <span style="color:${urgent ? '#dc2626' : '#9ca3af'};">(${g.days} nap)</span>`}</div>
    </td>
    <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;text-align:right;white-space:nowrap;vertical-align:top;">
      <span style="display:inline-block;background:#f0fdf4;color:#15803d;font-weight:800;font-size:13px;padding:3px 9px;border-radius:10px;">${g.score}</span>
    </td>
  </tr>`;
}

function emailHtml(name: string, top: any[], urgent: any[], token: string) {
  const greet = name ? `Tisztelt ${esc(name)}!` : 'Tisztelt Felhasználónk!';
  const unsubUrl = `${UNSUB_PAGE}?t=${encodeURIComponent(token)}`;
  const urgentBlock = urgent.length
    ? `<div style="margin:24px 0 8px;font-size:13px;font-weight:800;color:#b91c1c;text-transform:uppercase;letter-spacing:.4px;">⏰ Sürgős határidők (14 napon belül)</div>
       <table width="100%" cellpadding="0" cellspacing="0" border="0">${urgent.map(grantRow).join('')}</table>`
    : '';
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0fdf4;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:14px;border:1px solid #dcfce7;overflow:hidden;">
      <tr><td style="background-color:#16a34a;padding:22px 32px;">
        <span style="font-size:21px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">AI<span style="color:#bbf7d0;">pályázó</span></span>
      </td></tr>
      <tr><td style="padding:32px;">
        <h1 style="margin:0 0 6px;font-size:20px;line-height:1.3;color:#111827;">Heti pályázati összefoglaló</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4b5563;">${greet} A cégprofilja alapján ezek a legjobban illeszkedő, aktuális pályázatok:</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${top.map(grantRow).join('')}</table>
        ${urgentBlock}
        <div style="margin-top:26px;text-align:center;">
          <a href="${PORTAL_URL}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 28px;border-radius:10px;">Összes pályázat megnyitása</a>
        </div>
      </td></tr>
      <tr><td style="padding:18px 32px;background-color:#f9fafb;border-top:1px solid #f3f4f6;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
          Ezt az összefoglalót azért kapja, mert feliratkozott az AIpályázó heti e-mail jelentésére. ·
          <a href="${unsubUrl}" style="color:#16a34a;">Leiratkozás egy kattintással</a> ·
          <a href="https://aipalyazo.hu/aipalyazo/adatvedelem.html" style="color:#16a34a;">Adatkezelés</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

type Mail = { to: string; subject: string; html: string; token: string };
// One Resend batch call = up to 100 e-mails (Resend allows 2 calls/s).
async function resendBatch(mails: Mail[]) {
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(mails.map((m) => ({
      from: FROM, to: [m.to], subject: m.subject, html: m.html,
      // RFC 8058 one-click unsubscribe: Gmail / Outlook show a native
      // "Leiratkozás" button that POSTs to UNSUB_API. Required by Gmail and
      // Yahoo for bulk senders since 2024.
      headers: {
        'List-Unsubscribe': `<${UNSUB_API}?t=${m.token}>, <mailto:info@aipalyazo.hu?subject=Leiratkozas>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }))),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`resend ${r.status} ${t.slice(0, 200)}`); }
}

const PAGE_MAX = 100;
// Paged: POST { offset } → { next }. The weekly GitHub job repeats the call
// with offset = next until next is null. notif_prefs.last_digest_at makes a
// re-run of the same week skip users who already got their e-mail.
export async function handler(req: Request, deps: { admin?: any; sendBatch?: (m: Mail[]) => Promise<void>; grants?: any[]; now?: Date } = {}) {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!CRON_SECRET || !timingSafeEqual(req.headers.get('x-cron-secret') ?? '', CRON_SECRET)) {
    return new Response('forbidden', { status: 403 });
  }
  if (!RESEND_API_KEY && !deps.sendBatch) return new Response(JSON.stringify({ error: 'email_not_configured' }), { status: 503 });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body = first page */ }
  const offset = Math.max(0, Math.floor(Number(body?.offset) || 0));
  const page = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(body?.limit) || PAGE_MAX)));

  // 1) Live grant list.
  let grants: any[];
  try {
    grants = deps.grants ?? prepGrants(await (await fetch(GRANTS_URL, { cache: 'no-store' })).json());
  } catch (e) {
    return new Response(JSON.stringify({ error: 'grants_fetch_failed', detail: String(e) }), { status: 502 });
  }

  // 2) One page of opted-in users.
  const admin = deps.admin || createClient(SUPABASE_URL, SERVICE_ROLE);
  const sendBatch = deps.sendBatch || resendBatch;
  const { data: rows, error } = await admin
    .from('notif_prefs')
    .select('user_id, urgent_enabled, frequency, section_deadlines, unsubscribe_token, recipient_email, section_top_n, last_digest_at, profiles(email, display_name, company, industry, industries, categories, employees, site_region, years_operating, public_debt_free, in_difficulty, own_funds, teaor, revenue, rnd, women_led)')
    .eq('weekly_enabled', true)
    .order('user_id')
    .range(offset, offset + page - 1);
  if (error) return new Response(JSON.stringify({ error: 'query_failed', detail: error.message }), { status: 500 });
  const list: any[] = rows ?? [];
  const next = list.length === page ? offset + page : null;

  // Frequency: 'heti' every run; 'kétheti' on even ISO weeks; 'havi' only in
  // the first run of the month (the cron fires once a week).
  const now = deps.now ?? new Date();
  const isoWeek = (() => {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - y0.getTime()) / 86400000 + 1) / 7);
  })();
  const dueThisWeek = (f: string | null) =>
    f === 'kétheti' ? isoWeek % 2 === 0 : f === 'havi' ? now.getDate() <= 7 : true;
  const todayIso = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  const recent = now.getTime() - 3 * 86400000; // sent in this run already → skip on re-run

  let skipped = 0;
  const mails: Mail[] = [];
  const sentIds: string[] = [];
  for (const row of list) {
    if (!dueThisWeek(row.frequency)) { skipped++; continue; }
    if (row.last_digest_at && Date.parse(row.last_digest_at) > recent) { skipped++; continue; }
    const token = row.unsubscribe_token;
    if (!token) { skipped++; continue; } // never send without a working unsubscribe link
    const p: any = row.profiles;
    if (!p || !p.company || !String(p.company).trim()) { skipped++; continue; } // no profile → no personalised digest
    const to = row.recipient_email || p.email;
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { skipped++; continue; }

    // Only calls the company is eligible for, best fit first.
    const ranked = grants
      .map((g) => { const m = AIPMatch.match(g, p, todayIso); return { g: { ...g, score: m.score, why: (m.checks.find((c: any) => c.key === 'sector' && c.status === 'ok') || {}).reason || '' }, s: m.score, ok: m.eligible }; })
      .filter((x) => x.ok && x.s >= 60)
      .sort((a, b) => b.s - a.s || a.g.days - b.g.days);
    if (!ranked.length) { skipped++; continue; }

    const topN = Math.min(Math.max(row.section_top_n || 5, 3), 8);
    const top = ranked.slice(0, topN).map((x) => x.g);
    const urgent = (row.urgent_enabled && row.section_deadlines !== false)
      ? ranked.map((x) => x.g).filter((g) => g.days > 0 && g.days <= 14).slice(0, 5)
      : [];
    mails.push({ to, subject: 'Heti pályázati összefoglaló — AIpályázó', html: emailHtml(p.display_name, top, urgent, token), token });
    sentIds.push(row.user_id);
  }

  let sent = 0;
  const errors: string[] = [];
  if (mails.length) {
    try {
      await sendBatch(mails);
      sent = mails.length;
      const { error: upErr } = await admin.from('notif_prefs').update({ last_digest_at: now.toISOString() }).in('user_id', sentIds);
      if (upErr) console.error('last_digest_at update failed', String(upErr.message).slice(0, 120));
    } catch (e) {
      // Log the detail server-side only; the response goes to a CI log.
      console.error('digest batch failed', String(e).slice(0, 200));
      errors.push(`page ${offset}: send failed (${mails.length})`);
    }
  }

  return new Response(JSON.stringify({ ok: !errors.length, sent, skipped, errors, next }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

if (import.meta.main) Deno.serve((req) => handler(req));
