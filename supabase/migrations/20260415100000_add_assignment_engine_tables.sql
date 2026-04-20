-- Assignment engine: Phase 1.0 schema
--
-- Adds the tables for the "Chore management → Scope: Assignment" block
-- in homeops.helper_module.plan.md. These tables are the backbone of:
--
--   - the deterministic rules engine (assignment_rules, assignment_strategy_weights)
--   - the confidence-graduated operating modes (assignment_decisions)
--   - the override-driven learning loop (assignment_overrides)
--   - the conversational pattern elicitation flow (pattern_elicitation_state)
--
-- The rules engine itself and the strategy plug-ins ship in P1.4; this
-- migration only creates the storage, constraints, and RLS.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. assignment_rules — output of pattern elicitation and accepted nudges
-- ─────────────────────────────────────────────────────────────────────────
--
-- template_id is a soft enum validated in the agent-service strategy
-- registry, not in the database. New templates ship as new code, not new
-- migrations.

create table if not exists public.assignment_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  template_id text not null,
  template_params jsonb not null,
  helper_id uuid references public.helpers(id) on delete set null,
  weight numeric(4,2) not null default 1.0
    check (weight >= 0 and weight <= 10),
  conditions jsonb,
  source text not null check (source in ('elicitation','accepted_nudge','manual_edit')),
  active bool not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_by uuid references auth.users(id)
);

create index if not exists assignment_rules_household_active_idx
  on public.assignment_rules (household_id)
  where active = true and deleted_at is null;

create index if not exists assignment_rules_template_idx
  on public.assignment_rules (household_id, template_id)
  where active = true;

create index if not exists assignment_rules_helper_idx
  on public.assignment_rules (helper_id)
  where helper_id is not null and active = true;

alter table public.assignment_rules enable row level security;

drop policy if exists assignment_rules_select on public.assignment_rules;
create policy assignment_rules_select on public.assignment_rules
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists assignment_rules_insert on public.assignment_rules;
create policy assignment_rules_insert on public.assignment_rules
  for insert
  with check (public.is_household_member(household_id));

drop policy if exists assignment_rules_update on public.assignment_rules;
create policy assignment_rules_update on public.assignment_rules
  for update
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

create or replace function public.assignment_rules_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists assignment_rules_touch_updated_at_trg on public.assignment_rules;
create trigger assignment_rules_touch_updated_at_trg
  before update on public.assignment_rules
  for each row
  execute function public.assignment_rules_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 2. assignment_strategy_weights — per-household tunable weights
-- ─────────────────────────────────────────────────────────────────────────
--
-- A single row per household with a jsonb map of strategy_name → weight.
-- Missing entries default to 1.0 in the engine's combination logic.

