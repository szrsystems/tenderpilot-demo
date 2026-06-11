-- CRITICAL SECURITY FIX
--
-- The user_with_tier view was created without security_invoker, so it runs
-- with the view owner's (postgres) privileges and BYPASSES the RLS policies
-- on profiles + subscriptions. Result: an anonymous client with only the
-- public anon key could read EVERY user's email, name, company, tier and
-- subscription data:
--
--   curl "$SUPABASE_URL/rest/v1/user_with_tier?select=*" -H "apikey: $ANON_KEY"
--   -> full user list  (verified 2026-06-11)
--
-- Fix 1: make the view run with the CALLER's privileges, so the underlying
-- RLS policies ("users can read own profile / own subscription") apply.
-- Authenticated users still see exactly their own row — which is the only
-- way the app queries this view (lib/supabase.js getTier/getUserProfile use
-- .eq('id', user.id)).
alter view public.user_with_tier set (security_invoker = on);

-- Fix 2 (belt and suspenders): anonymous clients have no business reading
-- this view at all — the app checks auth before querying it.
revoke select on public.user_with_tier from anon;
