-- Add phone column to profiles (signup form now captures it as an optional
-- field). Free-text for now; if/when SMS OTP verification is added later, a
-- phone_verified_at timestamp can go alongside.

alter table public.profiles add column if not exists phone text;
