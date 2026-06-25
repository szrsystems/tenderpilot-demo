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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const GRANTS_URL = 'https://aipalyazo.hu/aipalyazo/grants.json';
const PORTAL_URL = 'https://aipalyazo.hu/aipalyazo/portal.html';
const FROM = 'AIpályázó <noreply@aipalyazo.hu>';

// Mirror of portal.html INDUSTRY_KEYWORDS.
const INDUSTRY_KEYWORDS: Record<string, RegExp> = {
  IT: /digit|innov|kutat|szoftver|informatik|adat/i,
  HVAC: /energi|épít|hvac|gépész|fűt/i,
  Construction: /épít|kapacit|telephely|infrastruktúr/i,
  Manufacturing: /gyárt|kapacit|innov|ipar|eszközbe|gépbe/i,
  Healthcare: /egészség|innov|orvos/i,
  Restaurant: /vendég|turiz|étterm|gasztron/i,
  Tourism: /turiz|szálláshely|vendég/i,
  Agriculture: /mező|agrár|gazda|leader|élelmiszer/i,
  Retail: /kkv|kapacit|kereskede/i,
  Education: /oktat|képz/i,
  General: /kkv/i,
};

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// Recompute score + days exactly like the portal does on load.
function prepGrants(raw: any[]) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out: any[] = [];
  for (const g of raw) {
    let days = 90, expired = false;
    try {
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

function boost(g: any, categories: string[], industry: string | null) {
  let b = 0;
  if (Array.isArray(categories) && categories.includes(g.cat)) b += 12;
  if (industry && INDUSTRY_KEYWORDS[industry] && INDUSTRY_KEYWORDS[industry].test((g.cat || '') + ' ' + (g.title || ''))) b += 8;
  return b;
}

function grantRow(g: any) {
  const urgent = g.days <= 14;
  return `<tr>
    <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
      <div style="font-size:14px;font-weight:700;color:#111827;">${esc(g.title)}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(g.cat)} · ${esc(g.amount)} · határidő: ${esc(g.deadline)} <span style="color:${urgent ? '#dc2626' : '#9ca3af'};">(${g.days} nap)</span></div>
    </td>
    <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;text-align:right;white-space:nowrap;vertical-align:top;">
      <span style="display:inline-block;background:#f0fdf4;color:#15803d;font-weight:800;font-size:13px;padding:3px 9px;border-radius:10px;">${g.score}</span>
    </td>
  </tr>`;
}

function emailHtml(name: string, top: any[], urgent: any[]) {
  const greet = name ? esc(name) : 'Üdvözöljük';
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
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4b5563;">Szia ${greet}! A cégprofilja alapján ezek a legjobban illeszkedő, aktuális pályázatok:</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${top.map(grantRow).join('')}</table>
        ${urgentBlock}
        <div style="margin-top:26px;text-align:center;">
          <a href="${PORTAL_URL}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 28px;border-radius:10px;">Összes pályázat megnyitása</a>
        </div>
      </td></tr>
      <tr><td style="padding:18px 32px;background-color:#f9fafb;border-top:1px solid #f3f4f6;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
          Ezt a heti összefoglalót azért kapja, mert bekapcsolta a Beállítások → Heti e-mail jelentést. Kikapcsolni a portál Beállítások menüjében tud. ·
          <a href="https://aipalyazo.hu/aipalyazo/adatvedelem.html" style="color:#16a34a;">Adatkezelés</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

async function sendEmail(to: string, subject: string, html: string) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`resend ${r.status} ${t}`); }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  if (!RESEND_API_KEY) return new Response(JSON.stringify({ error: 'email_not_configured' }), { status: 503 });

  // 1) Live grant list.
  let grants: any[];
  try {
    const gr = await fetch(GRANTS_URL, { cache: 'no-store' });
    grants = prepGrants(await gr.json());
  } catch (e) {
    return new Response(JSON.stringify({ error: 'grants_fetch_failed', detail: String(e) }), { status: 502 });
  }

  // 2) Opted-in users with a real profile.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: rows, error } = await admin
    .from('notif_prefs')
    .select('user_id, urgent_enabled, recipient_email, section_top_n, profiles(email, display_name, company, industry, categories)')
    .eq('weekly_enabled', true);
  if (error) return new Response(JSON.stringify({ error: 'query_failed', detail: error.message }), { status: 500 });

  let sent = 0, skipped = 0;
  const errors: string[] = [];
  for (const row of (rows ?? [])) {
    const p: any = (row as any).profiles;
    if (!p || !p.company || !String(p.company).trim()) { skipped++; continue; } // no profile → no personalised digest
    const to = (row as any).recipient_email || p.email;
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { skipped++; continue; }

    const cats: string[] = Array.isArray(p.categories) ? p.categories : [];
    const ranked = grants
      .map((g) => ({ g, s: g.score + boost(g, cats, p.industry) }))
      .filter((x) => x.s >= 55)
      .sort((a, b) => b.s - a.s || a.g.days - b.g.days);
    if (!ranked.length) { skipped++; continue; }

    const topN = Math.min(Math.max((row as any).section_top_n || 5, 3), 8);
    const top = ranked.slice(0, topN).map((x) => x.g);
    const urgent = (row as any).urgent_enabled
      ? ranked.map((x) => x.g).filter((g) => g.days > 0 && g.days <= 14).slice(0, 5)
      : [];

    try {
      await sendEmail(to, 'Heti pályázati összefoglaló — AIpályázó', emailHtml(p.display_name, top, urgent));
      sent++;
    } catch (e) { errors.push(`${to}: ${String(e).slice(0, 120)}`); }
  }

  return new Response(JSON.stringify({ ok: true, sent, skipped, errors }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
