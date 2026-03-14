-- Extend home_profiles to support richer home layouts

alter table if exists public.home_profiles
  add column if not exists square_feet integer null,
  add column if not exists floors smallint null,
  add column if not exists spaces jsonb not null default '[]'::jsonb;
