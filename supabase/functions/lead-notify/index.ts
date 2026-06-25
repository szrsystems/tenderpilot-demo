// =========================================================================
// AIpályázó — lead-notify Edge Function
// =========================================================================
// Sends a branded Hungarian confirmation e-mail to a user who requested a
// pályázatíró consultation. The portal calls this right after the lead row
// is inserted into public.leads.
//
// Anti-relay: it ONLY e-mails an address that already has a fresh lead row
// (last 15 min), so it can't be used to spam arbitrary addresses beyond the
// public lead form's own surface.
//
// Deploy:
//   supabase functions deploy lead-notify --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// Secret (set once — the Resend "aipalyazo email" key):
//   supabase secrets set RESEND_API_KEY=re_xxx --project-ref kacnvchwfwvpkkyhyupb
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// =========================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'AIpályázó <noreply@aipalyazo.hu>';

const ALLOWED_ORIGINS = [
  'https://szrsystems.github.io',
  'https://aipalyazo.hu',
  'https://www.aipalyazo.hu',
];
function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (origin: string | null, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });

function esc(s: string) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function emailHtml(grantTitle: string) {
  const t = grantTitle ? esc(grantTitle) : 'a kiválasztott pályázat';
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0fdf4;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background-color:#ffffff;border-radius:14px;border:1px solid #dcfce7;overflow:hidden;">
      <tr><td style="background-color:#16a34a;padding:22px 32px;">
        <span style="font-size:21px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">AI<span style="color:#bbf7d0;">pályázó</span></span>
      </td></tr>
      <tr><td style="padding:32px;">
        <h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;color:#111827;">Konzultáció-igénylését rögzítettük ✓</h1>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#4b5563;">
          Köszönjük! Rögzítettük a díjmentes előzetes konzultáció iránti igényét a következő pályázatra:
        </p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#111827;font-weight:700;border-left:3px solid #16a34a;padding-left:12px;">${t}</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#4b5563;">
          Pályázatíró partnerünk <b>2 munkanapon belül</b> felveszi Önnel a kapcsolatot, átnézi a jogosultságát, és megmondja, megéri-e elindulni — kötelezettség nélkül.
        </p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#9ca3af;">
          Addig is böngészhet a cégére szabott pályázati lehetőségek között:
          <a href="https://aipalyazo.hu/aipalyazo/portal.html" style="color:#16a34a;">aipalyazo.hu</a>
        </p>
      </td></tr>
      <tr><td style="padding:18px 32px;background-color:#f9fafb;border-top:1px solid #f3f4f6;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
          AIpályázó — AI-alapú pályázatfigyelés magyar KKV-knak ·
          <a href="https://aipalyazo.hu/aipalyazo/adatvedelem.html" style="color:#16a34a;">Adatkezelés</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json(origin, { error: 'method_not_allowed' }, 405);
  if (!RESEND_API_KEY) return json(origin, { error: 'email_not_configured' }, 503);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(origin, { error: 'bad_request' }, 400); }
  const email = String(body?.email ?? '').trim().toLowerCase();
  const grantTitle = String(body?.grantTitle ?? '').slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(origin, { error: 'invalid_email' }, 400);

  // Anti-relay: only send to an address that actually has a fresh lead row.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: rows, error: lookupErr } = await admin
    .from('leads').select('id').ilike('email', email).gte('created_at', since).limit(1);
  if (lookupErr) { console.error('[lead-notify] lookup error', lookupErr); return json(origin, { error: 'lookup_failed' }, 500); }
  if (!rows || rows.length === 0) return json(origin, { skipped: 'no_recent_lead' });

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: 'Konzultáció-igénylését rögzítettük — AIpályázó',
      html: emailHtml(grantTitle),
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.error('[lead-notify] resend error', r.status, txt);
    return json(origin, { error: 'send_failed' }, 502);
  }
  return json(origin, { sent: true });
});
