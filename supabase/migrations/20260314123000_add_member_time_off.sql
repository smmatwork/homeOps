-- Member time off (leave)

create table if not exists public.member_time_off (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  member_kind text not null check (member_kind in ('person','helper')),
  person_id uuid null references public.household_people(id) on delete cascade,
  helper_id uuid null references public.helpers(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_time_off_member_ref_check check (
    (member_kind = 'person' and person_id is not null and helper_id is null)
    or
    (member_kind = 'helper' and helper_id is not null and person_id is null)
  ),
  constraint member_time_off_time_check check (end_at > start_at)
);

create index if not exists member_time_off_household_id_idx
  on public.member_time_off (household_id);

create index if not exists member_time_off_person_id_idx
  on public.member_time_off (person_id);

create index if not exists member_time_off_helper_id_idx
  on public.member_time_off (helper_id);

create index if not exists member_time_off_household_start_idx
  on public.member_time_off (household_id, start_at desc);

create trigger handle_updated_at_member_time_off
  before update on public.member_time_off
  for each row
  execute function public.handle_updated_at();

-- RLS
alter table public.member_time_off enable row level security;

-- member_time_off: read by household members, write by admins
create policy "member_time_off_select_household_access" on public.member_time_off
  for select
  using (public.can_access_household(household_id));

create policy "member_time_off_insert_admin" on public.member_time_off
  for insert
  with check (public.is_household_admin(household_id));

create policy "member_time_off_update_admin" on public.member_time_off
  for update
  using (public.is_household_admin(household_id))
  with check (public.is_household_admin(household_id));

create policy "member_time_off_delete_admin" on public.member_time_off
  for delete
  using (public.is_household_admin(household_id));
