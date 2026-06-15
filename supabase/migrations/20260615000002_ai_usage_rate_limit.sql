-- =========================================================================
-- AI usage rate limiting — protect the paid Gemini budget from abuse.
-- =========================================================================
-- ai-generate previously had NO rate limit: any signed-in user could call
-- task:"needs" (and Pro users task:"draft") in a loop and burn the owner's
-- LLM budget. This adds a per-user/day counter the Edge Function bumps via a
-- SECURITY DEFINER RPC (service role only — never reachable from the client).
-- =========================================================================

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;
-- No policies on purpose: only the service-role Edge Function touches this
-- table (via the RPC below). anon/authenticated get zero access.

-- Atomically increment today's counter and report whether the caller is still
-- under the limit. Returns true => allowed, false => over limit.
create or replace function public.bump_ai_usage(p_user uuid, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare c int;
begin
  insert into public.ai_usage (user_id, day, count)
  values (p_user, current_date, 1)
  on conflict (user_id, day)
  do update set count = ai_usage.count + 1
  returning count into c;
  return c <= p_limit;
end;
$$;

-- Only the service role (Edge Function) may call this. Block client roles.
revoke all on function public.bump_ai_usage(uuid, int) from public;
revoke all on function public.bump_ai_usage(uuid, int) from anon;
revoke all on function public.bump_ai_usage(uuid, int) from authenticated;
-- The Edge Function calls this as the service_role; after revoking from
-- public it needs an explicit grant, otherwise the RPC errors and the rate
-- limit "fails open" (silently does nothing).
grant execute on function public.bump_ai_usage(uuid, int) to service_role;
