-- Helper + assignment RPCs: Phase 1.0
--
-- Ships 4 RPCs that the agent service calls via the edge function's
-- query.rpc allowlist. The fifth RPC (score_helpers_for_chore) depends
-- on the strategy library and ships in P1.4.
--
-- All RPCs are security definer with a household_member check. They do
-- not trust the caller's JWT alone — the actor user id is passed as an
-- explicit argument so the edge function can enforce its own auth rules.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. apply_assignment_decision
-- ─────────────────────────────────────────────────────────────────────────
--
-- Atomic: update chores.helper_id, write chore_helper_assignments audit
-- row, write assignment_decisions row for the O1 metric. Returns the
-- new assignment_decisions.id so the caller can reference it.

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

  -- Confirm the chore belongs to this household. Pull the previous
  -- helper_id so we can write the correct action in the audit log.
  select helper_id into v_prev_helper_id
  from public.chores
  where id = p_chore_id
    and household_id = p_household_id
    and deleted_at is null;

  if not found then
    raise exception 'chore % not found in household %', p_chore_id, p_household_id;
  end if;

  -- If helper_id is being set to null, record an unassignment.
  if p_helper_id is null then
    v_action := 'unassigned';
  elsif v_prev_helper_id is null then
    v_action := 'assigned';
  elsif v_prev_helper_id = p_helper_id then
    v_action := 'assigned';  -- idempotent reassignment to same helper; still record for audit
  else
    v_action := 'reassigned';
  end if;

  -- 1) Update chores.helper_id
  update public.chores
  set helper_id = p_helper_id,
      updated_at = now()
  where id = p_chore_id
    and household_id = p_household_id;

  -- 2) Audit log
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

  -- 3) O1 instrumentation
  insert into public.assignment_decisions (
    household_id, chore_id, helper_id, mode, classification,
    rule_ids, contributions, proposed_helper_id,
    overridden, decided_by_user_id
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
    p_actor_user_id
  )
  returning id into v_decision_id;

  return v_decision_id;
end;
$$;

revoke all on function public.apply_assignment_decision(
  uuid, uuid, uuid, uuid, text, text, uuid[], jsonb, uuid
) from public;
grant execute on function public.apply_assignment_decision(
  uuid, uuid, uuid, uuid, text, text, uuid[], jsonb, uuid
) to authenticated;
grant execute on function public.apply_assignment_decision(
  uuid, uuid, uuid, uuid, text, text, uuid[], jsonb, uuid
) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. record_assignment_override
-- ─────────────────────────────────────────────────────────────────────────
--
-- Called when the owner overrides a system proposal. Updates the
-- assignment_overrides aggregator and returns should_nudge=true once
-- the override count reaches 3 for a given (chore pattern, proposed,
-- chosen) combination and the nudge is not hibernating.

