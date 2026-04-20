-- Phase 1 — pattern elicitation RPCs
--
-- The pattern_elicitation_state table already exists (migration 20260415100000).
-- This migration ships the three RPCs that drive the conversational
-- elicitation flow:
--
--   1. start_pattern_elicitation          — seed pending rows if none exist
--   2. get_next_elicitation_question      — returns the next pending question
--   3. answer_elicitation_question        — writes answer + translates to
--                                           assignment_rules (source=elicitation)
--
-- The question catalog is hard-coded here so the client only needs
-- template_ids + answer shapes; labels + help text live in the UI.
--
-- v1 catalog — 4 specialty questions:
--   specialty_kitchen   — Who handles kitchen tasks?
--   specialty_cleaning  — Who handles room/bathroom cleaning?
--   specialty_outdoor   — Who handles outdoor/garden tasks?
--   specialty_laundry   — Who handles laundry/ironing?
--
-- Each answer is { helper_id: uuid | null }. A null helper_id means
-- "no strong preference" and is recorded as 'skipped' status. Non-null
-- answers insert an assignment_rules row with source='elicitation'.

-- ─────────────────────────────────────────────────────────────────────────
-- Helper: canonical area tag catalog (matches AssignmentPanel SPECIALTY_AREAS)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.elicitation_area_tags(p_template_id text)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case p_template_id
    when 'specialty_kitchen'  then '["kitchen","cooking","dining"]'::jsonb
    when 'specialty_cleaning' then '["cleaning","sweeping","mopping","dusting","bathroom","bedroom","living","general"]'::jsonb
    when 'specialty_outdoor'  then '["garden","outdoor","balcony","garage"]'::jsonb
    when 'specialty_laundry'  then '["laundry","washing","ironing"]'::jsonb
    else '[]'::jsonb
  end;
$$;

