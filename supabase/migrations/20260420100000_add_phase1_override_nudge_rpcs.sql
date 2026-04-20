-- Phase 1 — override tracking + learning nudges
--
-- Ships four RPCs to wire the override + nudge flow end-to-end:
--
--   1. reassign_chore           — unified wrapper for all reassignment writes.
--                                 Auto-detects overrides of prior system
--                                 decisions and fires record_assignment_override.
--   2. get_pending_nudges       — returns nudges ready to surface.
--   3. accept_nudge             — converts a nudge into an assignment_rules row
--                                 with source='accepted_nudge' (locked: rules are
--                                 only learned after explicit owner confirmation).
--   4. decline_nudge            — 30-day hibernation window for this (predicate,
--                                 proposed, chosen) triple.
--
-- All functions are security definer with household-member checks.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. reassign_chore
-- ─────────────────────────────────────────────────────────────────────────
--
-- Single entry point for reassigning a chore. Handles:
--   • Writing to chores.helper_id (via apply_assignment_decision)
--   • Writing the assignment_decisions row for O1
--   • Detecting override-of-system-decision even when the caller didn't pass
--     a proposed_helper_id (the inline-assign + edit-dialog flows on the
--     Chores page can't know what was "proposed")
--   • Firing record_assignment_override + returning should_nudge when the
--     aggregator crosses threshold
--
-- Mode handling:
--   • Caller passes 'manual' (or omits): if the chore's latest decision was
--     a system decision that got overridden here, we rewrite mode='override'
--     and set proposed_helper_id to the previously-assigned helper.
--   • Caller passes 'one_tap'/'silent_auto'/etc.: pass through. If the caller
--     also passed proposed_helper_id and it differs from new_helper_id, the
--     underlying apply_assignment_decision auto-flags overridden=true.
--
-- Classification:
--   • load_reducing: one_tap, silent_auto, reassignment_silent,
--     reassignment_one_tap, bulk (when not overridden)
--   • full_effort:   manual, override, elicitation, manual_edit_rules, and
--                    anything where overridden=true

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
  effective_mode text
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

  -- Pull the chore's current helper and its most recent non-null decision
  -- mode. We use these to decide whether a 'manual' edit is actually an
  -- override of a system-made choice.
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

  -- Decide the effective mode + proposed_helper_id.
  v_effective_mode := coalesce(p_mode, 'manual');
  v_effective_proposed := p_proposed_helper_id;

  -- Auto-detect: a caller-passed 'manual' that actually overrides a prior
  -- system decision gets rewritten to 'override' so the O1 metric and the
  -- override aggregator both see it correctly.
  if v_effective_mode = 'manual'
     and v_prev_helper_id is not null
     and v_prev_helper_id is distinct from p_new_helper_id
     and v_prev_decision_mode is not null
     and v_prev_decision_mode = any(v_system_modes)
  then
    v_effective_mode := 'override';
    v_effective_proposed := v_prev_helper_id;
  end if;

  -- Classification per the locked O1 rules.
  if v_effective_mode in ('one_tap','silent_auto','reassignment_silent','reassignment_one_tap','bulk')
     and (v_effective_proposed is null or v_effective_proposed is not distinct from p_new_helper_id)
  then
    v_classification := 'load_reducing';
  else
    v_classification := 'full_effort';
  end if;

  -- Delegate the actual write to apply_assignment_decision (single source
  -- of truth for chores.helper_id + audit + assignment_decisions).
  v_decision_id := public.apply_assignment_decision(
    p_household_id,
    p_actor_user_id,
    p_chore_id,
    p_new_helper_id,
    v_effective_mode,
    v_classification,
    null,           -- rule_ids (not populated from ad-hoc reassignments)
    null,           -- contributions
    v_effective_proposed
  );

  overridden := (v_effective_proposed is not null
                 and v_effective_proposed is distinct from p_new_helper_id);
  decision_id := v_decision_id;
  effective_mode := v_effective_mode;

  -- Fire override tracking only when we actually overrode a proposal AND
  -- both sides of the (proposed, chosen) pair are helpers (not null).
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

    -- Return the override row id so the client can display a nudge card
    -- keyed to this specific override.
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

  return next;
end;
$$;

revoke all on function public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid) from public;
grant execute on function public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid) to authenticated;
grant execute on function public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid) to service_role;

