-- =========================================================================
-- Abuse limits found in the independent audit (2026-11-27)
-- =========================================================================
-- 1) company_lookup_log: every tax-number lookup is logged (user, target,
--    time). The company-lookup edge function allows at most 10 different
--    lookups per user per 24 hours (it used to share the 150/day AI counter,
--    so a free account could look up 150 companies — or sole traders — a day).
--    Service-role only; rows are purged after 90 days.
-- 2) bookmarks: at most 500 saved calls per user (a script could otherwise
--    insert unlimited rows).
-- Apply after 20261125000001. Safe to re-run.
-- =========================================================================

create table if not exists public.company_lookup_log (
  id       bigserial primary key,
  user_id  uuid not null,
  tax8     text not null check (tax8 ~ '^[0-9]{8}$'),
  at       timestamptz not null default now()
);
create index if not exists company_lookup_log_user_at on public.company_lookup_log (user_id, at desc);
alter table public.company_lookup_log enable row level security;
revoke all on public.company_lookup_log from anon, authenticated;
-- no policies: only the service role (edge function) reads and writes

create or replace function public.purge_company_data()
returns int
language sql
security definer
set search_path = public
as $$
  with d as (delete from public.company_data where fetched_at < now() - interval '365 days' returning 1),
       l as (delete from public.company_lookup_log where at < now() - interval '90 days' returning 1)
  select ((select count(*) from d) + (select count(*) from l))::int;
$$;
revoke all on function public.purge_company_data() from public, anon, authenticated;
grant execute on function public.purge_company_data() to service_role;

create or replace function public.bookmarks_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.bookmarks where user_id = new.user_id) >= 500 then
    raise exception 'bookmark limit reached' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.bookmarks_cap() from public, anon, authenticated;
drop trigger if exists bookmarks_cap on public.bookmarks;
create trigger bookmarks_cap before insert on public.bookmarks
  for each row execute function public.bookmarks_cap();
