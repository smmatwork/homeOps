-- RPC: complete_chore_by_query

create or replace function public.complete_chore_by_query(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_query text,
  p_when text default null
)
returns table (
  action text,
  chore_id uuid,
  chore_title text,
  due_at timestamptz,
  candidates jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  tz text;
  q text;
  base_day date;
  match_id uuid;
  match_title text;
  match_due timestamptz;
  match_count int;
  chosen_rank real;
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

  q := trim(coalesce(p_query, ''));
  if q = '' then
    raise exception 'p_query is required';
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

  with candidates as (
    select
      c.id,
      c.title,
      c.due_at,
      ts_rank(to_tsvector('simple', coalesce(c.title, '')), plainto_tsquery('simple', q)) as rnk
    from public.chores c
    where c.household_id = p_household_id
      and c.deleted_at is null
      and (c.status is null or c.status <> 'done')
      and (
        lower(coalesce(p_when, '')) = ''
        or (c.due_at is not null and (c.due_at at time zone tz)::date = base_day)
      )
      and to_tsvector('simple', coalesce(c.title, '')) @@ plainto_tsquery('simple', q)
  )
  select count(*) into match_count from candidates;

  if match_count = 0 then
    action := 'none_found';
    chore_id := null;
    chore_title := null;
    due_at := null;
    candidates := '[]'::jsonb;
    return next;
    return;
  end if;

  if match_count > 1 then
    action := 'clarify_chore';
    chore_id := null;
    chore_title := null;
    due_at := null;
    candidates := (
      select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'due_at', due_at) order by rnk desc)
      from (
        select id, title, due_at, rnk
        from candidates
        order by rnk desc
        limit 5
      ) s
    );
    return next;
    return;
  end if;

  select id, title, due_at, rnk
    into match_id, match_title, match_due, chosen_rank
  from candidates
  order by rnk desc
  limit 1;

  update public.chores c
    set status = 'done'
  where c.id = match_id;

  action := 'completed';
  chore_id := match_id;
  chore_title := match_title;
  due_at := match_due;
  candidates := null;
  return next;
end;
$$;

revoke all on function public.complete_chore_by_query(uuid, uuid, text, text) from public;
grant execute on function public.complete_chore_by_query(uuid, uuid, text, text) to authenticated;
grant execute on function public.complete_chore_by_query(uuid, uuid, text, text) to service_role;
