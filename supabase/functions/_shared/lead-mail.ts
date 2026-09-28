// E-mails of the lead pipeline: the partner notification (operator + grant
// writers) and the requester's confirmation. Everything user-supplied is
// HTML-escaped; only http(s) links from the official feed become hrefs.

import { budapestDateTime, esc, safeUrl } from './http.ts';
import type { LeadRow, NotifyStore } from './lead-store.ts';
import { LINK_STATUSES, type LinkStatus, STATUS_PAGE, statusLink } from './lead-token.ts';

export const FROM = 'AIpályázó <noreply@aipalyazo.hu>';
export const PARTNER_NAME_DEFAULT = 'DFT-Hungária';
export const PRIVACY_URL = 'https://aipalyazo.hu/aipalyazo/adatvedelem.html';
export const MAX_NOTIFY_ATTEMPTS = 5;

export type MailMessage = {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  idempotencyKey?: string;
};
/** Sends or throws. */
export type Mailer = (msg: MailMessage) => Promise<void>;

export function resendMailer(apiKey: string, doFetch: typeof fetch = fetch): Mailer {
  return async (m) => {
    if (!apiKey) throw new Error('resend_not_configured');
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    if (m.idempotencyKey) headers['Idempotency-Key'] = m.idempotencyKey;
    const r = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        from: FROM, to: m.to, subject: m.subject, html: m.html,
        ...(m.text ? { text: m.text } : {}),
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
    });
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).slice(0, 200);
      throw new Error(`resend ${r.status} ${body}`);
    }
  };
}

export function parseRecipients(v: string | undefined): string[] {
  return String(v ?? '').split(',').map((s) => s.trim()).filter((s) => /^[^@\s,<>]+@[^@\s,<>]+\.[^@\s,<>]+$/.test(s));
}

/** Hungarian definite article for a name: "az" before a vowel, else "a". */
export function article(name: string): string {
  return /^[aáeéiíoóöőuúüű]/i.test(name.trim()) ? 'az' : 'a';
}

const oneLine = (s: unknown, max = 200) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

const ICON: Record<string, [string, string]> = {
  ok: ['✓', '#15803d'],
  fail: ['✗', '#b91c1c'],
};
const icon = (status: string) => ICON[status] ?? ['?', '#b45309'];

const PROFILE_LABELS: [string, string][] = [
  ['company', 'Cégnév (profil)'],
  ['employees', 'Létszám'],
  ['site_region', 'Beruházás helye'],
  ['teaor', 'Főtevékenység (TEÁOR)'],
  ['years_operating', 'Lezárt üzleti évek'],
];

const LINK_LABELS: Record<LinkStatus, string> = {
  contacted: 'Felvettük a kapcsolatot',
  applied: 'Beadtuk a pályázatot',
  won: 'Nyert',
  lost: 'Nem valósult meg',
  spam: 'Spam / érvénytelen igény',
};

export async function statusLinks(ref: string, secret: string | undefined, page = STATUS_PAGE): Promise<Record<LinkStatus, string> | null> {
  if (!secret) return null;
  const out = {} as Record<LinkStatus, string>;
  for (const s of LINK_STATUSES) out[s] = await statusLink(secret, ref, s, page);
  return out;
}

function row(label: string, valueHtml: string) {
  return `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap;">${esc(label)}</td><td style="padding:6px 0;font-size:14px;color:#111827;">${valueHtml}</td></tr>`;
}

