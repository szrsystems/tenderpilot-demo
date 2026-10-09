-- =========================================================================
-- Security audit fixes (2026-10-09)
-- =========================================================================
-- 1) Retention matches the privacy notice (adatvedelem.html):
--    - leads.ip_hash is cleared after 90 days (spam check only needs 24 h);
--    - leads older than 5 years are anonymised (name/email/phone/company/
--      message/match_snapshot removed; lead_ref, grant, status, dates kept
--      for the partner settlement record).
--    purge_deleted_emails() (already called daily by lead-digest) now does
--    both, so no new cron or function deploy is needed for the SQL part.
-- 2) Text-length limits on user-writable columns (profiles, bookmarks),
--    added NOT VALID so old rows never block the migration.
-- 3) The unused drafts table (draft feature removed) is closed to clients.
-- 4) A profile marked '__DELETED__' (re-registration block) cannot be
--    "un-marked" by the user through the display_name column grant.
-- Apply after 20260928000003. Safe to re-run.
-- =========================================================================

-- 1) retention ------------------------------------------------------------
create or replace function public.purge_deleted_emails()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.deleted_emails where created_at < now() - interval '180 days';
  get diagnostics n = row_count;

  update public.leads set ip_hash = null
   where ip_hash is not null and created_at < now() - interval '90 days';

  update public.leads
     set name = 'Anonimizált',
         email = 'anonim+' || lead_ref || '@invalid.aipalyazo.hu',
         phone = null, company = null, message = null, match_snapshot = null,
         status_note = null, ip_hash = null, user_id = null
   where created_at < now() - interval '5 years'
     and name <> 'Anonimizált';

  return n;
end;
$$;
revoke all on function public.purge_deleted_emails() from public, anon, authenticated;
grant execute on function public.purge_deleted_emails() to service_role;

-- 2) length limits ----------------------------------------------------------
do $$
declare
  defs text[][] := array[
    ['profiles', 'profiles_display_name_len', $c$display_name is null or char_length(display_name) <= 120$c$],
    ['profiles', 'profiles_phone_len',        $c$phone is null or char_length(phone) <= 40$c$],
    ['profiles', 'profiles_company_len',      $c$company is null or char_length(company) <= 200$c$],
    ['profiles', 'profiles_industry_len',     $c$industry is null or char_length(industry) <= 200$c$],
    ['profiles', 'profiles_industries_len',   $c$industries is null or (cardinality(industries) <= 30 and char_length(array_to_string(industries, ',')) <= 2000)$c$],
    ['profiles', 'profiles_employees_len',    $c$employees is null or char_length(employees) <= 40$c$],
    ['profiles', 'profiles_revenue_len',      $c$revenue is null or char_length(revenue) <= 40$c$],
    ['profiles', 'profiles_location_len',     $c$location is null or char_length(location) <= 120$c$],
    ['profiles', 'profiles_site_region_len',  $c$site_region is null or char_length(site_region) <= 120$c$],
    ['profiles', 'profiles_years_len',        $c$years_operating is null or char_length(years_operating) <= 40$c$],
    ['profiles', 'profiles_legal_form_len',   $c$legal_form is null or char_length(legal_form) <= 80$c$],
    ['profiles', 'profiles_debt_free_len',    $c$public_debt_free is null or char_length(public_debt_free) <= 20$c$],
    ['profiles', 'profiles_own_funds_len',    $c$own_funds is null or char_length(own_funds) <= 20$c$],
    ['profiles', 'profiles_difficulty_len',   $c$in_difficulty is null or char_length(in_difficulty) <= 20$c$],
    ['profiles', 'profiles_teaor_len',        $c$teaor is null or char_length(teaor) <= 400$c$],
    ['profiles', 'profiles_categories_len',   $c$categories is null or (cardinality(categories) <= 40 and char_length(array_to_string(categories, ',')) <= 2000)$c$],
    ['profiles', 'profiles_acq_len',          $c$char_length(coalesce(acq_source, '') || coalesce(acq_campaign, '') || coalesce(acq_medium, '')) <= 300$c$],
    ['bookmarks', 'bookmarks_grant_id_len',   $c$char_length(grant_id) between 1 and 200$c$],
    ['bookmarks', 'bookmarks_note_len',       $c$note is null or char_length(note) <= 2000$c$]
  ];
  i int;
begin
  for i in 1 .. array_length(defs, 1) loop
    if not exists (select 1 from pg_constraint
                    where conname = defs[i][2] and conrelid = ('public.' || defs[i][1])::regclass) then
      execute format('alter table public.%I add constraint %I check (%s) not valid', defs[i][1], defs[i][2], defs[i][3]);
    end if;
  end loop;
end $$;

-- 3) drafts: feature removed, keep the data but block client access --------
revoke all on public.drafts from anon, authenticated;

-- 4) deleted-account marker is sticky ---------------------------------------
create or replace function public.keep_deleted_marker()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.display_name = '__DELETED__' and new.display_name is distinct from '__DELETED__'
     and current_user in ('authenticated', 'anon') then
    new.display_name := '__DELETED__';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_keep_deleted_marker on public.profiles;
create trigger profiles_keep_deleted_marker
  before update on public.profiles
  for each row execute function public.keep_deleted_marker();
