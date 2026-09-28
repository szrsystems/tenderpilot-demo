-- =========================================================================
-- Lead pipeline + data hardening (2026-09-28)
-- =========================================================================
-- 1. leads: server-side reference (L-XXXXXX), status loop for the grant-writer
--    partner, notification bookkeeping, input-size CHECKs. Browsers can no
--    longer INSERT leads — only the `lead-submit` edge function (service role).
-- 2. profiles: signed-in users may UPDATE only an allow-list of columns
--    (never email / id / created_at / gdpr_consent_at).
-- 3. notif_prefs.calendar_token: private iCal feed token (read-only for users).
-- 4. deleted_emails: stores sha256(lower(email)) only; 180-day retention.
-- 5. ai_usage_global: global daily cap for the paid AI API.
--
-- Apply via the Supabase SQL Editor, after 20260925000001. Safe to re-run.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) leads
-- -------------------------------------------------------------------------
alter table public.leads add column if not exists lead_ref          text;
alter table public.leads add column if not exists status            text not null default 'new';
alter table public.leads add column if not exists notified_at       timestamptz;
alter table public.leads add column if not exists notify_attempts   int not null default 0;
alter table public.leads add column if not exists notify_error      text;
alter table public.leads add column if not exists notify_locked_until timestamptz;
alter table public.leads add column if not exists company           text;
alter table public.leads add column if not exists message           text;
alter table public.leads add column if not exists match_snapshot    jsonb;
alter table public.leads add column if not exists ip_hash           text;
alter table public.leads add column if not exists status_note       text;
alter table public.leads add column if not exists status_updated_at timestamptz;
alter table public.leads add column if not exists updated_at        timestamptz default now();

-- 'L-' + 6 characters of RFC 4648 base32 (A–Z, 2–7) = 2^30 values.
-- Bytes 0–5 of a v4 UUID are fully random; 256 % 32 = 0, so no modulo bias.
create or replace function public.gen_lead_ref()
returns text
language plpgsql
volatile
as $$
declare
  b bytea := uuid_send(gen_random_uuid());
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  r text := 'L-';
begin
  for i in 0..5 loop
    r := r || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return r;
end;
$$;

-- Rows from before this migration: give them a ref; they were never
-- forwarded automatically, so they must NOT be picked up by the retry job
-- (that would mail the partner every historical lead at once).
do $$
begin
  if exists (select 1 from public.leads where lead_ref is null) then
    update public.leads
       set lead_ref        = public.gen_lead_ref(),
           notify_attempts = 5,
           notify_error    = 'legacy_pre_pipeline'
     where lead_ref is null;
  end if;
end $$;
update public.leads set email = lower(btrim(email)) where email <> lower(btrim(email));

alter table public.leads alter column lead_ref set default public.gen_lead_ref();
alter table public.leads alter column lead_ref set not null;
create unique index if not exists leads_lead_ref_key on public.leads(lead_ref);
create index if not exists leads_email_created_idx  on public.leads(email, created_at desc);
create index if not exists leads_ip_created_idx     on public.leads(ip_hash, created_at desc) where ip_hash is not null;
create index if not exists leads_status_idx         on public.leads(status);
create index if not exists leads_unnotified_idx     on public.leads(created_at) where notified_at is null;

