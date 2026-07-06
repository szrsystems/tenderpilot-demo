-- =========================================================================
-- Profile eligibility fields (2026-07-06)
-- =========================================================================
-- The cégprofil form now captures multi-select industries and the standard
-- Hungarian grant-eligibility gates. Until this migration runs, the frontend
-- syncs these in a separate fire-and-forget patch that fails silently — so
-- applying this is non-breaking in either order.
--
-- Apply via the Supabase SQL Editor (paste + run), NOT `db push`.

alter table public.profiles add column if not exists industries       text[];
alter table public.profiles add column if not exists site_region      text;
alter table public.profiles add column if not exists public_debt_free text;
alter table public.profiles add column if not exists own_funds        text;
alter table public.profiles add column if not exists in_difficulty    text;
alter table public.profiles add column if not exists teaor            text;

-- Backfill: users who set a single industry before multi-select existed.
update public.profiles
   set industries = array[industry]
 where industries is null
   and industry is not null
   and industry <> '';

-- Recreate the view so the app's profile reads include the new columns.
-- IMPORTANT: re-assert the 2026-06-11 leak fix (security_invoker + no anon),
-- because CREATE OR REPLACE VIEW resets storage parameters on some versions.
create or replace view public.user_with_tier as
select
  p.id,
  p.email,
  p.display_name,
  p.tier,
  s.status            as subscription_status,
  s.billing_interval,
  s.current_period_end,
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
from public.profiles p
left join lateral (
  select status, billing_interval, current_period_end
  from public.subscriptions s
  where s.user_id = p.id
    and s.status in ('trialing','active')
  order by s.current_period_end desc
  limit 1
) s on true;

alter view public.user_with_tier set (security_invoker = on);
revoke select on public.user_with_tier from anon;
