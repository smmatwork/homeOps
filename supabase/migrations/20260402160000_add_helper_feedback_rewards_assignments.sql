-- Helper assignment history, feedback, and rewards (additive)

create table if not exists public.chore_helper_assignments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  chore_id uuid not null references public.chores(id) on delete cascade,
  helper_id uuid null references public.helpers(id) on delete set null,
  action text not null check (action in ('assigned','unassigned','reassigned')),
  assigned_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  metadata jsonb null
);

create index if not exists chore_helper_assignments_household_id_idx
  on public.chore_helper_assignments (household_id);
create index if not exists chore_helper_assignments_chore_id_idx
  on public.chore_helper_assignments (chore_id);
create index if not exists chore_helper_assignments_helper_id_idx
  on public.chore_helper_assignments (helper_id);
create index if not exists chore_helper_assignments_household_created_idx
  on public.chore_helper_assignments (household_id, created_at desc);

alter table public.chore_helper_assignments enable row level security;

create policy "chore_helper_assignments_select_household_access" on public.chore_helper_assignments
  for select
  using (public.can_access_household(household_id));

create policy "chore_helper_assignments_insert_admin" on public.chore_helper_assignments
  for insert
  with check (public.is_household_admin(household_id));

-- Feedback on helpers
create table if not exists public.helper_feedback (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  author_id uuid null references public.profiles(id) on delete set null,
  rating int not null check (rating >= 1 and rating <= 5),
  comment text null,
  tags text[] null,
  occurred_at timestamptz not null default now(),
  chore_id uuid null references public.chores(id) on delete set null,
  created_at timestamptz not null default now(),
  metadata jsonb null
);

create index if not exists helper_feedback_household_id_idx
  on public.helper_feedback (household_id);
create index if not exists helper_feedback_helper_id_idx
  on public.helper_feedback (helper_id);
create index if not exists helper_feedback_household_occurred_idx
  on public.helper_feedback (household_id, occurred_at desc);

alter table public.helper_feedback enable row level security;

create policy "helper_feedback_select_household_access" on public.helper_feedback
  for select
  using (public.can_access_household(household_id));

create policy "helper_feedback_insert_household_access" on public.helper_feedback
  for insert
  with check (public.can_access_household(household_id));

-- Quarterly rewards
create table if not exists public.helper_rewards (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  quarter text not null,
  reward_type text not null,
  amount numeric null,
  currency text null,
  reason text null,
  awarded_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  metadata jsonb null,
  constraint helper_rewards_household_helper_quarter_unique unique (household_id, helper_id, quarter, reward_type)
);

create index if not exists helper_rewards_household_id_idx
  on public.helper_rewards (household_id);
create index if not exists helper_rewards_helper_id_idx
  on public.helper_rewards (helper_id);
create index if not exists helper_rewards_household_quarter_idx
  on public.helper_rewards (household_id, quarter);

alter table public.helper_rewards enable row level security;

create policy "helper_rewards_select_household_access" on public.helper_rewards
  for select
  using (public.can_access_household(household_id));

create policy "helper_rewards_insert_admin" on public.helper_rewards
  for insert
  with check (public.is_household_admin(household_id));

create policy "helper_rewards_update_admin" on public.helper_rewards
  for update
  using (public.is_household_admin(household_id))
  with check (public.is_household_admin(household_id));

create policy "helper_rewards_delete_admin" on public.helper_rewards
  for delete
  using (public.is_household_admin(household_id));

-- Optional snapshot of computed metrics
create table if not exists public.helper_reward_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  quarter text not null,
  avg_rating numeric null,
  feedback_count int not null default 0,
  leave_days numeric not null default 0,
  assigned_completed_count int not null default 0,
  computed_at timestamptz not null default now(),
  metadata jsonb null,
  constraint helper_reward_snapshots_household_helper_quarter_unique unique (household_id, helper_id, quarter)
);

create index if not exists helper_reward_snapshots_household_id_idx
  on public.helper_reward_snapshots (household_id);
create index if not exists helper_reward_snapshots_helper_id_idx
  on public.helper_reward_snapshots (helper_id);
create index if not exists helper_reward_snapshots_household_quarter_idx
  on public.helper_reward_snapshots (household_id, quarter);

alter table public.helper_reward_snapshots enable row level security;

create policy "helper_reward_snapshots_select_household_access" on public.helper_reward_snapshots
  for select
  using (public.can_access_household(household_id));

create policy "helper_reward_snapshots_insert_admin" on public.helper_reward_snapshots
  for insert
  with check (public.is_household_admin(household_id));
