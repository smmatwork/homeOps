-- Add counts for repeatable spaces (e.g., balconies, terraces) on home_profiles

alter table if exists public.home_profiles
  add column if not exists space_counts jsonb not null default '{}'::jsonb;
