#!/usr/bin/env node
// =========================================================================
// AIpályázó — branded Hungarian Supabase Auth e-mails
// =========================================================================
// Writes supabase/email-templates/*.html (one per auth e-mail) and
// supabase/email-templates/auth-config.json (subjects + bodies in the shape
// the Supabase Management API expects), so all templates can be applied with
// one command — see supabase/email-templates/README.md.
//
// Run: node scripts/build-auth-emails.mjs
// =========================================================================
import { writeFileSync } from 'node:fs';

const DIR = new URL('../supabase/email-templates/', import.meta.url);
const SITE = 'https://aipalyazo.hu/aipalyazo';
const BRAND = '#12844a';
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// No images: many clients block them by default, so the logo is drawn with a table cell.
const logo = `<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>
<td width="30" height="30" align="center" valign="middle" style="width:30px;height:30px;background-color:${BRAND};border-radius:7px;font-family:${FONT};font-size:13px;font-weight:800;color:#ffffff;line-height:30px;">AI</td>
<td style="padding-left:10px;font-family:${FONT};font-size:19px;font-weight:700;color:#111827;letter-spacing:-0.3px;">AI<span style="color:${BRAND};">pályázó</span></td>
</tr></table>`;

const button = (href, label) => `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 24px;"><tr>
<td align="center" style="background-color:${BRAND};border-radius:8px;"><a href="${href}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${label}</a></td>
</tr></table>`;

const fallbackLink = (href) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#6b7280;">Ha a gomb nem működik, másolja ezt a linket a böngészőjébe:</p>
<p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${href}" style="color:${BRAND};">${href}</a></p>`;

const p = (t) => `<p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#374151;">${t}</p>`;
const small = (t) => `<p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">${t}</p>`;

function shell({ preheader, title, body }) {
  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background-color:#f3f5f4;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f5f4;">${preheader}</div>
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#f3f5f4;padding:32px 12px;font-family:${FONT};">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">
<tr><td style="padding:24px 32px;border-bottom:3px solid ${BRAND};">${logo}</td></tr>
<tr><td style="padding:32px 32px 28px;">
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:#111827;">${title}</h1>
${body}
</td></tr>
<tr><td style="padding:18px 32px;background-color:#f9fafb;border-top:1px solid #f0f0f0;border-radius:0 0 12px 12px;">
<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:#9ca3af;">AIpályázó — pályázatfigyelés magyar vállalkozásoknak · <a href="${SITE}/index.html" style="color:${BRAND};">aipalyazo.hu</a> · <a href="${SITE}/adatvedelem.html" style="color:${BRAND};">Adatkezelés</a> · <a href="mailto:info@aipalyazo.hu" style="color:${BRAND};">info@aipalyazo.hu</a><br>Ezt az automatikus levelet a(z) {{ .Email }} címre küldtük. Kérjük, ne válaszoljon rá.</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>
`;
}

const URL_ = '{{ .ConfirmationURL }}';

export const TEMPLATES = [
  {
    key: 'confirmation', file: 'confirm-signup.html',
    subject: 'Erősítse meg az e-mail-címét – AIpályázó',
    html: shell({
      preheader: 'Egy kattintás, és kész a fiókja.',
      title: 'Erősítse meg az e-mail-címét',
      body: p('Köszönjük, hogy regisztrált az AIpályázó-n. A fiókja aktiválásához erősítse meg az e-mail-címét az alábbi gombbal.') +
        button(URL_, 'E-mail-cím megerősítése') + fallbackLink(URL_) +
        small('Ha nem Ön regisztrált, hagyja figyelmen kívül ezt a levelet: megerősítés nélkül a fiók nem jön létre.'),
    }),
  },
  {
    key: 'recovery', file: 'reset-password.html',
    subject: 'Jelszó visszaállítása – AIpályázó',
    html: shell({
      preheader: 'Új jelszót állíthat be az AIpályázó-fiókjához.',
      title: 'Jelszó visszaállítása',
      body: p('Jelszó-visszaállítást kértek az AIpályázó-fiókjához. Az alábbi gombbal új jelszót állíthat be. A link 1 óráig érvényes, és csak egyszer használható.') +
        button(URL_, 'Új jelszó beállítása') + fallbackLink(URL_) +
        small('Ha nem Ön kérte, hagyja figyelmen kívül ezt a levelet: a jelszava nem változik. Ha többször kap ilyen levelet kérés nélkül, írjon nekünk az info@aipalyazo.hu címre.'),
    }),
  },
  {
    key: 'email_change', file: 'change-email.html',
    subject: 'Erősítse meg az új e-mail-címét – AIpályázó',
    html: shell({
      preheader: 'Az e-mail-cím módosítását meg kell erősíteni.',
      title: 'E-mail-cím módosítása',
      body: p('Az AIpályázó-fiókjához tartozó e-mail-címet a(z) <b>{{ .Email }}</b> címről a(z) <b>{{ .NewEmail }}</b> címre kérték módosítani. A módosítás az alábbi gombbal erősíthető meg.') +
        button(URL_, 'Módosítás megerősítése') + fallbackLink(URL_) +
        small('Ha nem Ön kérte, ne kattintson a linkre, és írjon nekünk az info@aipalyazo.hu címre.'),
    }),
  },
  {
    key: 'magic_link', file: 'magic-link.html',
    subject: 'Belépési link – AIpályázó',
    html: shell({
      preheader: 'Egy kattintással beléphet az AIpályázó-ba.',
      title: 'Belépés az AIpályázó-ba',
      body: p('Az alábbi gombbal jelszó nélkül beléphet a fiókjába. A link 1 óráig érvényes, és csak egyszer használható.') +
        button(URL_, 'Belépés') + fallbackLink(URL_) +
        small('Ha nem Ön kérte, hagyja figyelmen kívül ezt a levelet.'),
    }),
  },
  {
    key: 'reauthentication', file: 'reauthentication.html',
    subject: 'Megerősítő kód – AIpályázó',
    html: shell({
      preheader: 'A biztonsági művelethez szükséges kód.',
      title: 'Megerősítő kód',
      body: p('Biztonsági okból meg kell erősítenie, hogy Ön kezdeményezte a módosítást. Adja meg az alábbi kódot:') +
        `<p style="margin:0 0 24px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:#111827;">{{ .Token }}</p>` +
        small('Ha nem Ön kezdeményezte, ne adja meg a kódot senkinek, és írjon nekünk az info@aipalyazo.hu címre.'),
    }),
  },
  {
    key: 'invite', file: 'invite.html',
    subject: 'Meghívás az AIpályázó-ba',
    html: shell({
      preheader: 'Meghívták az AIpályázó-ba.',
      title: 'Meghívást kapott',
      body: p('Meghívták az AIpályázó-ba, a magyar vállalkozásoknak szóló pályázatfigyelőbe. A fiókja létrehozásához kattintson az alábbi gombra.') +
        button(URL_, 'Meghívás elfogadása') + fallbackLink(URL_) +
        small('Ha nem számított erre a meghívásra, hagyja figyelmen kívül ezt a levelet.'),
    }),
  },
];

export function authConfig() {
  const out = {};
  for (const t of TEMPLATES) {
    out[`mailer_subjects_${t.key}`] = t.subject;
    out[`mailer_templates_${t.key}_content`] = t.html;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const t of TEMPLATES) writeFileSync(new URL(t.file, DIR), t.html);
  writeFileSync(new URL('auth-config.json', DIR), JSON.stringify(authConfig(), null, 2) + '\n');
  console.log(`auth e-mails: ${TEMPLATES.length} templates + auth-config.json`);
}
