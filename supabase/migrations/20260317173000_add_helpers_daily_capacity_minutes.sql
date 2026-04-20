alter table if exists public.helpers
  add column if not exists daily_capacity_minutes integer not null default 120;
