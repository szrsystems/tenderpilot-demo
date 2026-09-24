-- =========================================================================
-- Weekly e-mail: opt-in + working unsubscribe (2026-09-24)
-- =========================================================================
-- Before this migration:
--   * weekly_enabled defaulted to TRUE and onboarding pre-ticked the box
--     (pre-ticked boxes are not valid consent under GDPR / CJEU Planet49);
--   * the portal "turn off" switch only wrote to localStorage, so nobody
--     could actually stop the e-mail.
-- This migration:
--   1. makes the weekly e-mail opt-in (default FALSE);
--   2. adds a per-user random unsubscribe_token used by the one-click
--      unsubscribe link in every digest (edge function `unsubscribe`);
--   3. lets users change only their own on/off switches — not the
--      recipient address or the token (stops pointing the digest at a
--      third party's inbox);
--   4. tightens the update policy with a WITH CHECK clause.
--
-- Apply via the Supabase SQL Editor, NOT `db push` (same as earlier files).
-- Safe to re-run.

-- 1) Opt-in by default.
alter table public.notif_prefs alter column weekly_enabled set default false;

-- 2) Unsubscribe token (122 random bits; unguessable).
alter table public.notif_prefs
  add column if not exists unsubscribe_token uuid not null default gen_random_uuid();
create unique index if not exists notif_prefs_unsubscribe_token_idx
  on public.notif_prefs(unsubscribe_token);

-- 3) Column-level privileges for signed-in users.
--    Service role (edge functions) and the security-definer signup trigger
--    are unaffected.
revoke insert, update on public.notif_prefs from anon, authenticated;
grant insert (user_id, weekly_enabled, urgent_enabled, frequency,
              section_top_n, section_new_since_last, section_deadlines,
              section_totals, section_saved_updates)
  on public.notif_prefs to authenticated;
grant update (user_id, weekly_enabled, urgent_enabled, frequency,
              section_top_n, section_new_since_last, section_deadlines,
              section_totals, section_saved_updates)
  on public.notif_prefs to authenticated;

-- 4) A user can only ever update a row into their own row.
drop policy if exists "notif: update own" on public.notif_prefs;
create policy "notif: update own" on public.notif_prefs
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- -------------------------------------------------------------------------
-- 5) OPTIONAL, RECOMMENDED — decide before running.
-- Everyone who signed up so far was opted in by a pre-ticked box and could
-- not opt out, so that consent is not valid. Turning the e-mail off for
-- existing users is the clean fix; they can switch it back on in
-- Beállítások. Uncomment to apply:
--
-- update public.notif_prefs set weekly_enabled = false, urgent_enabled = false;
-- -------------------------------------------------------------------------
