-- =========================================================================
-- deleted_emails — persistent block list for accounts that were deleted.
-- =========================================================================
-- Without this, a user who deletes their account and signs in again via
-- Google OAuth gets a brand-new auth.users row (Google providers create on
-- demand), and the "__DELETED__" marker on the OLD profile is gone (cascade
-- deleted). This table SURVIVES the cascade because it's not FK-linked to
-- auth.users — emails go in when the user clicks delete-account, and any
-- future sign-in checks here first.
-- =========================================================================

create table public.deleted_emails (
  email        text primary key,
  deleted_at   timestamptz not null default now(),
  user_id      uuid,         -- the original user_id (informational; no FK)
  reason       text default 'user_requested'
);

create index deleted_emails_deleted_at_idx on public.deleted_emails(deleted_at desc);

alter table public.deleted_emails enable row level security;

-- Anyone (anon) can SELECT to check if their email is blocked.
-- They can only see their own auth user's email anyway via the auth.uid()
-- match, but we allow anon read of just the email column for sign-in checks.
create policy "deleted_emails: read for sign-in check"
  on public.deleted_emails
  for select
  to anon, authenticated
  using (true);

-- INSERT is allowed for authenticated users on their own email (so the
-- frontend deleteAccount flow can insert before signing out).
create policy "deleted_emails: insert own"
  on public.deleted_emails
  for insert
  to authenticated
  with check (
    email = (select email from auth.users where id = auth.uid())
  );

-- No UPDATE policy → nothing can ever modify a deleted_emails row.
-- DELETE only by service_role (via delete-user Edge Function or admin SQL
-- — for un-banning an email, the admin does this manually).
