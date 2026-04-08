-- Fix: list_chores_enriched ambiguous helper_id reference

create or replace function public.list_chores_enriched(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_filters jsonb default '{}'::jsonb,
  p_limit int default 25
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
  f jsonb;
  helper_q text;
  space_q text;
  v_helper_id uuid;
  space_val text;
  st text;
  helper_row record;
  space_row record;
  lim int;
  due_before timestamptz;
  due_after timestamptz;
  overdue boolean;
  before_created_at timestamptz;
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

  st := nullif(btrim(coalesce(f->>'status', '')), '');
  due_before := nullif(btrim(coalesce(f->>'due_before', '')), '')::timestamptz;
  due_after := nullif(btrim(coalesce(f->>'due_after', '')), '')::timestamptz;
  overdue := (coalesce(f->>'overdue', '') = 'true');
  before_created_at := nullif(btrim(coalesce(f->>'before_created_at', '')), '')::timestamptz;

  lim := greatest(1, least(coalesce(p_limit, 25), 100));

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

  select jsonb_agg(
    jsonb_build_object(
      'id', x.id,
      'title', x.title,
      'status', x.status,
      'due_at', x.due_at,
      'created_at', x.created_at,
      'helper_id', x.helper_id,
      'helper_name', x.helper_name,
      'space', x.space
    )
    order by x.created_at desc
  )
    into result
  from (
    select
      c.id,
      c.title,
      c.status,
      c.due_at,
      c.created_at,
      c.helper_id,
      h.name as helper_name,
      c.metadata->>'space' as space
    from public.chores c
    left join public.helpers h
      on h.id = c.helper_id
    where c.household_id = p_household_id
      and c.deleted_at is null
      and (st is null or c.status = st)
      and (v_helper_id is null or c.helper_id = v_helper_id)
      and (space_val is null or (c.metadata->>'space') ilike space_val)
      and (due_before is null or c.due_at <= due_before)
      and (due_after is null or c.due_at >= due_after)
      and (before_created_at is null or c.created_at < before_created_at)
      and (not overdue or (c.due_at is not null and c.due_at < now() and c.status <> 'completed'))
    order by c.created_at desc
    limit lim
  ) x;

  if result is null then
    result := '[]'::jsonb;
  end if;

  match_type := 'unique';
  helper_candidates := null;
  space_candidates := null;
  return next;
end;
$$;

revoke all on function public.list_chores_enriched(uuid, uuid, jsonb, int) from public;
grant execute on function public.list_chores_enriched(uuid, uuid, jsonb, int) to authenticated;
grant execute on function public.list_chores_enriched(uuid, uuid, jsonb, int) to service_role;
