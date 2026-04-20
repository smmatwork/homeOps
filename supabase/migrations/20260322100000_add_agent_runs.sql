create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null,
  trigger text not null,
  graph_key text not null,
  status text not null default 'queued',
  input jsonb not null default '{}'::jsonb,
  output jsonb null,
  error text null,
  started_at timestamptz null,
  ended_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_runs_status_check check (status in ('queued','running','succeeded','failed','canceled'))
);

create index if not exists agent_runs_household_created_at_idx on public.agent_runs (household_id, created_at desc);
create index if not exists agent_runs_household_status_idx on public.agent_runs (household_id, status);

alter table public.agent_runs enable row level security;

drop trigger if exists set_agent_runs_updated_at on public.agent_runs;
create trigger set_agent_runs_updated_at before update on public.agent_runs
for each row execute function public.handle_updated_at();

create policy "agent_runs_select_household_access" on public.agent_runs
for select using (public.can_access_household(household_id));

create policy "agent_runs_insert_household_access" on public.agent_runs
for insert with check (public.can_access_household(household_id) and created_by = auth.uid());

create policy "agent_runs_update_admin" on public.agent_runs
for update using (public.is_household_admin(household_id))
with check (public.is_household_admin(household_id));

create policy "agent_runs_delete_admin" on public.agent_runs
for delete using (public.is_household_admin(household_id));

create table if not exists public.agent_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  node_key text null,
  level text not null default 'info',
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_run_events_level_check check (level in ('info','warn','error'))
);

create index if not exists agent_run_events_run_created_at_idx on public.agent_run_events (run_id, created_at asc);
create index if not exists agent_run_events_household_created_at_idx on public.agent_run_events (household_id, created_at asc);

alter table public.agent_run_events enable row level security;

create policy "agent_run_events_select_household_access" on public.agent_run_events
for select using (public.can_access_household(household_id));

create policy "agent_run_events_insert_household_access" on public.agent_run_events
for insert with check (public.can_access_household(household_id));

create policy "agent_run_events_update_admin" on public.agent_run_events
for update using (public.is_household_admin(household_id))
with check (public.is_household_admin(household_id));

create policy "agent_run_events_delete_admin" on public.agent_run_events
for delete using (public.is_household_admin(household_id));