create table if not exists public.assignment_strategy_weights (
  household_id uuid primary key references public.households(id) on delete cascade,
  weights jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.assignment_strategy_weights enable row level security;

drop policy if exists assignment_strategy_weights_select on public.assignment_strategy_weights;
create policy assignment_strategy_weights_select on public.assignment_strategy_weights
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists assignment_strategy_weights_upsert on public.assignment_strategy_weights;
create policy assignment_strategy_weights_upsert on public.assignment_strategy_weights
  for all
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 3. assignment_decisions — source of truth for the O1 metric
-- ─────────────────────────────────────────────────────────────────────────
--
-- Every assignment event writes one row here. The `classification` column
-- implements the locked classifier rules from homeops.system.manifest.md:
--
--   - load_reducing: silent auto-handle, tap-to-confirm, bulk one-tap,
--     reassignment (silent or one-tap)
--   - full_effort:   manual pick, owner override, elicitation answer,
--     manual_edit_rules
--
-- The O1 metric query is:
--   SELECT COUNT(*) FILTER (WHERE classification='load_reducing')::float
--          / NULLIF(COUNT(*), 0)
--   FROM assignment_decisions
--   WHERE household_id = ? AND decided_at >= now() - interval '4 weeks';

create table if not exists public.assignment_decisions (
  id bigserial primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  chore_id uuid not null references public.chores(id) on delete cascade,
  helper_id uuid references public.helpers(id) on delete set null,
  decided_at timestamptz not null default now(),
  mode text not null check (mode in (
    'manual','one_tap','silent_auto',
    'reassignment_silent','reassignment_one_tap','bulk',
    'override','elicitation','manual_edit_rules'
  )),
  classification text not null check (classification in ('load_reducing','full_effort')),
  rule_ids uuid[],
  contributions jsonb,
  proposed_helper_id uuid references public.helpers(id) on delete set null,
  overridden bool not null default false,
  override_recorded_at timestamptz,
  decided_by_user_id uuid references auth.users(id)
);

create index if not exists assignment_decisions_household_week_idx
  on public.assignment_decisions (household_id, decided_at);

create index if not exists assignment_decisions_chore_idx
  on public.assignment_decisions (chore_id);

create index if not exists assignment_decisions_classification_idx
  on public.assignment_decisions (household_id, classification, decided_at);

alter table public.assignment_decisions enable row level security;

drop policy if exists assignment_decisions_select on public.assignment_decisions;
create policy assignment_decisions_select on public.assignment_decisions
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists assignment_decisions_insert on public.assignment_decisions;
create policy assignment_decisions_insert on public.assignment_decisions
  for insert
  with check (public.is_household_member(household_id));

drop policy if exists assignment_decisions_update on public.assignment_decisions;
create policy assignment_decisions_update on public.assignment_decisions
  for update
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. assignment_overrides — aggregator for the learning nudge
-- ─────────────────────────────────────────────────────────────────────────
--
-- One row per (household, chore_predicate_hash, proposed_helper,
-- chosen_helper) combination. Nudge fires when override_count reaches 3
-- and nudge_status='none' (or nudge_decline_until < now()).

create table if not exists public.assignment_overrides (
  id bigserial primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  chore_predicate_hash text not null,
  chore_predicate_sample jsonb,
  proposed_helper_id uuid references public.helpers(id) on delete set null,
  chosen_helper_id uuid references public.helpers(id) on delete set null,
  override_count int not null default 1,
  first_override_at timestamptz not null default now(),
  last_override_at timestamptz not null default now(),
  nudge_status text not null default 'none' check (nudge_status in (
    'none','shown','accepted','declined'
  )),
  nudge_shown_at timestamptz,
  nudge_decline_until timestamptz,
  unique (household_id, chore_predicate_hash, proposed_helper_id, chosen_helper_id)
);

create index if not exists assignment_overrides_household_idx
  on public.assignment_overrides (household_id, last_override_at desc);

-- Nudge-ready filter: cover the common "ready to show a nudge" case
-- (status = 'none'). The declined-but-hibernation-expired case is
-- handled at query time (`and nudge_decline_until < now()`) since
-- now() isn't immutable and can't appear in an index predicate.
create index if not exists assignment_overrides_nudge_ready_idx
  on public.assignment_overrides (household_id, last_override_at desc)
  where nudge_status in ('none','declined');

alter table public.assignment_overrides enable row level security;

drop policy if exists assignment_overrides_select on public.assignment_overrides;
create policy assignment_overrides_select on public.assignment_overrides
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists assignment_overrides_insert on public.assignment_overrides;
create policy assignment_overrides_insert on public.assignment_overrides
  for insert
  with check (public.is_household_member(household_id));

drop policy if exists assignment_overrides_update on public.assignment_overrides;
create policy assignment_overrides_update on public.assignment_overrides
  for update
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 5. pattern_elicitation_state — resumable elicitation conversation state
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.pattern_elicitation_state (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  template_id text not null,
  status text not null check (status in ('pending','in_progress','completed','skipped')),
  answer jsonb,
  asked_at timestamptz,
  answered_at timestamptz,
  unique (household_id, template_id)
);

create index if not exists pattern_elicitation_state_household_idx
  on public.pattern_elicitation_state (household_id, status);

alter table public.pattern_elicitation_state enable row level security;

drop policy if exists pattern_elicitation_state_select on public.pattern_elicitation_state;
create policy pattern_elicitation_state_select on public.pattern_elicitation_state
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists pattern_elicitation_state_upsert on public.pattern_elicitation_state;
create policy pattern_elicitation_state_upsert on public.pattern_elicitation_state
  for all
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

-- ─────────────────────────────────────────────────────────────────────────
-- Comments
-- ─────────────────────────────────────────────────────────────────────────

comment on table public.assignment_rules is 'Assignment rules from elicitation, accepted nudges, or manual edit. template_id is a soft enum validated in agent-service strategy registry (Phase 1.0)';
comment on table public.assignment_strategy_weights is 'Per-household strategy weight tuning; defaults to 1.0 for missing entries (Phase 1.0)';
comment on table public.assignment_decisions is 'Source of truth for O1 cognitive-load reduction metric. Every assignment event must write a row (Phase 1.0)';
comment on table public.assignment_overrides is 'Override aggregator driving the learning nudge flow (Phase 1.0)';
comment on table public.pattern_elicitation_state is 'Per-household pattern elicitation conversation state, resumable across sessions (Phase 1.0)';
