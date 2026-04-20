-- RPC: server-side substring resolution for chore match_text → ids.
-- Replaces the agent-service FACTS scan, which truncated descriptions
-- at 60 chars and capped the corpus at 30 rows. Runs ILIKE over the full
-- title and description for every non-deleted chore in the household
-- and returns rows where any of the supplied keywords appears as a
-- substring.

create or replace function public.find_chores_matching_keywords(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_keywords text[]
)
returns table (
  id uuid,
  title text,
  description text,
  status text,
  match_score int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cleaned_keywords text[];
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

  -- Drop empty/whitespace keywords; if nothing left, return empty.
  select coalesce(array_agg(trim(k)), array[]::text[])
    into cleaned_keywords
  from unnest(coalesce(p_keywords, array[]::text[])) as k
  where trim(coalesce(k, '')) <> '';

  if cleaned_keywords is null or array_length(cleaned_keywords, 1) is null then
    return;
  end if;

  return query
  with scored as (
    select
      c.id,
      c.title,
      c.description,
      c.status,
      (
        select count(*)::int
        from unnest(cleaned_keywords) as kw
        where c.title ilike '%' || kw || '%'
           or coalesce(c.description, '') ilike '%' || kw || '%'
      ) as match_score
    from public.chores c
    where c.household_id = p_household_id
      and c.deleted_at is null
  )
  select s.id, s.title, s.description, s.status, s.match_score
  from scored s
  where s.match_score > 0
  order by s.match_score desc, s.title asc
  limit 100;
end;
$$;

revoke all on function public.find_chores_matching_keywords(uuid, uuid, text[]) from public;
grant execute on function public.find_chores_matching_keywords(uuid, uuid, text[]) to authenticated;
grant execute on function public.find_chores_matching_keywords(uuid, uuid, text[]) to service_role;