comment on function public.reassign_chore(uuid, uuid, uuid, uuid, text, uuid) is
  'Unified reassignment entry point. Auto-detects override-of-system-decision for manual edits, fires record_assignment_override when overridden, and returns should_nudge. (Phase 1)';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. get_pending_nudges
-- ─────────────────────────────────────────────────────────────────────────
--
-- Returns override rows that are ready to surface as a nudge:
--   • override_count >= 3
--   • nudge_status = 'none', OR ('declined' AND the 30-day hibernation
--     window has expired)
-- Caps at 5 to avoid overwhelming the owner with nudges at once.

create or replace function public.get_pending_nudges(
  p_household_id uuid,
  p_actor_user_id uuid
)
returns table (
  override_id bigint,
  chore_predicate_sample jsonb,
  proposed_helper_id uuid,
  proposed_helper_name text,
  chosen_helper_id uuid,
  chosen_helper_name text,
  override_count int,
  first_override_at timestamptz,
  last_override_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_household_id is null or p_actor_user_id is null then
    raise exception 'p_household_id and p_actor_user_id are required';
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  return query
  select
    ao.id,
    ao.chore_predicate_sample,
    ao.proposed_helper_id,
    hp.name,
    ao.chosen_helper_id,
    hc.name,
    ao.override_count,
    ao.first_override_at,
    ao.last_override_at
  from public.assignment_overrides ao
  left join public.helpers hp on hp.id = ao.proposed_helper_id
  left join public.helpers hc on hc.id = ao.chosen_helper_id
  where ao.household_id = p_household_id
    and ao.override_count >= 3
    and (
      ao.nudge_status = 'none'
      or (
        ao.nudge_status = 'declined'
        and ao.nudge_decline_until is not null
        and ao.nudge_decline_until < now()
      )
    )
  order by ao.last_override_at desc
  limit 5;
end;
$$;

revoke all on function public.get_pending_nudges(uuid, uuid) from public;
grant execute on function public.get_pending_nudges(uuid, uuid) to authenticated;
grant execute on function public.get_pending_nudges(uuid, uuid) to service_role;

comment on function public.get_pending_nudges(uuid, uuid) is
  'Surface nudge-ready overrides (count >= 3 AND not hibernating). (Phase 1)';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. accept_nudge
-- ─────────────────────────────────────────────────────────────────────────
--
-- Owner says "yes, make {chosen} the default for {predicate}."
-- Atomically:
--   • Inserts an assignment_rules row with source='accepted_nudge'
--   • Updates the assignment_overrides row to nudge_status='accepted'
--
-- The template_id for the new rule is 'override_learned' with template_params
-- holding the predicate sample + (proposed, chosen) pair. The assignment
-- engine consumes this as a soft preference (weight=1.5 to outrank specialty
-- defaults but not hard rules).
--
-- Optional p_conditions jsonb lets the owner accept with qualifiers like
-- {"weekday_only": true} — carried verbatim into assignment_rules.conditions.

create or replace function public.accept_nudge(
  p_override_id bigint,
  p_actor_user_id uuid,
  p_conditions jsonb default null
)
returns table (
  rule_id uuid,
  accepted_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ao public.assignment_overrides%rowtype;
  v_rule_id uuid;
  v_now timestamptz := now();
begin
  if p_override_id is null or p_actor_user_id is null then
    raise exception 'p_override_id and p_actor_user_id are required';
  end if;

  select * into v_ao
  from public.assignment_overrides
  where id = p_override_id
  for update;

  if not found then
    raise exception 'override row % not found', p_override_id;
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = v_ao.household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  if v_ao.chosen_helper_id is null then
    raise exception 'override row % has no chosen_helper_id; cannot build a rule', p_override_id;
  end if;

  -- Insert the learned rule.
  insert into public.assignment_rules (
    household_id,
    template_id,
    template_params,
    helper_id,
    weight,
    conditions,
    source,
    active,
    created_by
  )
  values (
    v_ao.household_id,
    'override_learned',
    jsonb_build_object(
      'predicate_sample', v_ao.chore_predicate_sample,
      'proposed_helper_id', v_ao.proposed_helper_id,
      'chosen_helper_id', v_ao.chosen_helper_id,
      'override_count_at_accept', v_ao.override_count
    ),
    v_ao.chosen_helper_id,
    1.5,
    p_conditions,
    'accepted_nudge',
    true,
    p_actor_user_id
  )
  returning id into v_rule_id;

  -- Flip the nudge row.
  update public.assignment_overrides
  set nudge_status = 'accepted',
      nudge_shown_at = coalesce(nudge_shown_at, v_now),
      nudge_decline_until = null
  where id = p_override_id;

  -- Instrument: this is an explicit owner confirmation of a learned pattern
  -- (manifest-locked: "every learned preference must be explicitly
  -- confirmed"). Log it in assignment_decisions so the O1 metric sees the
  -- cognitive work. The chore_id is null because this decision isn't tied
  -- to a specific chore.
  insert into public.assignment_decisions (
    household_id, chore_id, helper_id, mode, classification,
    rule_ids, contributions, proposed_helper_id, overridden, decided_by_user_id
  ) values (
    v_ao.household_id,
    null,
    v_ao.chosen_helper_id,
    'manual_edit_rules',
    'full_effort',
    array[v_rule_id],
    jsonb_build_object('source', 'accepted_nudge', 'override_id', p_override_id),
    null,
    false,
    p_actor_user_id
  );

  rule_id := v_rule_id;
  accepted_at := v_now;
  return next;
end;
$$;

revoke all on function public.accept_nudge(bigint, uuid, jsonb) from public;
grant execute on function public.accept_nudge(bigint, uuid, jsonb) to authenticated;
grant execute on function public.accept_nudge(bigint, uuid, jsonb) to service_role;

comment on function public.accept_nudge(bigint, uuid, jsonb) is
  'Accept a learning nudge: writes assignment_rules (source=accepted_nudge) + flips nudge_status. (Phase 1)';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. decline_nudge
-- ─────────────────────────────────────────────────────────────────────────
--
-- Owner declines the nudge. We hibernate this specific (predicate,
-- proposed, chosen) triple for 30 days — counting resumes normally, but
-- the nudge won't re-surface until the window expires.

create or replace function public.decline_nudge(
  p_override_id bigint,
  p_actor_user_id uuid
)
returns table (
  declined_at timestamptz,
  hibernate_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ao public.assignment_overrides%rowtype;
  v_now timestamptz := now();
  v_until timestamptz;
begin
  if p_override_id is null or p_actor_user_id is null then
    raise exception 'p_override_id and p_actor_user_id are required';
  end if;

  select * into v_ao
  from public.assignment_overrides
  where id = p_override_id
  for update;

  if not found then
    raise exception 'override row % not found', p_override_id;
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = v_ao.household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  v_until := v_now + interval '30 days';

  update public.assignment_overrides
  set nudge_status = 'declined',
      nudge_shown_at = coalesce(nudge_shown_at, v_now),
      nudge_decline_until = v_until
  where id = p_override_id;

  declined_at := v_now;
  hibernate_until := v_until;
  return next;
end;
$$;

revoke all on function public.decline_nudge(bigint, uuid) from public;
grant execute on function public.decline_nudge(bigint, uuid) to authenticated;
grant execute on function public.decline_nudge(bigint, uuid) to service_role;

comment on function public.decline_nudge(bigint, uuid) is
  'Decline a learning nudge: 30-day hibernation before the nudge can re-surface. (Phase 1)';
