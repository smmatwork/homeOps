-- RPC: count chores assigned to a helper by helper name (with ambiguity handling)

create or replace function public.count_chores_assigned_to(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_helper_name text
)
returns table (
  match_type text,
  helper_id uuid,
  helper_name text,
  chore_count int,
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

  q := trim(coalesce(p_helper_name, ''));
  if q = '' then
    raise exception 'p_helper_name is required';
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
    chore_count := null;
    candidates := '[]'::jsonb;
    return next;
    return;
  end if;

  if n > 1 then
    match_type := 'ambiguous';
    helper_id := null;
    helper_name := null;
    chore_count := null;
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

  select count(*)
    into chore_count
  from public.chores c
  where c.household_id = p_household_id
    and c.deleted_at is null
    and c.helper_id = hid;

  return next;
end;
$$;

revoke all on function public.count_chores_assigned_to(uuid, uuid, text) from public;
grant execute on function public.count_chores_assigned_to(uuid, uuid, text) to authenticated;
grant execute on function public.count_chores_assigned_to(uuid, uuid, text) to service_role;
