# Security headers — AIpályázó

GitHub Pages cannot send custom HTTP headers. Today every page carries a CSP and
a Referrer-Policy as `<meta>` tags. The rest (clickjacking protection, nosniff,
Permissions-Policy) needs Cloudflare in front of the domain.

## What is live now (meta tags)

| Page group | script-src | Notes |
|---|---|---|
| `portal.html` | `'self'` + jsdelivr (Supabase SDK, SRI-pinned) + Turnstile + GoatCounter | **No `'unsafe-inline'`** — the portal has no inline scripts or handlers, so injected markup cannot run script. |
| Auth pages, onboarding, unsubscribe, lead status | `'self' 'unsafe-inline'` + jsdelivr + GoatCounter | Still have inline `<script>` blocks. |
| Home, legal, public call pages | `'self' 'unsafe-inline'` + GoatCounter | No Supabase access at all (`connect-src` limited). |

Common to all: `default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'`
(fonts are self-hosted), `img-src 'self' data:`, `base-uri 'self'; object-src 'none'; form-action 'self'`.

Allowed origins and why:

| Origin | Used for |
|---|---|
| `cdn.jsdelivr.net` | Supabase JS SDK (pinned version + SRI hash in `lib/supabase.js`) |
| `kacnvchwfwvpkkyhyupb.supabase.co` (https + wss) | Auth, database, Edge Functions |
| `challenges.cloudflare.com` (script + frame) | Turnstile captcha on the consultation form (only when a site key is set) |
| `gc.zgo.at`, `*.goatcounter.com` | Cookie-free analytics (only when `GC_CODE` is set) |

If the Supabase project, SDK version or analytics provider changes, update the
CSP meta in the affected HTML files and `scripts/build-pages.mjs`.

## Cloudflare (do this at domain launch)

Dashboard → Rules → Transform Rules → Modify Response Header, for `aipalyazo.hu/*`:

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | `frame-ancestors 'none'` (only this directive — the per-page meta CSP keeps doing the rest) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Strict-Transport-Security` | `max-age=31536000` (add `includeSubDomains` only if every subdomain is HTTPS) |

Two CSPs (header + meta) are both enforced, so the header only needs `frame-ancestors`.

## Next hardening step

Move the remaining inline `<script>` blocks on the auth pages and onboarding
into `assets/*.js` files, then drop `'unsafe-inline'` from their `script-src`
the same way the portal already does.

## Verify

- `curl -sI https://aipalyazo.hu/aipalyazo/ | grep -iE 'x-frame|x-content|referrer|permissions|strict-transport|content-security'`
- DevTools → Console: CSP blocks show up as errors.
- https://securityheaders.com, https://observatory.mozilla.org
