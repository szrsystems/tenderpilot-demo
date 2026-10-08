-- =========================================================================
-- Campaign attribution (partner campaigns, e.g. DFT-Hungária).
--
-- Partner links carry ?utm_source=…&utm_campaign=…&utm_medium=… . The
-- browser keeps the first one it saw (lib/attribution.js) and sends it
--   * with the profile (acq_*) after sign-in / onboarding, and
--   * with every consultation request (leads.utm_*), via lead-submit.
-- Tags are short [a-z0-9._-] strings; they identify a campaign, not a person.
-- profiles.acq_* is first-touch: once set it never changes (trigger below),
-- so a later click on another campaign cannot rewrite who brought the user.
-- =========================================================================

alter table public.leads add column if not exists utm_source   text;
alter table public.leads add column if not exists utm_campaign text;
alter table public.leads add column if not exists utm_medium   text;

alter table public.profiles add column if not exists acq_source   text;
alter table public.profiles add column if not exists acq_campaign text;
alter table public.profiles add column if not exists acq_medium   text;
alter table public.profiles add column if not exists acq_at       timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_utm_fmt' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_utm_fmt check (
      (utm_source   is null or utm_source   ~ '^[a-z0-9._-]{1,60}$') and
      (utm_campaign is null or utm_campaign ~ '^[a-z0-9._-]{1,60}$') and
      (utm_medium   is null or utm_medium   ~ '^[a-z0-9._-]{1,60}$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_acq_fmt' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_acq_fmt check (
      (acq_source   is null or acq_source   ~ '^[a-z0-9._-]{1,60}$') and
      (acq_campaign is null or acq_campaign ~ '^[a-z0-9._-]{1,60}$') and
      (acq_medium   is null or acq_medium   ~ '^[a-z0-9._-]{1,60}$'));
  end if;
end $$;

create index if not exists leads_utm_source_idx on public.leads(utm_source, created_at desc) where utm_source is not null;
create index if not exists profiles_acq_source_idx on public.profiles(acq_source) where acq_source is not null;

-- Users may set their own attribution once (column grant + first-touch trigger).
grant update (acq_source, acq_campaign, acq_medium, acq_at) on public.profiles to authenticated;
-- Users can see the campaign tag on their own leads (harmless, keeps the column list explicit).
grant select (utm_source, utm_campaign) on public.leads to authenticated;

create or replace function public.profiles_acq_first_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.acq_source is not null then
    new.acq_source := old.acq_source; new.acq_campaign := old.acq_campaign;
    new.acq_medium := old.acq_medium; new.acq_at := old.acq_at;
  elsif new.acq_source is not null then
    -- acq_at is the server's time, not the browser's claim
    new.acq_at := least(coalesce(new.acq_at, now()), now());
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_acq_first_touch on public.profiles;
create trigger profiles_acq_first_touch before update on public.profiles
  for each row execute function public.profiles_acq_first_touch();
