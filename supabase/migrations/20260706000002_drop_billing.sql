-- =========================================================================
-- Drop dead billing machinery + recreate user_with_tier (2026-07-06)
-- =========================================================================
-- AIpályázó is fully free: Paddle is gone, every signed-in user has full
-- access (getTier() never reads the DB). The subscriptions table and
-- profiles.tier column are dead weight — and the tier-gated RLS policies
-- they feed are silently vacuous. This migration:
--   1. replaces the tier-referencing policies with plain owner checks
--   2. drops subscriptions + profiles.tier
--   3. recreates user_with_tier without billing columns, WITH the new
--      eligibility columns (see ...000001), re-asserting the 2026-06-11
--      security_invoker leak fix
--
-- Apply via the Supabase SQL Editor, NOT `db push`.

-- 1) Policies that reference profiles.tier must go before the column can.
drop policy if exists "profiles: update own (except tier)" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "drafts: pro read own"   on public.drafts;
drop policy if exists "drafts: pro write own"  on public.drafts;
drop policy if exists "drafts: pro update own" on public.drafts;
drop policy if exists "drafts: pro delete own" on public.drafts;
create policy "drafts: read own"   on public.drafts for select using (auth.uid() = user_id);
create policy "drafts: write own"  on public.drafts for insert with check (auth.uid() = user_id);
create policy "drafts: update own" on public.drafts for update using (auth.uid() = user_id);
create policy "drafts: delete own" on public.drafts for delete using (auth.uid() = user_id);

-- 2) The view depends on both subscriptions and profiles.tier — drop it first.
drop view if exists public.user_with_tier;
drop table if exists public.subscriptions cascade;
alter table public.profiles drop column if exists tier;

-- 3) Recreate the view: same name (the app selects * from it), no billing
--    columns, plus the new eligibility fields.
create view public.user_with_tier as
select
  p.id,
  p.email,
  p.display_name,
  p.company,
  p.industry,
  p.industries,
  p.employees,
  p.revenue,
  p.location,
  p.site_region,
  p.years_operating,
  p.legal_form,
  p.public_debt_free,
  p.own_funds,
  p.in_difficulty,
  p.teaor,
  p.categories,
  p.created_at
from public.profiles p;

-- Re-assert the 2026-06-11 leak fix on the fresh view.
alter view public.user_with_tier set (security_invoker = on);
revoke select on public.user_with_tier from anon;
grant select on public.user_with_tier to authenticated;
