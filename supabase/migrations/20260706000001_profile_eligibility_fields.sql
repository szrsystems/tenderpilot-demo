-- =========================================================================
-- Profile eligibility fields (2026-07-06) — v2
-- =========================================================================
-- v1 failed with 42P16: CREATE OR REPLACE VIEW cannot reorder/insert view
-- columns — the view must be DROPped and recreated instead.
-- NOTE: run together with 20260706000002_drop_billing.sql (one combined
-- paste in the SQL Editor). The view is recreated THERE, after the dead
-- billing columns are dropped, so it's only dropped/created once.
--
-- Apply via the Supabase SQL Editor, NOT `db push`.

alter table public.profiles add column if not exists industries       text[];
alter table public.profiles add column if not exists site_region      text;
alter table public.profiles add column if not exists public_debt_free text;
alter table public.profiles add column if not exists own_funds        text;
alter table public.profiles add column if not exists in_difficulty    text;
alter table public.profiles add column if not exists teaor            text;

-- Backfill: users who set a single industry before multi-select existed.
update public.profiles
   set industries = array[industry]
 where industries is null
   and industry is not null
   and industry <> '';
