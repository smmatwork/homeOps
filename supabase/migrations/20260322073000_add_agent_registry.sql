create table if not exists public.agent_registry (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  key text not null,
  display_name text not null,
  enabled boolean not null default true,
  model text null,
  system_prompt text not null,
  tool_allowlist jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_registry_household_key_unique unique (household_id, key)
);

alter table public.agent_registry enable row level security;

drop trigger if exists set_agent_registry_updated_at on public.agent_registry;
create trigger set_agent_registry_updated_at before update on public.agent_registry
for each row execute function public.handle_updated_at();

-- Members can read
create policy "agent_registry_select_household_access" on public.agent_registry
for select using (public.can_access_household(household_id));

-- Only admins can write
create policy "agent_registry_insert_admin" on public.agent_registry
for insert with check (public.is_household_admin(household_id));

create policy "agent_registry_update_admin" on public.agent_registry
for update using (public.is_household_admin(household_id))
with check (public.is_household_admin(household_id));

create policy "agent_registry_delete_admin" on public.agent_registry
for delete using (public.is_household_admin(household_id));
