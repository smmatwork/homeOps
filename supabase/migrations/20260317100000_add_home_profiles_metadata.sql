-- Add flexible metadata storage for home_profiles (used for coverage baseline, etc.)

alter table if exists public.home_profiles
  add column if not exists metadata jsonb not null default '{}'::jsonb;