create or replace function public.record_assignment_override(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_id uuid,
  p_proposed_helper_id uuid,
  p_chosen_helper_id uuid
)
returns table (
  override_count int,
  should_nudge bool
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_predicate_sample jsonb;
  v_predicate_hash text;
  v_row public.assignment_overrides%rowtype;
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;
  if p_actor_user_id is null then
    raise exception 'p_actor_user_id is required';
  end if;
  if p_chore_id is null or p_proposed_helper_id is null or p_chosen_helper_id is null then
    raise exception 'p_chore_id, p_proposed_helper_id, p_chosen_helper_id are all required';
  end if;

  if not exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  -- Build a canonical predicate sample + hash from the chore's metadata.
  -- We key on space, cadence, and the first word of the title as a
  -- stable-enough grouping for override patterns.
  select
    jsonb_build_object(
      'space', coalesce(c.metadata->>'space',''),
      'cadence', coalesce(c.metadata->>'cadence',''),
      'title_head', lower(split_part(trim(c.title),' ',1))
    )
  into v_predicate_sample
  from public.chores c
  where c.id = p_chore_id
    and c.household_id = p_household_id;

  if v_predicate_sample is null then
    raise exception 'chore % not found in household %', p_chore_id, p_household_id;
  end if;

  v_predicate_hash := md5(v_predicate_sample::text);

  -- Upsert the aggregator row.
  insert into public.assignment_overrides (
    household_id, chore_predicate_hash, chore_predicate_sample,
    proposed_helper_id, chosen_helper_id,
    override_count, first_override_at, last_override_at
  )
  values (
    p_household_id, v_predicate_hash, v_predicate_sample,
    p_proposed_helper_id, p_chosen_helper_id,
    1, now(), now()
  )
  on conflict (household_id, chore_predicate_hash, proposed_helper_id, chosen_helper_id)
  do update set
    override_count = public.assignment_overrides.override_count + 1,
    last_override_at = now(),
    chore_predicate_sample = excluded.chore_predicate_sample
  returning * into v_row;

  override_count := v_row.override_count;

  -- Nudge fires when count reaches 3 and status is 'none', OR when
  -- status is 'declined' but the hibernation window has expired.
  should_nudge := (
    v_row.override_count >= 3
    and (
      v_row.nudge_status = 'none'
      or (v_row.nudge_status = 'declined'
          and v_row.nudge_decline_until is not null
          and v_row.nudge_decline_until < now())
    )
  );

  return next;
end;
$$;

revoke all on function public.record_assignment_override(uuid, uuid, uuid, uuid, uuid) from public;
grant execute on function public.record_assignment_override(uuid, uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.record_assignment_override(uuid, uuid, uuid, uuid, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. find_chores_needing_reassignment
-- ─────────────────────────────────────────────────────────────────────────
--
-- When a helper is going on leave, return the chores assigned to them
-- that fall within the leave window. The caller decides how to
-- reassign each one.

create or replace function public.find_chores_needing_reassignment(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_helper_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  chore_id uuid,
  title text,
  description text,
  due_at timestamptz,
  status text,
  priority smallint,
  metadata jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_household_id is null or p_actor_user_id is null or p_helper_id is null then
    raise exception 'p_household_id, p_actor_user_id, p_helper_id are required';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'p_start and p_end are required and p_end must be after p_start';
  end if;

  if not exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  return query
  select
    c.id,
    c.title,
    c.description,
    c.due_at,
    c.status,
    c.priority::smallint,
    c.metadata
  from public.chores c
  where c.household_id = p_household_id
    and c.helper_id = p_helper_id
    and c.deleted_at is null
    and c.status in ('pending','in-progress')
    and (
      (c.due_at is not null and c.due_at >= p_start and c.due_at < p_end)
      or (c.due_at is null)   -- recurring chores with no explicit due_at; caller can filter further
    )
  order by c.due_at nulls last, c.priority desc
  limit 200;
end;
$$;

revoke all on function public.find_chores_needing_reassignment(uuid, uuid, uuid, timestamptz, timestamptz) from public;
grant execute on function public.find_chores_needing_reassignment(uuid, uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.find_chores_needing_reassignment(uuid, uuid, uuid, timestamptz, timestamptz) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. compensation_ledger_summary
-- ─────────────────────────────────────────────────────────────────────────
--
-- Computes the current ledger state for a helper: current salary,
-- total advances outstanding, total bonuses ytd, last settlement date.
-- Owner-view and helper-view return the same numbers; the caller
-- decides what to render.

create or replace function public.compensation_ledger_summary(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_helper_id uuid
)
returns table (
  current_salary numeric,
  currency text,
  salary_effective_date date,
  total_advances_outstanding numeric,
  total_bonuses_ytd numeric,
  last_settlement_date date,
  entries_count int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_year_start date := date_trunc('year', now())::date;
begin
  if p_household_id is null or p_actor_user_id is null or p_helper_id is null then
    raise exception 'p_household_id, p_actor_user_id, p_helper_id are required';
  end if;

  if not exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  -- Current salary = most recent salary_set / salary_change that isn't voided.
  select l.amount, l.currency, l.effective_date
    into current_salary, currency, salary_effective_date
  from public.helper_compensation_ledger l
  where l.helper_id = p_helper_id
    and l.household_id = p_household_id
    and l.entry_type in ('salary_set','salary_change')
    and l.voided_at is null
  order by l.effective_date desc, l.created_at desc
  limit 1;

  if currency is null then
    currency := 'INR';
  end if;

  -- Total advances outstanding = sum of advances since last settlement,
  -- excluding voided rows.
  select coalesce(sum(l.amount), 0)
    into total_advances_outstanding
  from public.helper_compensation_ledger l
  where l.helper_id = p_helper_id
    and l.household_id = p_household_id
    and l.entry_type = 'advance'
    and l.voided_at is null
    and l.effective_date > coalesce(
      (select max(effective_date)
       from public.helper_compensation_ledger
       where helper_id = p_helper_id
         and household_id = p_household_id
         and entry_type = 'settlement'
         and voided_at is null),
      '1900-01-01'::date
    );

  -- Total bonuses YTD.
  select coalesce(sum(l.amount), 0)
    into total_bonuses_ytd
  from public.helper_compensation_ledger l
  where l.helper_id = p_helper_id
    and l.household_id = p_household_id
    and l.entry_type = 'bonus'
    and l.voided_at is null
    and l.effective_date >= v_year_start;

  -- Last settlement date.
  select max(l.effective_date)
    into last_settlement_date
  from public.helper_compensation_ledger l
  where l.helper_id = p_helper_id
    and l.household_id = p_household_id
    and l.entry_type = 'settlement'
    and l.voided_at is null;

  -- Entries count.
  select count(*)::int
    into entries_count
  from public.helper_compensation_ledger l
  where l.helper_id = p_helper_id
    and l.household_id = p_household_id
    and l.voided_at is null;

  return next;
end;
$$;

revoke all on function public.compensation_ledger_summary(uuid, uuid, uuid) from public;
grant execute on function public.compensation_ledger_summary(uuid, uuid, uuid) to authenticated;
grant execute on function public.compensation_ledger_summary(uuid, uuid, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Function comments
-- ─────────────────────────────────────────────────────────────────────────

comment on function public.apply_assignment_decision(uuid, uuid, uuid, uuid, text, text, uuid[], jsonb, uuid) is
  'Atomic: update chores.helper_id + write chore_helper_assignments + write assignment_decisions (O1). Returns decision id. (Phase 1.0)';
comment on function public.record_assignment_override(uuid, uuid, uuid, uuid, uuid) is
  'Increment override aggregator and return should_nudge when threshold reached (Phase 1.0)';
comment on function public.find_chores_needing_reassignment(uuid, uuid, uuid, timestamptz, timestamptz) is
  'Return chores assigned to a helper within a leave window, for reassignment flow (Phase 1.0)';
comment on function public.compensation_ledger_summary(uuid, uuid, uuid) is
  'Compute current salary, outstanding advances, YTD bonuses, last settlement for a helper (Phase 1.0)';
