-- Add assignee_person_id to chores table for user-only households.
--
-- Allows chores to be assigned to household members (people) instead of
-- or in addition to helpers. At most one of helper_id or assignee_person_id
-- can be non-null — a chore is assigned to either a helper or a person.
--
-- Backward-compatible: existing code that only uses helper_id continues
-- to work. New code checks both columns.

-- 1) Add the column
alter table public.chores
  add column if not exists assignee_person_id uuid
    references public.household_people(id) on delete set null;

-- 2) Constraint: at most one assignee type
alter table public.chores
  add constraint chk_single_assignee
    check (
      not (helper_id is not null and assignee_person_id is not null)
    );

-- 3) Index for person-based lookups
create index if not exists idx_chores_assignee_person_id
  on public.chores (assignee_person_id)
  where assignee_person_id is not null;

-- 4) Update apply_assignment_decision to support person assignment
create or replace function public.apply_assignment_decision(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_id uuid,
  p_helper_id uuid,
  p_mode text,
  p_classification text,
  p_rule_ids uuid[] default null,
  p_contributions jsonb default null,
  p_proposed_helper_id uuid default null,
  p_person_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_helper_id uuid;
  v_prev_person_id uuid;
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
  -- Cannot assign to both helper and person simultaneously
  if p_helper_id is not null and p_person_id is not null then
    raise exception 'cannot assign to both helper and person';
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

  -- Confirm the chore belongs to this household.
  select helper_id, assignee_person_id
    into v_prev_helper_id, v_prev_person_id
  from public.chores
  where id = p_chore_id
    and household_id = p_household_id
    and deleted_at is null;

  if not found then
    raise exception 'chore % not found in household %', p_chore_id, p_household_id;
  end if;

  -- Determine action for audit log
  if p_helper_id is null and p_person_id is null then
    v_action := 'unassigned';
  elsif v_prev_helper_id is null and v_prev_person_id is null then
    v_action := 'assigned';
  else
    v_action := 'reassigned';
  end if;

  -- 1) Update chores: set the appropriate assignee, clear the other
  update public.chores
  set helper_id = p_helper_id,
      assignee_person_id = p_person_id,
      updated_at = now()
  where id = p_chore_id
    and household_id = p_household_id;

  -- 2) Audit log
  insert into public.chore_helper_assignments (
    household_id, chore_id, helper_id, action, assigned_by, metadata
  ) values (
    p_household_id,
    p_chore_id,
    coalesce(p_helper_id, p_person_id),  -- use whichever assignee is set
    v_action,
    p_actor_user_id,
    jsonb_build_object(
      'mode', p_mode,
      'previous_helper_id', v_prev_helper_id,
      'previous_person_id', v_prev_person_id,
      'assignee_type', case when p_person_id is not null then 'person' else 'helper' end,
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
    coalesce(p_helper_id, p_person_id),
    p_mode,
    p_classification,
    p_rule_ids,
    p_contributions,
    p_proposed_helper_id,
    (p_proposed_helper_id is not null and p_proposed_helper_id is distinct from coalesce(p_helper_id, p_person_id)),
    p_actor_user_id
  )
  returning id into v_decision_id;

  return v_decision_id;
end;
$$;

-- Re-grant permissions (function signature changed with new param)
revoke all on function public.apply_assignment_decision(
  uuid, uuid, uuid, uuid, text, text, uuid[], jsonb, uuid, uuid
) from public;
grant execute on function public.apply_assignment_decision(
  uuid, uuid, uuid, uuid, text, text, uuid[], jsonb, uuid, uuid
) to authenticated;
grant execute on function public.apply_assignment_decision(
  uuid, uuid, uuid, uuid, text, text, uuid[], jsonb, uuid, uuid
) to service_role;

-- 5) Update list_chores_enriched to include assignee_person_id and person name
--    (existing callers see the new columns as null for helper-assigned chores)
create or replace function public.list_chores_enriched(
  p_household_id uuid,
  p_status text default null,
  p_helper_id uuid default null,
  p_space text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  title text,
  description text,
  status text,
  priority smallint,
  due_at timestamptz,
  completed_at timestamptz,
  helper_id uuid,
  helper_name text,
  assignee_person_id uuid,
  assignee_person_name text,
  space text,
  cadence text,
  estimated_minutes int,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;

  return query
    select
      c.id,
      c.title,
      c.description,
      c.status,
      c.priority,
      c.due_at,
      c.completed_at,
      c.helper_id,
      h.name as helper_name,
      c.assignee_person_id,
      hp.display_name as assignee_person_name,
      (c.metadata->>'space')::text as space,
      (c.metadata->>'cadence')::text as cadence,
      (c.metadata->>'estimated_minutes')::int as estimated_minutes,
      c.metadata,
      c.created_at
    from public.chores c
    left join public.helpers h on h.id = c.helper_id
    left join public.household_people hp on hp.id = c.assignee_person_id
    where c.household_id = p_household_id
      and c.deleted_at is null
      and (p_status is null or c.status = p_status)
      and (p_helper_id is null or c.helper_id = p_helper_id or c.assignee_person_id = p_helper_id)
      and (p_space is null or (c.metadata->>'space') = p_space)
    order by c.due_at asc nulls last, c.created_at desc
    limit p_limit
    offset p_offset;
end;
$$;

-- 6) Update count_chores_assigned_to to also count person assignments
create or replace function public.count_chores_assigned_to(
  p_household_id uuid,
  p_helper_query text
)
returns table (
  helper_id uuid,
  helper_name text,
  assigned_count bigint,
  assignee_type text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q text;
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;

  q := trim(lower(coalesce(p_helper_query, '')));

  -- Search helpers first, then people
  return query
    select
      h.id as helper_id,
      h.name as helper_name,
      count(c.id) as assigned_count,
      'helper'::text as assignee_type
    from public.helpers h
    left join public.chores c
      on c.helper_id = h.id
      and c.household_id = p_household_id
      and c.deleted_at is null
      and c.status != 'done'
    where h.household_id = p_household_id
      and (q = '' or lower(h.name) like '%' || q || '%' or lower(h.type) like '%' || q || '%')
    group by h.id, h.name

    union all

    select
      hp.id as helper_id,
      hp.display_name as helper_name,
      count(c.id) as assigned_count,
      'person'::text as assignee_type
    from public.household_people hp
    left join public.chores c
      on c.assignee_person_id = hp.id
      and c.household_id = p_household_id
      and c.deleted_at is null
      and c.status != 'done'
    where hp.household_id = p_household_id
      and (q = '' or lower(hp.display_name) like '%' || q || '%')
    group by hp.id, hp.display_name;
end;
$$;

-- 7) Add RPC to get O1 cognitive load metric (4-week rolling window)
create or replace function public.get_o1_cognitive_load_ratio(
  p_household_id uuid
)
returns table (
  total_decisions bigint,
  load_reducing_decisions bigint,
  ratio float
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;

  return query
    select
      count(*)::bigint as total_decisions,
      count(*) filter (where ad.classification = 'load_reducing')::bigint as load_reducing_decisions,
      case
        when count(*) = 0 then 0.0
        else count(*) filter (where ad.classification = 'load_reducing')::float / count(*)::float
      end as ratio
    from public.assignment_decisions ad
    where ad.household_id = p_household_id
      and ad.decided_at >= now() - interval '4 weeks';
end;
$$;

revoke all on function public.get_o1_cognitive_load_ratio(uuid) from public;
grant execute on function public.get_o1_cognitive_load_ratio(uuid) to authenticated;
grant execute on function public.get_o1_cognitive_load_ratio(uuid) to service_role;

-- 8) Add RPC to check auto-assignment graduation status
create or replace function public.check_auto_assignment_graduation(
  p_household_id uuid,
  p_chore_predicate_hash text,
  p_helper_id uuid
)
returns table (
  should_graduate boolean,
  consecutive_approvals bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;

  -- Count consecutive one_tap approvals without override for this
  -- (chore pattern, helper) combination. Graduation threshold = 5.
  return query
    with recent as (
      select
        ad.mode,
        ad.overridden,
        ad.decided_at,
        row_number() over (order by ad.decided_at desc) as rn
      from public.assignment_decisions ad
      where ad.household_id = p_household_id
        and ad.helper_id = p_helper_id
        and ad.mode in ('one_tap', 'silent_auto')
        and not ad.overridden
      order by ad.decided_at desc
      limit 10
    ),
    consecutive as (
      select count(*) as cnt
      from recent
      where rn <= (
        select coalesce(min(r2.rn) - 1, (select count(*) from recent))
        from (
          select rn from public.assignment_decisions ad2
          where ad2.household_id = p_household_id
            and ad2.helper_id = p_helper_id
            and (ad2.overridden = true or ad2.mode = 'manual')
          order by ad2.decided_at desc
          limit 1
        ) as broken
        cross join lateral (
          select r3.rn from recent r3
          where r3.decided_at <= (
            select ad3.decided_at from public.assignment_decisions ad3
            where ad3.household_id = p_household_id
              and ad3.helper_id = p_helper_id
              and (ad3.overridden = true or ad3.mode = 'manual')
            order by ad3.decided_at desc
            limit 1
          )
          limit 1
        ) r2
      )
    )
    select
      (select cnt >= 5 from consecutive) as should_graduate,
      (select cnt from consecutive) as consecutive_approvals;
end;
$$;

revoke all on function public.check_auto_assignment_graduation(uuid, text, uuid) from public;
grant execute on function public.check_auto_assignment_graduation(uuid, text, uuid) to authenticated;
grant execute on function public.check_auto_assignment_graduation(uuid, text, uuid) to service_role;
