-- RPC: reassign_chore_by_query

create or replace function public.reassign_chore_by_query(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_query text,
  p_helper_query text default null,
  p_when text default null
)
returns table (
  action text,
  chore_id uuid,
  chore_title text,
  due_at timestamptz,
  helper_id uuid,
  helper_name text,
  chore_candidates jsonb,
  helper_candidates jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  tz text;
  cq text;
  hq text;
  base_day date;
  hres record;
  match_id uuid;
  match_title text;
  match_due timestamptz;
  match_count int;
  target_helper_id uuid;
  target_helper_name text;
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

  cq := trim(coalesce(p_chore_query, ''));
  if cq = '' then
    raise exception 'p_chore_query is required';
  end if;

  select h.timezone into tz
  from public.households h
  where h.id = p_household_id;
  if tz is null or btrim(tz) = '' then
    tz := 'UTC';
  end if;

  base_day := (now() at time zone tz)::date;
  if lower(coalesce(p_when, '')) in ('tomorrow', 'tmrw', 'tmr') then
    base_day := base_day + 1;
  end if;

  hq := trim(coalesce(p_helper_query, ''));
  if hq = '' then
    target_helper_id := null;
    target_helper_name := null;
  else
    select * into hres
    from public.resolve_helper(p_household_id, p_actor_user_id, hq)
    limit 1;

    if hres.match_type = 'none' then
      action := 'clarify_helper';
      chore_id := null;
      chore_title := null;
      due_at := null;
      helper_id := null;
      helper_name := null;
      chore_candidates := null;
      helper_candidates := '[]'::jsonb;
      return next;
      return;
    end if;

    if hres.match_type = 'ambiguous' then
      action := 'clarify_helper';
      chore_id := null;
      chore_title := null;
      due_at := null;
      helper_id := null;
      helper_name := null;
      chore_candidates := null;
      helper_candidates := coalesce(hres.candidates, '[]'::jsonb);
      return next;
      return;
    end if;

    target_helper_id := hres.helper_id;
    target_helper_name := hres.helper_name;
  end if;

  with candidates as (
    select
      c.id,
      c.title,
      c.due_at,
      c.helper_id,
      ts_rank(to_tsvector('simple', coalesce(c.title, '')), plainto_tsquery('simple', cq)) as rnk
    from public.chores c
    where c.household_id = p_household_id
      and c.deleted_at is null
      and (c.status is null or c.status <> 'done')
      and (
        lower(coalesce(p_when, '')) = ''
        or (c.due_at is not null and (c.due_at at time zone tz)::date = base_day)
      )
      and to_tsvector('simple', coalesce(c.title, '')) @@ plainto_tsquery('simple', cq)
  )
  select count(*) into match_count from candidates;

  if match_count = 0 then
    action := 'none_found';
    chore_id := null;
    chore_title := null;
    due_at := null;
    helper_id := target_helper_id;
    helper_name := target_helper_name;
    chore_candidates := '[]'::jsonb;
    helper_candidates := null;
    return next;
    return;
  end if;

  if match_count > 1 then
    action := 'clarify_chore';
    chore_id := null;
    chore_title := null;
    due_at := null;
    helper_id := target_helper_id;
    helper_name := target_helper_name;
    chore_candidates := (
      select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'due_at', due_at, 'helper_id', helper_id) order by rnk desc)
      from (
        select id, title, due_at, helper_id, rnk
        from candidates
        order by rnk desc
        limit 5
      ) s
    );
    helper_candidates := null;
    return next;
    return;
  end if;

  select id, title, due_at
    into match_id, match_title, match_due
  from candidates
  order by rnk desc
  limit 1;

  update public.chores c
    set helper_id = target_helper_id
  where c.id = match_id;

  action := case when target_helper_id is null then 'unassigned' else 'reassigned' end;
  chore_id := match_id;
  chore_title := match_title;
  due_at := match_due;
  helper_id := target_helper_id;
  helper_name := target_helper_name;
  chore_candidates := null;
  helper_candidates := null;
  return next;
end;
$$;

revoke all on function public.reassign_chore_by_query(uuid, uuid, text, text, text) from public;
grant execute on function public.reassign_chore_by_query(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.reassign_chore_by_query(uuid, uuid, text, text, text) to service_role;
