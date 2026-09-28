-- =========================================================================
-- Matching v2 profile fields (2026-09-28)
-- =========================================================================
-- rnd       'igen' | 'nem' | null — does the company plan an R&D / innovation
--           project (many EU and NKFI calls fund only that)
-- women_led 'igen' | 'nem' | null — women-founded / women-led company
--           (e.g. Women TechEU). Asked only as an optional eligibility field.
-- Apply after 20260928000001. Safe to re-run.

alter table public.profiles add column if not exists rnd       text check (rnd in ('igen', 'nem'));
alter table public.profiles add column if not exists women_led text check (women_led in ('igen', 'nem'));

grant update (rnd, women_led) on public.profiles to authenticated;

-- The app reads profiles through this view; add the new columns at the end
-- (create or replace may only append columns).
create or replace view public.user_with_tier as
select
  p.id, p.email, p.display_name, p.company, p.industry, p.industries, p.employees, p.revenue,
  p.location, p.site_region, p.years_operating, p.legal_form, p.public_debt_free, p.own_funds,
  p.in_difficulty, p.teaor, p.categories, p.created_at, p.rnd, p.women_led
from public.profiles p;
alter view public.user_with_tier set (security_invoker = on);
revoke select on public.user_with_tier from anon;
grant select on public.user_with_tier to authenticated;
