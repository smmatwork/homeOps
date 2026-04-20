-- RPC: apply chore assignments in bulk based on (title, due_at) -> helper name suggestions.
-- Updates existing chores (does not insert new chores).

create or replace function public.apply_chore_assignments(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a jsonb;
  title_text text;
  due_text text;
  helper_q text;
  due_ts timestamptz;
  helper_row record;
  hid uuid;
  updated int;
  total_updated int := 0;
  results jsonb := '[]'::jsonb;
  errors jsonb := '[]'::jsonb;
  obj jsonb;
  match_type text;
begin
  if p_household_id is null then
    raise exception 'p_household_id is required';
  end if;
  if p_actor_user_id is null then
    raise exception 'p_actor_user_id is required';
  end if;
  if p_assignments is null then
    raise exception 'p_assignments is required';
  end if;

  if not exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  if jsonb_typeof(p_assignments) <> 'array' then
    raise exception 'p_assignments must be a JSON array';
  end if;

  for a in select * from jsonb_array_elements(p_assignments)
  loop
    if jsonb_typeof(a) <> 'object' then
      errors := errors || jsonb_build_array(jsonb_build_object('error', 'invalid_assignment_shape', 'assignment', a));
      continue;
    end if;

    title_text := nullif(btrim(coalesce(a->>'title', '')), '');
    due_text := nullif(btrim(coalesce(a->>'due_at', '')), '');
    helper_q := nullif(btrim(coalesce(a->>'helper_name', '')), '');

    if title_text is null or due_text is null or helper_q is null then
      errors := errors || jsonb_build_array(
        jsonb_build_object(
          'error', 'missing_fields',
          'title', title_text,
          'due_at', due_text,
          'helper_name', helper_q
        )
      );
      continue;
    end if;

    begin
      due_ts := due_text::timestamptz;
    exception when others then
      errors := errors || jsonb_build_array(
        jsonb_build_object(
          'error', 'invalid_due_at',
          'title', title_text,
          'due_at', due_text,
          'helper_name', helper_q
        )
      );
      continue;
    end;

    select * into helper_row
    from public.resolve_helper(p_household_id, p_actor_user_id, helper_q)
    limit 1;

    match_type := coalesce(helper_row.match_type, 'none');

    if match_type <> 'unique' then
      errors := errors || jsonb_build_array(
        jsonb_build_object(
          'error', 'helper_not_unique',
          'match_type', match_type,
          'title', title_text,
          'due_at', due_text,
          'helper_name', helper_q,
          'candidates', helper_row.candidates
        )
      );
      continue;
    end if;

    hid := helper_row.helper_id;

    update public.chores c
      set helper_id = hid,
          updated_at = now()
      where c.household_id = p_household_id
        and c.deleted_at is null
        and lower(c.title) = lower(title_text)
        and c.due_at = due_ts
        and c.helper_id is null;

    get diagnostics updated = row_count;
    total_updated := total_updated + updated;

    obj := jsonb_build_object(
      'title', title_text,
      'due_at', due_text,
      'helper_name', helper_row.helper_name,
      'helper_id', hid,
      'updated', updated
    );
    results := results || jsonb_build_array(obj);
  end loop;

  return jsonb_build_object(
    'ok', true,
    'updated_total', total_updated,
    'results', results,
    'errors', errors
  );
end;
$$;

revoke all on function public.apply_chore_assignments(uuid, uuid, jsonb) from public;
grant execute on function public.apply_chore_assignments(uuid, uuid, jsonb) to authenticated;
grant execute on function public.apply_chore_assignments(uuid, uuid, jsonb) to service_role;
