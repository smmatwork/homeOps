-- Phase 1 — confidence-graduated operating modes + graduation bug fix
--
-- Ships:
--   1. compute_chore_predicate / compute_chore_predicate_hash — single source
--      of truth for the (space, cadence, title_head) predicate used by
--      override aggregation, graduation, and mode state.
--   2. assignment_decisions.chore_predicate_hash column — stored at write time
--      so graduation can filter by predicate (previous RPC had a bug where
--      p_chore_predicate_hash was declared but never used in the WHERE).
--   3. assignment_modes table — per (household, predicate, helper) mode.
--   4. get_assignment_mode / set_assignment_mode / maybe_graduate_or_demote
--      RPCs for the auto-promotion/demotion flow.
--   5. Updated apply_assignment_decision (populates the new column).
--   6. Updated check_auto_assignment_graduation (now actually filters by
--      predicate hash — the manifest-locked "5 consecutive approvals for
--      *similar* chores" rule).
--   7. Updated reassign_chore — calls maybe_graduate_or_demote after each
--      write and returns mode_changed_to so the client can show a toast.
--
-- Order matters inside this file because maybe_graduate_or_demote reads
-- from assignment_decisions and calls check_auto_assignment_graduation,
-- and reassign_chore calls maybe_graduate_or_demote.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Predicate helpers (shared hashing logic)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.compute_chore_predicate(p_chore_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'space', coalesce(c.metadata->>'space',''),
    'cadence', coalesce(c.metadata->>'cadence',''),
    'title_head', lower(split_part(trim(c.title),' ',1))
  )
  from public.chores c
  where c.id = p_chore_id;
$$;

create or replace function public.compute_chore_predicate_hash(p_chore_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select md5((public.compute_chore_predicate(p_chore_id))::text);
$$;

revoke all on function public.compute_chore_predicate(uuid) from public;
grant execute on function public.compute_chore_predicate(uuid) to authenticated;
grant execute on function public.compute_chore_predicate(uuid) to service_role;
revoke all on function public.compute_chore_predicate_hash(uuid) from public;
grant execute on function public.compute_chore_predicate_hash(uuid) to authenticated;
grant execute on function public.compute_chore_predicate_hash(uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. assignment_decisions.chore_predicate_hash
-- ─────────────────────────────────────────────────────────────────────────

alter table public.assignment_decisions
  add column if not exists chore_predicate_hash text;

-- Backfill. Rows with null chore_id (e.g. accept_nudge writes) stay null.
update public.assignment_decisions d
set chore_predicate_hash = public.compute_chore_predicate_hash(d.chore_id)
where d.chore_predicate_hash is null
  and d.chore_id is not null;

create index if not exists assignment_decisions_predicate_helper_idx
  on public.assignment_decisions (household_id, chore_predicate_hash, helper_id, decided_at desc)
  where chore_predicate_hash is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. assignment_modes table
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.assignment_modes (
  id bigserial primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  chore_predicate_hash text not null,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  mode text not null check (mode in ('manual','one_tap','silent_auto')),
  graduated_at timestamptz,
  demoted_at timestamptz,
  last_decision_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (household_id, chore_predicate_hash, helper_id)
);

create index if not exists assignment_modes_household_idx
  on public.assignment_modes (household_id, updated_at desc);

alter table public.assignment_modes enable row level security;

drop policy if exists assignment_modes_select on public.assignment_modes;
create policy assignment_modes_select on public.assignment_modes
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists assignment_modes_upsert on public.assignment_modes;
create policy assignment_modes_upsert on public.assignment_modes
  for all
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

comment on table public.assignment_modes is
  'Per (household, chore_predicate_hash, helper) operating mode. Default when no row exists is "manual". Auto-promoted to silent_auto after 5 clean one_tap/silent_auto decisions; demoted one step on override. (Phase 1)';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Updated apply_assignment_decision — populates chore_predicate_hash
-- ─────────────────────────────────────────────────────────────────────────
--
-- Same signature and behavior as before, plus:
--   • Computes predicate hash via compute_chore_predicate_hash
--   • Stores it on the assignment_decisions row
-- Everything else (audit log, idempotent re-assignments, overridden flag)
-- is unchanged.

create or replace function public.apply_assignment_decision(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_id uuid,
  p_helper_id uuid,
  p_mode text,
  p_classification text,
  p_rule_ids uuid[] default null,
  p_contributions jsonb default null,
  p_proposed_helper_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_helper_id uuid;
  v_action text;
  v_decision_id bigint;
  v_predicate_hash text;
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;
  if p_actor_user_id is null then
    raise exception 'p_actor_user_id is required';
  end if;
  if p_chore_id is null then
    raise exception 'p_chore_id is required';
  end if;
  if p_mode is null or p_mode not in (
    'manual','one_tap','silent_auto',
    'reassignment_silent','reassignment_one_tap','bulk',
    'override','elicitation','manual_edit_rules'
  ) then
    raise exception 'invalid p_mode: %', p_mode;
  end if;
  if p_classification is null or p_classification not in ('load_reducing','full_effort') then
    raise exception 'invalid p_classification: %', p_classification;
  end if;

  if not exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  select helper_id into v_prev_helper_id
  from public.chores
  where id = p_chore_id
    and household_id = p_household_id
    and deleted_at is null;

  if not found then
    raise exception 'chore % not found in household %', p_chore_id, p_household_id;
  end if;

  if p_helper_id is null then
    v_action := 'unassigned';
  elsif v_prev_helper_id is null then
    v_action := 'assigned';
  elsif v_prev_helper_id = p_helper_id then
    v_action := 'assigned';
  else
    v_action := 'reassigned';
  end if;

  update public.chores
  set helper_id = p_helper_id,
      updated_at = now()
  where id = p_chore_id
    and household_id = p_household_id;

  insert into public.chore_helper_assignments (
    household_id, chore_id, helper_id, action, assigned_by, metadata
  ) values (
    p_household_id,
    p_chore_id,
    p_helper_id,
    v_action,
    p_actor_user_id,
    jsonb_build_object(
      'mode', p_mode,
      'previous_helper_id', v_prev_helper_id,
      'classification', p_classification
    )
  );

  v_predicate_hash := public.compute_chore_predicate_hash(p_chore_id);

  insert into public.assignment_decisions (
    household_id, chore_id, helper_id, mode, classification,
    rule_ids, contributions, proposed_helper_id,
    overridden, decided_by_user_id, chore_predicate_hash
  ) values (
    p_household_id,
    p_chore_id,
    p_helper_id,
    p_mode,
    p_classification,
    p_rule_ids,
    p_contributions,
    p_proposed_helper_id,
    (p_proposed_helper_id is not null and p_proposed_helper_id is distinct from p_helper_id),
    p_actor_user_id,
    v_predicate_hash
  )
  returning id into v_decision_id;

  return v_decision_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Fix check_auto_assignment_graduation — actually filter by predicate
-- ─────────────────────────────────────────────────────────────────────────
--
-- Bug: earlier version declared p_chore_predicate_hash but never referenced
-- it, so graduation was keyed (household, helper) globally. That promotes
-- a helper to silent_auto for *any* chore type after 5 approvals for one
-- chore type — contradicts the manifest-locked rule that graduation is
-- per "similar" chores.
--
-- Fix: filter assignment_decisions by chore_predicate_hash matching the
-- parameter. Requires the column added in step 2.

create or replace function public.check_auto_assignment_graduation(
  p_household_id uuid,
  p_chore_predicate_hash text,
  p_helper_id uuid
)
returns table (
  should_graduate bool,
  consecutive_approvals bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_count bigint := 0;
  v_threshold constant int := 5;
begin
  if p_household_id is null or p_chore_predicate_hash is null or p_helper_id is null then
    should_graduate := false;
    consecutive_approvals := 0;
    return next;
    return;
  end if;

  -- Count how many of the most recent 10 decisions for this
  -- (household, predicate, helper) tuple were clean system approvals
  -- (one_tap or silent_auto, not overridden). Any break in the streak
  -- stops the count.
  with recent as (
    select
      d.mode,
      d.overridden,
      row_number() over (order by d.decided_at desc) as rn
    from public.assignment_decisions d
    where d.household_id = p_household_id
      and d.chore_predicate_hash = p_chore_predicate_hash
      and d.helper_id = p_helper_id
    order by d.decided_at desc
    limit 10
  ),
  streak as (
    -- Walk from most recent; stop at first break.
    select
      rn,
      mode,
      overridden,
      -- Cumulative bool: "still a clean streak?"
      bool_and(
        mode in ('one_tap','silent_auto') and not overridden
      ) over (order by rn rows between unbounded preceding and current row) as still_clean
    from recent
  )
  select count(*) into v_count
  from streak
  where still_clean;

  should_graduate := v_count >= v_threshold;
  consecutive_approvals := v_count;
  return next;
end;
$$;

revoke all on function public.check_auto_assignment_graduation(uuid, text, uuid) from public;
grant execute on function public.check_auto_assignment_graduation(uuid, text, uuid) to authenticated;
grant execute on function public.check_auto_assignment_graduation(uuid, text, uuid) to service_role;

comment on function public.check_auto_assignment_graduation(uuid, text, uuid) is
  'Returns (should_graduate, consecutive_approvals) for a (household, predicate, helper) tuple. Fixed in Phase 1 — now actually filters by predicate hash.';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. get_assignment_mode
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.get_assignment_mode(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_predicate_hash text,
  p_helper_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mode text;
begin
  if p_household_id is null or p_actor_user_id is null
     or p_chore_predicate_hash is null or p_helper_id is null then
    return 'manual';
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  select mode into v_mode
  from public.assignment_modes
  where household_id = p_household_id
    and chore_predicate_hash = p_chore_predicate_hash
    and helper_id = p_helper_id;

  return coalesce(v_mode, 'manual');
end;
$$;

revoke all on function public.get_assignment_mode(uuid, uuid, text, uuid) from public;
grant execute on function public.get_assignment_mode(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.get_assignment_mode(uuid, uuid, text, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. set_assignment_mode — explicit owner override (e.g., "back to manual")
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.set_assignment_mode(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_predicate_hash text,
  p_helper_id uuid,
  p_mode text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  if p_household_id is null or p_actor_user_id is null
     or p_chore_predicate_hash is null or p_helper_id is null then
    raise exception 'missing required arguments';
  end if;
  if p_mode not in ('manual','one_tap','silent_auto') then
    raise exception 'invalid p_mode: %', p_mode;
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  insert into public.assignment_modes (
    household_id, chore_predicate_hash, helper_id, mode, updated_at
  ) values (
    p_household_id, p_chore_predicate_hash, p_helper_id, p_mode, v_now
  )
  on conflict (household_id, chore_predicate_hash, helper_id) do update
    set mode = excluded.mode,
        updated_at = v_now,
        graduated_at = case when excluded.mode = 'silent_auto' then v_now else assignment_modes.graduated_at end,
        demoted_at = case when excluded.mode in ('one_tap','manual') then v_now else assignment_modes.demoted_at end;

  return p_mode;
end;
$$;

revoke all on function public.set_assignment_mode(uuid, uuid, text, uuid, text) from public;
grant execute on function public.set_assignment_mode(uuid, uuid, text, uuid, text) to authenticated;
grant execute on function public.set_assignment_mode(uuid, uuid, text, uuid, text) to service_role;

comment on function public.set_assignment_mode(uuid, uuid, text, uuid, text) is
  'Explicit owner-set mode for a (predicate, helper) pair. Use for manual mode changes (e.g. "back to manual"). (Phase 1)';

-- ─────────────────────────────────────────────────────────────────────────
-- 8. maybe_graduate_or_demote
-- ─────────────────────────────────────────────────────────────────────────
--
-- Called after every assignment_decisions write. Reads the decision, decides
-- whether to promote or demote the (predicate, helper) pair. Returns the
-- new mode if changed, null if unchanged.
--
-- Promotion (→ silent_auto):
--   trigger: check_auto_assignment_graduation returns should_graduate=true
--   condition: mode in ('one_tap','silent_auto') AND !overridden
-- Demotion (silent_auto → one_tap):
--   trigger: the latest decision overrode a prior silent_auto assignment
--   condition: overridden=true AND previous mode for this pair was 'silent_auto'
-- Idempotent creation (→ one_tap):
--   trigger: first clean one_tap decision for a new pair
--   ensures a row exists so the UI can show a mode chip

create or replace function public.maybe_graduate_or_demote(
  p_decision_id bigint
)
returns table (
  previous_mode text,
  new_mode text,
  changed bool
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision public.assignment_decisions%rowtype;
  v_prev_mode text;
  v_new_mode text;
  v_grad record;
  v_now timestamptz := now();
  v_system_modes text[] := array['one_tap','silent_auto','reassignment_silent','reassignment_one_tap','bulk'];
begin
  if p_decision_id is null then
    previous_mode := null; new_mode := null; changed := false;
    return next;
    return;
  end if;

  select * into v_decision
  from public.assignment_decisions
  where id = p_decision_id;

  if not found
     or v_decision.chore_id is null
     or v_decision.helper_id is null
     or v_decision.chore_predicate_hash is null then
    previous_mode := null; new_mode := null; changed := false;
    return next;
    return;
  end if;

  -- Existing mode (default manual if no row).
  select mode into v_prev_mode
  from public.assignment_modes
  where household_id = v_decision.household_id
    and chore_predicate_hash = v_decision.chore_predicate_hash
    and helper_id = v_decision.helper_id;
  v_prev_mode := coalesce(v_prev_mode, 'manual');

  -- DEMOTE: an override of a prior silent_auto assignment → one_tap
  if v_decision.overridden and v_prev_mode = 'silent_auto' then
    v_new_mode := 'one_tap';
    update public.assignment_modes
    set mode = v_new_mode,
        demoted_at = v_now,
        updated_at = v_now,
        last_decision_at = v_now
    where household_id = v_decision.household_id
      and chore_predicate_hash = v_decision.chore_predicate_hash
      and helper_id = v_decision.helper_id;

    previous_mode := v_prev_mode;
    new_mode := v_new_mode;
    changed := true;
    return next;
    return;
  end if;

  -- Anything past this point requires a clean system-mode decision.
  if v_decision.overridden or not (v_decision.mode = any(v_system_modes)) then
    previous_mode := v_prev_mode;
    new_mode := v_prev_mode;
    changed := false;
    return next;
    return;
  end if;

  -- PROMOTE: check graduation threshold
  select g.should_graduate, g.consecutive_approvals
    into v_grad
  from public.check_auto_assignment_graduation(
    v_decision.household_id,
    v_decision.chore_predicate_hash,
    v_decision.helper_id
  ) g;

  if v_grad.should_graduate and v_prev_mode <> 'silent_auto' then
    v_new_mode := 'silent_auto';
    insert into public.assignment_modes (
      household_id, chore_predicate_hash, helper_id, mode,
      graduated_at, last_decision_at, updated_at
    ) values (
      v_decision.household_id, v_decision.chore_predicate_hash, v_decision.helper_id,
      v_new_mode, v_now, v_now, v_now
    )
    on conflict (household_id, chore_predicate_hash, helper_id) do update
      set mode = v_new_mode,
          graduated_at = v_now,
          last_decision_at = v_now,
          updated_at = v_now;

    previous_mode := v_prev_mode;
    new_mode := v_new_mode;
    changed := true;
    return next;
    return;
  end if;

  -- IDEMPOTENT INSERT: ensure a row at one_tap exists so the UI can show
  -- the mode chip. Never downgrades an existing silent_auto row.
  if v_prev_mode = 'manual' then
    insert into public.assignment_modes (
      household_id, chore_predicate_hash, helper_id, mode,
      last_decision_at, updated_at
    ) values (
      v_decision.household_id, v_decision.chore_predicate_hash, v_decision.helper_id,
      'one_tap', v_now, v_now
    )
    on conflict (household_id, chore_predicate_hash, helper_id) do update
      set last_decision_at = v_now, updated_at = v_now;

    previous_mode := v_prev_mode;
    new_mode := 'one_tap';
    changed := true;
    return next;
    return;
  end if;

  -- No change: bump last_decision_at.
  update public.assignment_modes
  set last_decision_at = v_now,
      updated_at = v_now
  where household_id = v_decision.household_id
    and chore_predicate_hash = v_decision.chore_predicate_hash
    and helper_id = v_decision.helper_id;

  previous_mode := v_prev_mode;
  new_mode := v_prev_mode;
  changed := false;
  return next;
end;
$$;

revoke all on function public.maybe_graduate_or_demote(bigint) from public;
grant execute on function public.maybe_graduate_or_demote(bigint) to authenticated;
grant execute on function public.maybe_graduate_or_demote(bigint) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Updated reassign_chore — returns mode_changed_to and fires mode updates
-- ─────────────────────────────────────────────────────────────────────────
--
-- Drop the old signature first because we're changing the RETURNS TABLE
-- column list. PostgREST treats returned column sets as part of the
-- effective signature.

drop function if exists public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid);

create or replace function public.reassign_chore(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_id uuid,
  p_new_helper_id uuid,
  p_mode text default 'manual',
  p_proposed_helper_id uuid default null
)
returns table (
  decision_id bigint,
  overridden bool,
  should_nudge bool,
  override_id bigint,
  effective_mode text,
  mode_changed_to text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_helper_id uuid;
  v_prev_decision_mode text;
  v_effective_mode text;
  v_effective_proposed uuid;
  v_classification text;
  v_decision_id bigint;
  v_override_result record;
  v_override_id bigint;
  v_mode_result record;
  v_system_modes text[] := array['one_tap','silent_auto','reassignment_silent','reassignment_one_tap','bulk'];
begin
  if p_household_id is null or p_actor_user_id is null or p_chore_id is null then
    raise exception 'p_household_id, p_actor_user_id, p_chore_id are required';
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  select c.helper_id into v_prev_helper_id
  from public.chores c
  where c.id = p_chore_id
    and c.household_id = p_household_id
    and c.deleted_at is null;

  if not found then
    raise exception 'chore % not found in household %', p_chore_id, p_household_id;
  end if;

  select d.mode into v_prev_decision_mode
  from public.assignment_decisions d
  where d.chore_id = p_chore_id
    and d.household_id = p_household_id
  order by d.decided_at desc
  limit 1;

  v_effective_mode := coalesce(p_mode, 'manual');
  v_effective_proposed := p_proposed_helper_id;

  if v_effective_mode = 'manual'
     and v_prev_helper_id is not null
     and v_prev_helper_id is distinct from p_new_helper_id
     and v_prev_decision_mode is not null
     and v_prev_decision_mode = any(v_system_modes)
  then
    v_effective_mode := 'override';
    v_effective_proposed := v_prev_helper_id;
  end if;

  if v_effective_mode in ('one_tap','silent_auto','reassignment_silent','reassignment_one_tap','bulk')
     and (v_effective_proposed is null or v_effective_proposed is not distinct from p_new_helper_id)
  then
    v_classification := 'load_reducing';
  else
    v_classification := 'full_effort';
  end if;

  v_decision_id := public.apply_assignment_decision(
    p_household_id,
    p_actor_user_id,
    p_chore_id,
    p_new_helper_id,
    v_effective_mode,
    v_classification,
    null,
    null,
    v_effective_proposed
  );

  overridden := (v_effective_proposed is not null
                 and v_effective_proposed is distinct from p_new_helper_id);
  decision_id := v_decision_id;
  effective_mode := v_effective_mode;

  if overridden and p_new_helper_id is not null and v_effective_proposed is not null then
    select ro.override_count, ro.should_nudge
      into v_override_result
    from public.record_assignment_override(
      p_household_id,
      p_actor_user_id,
      p_chore_id,
      v_effective_proposed,
      p_new_helper_id
    ) ro;

    should_nudge := coalesce(v_override_result.should_nudge, false);

    select ao.id into v_override_id
    from public.assignment_overrides ao
    where ao.household_id = p_household_id
      and ao.proposed_helper_id = v_effective_proposed
      and ao.chosen_helper_id = p_new_helper_id
    order by ao.last_override_at desc
    limit 1;

    override_id := v_override_id;
  else
    should_nudge := false;
    override_id := null;
  end if;

  -- Auto-promote or auto-demote the (predicate, helper) pair.
  select gm.previous_mode, gm.new_mode, gm.changed
    into v_mode_result
  from public.maybe_graduate_or_demote(v_decision_id) gm;

  mode_changed_to := case when v_mode_result.changed then v_mode_result.new_mode else null end;

  return next;
end;
$$;

revoke all on function public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid) from public;
grant execute on function public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid) to authenticated;
grant execute on function public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid) to service_role;

comment on function public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid) is
  'Unified reassignment: writes decision + audits overrides + auto-promotes/demotes the (predicate, helper) mode. Returns should_nudge + mode_changed_to. (Phase 1)';
