create table if not exists public.household_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  type text not null,
  start_at timestamptz not null,
  end_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists household_events_household_start_idx
  on public.household_events (household_id, start_at desc);

create trigger handle_updated_at_household_events
  before update on public.household_events
  for each row
  execute function public.handle_updated_at();

alter table public.household_events enable row level security;

create policy "household_events_select_household_access" on public.household_events
  for select
  using (public.can_access_household(household_id));

create policy "household_events_insert_admin" on public.household_events
  for insert
  with check (public.is_household_admin(household_id));

create policy "household_events_update_admin" on public.household_events
  for update
  using (public.is_household_admin(household_id))
  with check (public.is_household_admin(household_id));

create policy "household_events_delete_admin" on public.household_events
  for delete
  using (public.is_household_admin(household_id));

create table if not exists public.cleaning_feedback (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  rating smallint not null check (rating >= 1 and rating <= 5),
  notes text null,
  areas jsonb null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists cleaning_feedback_household_created_at_idx
  on public.cleaning_feedback (household_id, created_at desc);

alter table public.cleaning_feedback enable row level security;

create policy "cleaning_feedback_select_household_access" on public.cleaning_feedback
  for select
  using (public.can_access_household(household_id));

create policy "cleaning_feedback_insert_household_access" on public.cleaning_feedback
  for insert
  with check (public.can_access_household(household_id) and created_by = auth.uid());

create policy "cleaning_feedback_delete_admin" on public.cleaning_feedback
  for delete
  using (public.is_household_admin(household_id));
