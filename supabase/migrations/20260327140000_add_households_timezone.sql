alter table public.households
  add column if not exists timezone text not null default 'Asia/Kolkata';

create index if not exists households_timezone_idx
  on public.households (timezone);
