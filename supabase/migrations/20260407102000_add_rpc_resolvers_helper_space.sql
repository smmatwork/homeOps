-- RPC resolvers: resolve_helper and resolve_space

create or replace function public.resolve_helper(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_query text
)
returns table (
  match_type text,
  helper_id uuid,
  helper_name text,
  candidates jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q text;
  n int;
  hid uuid;
  hname text;
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;
  if p_actor_user_id is null then
    raise exception 'p_actor_user_id is required';
  end if;

  q := trim(coalesce(p_query, ''));
  if q = '' then
    raise exception 'p_query is required';
  end if;

  if not exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  select count(*)
    into n
  from public.helpers h
  where h.household_id = p_household_id
    and h.name ilike '%' || q || '%';

  if n = 0 then
    match_type := 'none';
    helper_id := null;
    helper_name := null;
    candidates := '[]'::jsonb;
    return next;
    return;
  end if;

  if n > 1 then
    match_type := 'ambiguous';
    helper_id := null;
    helper_name := null;
    select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name) order by h.name)
      into candidates
    from public.helpers h
    where h.household_id = p_household_id
      and h.name ilike '%' || q || '%';
    if candidates is null then
      candidates := '[]'::jsonb;
    end if;
    return next;
    return;
  end if;

  select h.id, h.name
    into hid, hname
  from public.helpers h
  where h.household_id = p_household_id
    and h.name ilike '%' || q || '%'
  limit 1;

  match_type := 'unique';
  helper_id := hid;
  helper_name := hname;
  candidates := null;
  return next;
end;
$$;

revoke all on function public.resolve_helper(uuid, uuid, text) from public;
grant execute on function public.resolve_helper(uuid, uuid, text) to authenticated;
grant execute on function public.resolve_helper(uuid, uuid, text) to service_role;


create or replace function public.resolve_space(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_query text
)
returns table (
  match_type text,
  space text,
  candidates jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q text;
  n int;
  resolved text;
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;
  if p_actor_user_id is null then
    raise exception 'p_actor_user_id is required';
  end if;

  q := trim(coalesce(p_query, ''));
  if q = '' then
    raise exception 'p_query is required';
  end if;

  if not exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  with space_sources as (
    -- home_profiles.spaces is jsonb array (strings or objects)
    select
      case
        when jsonb_typeof(e.value) = 'string' then nullif(btrim(e.value #>> '{}'), '')
        when jsonb_typeof(e.value) = 'object' then nullif(btrim(coalesce(e.value->>'name', e.value->>'label', e.value->>'space', '')), '')
        else null
      end as space
    from public.home_profiles hp
    left join lateral jsonb_array_elements(hp.spaces) as e(value) on true
    where hp.household_id = p_household_id

    union

    -- space_counts keys
    select nullif(btrim(k.key), '') as space
    from public.home_profiles hp
    left join lateral jsonb_object_keys(hp.space_counts) as k(key) on true
    where hp.household_id = p_household_id

    union

    -- any historical spaces used on chores
    select nullif(btrim(c.metadata->>'space'), '') as space
    from public.chores c
    where c.household_id = p_household_id
      and c.metadata ? 'space'
  ),
  distinct_spaces as (
    select distinct space
    from space_sources
    where space is not null and space <> ''
  ),
  matches as (
    select space
    from distinct_spaces
    where space ilike '%' || q || '%'
  )
  select count(*) into n from matches;

  if n = 0 then
    match_type := 'none';
    space := null;
    candidates := '[]'::jsonb;
    return next;
    return;
  end if;

  if n > 1 then
    match_type := 'ambiguous';
    space := null;
    select jsonb_agg(jsonb_build_object('space', m.space) order by m.space)
      into candidates
    from matches m;
    if candidates is null then
      candidates := '[]'::jsonb;
    end if;
    return next;
    return;
  end if;

  select m.space into resolved from matches m limit 1;
  match_type := 'unique';
  space := resolved;
  candidates := null;
  return next;
end;
$$;

revoke all on function public.resolve_space(uuid, uuid, text) from public;
grant execute on function public.resolve_space(uuid, uuid, text) to authenticated;
grant execute on function public.resolve_space(uuid, uuid, text) to service_role;
