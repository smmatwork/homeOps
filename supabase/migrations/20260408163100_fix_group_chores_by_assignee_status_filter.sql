-- Fix group_chores_by_assignee to actually apply status filter and avoid ambiguous helper_id reference

create or replace function public.group_chores_by_assignee(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_filters jsonb default '{}'::jsonb
)
returns table (
  match_type text,
  result jsonb,
  resolved_space text,
  space_candidates jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  f jsonb;
  space_q text;
  space_val text;
  space_row record;
  st text;
  due_before timestamptz;
  due_after timestamptz;
  overdue boolean;
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;
  if p_actor_user_id is null then
    raise exception 'p_actor_user_id is required';
  end if;

  if not exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  f := coalesce(p_filters, '{}'::jsonb);

  space_q := nullif(btrim(coalesce(f->>'space_query', '')), '');
  space_val := nullif(btrim(coalesce(f->>'space', '')), '');
  st := nullif(btrim(coalesce(f->>'status', '')), '');
  due_before := nullif(btrim(coalesce(f->>'due_before', '')), '')::timestamptz;
  due_after := nullif(btrim(coalesce(f->>'due_after', '')), '')::timestamptz;
  overdue := (coalesce(f->>'overdue', '') = 'true');

  resolved_space := null;
  space_candidates := null;

  if space_val is null and space_q is not null then
    select * into space_row from public.resolve_space(p_household_id, p_actor_user_id, space_q) limit 1;
    if space_row.match_type = 'ambiguous' then
      match_type := 'ambiguous_space';
      result := null;
      space_candidates := space_row.candidates;
      return next;
      return;
    end if;
    if space_row.match_type = 'none' then
      match_type := 'none_space';
      result := null;
      space_candidates := space_row.candidates;
      return next;
      return;
    end if;
    space_val := space_row.space;
  end if;

  resolved_space := space_val;

  select jsonb_agg(
    jsonb_build_object(
      'helper_id', x.helper_id,
      'helper_name', x.helper_name,
      'count', x.cnt
    )
    order by x.helper_name
  )
    into result
  from (
    select
      c.helper_id as helper_id,
      coalesce(h.name, '(unassigned)') as helper_name,
      count(*)::int as cnt
    from public.chores c
    left join public.helpers h
      on h.id = c.helper_id
    where c.household_id = p_household_id
      and c.deleted_at is null
      and (st is null or c.status = st)
      and (space_val is null or (c.metadata->>'space') ilike space_val)
      and (due_before is null or c.due_at <= due_before)
      and (due_after is null or c.due_at >= due_after)
      and (not overdue or (c.due_at is not null and c.due_at < now() and c.status <> 'completed'))
    group by c.helper_id, h.name
  ) x;

  if result is null then
    result := '[]'::jsonb;
  end if;

  match_type := 'unique';
  space_candidates := null;
  return next;
end;
$$;

revoke all on function public.group_chores_by_assignee(uuid, uuid, jsonb) from public;
grant execute on function public.group_chores_by_assignee(uuid, uuid, jsonb) to authenticated;
grant execute on function public.group_chores_by_assignee(uuid, uuid, jsonb) to service_role;
