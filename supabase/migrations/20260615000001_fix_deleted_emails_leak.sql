-- =========================================================================
-- SECURITY FIX — deleted_emails was world-readable.
-- =========================================================================
-- The original policy:
--
--   create policy "deleted_emails: read for sign-in check"
--     on public.deleted_emails for select to anon, authenticated using (true);
--
-- `using (true)` means ANY caller with the public anon key can read EVERY row,
-- i.e. enumerate the full list of emails of users who deleted their accounts
-- (PII leak). The accompanying comment claimed callers "only see their own"
-- email — that was never true.
--
--   curl "$SUPABASE_URL/rest/v1/deleted_emails?select=email" -H "apikey: $ANON_KEY"
--   -> every deleted user's email
--
-- Fix: drop anon access entirely and restrict authenticated callers to their
-- OWN email. The only legitimate read is checkDeletedAccount() in
-- lib/supabase.js, which runs AFTER getUser() (authenticated) and matches the
-- caller's own email — including OAuth re-signups, where auth.uid() is a fresh
-- user_id but the email is the same one being checked.
-- =========================================================================

drop policy if exists "deleted_emails: read for sign-in check" on public.deleted_emails;

create policy "deleted_emails: read own email only"
  on public.deleted_emails
  for select
  to authenticated
  -- Use auth.email() (the JWT email claim) rather than a subquery on
  -- auth.users: the `authenticated` role cannot reliably SELECT auth.users
  -- inside an RLS policy, which would make this clause error and the
  -- re-registration check silently fail. lower() makes it case-insensitive
  -- (stored emails are lowercased by delete-user).
  using (lower(email) = lower(auth.email()));
