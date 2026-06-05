-- =========================================================================
-- AIpályázó — initial schema
-- =========================================================================
-- Tier model:
--   anonymous → not logged in (no row anywhere)
--   basic     → registered, free; can save grants + opt into generic digest
--   pro       → paid 5067 Ft/hó (gross) via Paddle; full personalisation
-- =========================================================================

-- profiles: 1:1 with auth.users, holds business identity + tier flag.
create table public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null,
  display_name    text,
  -- Tier state. Source of truth: the Paddle webhook function.
  -- Frontend NEVER sets this; it only reads.
  tier            text not null default 'basic' check (tier in ('basic','pro')),
  -- Pro-only business profile fields (collected post-upgrade, used for scoring)
  company         text,
  industry        text,
  employees       text,
  revenue         text,
  location        text,
  years_operating text,
  legal_form      text,
  categories      text[],
  -- Bookkeeping
  gdpr_consent_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- subscriptions: Paddle webhook is the only writer. One active row per user.
create table public.subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  paddle_customer_id    text,
  paddle_subscription_id text unique,
  status                text not null check (status in ('trialing','active','past_due','canceled','expired')),
  billing_interval      text not null check (billing_interval in ('monthly','annual')),
  current_period_start  timestamptz,
  current_period_end    timestamptz not null,
  cancel_at             timestamptz,
  canceled_at           timestamptz,
  -- Hungarian invoicing trail (Paddle MoR handles NAV reporting)
  last_invoice_id       text,
  last_invoice_url      text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index subscriptions_user_id_idx on public.subscriptions(user_id);
create index subscriptions_status_idx on public.subscriptions(status);

-- bookmarks: a user's saved grants. Free tier feature.
create table public.bookmarks (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  grant_id   text not null,
  note       text,
  created_at timestamptz not null default now(),
  primary key (user_id, grant_id)
);

-- leads: consultation requests (visible to anonymous too via signed-out path,
-- but here we only store the ones from registered users for cross-device sync).
create table public.leads (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references public.profiles(id) on delete set null,
  grant_id        text not null,
  grant_title     text,
  name            text not null,
  email           text not null,
  phone           text,
  gdpr_consent_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index leads_grant_id_idx on public.leads(grant_id);
create index leads_created_at_idx on public.leads(created_at desc);

-- drafts: AI-generated bid/application drafts (Pro feature, persisted).
create table public.drafts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  grant_id    text not null,
  grant_title text,
  sections    jsonb not null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index drafts_user_id_idx on public.drafts(user_id);

-- notif_prefs: weekly digest configuration. Basic gets generic; Pro can personalize.
create table public.notif_prefs (
  user_id          uuid primary key references public.profiles(id) on delete cascade,
  weekly_enabled   boolean not null default true,
  urgent_enabled   boolean not null default true,
  frequency        text not null default 'heti' check (frequency in ('heti','kétheti','havi')),
  recipient_email  text,
  -- Pro-only personalisation toggles
  section_top_n           int default 5,
  section_new_since_last  boolean default true,
  section_deadlines       boolean default true,
  section_totals          boolean default true,
  section_saved_updates   boolean default false,
  updated_at       timestamptz not null default now()
);

-- =========================================================================
-- Row-Level Security — assume the client is hostile, enforce per-row.
-- =========================================================================
alter table public.profiles      enable row level security;
alter table public.subscriptions enable row level security;
alter table public.bookmarks     enable row level security;
alter table public.leads         enable row level security;
alter table public.drafts        enable row level security;
alter table public.notif_prefs   enable row level security;

-- profiles: a user can read and update their own row (NEVER tier).
create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles: update own (except tier)" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id and tier = (select tier from public.profiles where id = auth.uid()));

-- subscriptions: read own only. Writes are service-role only (the webhook).
create policy "subs: read own" on public.subscriptions
  for select using (auth.uid() = user_id);

-- bookmarks: full CRUD on own rows.
create policy "bookmarks: select own" on public.bookmarks
  for select using (auth.uid() = user_id);
create policy "bookmarks: insert own" on public.bookmarks
  for insert with check (auth.uid() = user_id);
create policy "bookmarks: delete own" on public.bookmarks
  for delete using (auth.uid() = user_id);

-- leads: insert for any signed-in user (consultation requests). Read own only.
create policy "leads: insert own or anonymous" on public.leads
  for insert with check (auth.uid() = user_id or user_id is null);
create policy "leads: read own" on public.leads
  for select using (auth.uid() = user_id);

-- drafts: Pro-tier-only. RLS checks the profile's tier on every access.
create policy "drafts: pro read own" on public.drafts
  for select using (
    auth.uid() = user_id
    and (select tier from public.profiles where id = auth.uid()) = 'pro'
  );
create policy "drafts: pro write own" on public.drafts
  for insert with check (
    auth.uid() = user_id
    and (select tier from public.profiles where id = auth.uid()) = 'pro'
  );
create policy "drafts: pro update own" on public.drafts
  for update using (
    auth.uid() = user_id
    and (select tier from public.profiles where id = auth.uid()) = 'pro'
  );
create policy "drafts: pro delete own" on public.drafts
  for delete using (
    auth.uid() = user_id
    and (select tier from public.profiles where id = auth.uid()) = 'pro'
  );

-- notif_prefs: read/write own.
create policy "notif: select own" on public.notif_prefs
  for select using (auth.uid() = user_id);
create policy "notif: insert own" on public.notif_prefs
  for insert with check (auth.uid() = user_id);
create policy "notif: update own" on public.notif_prefs
  for update using (auth.uid() = user_id);

-- =========================================================================
-- Triggers
-- =========================================================================
-- On user signup → automatically create a basic-tier profile row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)));
  insert into public.notif_prefs (user_id, recipient_email) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at automation on every UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at      before update on public.profiles      for each row execute function public.set_updated_at();
create trigger subscriptions_updated_at before update on public.subscriptions for each row execute function public.set_updated_at();
create trigger drafts_updated_at        before update on public.drafts        for each row execute function public.set_updated_at();
create trigger notif_prefs_updated_at   before update on public.notif_prefs   for each row execute function public.set_updated_at();

-- =========================================================================
-- Helpful views
-- =========================================================================
-- A single tier-resolved row per user, joining the latest active subscription.
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
  p.employees,
  p.revenue,
  p.location,
  p.years_operating,
  p.legal_form,
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