revoke all on function public.elicitation_area_tags(text) from public;
grant execute on function public.elicitation_area_tags(text) to authenticated;
grant execute on function public.elicitation_area_tags(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. start_pattern_elicitation
-- ─────────────────────────────────────────────────────────────────────────
--
-- Idempotent: seeds 4 pending rows for the household if none exist yet.
-- Returns the total count of elicitation rows (seeded or pre-existing)
-- plus the count currently pending.

create or replace function public.start_pattern_elicitation(
  p_household_id uuid,
  p_actor_user_id uuid
)
returns table (
  total_count int,
  pending_count int,
  just_seeded bool
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing int;
  v_seeded bool := false;
  v_templates text[] := array[
    'specialty_kitchen',
    'specialty_cleaning',
    'specialty_outdoor',
    'specialty_laundry'
  ];
  v_t text;
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

  select count(*)::int into v_existing
  from public.pattern_elicitation_state
  where household_id = p_household_id;

  if v_existing = 0 then
    foreach v_t in array v_templates loop
      insert into public.pattern_elicitation_state (
        household_id, template_id, status
      ) values (
        p_household_id, v_t, 'pending'
      )
      on conflict (household_id, template_id) do nothing;
    end loop;
    v_seeded := true;
  end if;

  select count(*)::int into total_count
  from public.pattern_elicitation_state
  where household_id = p_household_id;

  select count(*)::int into pending_count
  from public.pattern_elicitation_state
  where household_id = p_household_id
    and status in ('pending', 'in_progress');

  just_seeded := v_seeded;
  return next;
end;
$$;

revoke all on function public.start_pattern_elicitation(uuid, uuid) from public;
grant execute on function public.start_pattern_elicitation(uuid, uuid) to authenticated;
grant execute on function public.start_pattern_elicitation(uuid, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. get_next_elicitation_question
-- ─────────────────────────────────────────────────────────────────────────
--
-- Returns the next pending (or in_progress) question for a household,
-- or null-valued row when none remain. Also marks the returned row as
-- 'in_progress' with asked_at = now() so the UI can track progress.

create or replace function public.get_next_elicitation_question(
  p_household_id uuid,
  p_actor_user_id uuid
)
returns table (
  template_id text,
  status text,
  asked_at timestamptz,
  pending_count int,
  answered_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid text;
  v_status text;
  v_asked_at timestamptz;
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

  -- Find the next question to ask. Prefer pending; fall back to in_progress
  -- (so a resumed session continues where it left off).
  select s.template_id, s.status, s.asked_at
    into v_tid, v_status, v_asked_at
  from public.pattern_elicitation_state s
  where s.household_id = p_household_id
    and s.status in ('pending', 'in_progress')
  order by
    case when s.status = 'in_progress' then 0 else 1 end,
    s.asked_at nulls first,
    s.template_id
  limit 1;

  if v_tid is not null and v_status = 'pending' then
    update public.pattern_elicitation_state
    set status = 'in_progress',
        asked_at = coalesce(asked_at, now())
    where household_id = p_household_id
      and template_id = v_tid;
    v_status := 'in_progress';
    v_asked_at := coalesce(v_asked_at, now());
  end if;

  select count(*)::int into pending_count
  from public.pattern_elicitation_state
  where household_id = p_household_id
    and status in ('pending', 'in_progress');

  select count(*)::int into answered_count
  from public.pattern_elicitation_state
  where household_id = p_household_id
    and status in ('completed', 'skipped');

  template_id := v_tid;
  status := v_status;
  asked_at := v_asked_at;
  return next;
end;
$$;

revoke all on function public.get_next_elicitation_question(uuid, uuid) from public;
grant execute on function public.get_next_elicitation_question(uuid, uuid) to authenticated;
grant execute on function public.get_next_elicitation_question(uuid, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. answer_elicitation_question
-- ─────────────────────────────────────────────────────────────────────────
--
-- Accepts the answer for a question, writes it to pattern_elicitation_state,
-- and translates it into an assignment_rules row if the helper_id is
-- non-null. If the user skips (answer = {skip: true}), the row is marked
-- 'skipped' and no rule is created.
--
-- For 'specialty_*' template_ids:
--   • answer shape: { helper_id: uuid | null, skip?: bool }
--   • if helper_id is non-null: insert assignment_rules with
--       template_id = <same template_id>
--       template_params = { area_key, area_tags }
--       source = 'elicitation'
--       weight = 1.0
--   • if skipped: no rule; status='skipped'
--
-- Idempotent on (household_id, template_id): re-answering the same
-- question replaces the prior rule and updates the state row.

create or replace function public.answer_elicitation_question(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_template_id text,
  p_answer jsonb
)
returns table (
  status text,
  rule_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_skip bool;
  v_helper_id uuid;
  v_rule_id uuid;
  v_area_tags jsonb;
  v_area_key text;
  v_state_status text;
begin
  if p_household_id is null or p_actor_user_id is null or p_template_id is null then
    raise exception 'p_household_id, p_actor_user_id, p_template_id are required';
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  v_skip := coalesce((p_answer->>'skip')::bool, false);

  if not v_skip and p_answer ? 'helper_id' and nullif(p_answer->>'helper_id', '') is not null then
    begin
      v_helper_id := (p_answer->>'helper_id')::uuid;
    exception when others then
      raise exception 'invalid helper_id in answer';
    end;

    if not exists (
      select 1 from public.helpers h
      where h.id = v_helper_id and h.household_id = p_household_id
    ) then
      raise exception 'helper % not found in household %', v_helper_id, p_household_id;
    end if;
  end if;

  -- Remove any prior rule from elicitation for this template so re-answering
  -- is idempotent. Only deletes rules with source='elicitation' (nudge-
  -- learned rules and manual-edit rules are preserved).
  delete from public.assignment_rules
  where household_id = p_household_id
    and template_id = p_template_id
    and source = 'elicitation';

  if v_helper_id is not null then
    v_area_tags := public.elicitation_area_tags(p_template_id);
    v_area_key := case
      when p_template_id like 'specialty_%' then substring(p_template_id from 11)
      else p_template_id
    end;

    insert into public.assignment_rules (
      household_id,
      template_id,
      template_params,
      helper_id,
      weight,
      source,
      active,
      created_by
    )
    values (
      p_household_id,
      p_template_id,
      jsonb_build_object('area_key', v_area_key, 'area_tags', v_area_tags),
      v_helper_id,
      1.0,
      'elicitation',
      true,
      p_actor_user_id
    )
    returning id into v_rule_id;

    v_state_status := 'completed';
  else
    v_state_status := 'skipped';
  end if;

  insert into public.pattern_elicitation_state (
    household_id, template_id, status, answer, asked_at, answered_at
  )
  values (
    p_household_id,
    p_template_id,
    v_state_status,
    coalesce(p_answer, '{}'::jsonb),
    v_now,
    v_now
  )
  on conflict (household_id, template_id) do update
    set status = excluded.status,
        answer = excluded.answer,
        asked_at = coalesce(public.pattern_elicitation_state.asked_at, excluded.asked_at),
        answered_at = excluded.answered_at;

  -- Log a full-effort decision for the O1 metric. Elicitation answers are
  -- cognitive work the owner did (rule #6 locked in the manifest).
  insert into public.assignment_decisions (
    household_id, chore_id, helper_id, mode, classification,
    rule_ids, contributions, proposed_helper_id, overridden, decided_by_user_id
  ) values (
    p_household_id,
    null,
    v_helper_id,
    'elicitation',
    'full_effort',
    case when v_rule_id is not null then array[v_rule_id] else null end,
    jsonb_build_object('template_id', p_template_id, 'skipped', v_skip),
    null,
    false,
    p_actor_user_id
  );

  status := v_state_status;
  rule_id := v_rule_id;
  return next;
end;
$$;

revoke all on function public.answer_elicitation_question(uuid, uuid, text, jsonb) from public;
grant execute on function public.answer_elicitation_question(uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.answer_elicitation_question(uuid, uuid, text, jsonb) to service_role;

comment on function public.start_pattern_elicitation(uuid, uuid) is
  'Idempotent: seed 4 specialty-elicitation questions for a household. (Phase 1)';
comment on function public.get_next_elicitation_question(uuid, uuid) is
  'Return the next pending elicitation question, marking it in_progress. (Phase 1)';
comment on function public.answer_elicitation_question(uuid, uuid, text, jsonb) is
  'Record an elicitation answer + translate to assignment_rules row when not skipped. Logs a full-effort O1 decision. (Phase 1)';