-- CHECK constraints. Added NOT VALID (new/updated rows are always checked),
-- then validated; if a legacy row violates one, it stays NOT VALID with a
-- notice instead of failing the whole migration.
do $$
declare
  defs text[][] := array[
    ['leads_status_check',   $c$status in ('new','sent','contacted','applied','won','lost','paid','spam')$c$],
    ['leads_lead_ref_fmt',   $c$lead_ref ~ '^L-[A-Z2-7]{6}$'$c$],
    ['leads_name_len',       $c$char_length(name) between 2 and 120$c$],
    ['leads_email_fmt',      $c$char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'$c$],
    ['leads_phone_len',      $c$phone is null or char_length(phone) <= 40$c$],
    ['leads_grant_id_len',   $c$char_length(grant_id) between 1 and 200$c$],
    ['leads_grant_title_len',$c$grant_title is null or char_length(grant_title) <= 300$c$],
    ['leads_company_len',    $c$company is null or char_length(company) <= 200$c$],
    ['leads_message_len',    $c$message is null or char_length(message) <= 2000$c$],
    ['leads_status_note_len',$c$status_note is null or char_length(status_note) <= 1000$c$],
    ['leads_notify_error_len',$c$notify_error is null or char_length(notify_error) <= 500$c$],
    ['leads_match_size',     $c$match_snapshot is null or pg_column_size(match_snapshot) <= 20480$c$]
  ];
  i int;
begin
  for i in 1 .. array_length(defs, 1) loop
    if not exists (select 1 from pg_constraint
                    where conname = defs[i][1] and conrelid = 'public.leads'::regclass) then
      execute format('alter table public.leads add constraint %I check (%s) not valid', defs[i][1], defs[i][2]);
    end if;
  end loop;
end $$;

do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.leads'::regclass and contype = 'c' and not convalidated loop
    begin
      execute format('alter table public.leads validate constraint %I', c);
    exception when check_violation then
      raise notice 'leads constraint % left NOT VALID: legacy rows violate it', c;
    end;
  end loop;
end $$;

-- updated_at + status_updated_at bookkeeping.
create or replace function public.leads_before_update()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if new.status is distinct from old.status then
    new.status_updated_at = now();
  end if;
  return new;
end;
$$;
drop trigger if exists leads_before_update on public.leads;
create trigger leads_before_update before update on public.leads
  for each row execute function public.leads_before_update();

-- Atomically claim a lead for the partner notification: at most one sender
-- at a time (lead-submit vs. the lead-digest retry), at most p_max attempts,
-- never after a successful send.
create or replace function public.claim_lead_notify(p_id uuid, p_max int default 5)
returns boolean
language plpgsql
as $$
begin
  update public.leads
     set notify_attempts     = notify_attempts + 1,
         notify_locked_until = now() + interval '5 minutes'
   where id = p_id
     and notified_at is null
     and notify_attempts < p_max
     and (notify_locked_until is null or notify_locked_until < now());
  return found;
end;
$$;
revoke all on function public.claim_lead_notify(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_lead_notify(uuid, int) to service_role;

-- Only the service role writes leads now. Users keep read access to their
-- own rows, limited to what they themselves submitted (no internal fields).
drop policy if exists "leads: insert own or anonymous" on public.leads;
revoke insert, update, delete, truncate on public.leads from anon, authenticated;
revoke select on public.leads from anon, authenticated;
grant select (id, user_id, grant_id, grant_title, name, email, phone, company, message,
              lead_ref, status, gdpr_consent_at, created_at)
  on public.leads to authenticated;
drop policy if exists "leads: read own" on public.leads;
create policy "leads: read own" on public.leads
  for select to authenticated using (auth.uid() = user_id);

-- -------------------------------------------------------------------------
-- 2) profiles: column allow-list for UPDATE (onboarding.html + portal.html
--    saveProfile/syncProfile* write exactly these). No client INSERT at all:
--    rows are created by the handle_new_user() trigger.
-- -------------------------------------------------------------------------
revoke insert, update on public.profiles from anon, authenticated;
grant update (display_name, phone, company, industry, industries, employees, revenue,
              location, site_region, years_operating, legal_form, public_debt_free,
              own_funds, in_difficulty, teaor, categories)
  on public.profiles to authenticated;

-- -------------------------------------------------------------------------
-- 3) notif_prefs.calendar_token — secret for the personal iCal feed
--    (edge function `calendar`). Readable by the owner (existing SELECT
--    policy); NOT in the column grants of 20260924000001, so not writable.
-- -------------------------------------------------------------------------
alter table public.notif_prefs
  add column if not exists calendar_token uuid not null default gen_random_uuid();
create unique index if not exists notif_prefs_calendar_token_idx
  on public.notif_prefs(calendar_token);

-- Let a user invalidate a leaked calendar link (new token, old one stops working).
create or replace function public.rotate_calendar_token()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update public.notif_prefs set calendar_token = gen_random_uuid()
   where user_id = auth.uid()
  returning calendar_token into t;
  return t;
end;
$$;
revoke all on function public.rotate_calendar_token() from public, anon;
grant execute on function public.rotate_calendar_token() to authenticated;

-- -------------------------------------------------------------------------
-- 4) deleted_emails → hashes only
-- -------------------------------------------------------------------------
-- RETENTION: a row only exists to stop a deleted account being silently
-- re-created (e.g. Google OAuth creates users on demand). We keep the
-- sha256 of the lower-cased address for 180 days, then purge_deleted_emails()
-- (called daily by the lead-digest cron) removes it. No plaintext is stored.
create or replace function public.email_hash(p text)
returns text
language sql
immutable
as $$ select encode(sha256(convert_to(lower(btrim(p)), 'UTF8')), 'hex') $$;

alter table public.deleted_emails add column if not exists email_hash text;
alter table public.deleted_emails add column if not exists created_at timestamptz not null default now();

