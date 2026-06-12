# Branded Supabase auth e-mail templates

How to apply (2 minutes per template):

1. Supabase Dashboard → **Authentication → Email Templates**
2. Pick the template type, paste the matching HTML file's contents into the
   *Message body*, set the suggested subject, **Save**.

| Template type   | File                  | Suggested subject                              |
|-----------------|-----------------------|------------------------------------------------|
| Confirm signup  | `confirm-signup.html` | Erősítse meg e-mail-címét — AIpályázó           |
| Magic link      | adapt `confirm-signup.html`: swap H1 to "Belépés az AIpályázó-ba", button text to "Belépés", body copy accordingly. Variable stays `{{ .ConfirmationURL }}`. | Belépési link — AIpályázó |
| Reset password  | same base: H1 "Jelszó visszaállítása", button "Új jelszó beállítása". | Jelszó visszaállítása — AIpályázó |

Notes:
- Inline CSS only — Gmail/Outlook strip `<style>` blocks.
- The **sender address** stays `noreply@mail.app.supabase.io` until custom SMTP
  is configured (Settings → Authentication → SMTP). With the domain live,
  point it at Resend (free tier: 3 000 e-mail/month) and the sender becomes
  e.g. `AIpályázó <noreply@aipalyazo.hu>`.
- Test: register with a throwaway address and check the rendering on mobile.
