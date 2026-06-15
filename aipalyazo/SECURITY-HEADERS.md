# Security headers — AIpályázó

## TL;DR

GitHub Pages **cannot send custom HTTP headers**. We do what's possible with
`<meta>` tags now (CSP + Referrer-Policy), and the full set of real headers
gets set by **Cloudflare** once `aipalyazo.hu` is live. Until then, 3 of the 5
requested headers (X-Frame-Options, X-Content-Type-Options, Permissions-Policy)
**cannot be enforced** — that is a hosting limitation, not an oversight.

---

## What's live now (meta tags in every page `<head>`)

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://kacnvchwfwvpkkyhyupb.supabase.co wss://kacnvchwfwvpkkyhyupb.supabase.co https://formspree.io; form-action 'self' https://formspree.io; base-uri 'self'; object-src 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
```

### Why `'unsafe-inline'` is here (and why it's not ideal)

The app uses ~80 inline event handlers (`onclick=`), 121 inline `style=""`
attributes, inline `<script>`/`<style>` blocks. A strict `script-src 'self'`
would break the whole app. `'unsafe-inline'` still blocks **external** script
loading and data exfiltration to non-allowlisted origins (real protection),
but it does **not** stop inline-injection XSS. To get a truly strict CSP, see
"Path to a strict CSP" below.

### Origins in the allowlist and why

| Origin | Directive | Used for |
|---|---|---|
| `cdn.jsdelivr.net` | script-src | Supabase JS SDK |
| `fonts.googleapis.com` | style-src | Google Fonts stylesheet |
| `fonts.gstatic.com` | font-src | Google Fonts font files |
| `kacnvchwfwvpkkyhyupb.supabase.co` (https + wss) | connect-src | Auth, REST, realtime |
| `formspree.io` | connect-src, form-action | Lead/onboarding form (when wired up) |
| `data:` | img-src | Inline SVG favicon / data-URI images |

**If you change the Supabase project, swap fonts, or move the SDK**, update the
CSP in every HTML file (static sites can't share a header include).

---

## The full set of real headers (Cloudflare — do this at domain launch)

Once `aipalyazo.hu` points at GitHub Pages **through Cloudflare** (free plan):
Dashboard → **Rules → Transform Rules → Modify Response Header** → "Add" each:

| Header | Value |
|---|---|
| `Content-Security-Policy` | *(same string as the meta tag above, plus `frame-ancestors 'none';`)* |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |

`frame-ancestors 'none'` (real header) + `X-Frame-Options: DENY` together give
full clickjacking protection — neither works as a meta tag, so this is the step
that actually closes that gap. Once these are live you can delete the CSP meta
tag from the HTML (keep the `referrer` meta as a harmless fallback).

---

## Alternative: a header-capable host (`_headers` file)

If you ever move off GitHub Pages to **Netlify** or **Cloudflare Pages**, drop a
file named `_headers` at the site root — no other config needed:

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://kacnvchwfwvpkkyhyupb.supabase.co wss://kacnvchwfwvpkkyhyupb.supabase.co https://formspree.io; form-action 'self' https://formspree.io; base-uri 'self'; object-src 'none'; frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

---

## Path to a strict CSP (drop `'unsafe-inline'`)

Real XSS protection needs `script-src 'self'` with **no** `'unsafe-inline'`.
That requires, in order:

1. Move every inline `<script>` block into an external `.js` file.
2. Replace all ~80 inline `on*=` handlers with `addEventListener` in those files
   (event delegation keeps it small).
3. For styles: move `<style>` blocks to a `.css` file; replace dynamic
   `style=""` writes with class toggles (or keep `style-src 'unsafe-inline'` —
   style injection is far lower-risk than script injection).
4. Then tighten to: `script-src 'self' https://cdn.jsdelivr.net` (or
   self-host the SDK and drop jsdelivr too).

This is a real refactor (estimate 1–2 days for portal.html). Worth doing
post-launch; not a blocker for going live.

---

## Verifying

- Headers: `curl -sI https://aipalyazo.hu/ | grep -iE 'content-security|x-frame|x-content|referrer|permissions'`
- CSP violations: open the site, DevTools → Console — CSP blocks log as errors.
- Score: https://securityheaders.com and https://observatory.mozilla.org