do $$
declare pk_col text;
begin
  -- hash any plaintext still present
  update public.deleted_emails
     set email_hash = public.email_hash(email)
   where email is not null and email_hash is null;
  update public.deleted_emails set created_at = deleted_at where deleted_at < created_at;
  -- de-duplicate addresses that differed only in case
  delete from public.deleted_emails a
   using public.deleted_emails b
   where a.email_hash = b.email_hash and a.ctid > b.ctid;
  -- move the primary key from email to email_hash
  select a.attname into pk_col
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
   where i.indrelid = 'public.deleted_emails'::regclass and i.indisprimary
   limit 1;
  if pk_col is distinct from 'email_hash' then
    if pk_col is not null then
      execute (select format('alter table public.deleted_emails drop constraint %I', conname)
                 from pg_constraint where conrelid = 'public.deleted_emails'::regclass and contype = 'p');
    end if;
    alter table public.deleted_emails alter column email drop not null;
    alter table public.deleted_emails alter column email_hash set not null;
    alter table public.deleted_emails add primary key (email_hash);
  end if;
  update public.deleted_emails set email = null where email is not null;
end $$;

-- `email` stays only as a write-only compatibility column: legacy clients
-- still insert {email: ...}; the trigger hashes it and blanks it.
create or replace function public.deleted_emails_hash()
returns trigger
language plpgsql
as $$
begin
  if new.email is not null then
    new.email_hash := public.email_hash(new.email);
    new.email := null;
  end if;
  new.email_hash := lower(new.email_hash);
  return new;
end;
$$;
drop trigger if exists deleted_emails_hash on public.deleted_emails;
create trigger deleted_emails_hash before insert or update on public.deleted_emails
  for each row execute function public.deleted_emails_hash();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deleted_emails_hash_fmt'
                  and conrelid = 'public.deleted_emails'::regclass) then
    alter table public.deleted_emails add constraint deleted_emails_hash_fmt
      check (email_hash ~ '^[0-9a-f]{64}$' and email is null);
  end if;
end $$;

drop policy if exists "deleted_emails: read own email only" on public.deleted_emails;
drop policy if exists "deleted_emails: read own hash"       on public.deleted_emails;
create policy "deleted_emails: read own hash" on public.deleted_emails
  for select to authenticated
  using (email_hash = public.email_hash(auth.email()));
drop policy if exists "deleted_emails: insert own" on public.deleted_emails;
create policy "deleted_emails: insert own" on public.deleted_emails
  for insert to authenticated
  with check (email_hash = public.email_hash(auth.email()));
revoke all on public.deleted_emails from anon;
revoke update, delete, truncate on public.deleted_emails from authenticated;

-- Sign-in check for clients: true when the caller's own address is blocked.
create or replace function public.is_email_deleted()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.email() is not null
     and exists (select 1 from public.deleted_emails where email_hash = public.email_hash(auth.email()));
$$;
revoke all on function public.is_email_deleted() from public, anon;
grant execute on function public.is_email_deleted() to authenticated;

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
  return n;
end;
$$;
revoke all on function public.purge_deleted_emails() from public, anon, authenticated;
grant execute on function public.purge_deleted_emails() to service_role;

-- Keep the re-registration block working with hashes: a new auth user whose
-- address is on the list gets the '__DELETED__' profile sentinel, which the
-- existing client check (lib/supabase.js checkDeletedAccount) already refuses.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare blocked boolean;
begin
  blocked := new.email is not null and exists (
    select 1 from public.deleted_emails where email_hash = public.email_hash(new.email));
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email,
          case when blocked then '__DELETED__'
               else coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)) end);
  insert into public.notif_prefs (user_id, recipient_email) values (new.id, new.email);
  return new;
end;
$$;

-- -------------------------------------------------------------------------
-- 5) Global daily AI cap (all users together) — service role only.
-- -------------------------------------------------------------------------
create table if not exists public.ai_usage_global (
  day   date primary key default current_date,
  count int  not null default 0
);
alter table public.ai_usage_global enable row level security;  -- no policies
revoke all on public.ai_usage_global from anon, authenticated;

create or replace function public.bump_ai_global(p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare c int;
begin
  insert into public.ai_usage_global (day, count) values (current_date, 1)
  on conflict (day) do update set count = ai_usage_global.count + 1
  returning count into c;
  return c <= p_limit;
end;
$$;
revoke all on function public.bump_ai_global(int) from public, anon, authenticated;
grant execute on function public.bump_ai_global(int) to service_role;
