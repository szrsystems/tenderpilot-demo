-- =========================================================================
-- Detailed eligibility sheet — DFT eligibility model v2 (2026-11-25)
-- =========================================================================
-- profiles.elig holds the optional answers of the "Részletes adatlap"
-- (adatlap.html): founding date, ownership links with percentages, the last
-- two annual reports, legal proceedings, labour-law and transparency
-- declarations, de minimis used, and the planned project. One JSON object
-- instead of ~70 columns: the matcher (lib/match.js) reads it, unknown keys
-- are ignored, and the model can grow without a migration per field.
--   * only the owner can write it (column grant + the existing RLS policy)
--   * must be a JSON object, at most 24 kB
-- Apply after 20261123000001. Safe to re-run.
-- =========================================================================

alter table public.profiles add column if not exists elig jsonb;
alter table public.profiles add column if not exists elig_updated_at timestamptz;

do $$ begin
  alter table public.profiles add constraint profiles_elig_shape
    check (elig is null or (jsonb_typeof(elig) = 'object' and octet_length(elig::text) <= 24576));
exception when duplicate_object then null; end $$;

grant update (elig, elig_updated_at) on public.profiles to authenticated;

create or replace view public.user_with_tier as
select
  p.id, p.email, p.display_name, p.company, p.industry, p.industries, p.employees, p.revenue,
  p.location, p.site_region, p.years_operating, p.legal_form, p.public_debt_free, p.own_funds,
  p.in_difficulty, p.teaor, p.categories, p.created_at, p.rnd, p.women_led, p.phone,
  p.tax_regime, p.group_member, p.public_owner, p.de_minimis, p.insolvency,
  p.elig, p.elig_updated_at
from public.profiles p;
alter view public.user_with_tier set (security_invoker = on);
revoke select on public.user_with_tier from anon;
grant select on public.user_with_tier to authenticated;
