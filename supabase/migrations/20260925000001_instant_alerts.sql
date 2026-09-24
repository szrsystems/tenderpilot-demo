-- =========================================================================
-- Instant alerts (2026-09-25) — opt-in, off by default
-- =========================================================================
-- instant_enabled: e-mail the same day when (a) a NEW call appears that the
-- company is eligible for (match score ≥ 70), or (b) a SAVED call's official
-- budget passes 80% committed. alert_log makes sure nothing is sent twice.
-- Apply via the Supabase SQL Editor, after 20260924000001. Safe to re-run.

alter table public.notif_prefs
  add column if not exists instant_enabled boolean not null default false;

-- users may switch it on/off themselves (column-level grants from 0924)
grant insert (instant_enabled) on public.notif_prefs to authenticated;
grant update (instant_enabled) on public.notif_prefs to authenticated;

create table if not exists public.alert_log (
  user_id  uuid not null references auth.users(id) on delete cascade,
  grant_id text not null,
  kind     text not null check (kind in ('new', 'budget')),
  sent_at  timestamptz not null default now(),
  primary key (user_id, grant_id, kind)
);
alter table public.alert_log enable row level security;  -- no policies: service role only
