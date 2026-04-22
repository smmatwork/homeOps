-- Fix: resolve_space plpgsql 42702 "column reference space is ambiguous".
--
-- The RPC's RETURNS TABLE declares an output column named `space`, which
-- collides with the CTE column alias also named `space` inside the body
-- (space_sources / distinct_spaces / matches). Postgres 14+ raises 42702
-- whenever a bare reference is used in the CTE.
--
-- Reproduced via:
--   SELECT list_chores_enriched(<hh>, <user>, '{"space_query":"foo"}'::jsonb, 25);
-- → ERROR: column reference "space" is ambiguous
--   LINE 30: select distinct space
--   CONTEXT: PL/pgSQL function resolve_space(uuid,uuid,text) line 28 at SQL
--   statement "select * from public.resolve_space(...)"
--
-- Fix: rename the CTE column to `space_name` inside the function body.
-- The external RETURNS TABLE shape (`match_type`, `space`, `candidates`)
-- is unchanged — callers read the same column names.
--
-- Same class of bug as the agent_take_confirmation fix (migration
-- 20260422100000): whenever RETURNS TABLE names collide with inline
-- column aliases, prefix or rename the inner ones.

CREATE OR REPLACE FUNCTION public.resolve_space(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_query text
)
RETURNS TABLE (
  match_type text,
  space text,
  candidates jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  q text;
  n int;
  resolved text;
  v_candidates jsonb;
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

  -- NOTE: the CTE columns are aliased `space_name` (not `space`) to avoid
  -- colliding with the RETURNS TABLE output column `space`. Postgres
  -- treats the output column as an in-scope plpgsql variable during the
  -- SQL statement, so `select distinct space` became ambiguous.
  -- Build the full match list in one pass so the CTE only exists once.
  -- A WITH...SELECT's CTEs go out of scope when the statement completes;
  -- the original RPC referenced `matches` from TWO separate statements,
  -- which was latently broken (would have errored on the "unique" branch
  -- if exercised — it typically wasn't because users hit "none" / "ambiguous").
  with space_sources as (
    -- home_profiles.spaces is jsonb array (strings or objects)
    select
      case
        when jsonb_typeof(e.value) = 'string' then nullif(btrim(e.value #>> '{}'), '')
        when jsonb_typeof(e.value) = 'object' then nullif(btrim(coalesce(e.value->>'name', e.value->>'label', e.value->>'space', '')), '')
        else null
      end as space_name
    from public.home_profiles hp
    left join lateral jsonb_array_elements(hp.spaces) as e(value) on true
    where hp.household_id = p_household_id

    union

    -- space_counts keys
    select nullif(btrim(k.key), '') as space_name
    from public.home_profiles hp
    left join lateral jsonb_object_keys(hp.space_counts) as k(key) on true
    where hp.household_id = p_household_id

    union

    -- any historical spaces used on chores
    select nullif(btrim(c.metadata->>'space'), '') as space_name
    from public.chores c
    where c.household_id = p_household_id
      and c.metadata ? 'space'
  ),
  distinct_spaces as (
    select distinct space_name
    from space_sources
    where space_name is not null and space_name <> ''
  ),
  matches as (
    select space_name
    from distinct_spaces
    where space_name ilike '%' || q || '%'
  )
  select
    count(*),
    (select m.space_name from matches m order by m.space_name limit 1),
    coalesce(
      (select jsonb_agg(jsonb_build_object('space', m.space_name) order by m.space_name) from matches m),
      '[]'::jsonb
    )
  into n, resolved, v_candidates
  from matches;

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
    candidates := v_candidates;
    return next;
    return;
  end if;

  match_type := 'unique';
  space := resolved;
  candidates := null;
  return next;
end;
$$;

-- Grants match the original definition.
REVOKE ALL ON FUNCTION public.resolve_space(uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_space(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_space(uuid, uuid, text) TO service_role;
