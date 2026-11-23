-- =========================================================================
-- Matching v3 profile fields — DFT eligibility model, first round (2026-11-23)
-- =========================================================================
-- All optional, answered on onboarding step 2 ("Pontosítás"):
-- tax_regime     'normal' | 'kiva' | 'kata' | 'atalany'  — many state-aid calls exclude KATA
-- group_member   'igen' | 'nem'  — 25%+ ownership link with another enterprise
--                (SME status must then be counted at group level)
-- public_owner   'igen' | 'nem'  — state / municipality owns 25%+ → not an SME
-- de_minimis     'nincs' | '<100k' | '100k-250k' | '250k+'  (EUR, last 3 years)
-- insolvency     'igen' | 'nem'  — bankruptcy / liquidation / winding-up /
--                enforcement in progress → excluded from practically every call
-- Apply after 20261119000001. Safe to re-run.
-- =========================================================================

alter table public.profiles add column if not exists tax_regime   text check (tax_regime   in ('normal', 'kiva', 'kata', 'atalany'));
alter table public.profiles add column if not exists group_member text check (group_member in ('igen', 'nem'));
alter table public.profiles add column if not exists public_owner text check (public_owner in ('igen', 'nem'));
alter table public.profiles add column if not exists de_minimis   text check (de_minimis   in ('nincs', '<100k', '100k-250k', '250k+'));
alter table public.profiles add column if not exists insolvency   text check (insolvency   in ('igen', 'nem'));

grant update (tax_regime, group_member, public_owner, de_minimis, insolvency) on public.profiles to authenticated;

-- The app reads profiles through this view; new columns go at the end
-- (create or replace may only append columns).
create or replace view public.user_with_tier as
select
  p.id, p.email, p.display_name, p.company, p.industry, p.industries, p.employees, p.revenue,
  p.location, p.site_region, p.years_operating, p.legal_form, p.public_debt_free, p.own_funds,
  p.in_difficulty, p.teaor, p.categories, p.created_at, p.rnd, p.women_led, p.phone,
  p.tax_regime, p.group_member, p.public_owner, p.de_minimis, p.insolvency
from public.profiles p;
alter view public.user_with_tier set (security_invoker = on);
revoke select on public.user_with_tier from anon;
grant select on public.user_with_tier to authenticated;