export async function operatorEmail(lead: LeadRow, opts: { statusSecret?: string; statusPage?: string } = {}) {
  const snap = lead.match_snapshot ?? {};
  const g = snap.grant ?? { fromFeed: false };
  const title = lead.grant_title || lead.grant_id;
  const url = safeUrl(g.url);
  const created = budapestDateTime(new Date(lead.created_at));
  const links = await statusLinks(lead.lead_ref, opts.statusSecret, opts.statusPage);
  const subject = `[AIpályázó lead ${lead.lead_ref}] ${oneLine(title, 150)}`;

  const contact = [
    row('Cég', esc(lead.company || snap.profile?.company || '—')),
    row('Kapcsolattartó', esc(lead.name)),
    row('E-mail', `<a href="mailto:${esc(lead.email)}" style="color:#15803d;">${esc(lead.email)}</a>`),
    row('Telefon', lead.phone ? `<a href="tel:${esc(lead.phone.replace(/[^0-9+]/g, ''))}" style="color:#15803d;">${esc(lead.phone)}</a>` : '—'),
  ].join('');
  const message = lead.message
    ? `<div style="margin:6px 0 0;padding:12px 14px;background:#f9fafb;border-radius:8px;font-size:14px;line-height:1.55;color:#111827;white-space:pre-wrap;">${esc(lead.message)}</div>`
    : '<p style="margin:6px 0 0;font-size:13px;color:#9ca3af;">Nem írt üzenetet.</p>';
  const call = [
    row('Felhívás', `<b>${esc(title)}</b>${snap.titleFromClient ? ' <span style="color:#b45309;font-size:12px;">(a böngésző által küldött cím — a hírfolyamban nem található)</span>' : ''}`),
    row('Kód', esc(g.code || '—')),
    row('Határidő', esc(g.deadline || '—')),
    row('Hivatalos oldal', url ? `<a href="${esc(url)}" style="color:#15803d;">${esc(url)}</a>` : '—'),
    row('Belső azonosító', esc(lead.grant_id)),
  ].join('');
  const checks = (snap.checks ?? []).map((c) => {
    const [ic, col] = icon(c.status);
    return `<tr><td style="padding:4px 10px 4px 0;font-size:15px;font-weight:700;color:${col};vertical-align:top;">${ic}</td><td style="padding:4px 0;font-size:13px;color:#111827;">${c.label ? `<b>${esc(c.label)}:</b> ` : ''}${esc(c.reason)}</td></tr>`;
  }).join('');
  const evidence = snap.score != null || checks
    ? `<p style="margin:0 0 6px;font-size:14px;">Illeszkedés: <b>${esc(snap.score ?? '—')}</b>/100 · ítélet: <b>${esc(snap.verdict ?? '—')}</b> <span style="color:#9ca3af;font-size:12px;">(a portál számítása a felhasználó által megadott profil alapján)</span></p>${checks ? `<table cellpadding="0" cellspacing="0" border="0">${checks}</table>` : ''}`
    : '<p style="margin:0;font-size:13px;color:#9ca3af;">Nincs illeszkedési adat (a felhasználó nem töltötte ki a cégprofilt).</p>';
  const profile = PROFILE_LABELS.filter(([k]) => snap.profile?.[k]).map(([k, l]) => row(l, esc(snap.profile![k]))).join('');
  const btn = (s: LinkStatus) => `<a href="${esc(links![s])}" style="display:inline-block;margin:0 6px 8px 0;padding:9px 14px;border-radius:8px;background:#15803d;color:#fff;text-decoration:none;font-size:13px;font-weight:700;">${esc(LINK_LABELS[s])}</a>`;
  const statusBlock = links
    ? `<h3 style="margin:22px 0 8px;font-size:15px;color:#111827;">Visszajelzés (egy kattintás, majd megerősítés)</h3>
       <div>${btn('contacted')}${btn('applied')}${btn('won')}${btn('lost')}</div>
       <p style="margin:4px 0 0;font-size:12px;"><a href="${esc(links.spam)}" style="color:#9ca3af;">${esc(LINK_LABELS.spam)}</a></p>`
    : '';
  const h = (t: string) => `<h3 style="margin:22px 0 6px;font-size:15px;color:#111827;">${esc(t)}</h3>`;

  const html = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
<tr><td style="background:#15803d;padding:16px 24px;color:#fff;font-size:16px;font-weight:800;">Új konzultációs igény · ${esc(lead.lead_ref)}</td></tr>
<tr><td style="padding:20px 24px;">
<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Beérkezett: ${esc(created)} · Hivatkozási szám: <b style="color:#111827;">${esc(lead.lead_ref)}</b></p>
${h('Kapcsolat')}<table cellpadding="0" cellspacing="0" border="0">${contact}</table>
${h('Üzenet')}${message}
${h('Felhívás')}<table cellpadding="0" cellspacing="0" border="0">${call}</table>
${h('Jogosultsági előszűrés')}${evidence}
${profile ? h('Cégprofil') + `<table cellpadding="0" cellspacing="0" border="0">${profile}</table>` : ''}
${statusBlock}
<p style="margin:22px 0 0;font-size:12px;color:#9ca3af;line-height:1.5;">Válasz erre az e-mailre közvetlenül az igénylőnek megy. Az igénylő hozzájárult adatai továbbításához.</p>
</td></tr></table></td></tr></table>`;

  const text = [
    `Új konzultációs igény ${lead.lead_ref} (${created})`,
    '',
    `Cég: ${lead.company || snap.profile?.company || '—'}`,
    `Kapcsolattartó: ${lead.name}`,
    `E-mail: ${lead.email}`,
    `Telefon: ${lead.phone || '—'}`,
    `Üzenet: ${lead.message || '—'}`,
    '',
    `Felhívás: ${title}${snap.titleFromClient ? ' (böngésző által küldött cím)' : ''}`,
    `Kód: ${g.code || '—'} · Határidő: ${g.deadline || '—'}`,
    `Hivatalos oldal: ${url || '—'}`,
    '',
    `Illeszkedés: ${snap.score ?? '—'}/100 (${snap.verdict ?? '—'})`,
    ...(snap.checks ?? []).map((c) => `  ${icon(c.status)[0]} ${c.label ? c.label + ': ' : ''}${c.reason}`),
    ...(links ? ['', 'Visszajelzés:', ...LINK_STATUSES.map((s) => `  ${LINK_LABELS[s]}: ${links[s]}`)] : []),
  ].join('\n');

  return { subject, html, text };
}

export function requesterEmail(lead: Pick<LeadRow, 'lead_ref' | 'grant_title' | 'match_snapshot'>, partnerName = PARTNER_NAME_DEFAULT) {
  // A title the browser sent (id not in the feed) is attacker-controlled text:
  // never echo it (or the name/message) to the address in the form.
  const trusted = !lead.match_snapshot?.titleFromClient && lead.grant_title;
  const titleHtml = trusted ? `<p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:#111827;font-weight:700;border-left:3px solid #15803d;padding-left:12px;">${esc(lead.grant_title)}</p>` : '';
  const p = esc(partnerName);
  const a = article(partnerName);
  const A = a.charAt(0).toUpperCase() + a.slice(1);
  const subject = `Konzultációs igényét rögzítettük (${lead.lead_ref}) — AIpályázó`;
  const html = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background:#fff;border-radius:14px;border:1px solid #dcfce7;">
<tr><td style="background:#15803d;padding:20px 30px;"><span style="font-size:20px;font-weight:800;color:#fff;">AI<span style="color:#bbf7d0;">pályázó</span></span></td></tr>
<tr><td style="padding:30px;">
<p style="margin:0 0 14px;font-size:15px;color:#111827;">Tisztelt Érdeklődő!</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#374151;">Köszönjük, megkaptuk díjmentes előzetes konzultáció iránti igényét${trusted ? ' az alábbi pályázati felhívással kapcsolatban:' : '.'}</p>
${titleHtml}
<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#374151;">Hivatkozási szám: <b style="color:#111827;">${esc(lead.lead_ref)}</b><br><span style="font-size:13px;color:#6b7280;">Kérjük, ha kapcsolatba lép velünk, erre hivatkozzon.</span></p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#374151;">${A} ${p} pályázatírói <b>2 munkanapon belül</b> felveszik Önnel a kapcsolatot a megadott elérhetőségek egyikén. A konzultáció díjmentes és nem jár kötelezettséggel.</p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#6b7280;">Adatainak kezelése: a megadott nevet, e-mail-címet, telefonszámot, üzenetet és a felhíváshoz tartozó cégprofil-adatokat kizárólag a konzultáció megszervezéséhez használjuk, és ehhez továbbítjuk ${a} ${p} részére. Részletek: <a href="${PRIVACY_URL}" style="color:#15803d;">Adatkezelési tájékoztató</a>.</p>
<p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">Ha nem Ön küldte ezt az igényt, kérjük, jelezze az <a href="mailto:info@aipalyazo.hu" style="color:#15803d;">info@aipalyazo.hu</a> címen, és töröljük az adatokat.</p>
</td></tr>
<tr><td style="padding:16px 30px;background:#f9fafb;border-top:1px solid #f3f4f6;font-size:12px;line-height:1.6;color:#9ca3af;">AIpályázó — pályázatfigyelés magyar vállalkozásoknak · <a href="${PRIVACY_URL}" style="color:#15803d;">Adatkezelés</a></td></tr>
</table></td></tr></table>`;
  const text = [
    'Tisztelt Érdeklődő!', '',
    `Köszönjük, megkaptuk díjmentes előzetes konzultáció iránti igényét${trusted ? ` a következő felhívással kapcsolatban: ${lead.grant_title}` : '.'}`,
    `Hivatkozási szám: ${lead.lead_ref}`, '',
    `${A} ${partnerName} pályázatírói 2 munkanapon belül felveszik Önnel a kapcsolatot.`, '',
    `Adatkezelési tájékoztató: ${PRIVACY_URL}`,
    'Ha nem Ön küldte ezt az igényt, írjon az info@aipalyazo.hu címre.',
  ].join('\n');
  return { subject, html, text };
}

export type NotifyResult = 'sent' | 'skipped' | 'not_claimed' | 'failed';

/**
 * Partner notification with at-most-once semantics per row: the DB claim
 * (claim_lead_notify) serialises senders and caps attempts; notified_at is
 * only set after Resend accepted the message.
 */
export async function notifyOperator(lead: LeadRow, ctx: {
  store: NotifyStore;
  mailer: Mailer;
  recipients: string[];
  statusSecret?: string;
  statusPage?: string;
}): Promise<NotifyResult> {
  if (!ctx.recipients.length) return 'skipped';
  if (!(await ctx.store.claimNotify(lead.id))) return 'not_claimed';
  try {
    const m = await operatorEmail(lead, { statusSecret: ctx.statusSecret, statusPage: ctx.statusPage });
    await ctx.mailer({ to: ctx.recipients, ...m, replyTo: lead.email, idempotencyKey: `lead-${lead.id}-partner` });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    console.error('[lead] partner notification failed', lead.lead_ref, msg);
    try { await ctx.store.markNotifyFailed(lead.id, msg); } catch (e2) { console.error('[lead] markNotifyFailed', String(e2).slice(0, 200)); }
    return 'failed';
  }
  try { await ctx.store.markNotified(lead.id); } catch (e) {
    // Sent, but not recorded: the 5-minute claim lock + Resend idempotency key
    // prevent an immediate duplicate; log loudly for manual follow-up.
    console.error('[lead] SENT but markNotified failed', lead.lead_ref, String(e).slice(0, 200));
  }
  return 'sent';
}
