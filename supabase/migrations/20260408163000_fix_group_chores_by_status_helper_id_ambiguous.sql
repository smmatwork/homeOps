-- Fix ambiguous helper_id reference in group_chores_by_status by renaming local variable

create or replace function public.group_chores_by_status(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_filters jsonb default '{}'::jsonb
)
returns table (
  match_type text,
  result jsonb,
  resolved_helper_id uuid,
  resolved_space text,
  helper_candidates jsonb,
  space_candidates jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  out record;
  cnt record;
  f jsonb;
  helper_row record;
  space_row record;
  helper_q text;
  space_q text;
  v_helper_id uuid;
  space_val text;
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

  helper_q := nullif(btrim(coalesce(f->>'helper_query', '')), '');
  space_q := nullif(btrim(coalesce(f->>'space_query', '')), '');

  v_helper_id := nullif(btrim(coalesce(f->>'helper_id', '')), '')::uuid;
  space_val := nullif(btrim(coalesce(f->>'space', '')), '');

  due_before := nullif(btrim(coalesce(f->>'due_before', '')), '')::timestamptz;
  due_after := nullif(btrim(coalesce(f->>'due_after', '')), '')::timestamptz;
  overdue := (coalesce(f->>'overdue', '') = 'true');

  resolved_helper_id := null;
  resolved_space := null;
  helper_candidates := null;
  space_candidates := null;

  if v_helper_id is null and helper_q is not null then
    select * into helper_row from public.resolve_helper(p_household_id, p_actor_user_id, helper_q) limit 1;
    if helper_row.match_type = 'ambiguous' then
      match_type := 'ambiguous_helper';
      result := null;
      helper_candidates := helper_row.candidates;
      space_candidates := null;
      return next;
      return;
    end if;
    if helper_row.match_type = 'none' then
      match_type := 'none_helper';
      result := null;
      helper_candidates := helper_row.candidates;
      space_candidates := null;
      return next;
      return;
    end if;
    v_helper_id := helper_row.helper_id;
  end if;

  if space_val is null and space_q is not null then
    select * into space_row from public.resolve_space(p_household_id, p_actor_user_id, space_q) limit 1;
    if space_row.match_type = 'ambiguous' then
      match_type := 'ambiguous_space';
      result := null;
      helper_candidates := null;
      space_candidates := space_row.candidates;
      return next;
      return;
    end if;
    if space_row.match_type = 'none' then
      match_type := 'none_space';
      result := null;
      helper_candidates := null;
      space_candidates := space_row.candidates;
      return next;
      return;
    end if;
    space_val := space_row.space;
  end if;

  resolved_helper_id := v_helper_id;
  resolved_space := space_val;

  select jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt) order by s.status)
    into result
  from (
    select c.status as status, count(*)::int as cnt
    from public.chores c
    where c.household_id = p_household_id
      and c.deleted_at is null
      and (v_helper_id is null or c.helper_id = v_helper_id)
      and (space_val is null or (c.metadata->>'space') ilike space_val)
      and (due_before is null or c.due_at <= due_before)
      and (due_after is null or c.due_at >= due_after)
      and (not overdue or (c.due_at is not null and c.due_at < now() and c.status <> 'completed'))
    group by c.status
  ) s;

  if result is null then
    result := '[]'::jsonb;
  end if;

  match_type := 'unique';
  helper_candidates := null;
  space_candidates := null;
  return next;
end;
$$;

revoke all on function public.group_chores_by_status(uuid, uuid, jsonb) from public;
grant execute on function public.group_chores_by_status(uuid, uuid, jsonb) to authenticated;
grant execute on function public.group_chores_by_status(uuid, uuid, jsonb) to service_role;
