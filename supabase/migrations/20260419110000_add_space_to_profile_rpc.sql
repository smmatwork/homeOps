-- RPC: add_space_to_profile
-- Appends a new room/space to the home_profiles.spaces JSONB array.

create or replace function public.add_space_to_profile(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_display_name text,
  p_floor int default null,
  p_template_name text default null
)
returns table (
  action text,
  space_id text,
  display_name text,
  total_spaces int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id text;
  current_spaces jsonb;
  new_space jsonb;
  cnt int;
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;
  if p_actor_user_id is null then
    raise exception 'p_actor_user_id is required';
  end if;

  -- Verify membership
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  p_display_name := trim(coalesce(p_display_name, ''));
  if p_display_name = '' then
    raise exception 'p_display_name is required';
  end if;

  -- Check if this space already exists
  select spaces into current_spaces
  from public.home_profiles
  where household_id = p_household_id;

  if current_spaces is null then
    current_spaces := '[]'::jsonb;
  end if;

  -- Check for duplicate display_name
  if exists (
    select 1 from jsonb_array_elements(current_spaces) elem
    where lower(elem->>'display_name') = lower(p_display_name)
  ) then
    action := 'already_exists';
    space_id := null;
    display_name := p_display_name;
    total_spaces := jsonb_array_length(current_spaces);
    return next;
    return;
  end if;

  -- Generate a stable ID from the display name
  new_id := 'custom_' || lower(regexp_replace(p_display_name, '[^a-zA-Z0-9]+', '_', 'g'));

  -- Build the new space object
  new_space := jsonb_build_object(
    'id', new_id,
    'display_name', p_display_name,
    'template_name', coalesce(p_template_name, p_display_name),
    'floor', coalesce(p_floor, 0)
  );

  -- Append to the spaces array
  update public.home_profiles
  set spaces = current_spaces || jsonb_build_array(new_space),
      updated_at = now()
  where household_id = p_household_id;

  cnt := jsonb_array_length(current_spaces) + 1;

  action := 'added';
  space_id := new_id;
  display_name := p_display_name;
  total_spaces := cnt;
  return next;
end;
$$;

revoke all on function public.add_space_to_profile(uuid, uuid, text, int, text) from public;
grant execute on function public.add_space_to_profile(uuid, uuid, text, int, text) to authenticated;
grant execute on function public.add_space_to_profile(uuid, uuid, text, int, text) to service_role;
