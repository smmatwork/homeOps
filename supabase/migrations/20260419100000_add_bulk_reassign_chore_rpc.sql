-- RPC: bulk_reassign_chores_by_query
-- Reassigns ALL chores matching a text query to a target helper.
-- Unlike reassign_chore_by_query (single-chore), this handles bulk operations.

create or replace function public.bulk_reassign_chores_by_query(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_query text,
  p_new_helper_query text
)
returns table (
  action text,
  reassigned_count int,
  chore_titles text[],
  helper_id uuid,
  helper_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  hres record;
  target_helper_id uuid;
  target_helper_name text;
  cq text;
  matched_ids uuid[];
  matched_titles text[];
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

  cq := trim(coalesce(p_chore_query, ''));
  if cq = '' then
    raise exception 'p_chore_query is required';
  end if;

  -- Resolve helper
  select * into hres
  from public.resolve_helper(p_household_id, p_actor_user_id, trim(coalesce(p_new_helper_query, '')))
  limit 1;

  if hres.match_type = 'none' or hres.match_type = 'ambiguous' then
    action := 'clarify_helper';
    reassigned_count := 0;
    chore_titles := '{}';
    helper_id := null;
    helper_name := null;
    return next;
    return;
  end if;

  target_helper_id := hres.helper_id;
  target_helper_name := hres.helper_name;

  -- Find ALL matching chores (full-text search + ILIKE fallback)
  select
    array_agg(c.id),
    array_agg(c.title)
  into matched_ids, matched_titles
  from public.chores c
  where c.household_id = p_household_id
    and c.deleted_at is null
    and (c.status is null or c.status not in ('done', 'completed'))
    and (
      to_tsvector('simple', coalesce(c.title, '')) @@ plainto_tsquery('simple', cq)
      or lower(coalesce(c.title, '')) like '%' || lower(cq) || '%'
      or lower(coalesce(c.metadata->>'space', '')) like '%' || lower(cq) || '%'
      or lower(coalesce(c.metadata->>'category', '')) like '%' || lower(cq) || '%'
    );

  cnt := coalesce(array_length(matched_ids, 1), 0);

  if cnt = 0 then
    action := 'none_found';
    reassigned_count := 0;
    chore_titles := '{}';
    helper_id := target_helper_id;
    helper_name := target_helper_name;
    return next;
    return;
  end if;

  -- Bulk reassign
  update public.chores c
    set helper_id = target_helper_id
  where c.id = any(matched_ids);

  action := 'reassigned';
  reassigned_count := cnt;
  chore_titles := matched_titles;
  helper_id := target_helper_id;
  helper_name := target_helper_name;
  return next;
end;
$$;

revoke all on function public.bulk_reassign_chores_by_query(uuid, uuid, text, text) from public;
grant execute on function public.bulk_reassign_chores_by_query(uuid, uuid, text, text) to authenticated;
grant execute on function public.bulk_reassign_chores_by_query(uuid, uuid, text, text) to service_role;
