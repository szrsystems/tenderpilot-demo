-- =========================================================================
-- Company data cache + digest paging (2026-11-19)
-- =========================================================================
-- The company-lookup edge function asks NAV (queryTaxpayer) once per company
-- and keeps the answer here, so a re-registration, a second user of the same
-- company or a page reload never calls NAV again within 30 days.
--   company_data   service-role only (no client access at all). Holds only
--                  public company register facts (name, legal form,
--                  addresses), never personal data of owners or executives.
--   profiles.tax_number / company_verified_at
--                  set by the edge function (service role) when the user's
--                  own lookup succeeds; the user cannot write them directly.
-- Apply after 20261009000001. Safe to re-run.
-- =========================================================================

create table if not exists public.company_data (
  tax8        text primary key check (tax8 ~ '^[0-9]{8}$'),
  source      text not null default 'NAV',
  found       boolean not null,
  data        jsonb not null default '{}'::jsonb,
  fetched_at  timestamptz not null default now()
);
alter table public.company_data enable row level security;
-- no policies: only the service role (edge functions) can read or write
revoke all on public.company_data from anon, authenticated;

alter table public.profiles add column if not exists tax_number          text check (tax_number is null or tax_number ~ '^[0-9]{8}$');
alter table public.profiles add column if not exists company_verified_at timestamptz;
-- deliberately NOT granted to authenticated: only the edge function sets them

-- Retention: cached rows nobody refreshed for a year are removed by the
-- existing daily purge (lead-digest calls purge_deleted_emails()).
create or replace function public.purge_company_data()
returns int
language sql
security definer
set search_path = public
as $$
  with d as (delete from public.company_data where fetched_at < now() - interval '365 days' returning 1)
  select count(*)::int from d;
$$;
revoke all on function public.purge_company_data() from public, anon, authenticated;
grant execute on function public.purge_company_data() to service_role;

-- Weekly digest is now sent in pages of 100 (one Resend batch call each).
-- last_digest_at lets a re-run of the same week skip users already served.
alter table public.notif_prefs add column if not exists last_digest_at timestamptz;
