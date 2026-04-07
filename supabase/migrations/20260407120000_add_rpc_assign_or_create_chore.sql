-- RPC: assign_or_create_chore

create or replace function public.assign_or_create_chore(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_helper_query text,
  p_task text,
  p_when text default null
)
returns table (
  action text,
  chore_id uuid,
  chore_title text,
  due_at timestamptz,
  helper_id uuid,
  helper_name text,
  candidates jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  tz text;
  q_helper text;
  q_task text;
  res record;
  sched jsonb;
  sched_start text;
  sched_end text;
  start_h int;
  start_m int;
  end_h int;
  end_m int;
  mid_minutes int;
  base_day date;
  computed_due timestamptz;
  match_id uuid;
  match_title text;
  match_due timestamptz;
  match_helper uuid;
  match_rank real;
  match_count int;
  insert_id uuid;
  inserted_title text;
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

  q_helper := trim(coalesce(p_helper_query, ''));
  q_task := trim(coalesce(p_task, ''));
  if q_helper = '' then
    raise exception 'p_helper_query is required';
  end if;
  if q_task = '' then
    raise exception 'p_task is required';
  end if;

  select h.timezone into tz
  from public.households h
  where h.id = p_household_id;
  if tz is null or btrim(tz) = '' then
    tz := 'UTC';
  end if;

  -- Resolve helper (unique/ambiguous/none)
  select * into res
  from public.resolve_helper(p_household_id, p_actor_user_id, q_helper)
  limit 1;

  if res.match_type = 'none' then
    action := 'clarify_helper';
    chore_id := null;
    chore_title := null;
    due_at := null;
    helper_id := null;
    helper_name := null;
    candidates := '[]'::jsonb;
    return next;
    return;
  end if;

  if res.match_type = 'ambiguous' then
    action := 'clarify_helper';
    chore_id := null;
    chore_title := null;
    due_at := null;
    helper_id := null;
    helper_name := null;
    candidates := coalesce(res.candidates, '[]'::jsonb);
    return next;
    return;
  end if;

  helper_id := res.helper_id;
  helper_name := res.helper_name;

  -- Compute due_at for "tomorrow" using helper schedule if present.
  sched := null;
  select h.metadata->'schedule' into sched
  from public.helpers h
  where h.household_id = p_household_id
    and h.id = helper_id;

  sched_start := null;
  sched_end := null;
  if sched is not null then
    sched_start := nullif(btrim(sched->>'start'), '');
    sched_end := nullif(btrim(sched->>'end'), '');
  end if;

  if sched_start is null or sched_start !~ '^\d{2}:\d{2}$' then
    sched_start := '09:00';
  end if;
  if sched_end is null or sched_end !~ '^\d{2}:\d{2}$' then
    sched_end := '17:00';
  end if;

  start_h := split_part(sched_start, ':', 1)::int;
  start_m := split_part(sched_start, ':', 2)::int;
  end_h := split_part(sched_end, ':', 1)::int;
  end_m := split_part(sched_end, ':', 2)::int;

  mid_minutes := ((start_h * 60 + start_m) + (end_h * 60 + end_m)) / 2;

  base_day := (now() at time zone tz)::date;
  if lower(coalesce(p_when, '')) in ('tomorrow', 'tmrw', 'tmr') then
    base_day := base_day + 1;
  end if;

  computed_due := make_timestamptz(
    extract(year from base_day)::int,
    extract(month from base_day)::int,
    extract(day from base_day)::int,
    floor(mid_minutes / 60)::int,
    (mid_minutes % 60)::int,
    0,
    tz
  );

  -- Find existing chores that match the task for the computed due day.
  with candidates as (
    select
      c.id,
      c.title,
      c.due_at,
      c.helper_id,
      ts_rank(to_tsvector('simple', coalesce(c.title, '')), plainto_tsquery('simple', q_task)) as rnk
    from public.chores c
    where c.household_id = p_household_id
      and c.deleted_at is null
      and (c.status is null or c.status <> 'done')
      and (
        c.due_at is null
        or ((c.due_at at time zone tz)::date = base_day)
      )
      and to_tsvector('simple', coalesce(c.title, '')) @@ plainto_tsquery('simple', q_task)
  )
  select count(*) into match_count from candidates;

  if match_count = 1 then
    select id, title, due_at, helper_id, rnk
      into match_id, match_title, match_due, match_helper, match_rank
    from candidates
    order by rnk desc
    limit 1;

    update public.chores c
      set helper_id = public.assign_or_create_chore.helper_id,
          due_at = coalesce(c.due_at, computed_due)
    where c.id = match_id;

    action := 'updated';
    chore_id := match_id;
    chore_title := match_title;
    due_at := coalesce(match_due, computed_due);
    candidates := null;
    return next;
    return;
  end if;

  if match_count > 1 then
    action := 'clarify_chore';
    chore_id := null;
    chore_title := null;
    due_at := computed_due;
    candidates := (
      select jsonb_agg(
        jsonb_build_object('id', id, 'title', title, 'due_at', due_at, 'helper_id', helper_id)
        order by rnk desc
      )
      from (
        select *
        from (
          select
            c.id,
            c.title,
            c.due_at,
            c.helper_id,
            ts_rank(to_tsvector('simple', coalesce(c.title, '')), plainto_tsquery('simple', q_task)) as rnk
          from public.chores c
          where c.household_id = p_household_id
            and c.deleted_at is null
            and (c.status is null or c.status <> 'done')
            and (
              c.due_at is null
              or ((c.due_at at time zone tz)::date = base_day)
            )
            and to_tsvector('simple', coalesce(c.title, '')) @@ plainto_tsquery('simple', q_task)
        ) s
        order by rnk desc
        limit 5
      ) t
    );
    return next;
    return;
  end if;

  inserted_title := initcap(q_task);
  insert into public.chores (household_id, title, status, due_at, helper_id)
  values (p_household_id, inserted_title, 'pending', computed_due, helper_id)
  returning id into insert_id;

  action := 'created';
  chore_id := insert_id;
  chore_title := inserted_title;
  due_at := computed_due;
  candidates := null;
  return next;
end;
$$;

revoke all on function public.assign_or_create_chore(uuid, uuid, text, text, text) from public;
grant execute on function public.assign_or_create_chore(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.assign_or_create_chore(uuid, uuid, text, text, text) to service_role;
