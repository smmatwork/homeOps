-- Phase 1 — chore rollover + reopen mechanism
--
-- New chore lifecycle:
--   pending ──► auto_completed   (rollover_overdue_chores: next day, not on leave)
--   pending ──► pending + reopened_at  (rollover: helper was on leave that day)
--   any     ──► pending + reopened_at  (reopen_chore: owner flags "not done")
--
-- "Overdue" is redefined as `reopened_at IS NOT NULL AND status IN ('pending','in-progress')`.
-- Chores that simply passed their due_at without being marked done are rolled
-- into `auto_completed` by rollover_overdue_chores on the next page load.
--
-- This ships two RPCs:
--   1. rollover_overdue_chores — idempotent, called on Chores page load
--   2. reopen_chore            — called when the owner flags a chore as not-done

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Columns on chores
-- ─────────────────────────────────────────────────────────────────────────

alter table public.chores
  add column if not exists reopened_at timestamptz,
  add column if not exists reopened_reason text;

create index if not exists chores_reopened_idx
  on public.chores (household_id, reopened_at desc)
  where reopened_at is not null;

comment on column public.chores.reopened_at is
  'Set when a chore is reopened (helper leave fallback or owner flag). NULL = normal lifecycle.';
comment on column public.chores.reopened_reason is
  'Why the chore was reopened: helper_leave, feedback, manual. Free text is allowed but use canonical values when possible.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. rollover_overdue_chores
-- ─────────────────────────────────────────────────────────────────────────
--
-- For each pending chore whose due_at is strictly before the caller's
-- "start of today" (passed explicitly so the caller's timezone is honored):
--   • if the assigned helper was on leave on due_at → mark as reopened
--     (status stays pending so the chore surfaces as overdue in Day Focus)
--   • else → mark status='auto_completed', stamp completed_at
--
-- Idempotent: only touches rows where status='pending' AND reopened_at IS NULL.
-- A reopened chore that's still pending the next day won't be re-rolled —
-- it stays reopened until the owner acts on it.

create or replace function public.rollover_overdue_chores(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_cutoff_iso timestamptz
)
returns table (
  auto_completed_count int,
  reopened_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto int := 0;
  v_reopened int := 0;
  v_chore record;
  v_on_leave bool;
begin
  if p_household_id is null or p_actor_user_id is null or p_cutoff_iso is null then
    raise exception 'p_household_id, p_actor_user_id, p_cutoff_iso are required';
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  for v_chore in
    select c.id, c.helper_id, c.due_at
    from public.chores c
    where c.household_id = p_household_id
      and c.deleted_at is null
      and c.status = 'pending'
      and c.due_at is not null
      and c.due_at < p_cutoff_iso
      and c.reopened_at is null
  loop
    v_on_leave := false;

    if v_chore.helper_id is not null then
      select exists (
        select 1 from public.member_time_off t
        where t.helper_id = v_chore.helper_id
          and t.member_kind = 'helper'
          and t.start_at <= v_chore.due_at
          and t.end_at >= v_chore.due_at
      ) into v_on_leave;
    end if;

    if v_on_leave then
      update public.chores
      set reopened_at = now(),
          reopened_reason = 'helper_leave',
          updated_at = now()
      where id = v_chore.id;
      v_reopened := v_reopened + 1;
    else
      update public.chores
      set status = 'auto_completed',
          completed_at = coalesce(completed_at, v_chore.due_at),
          updated_at = now()
      where id = v_chore.id;
      v_auto := v_auto + 1;
    end if;
  end loop;

  auto_completed_count := v_auto;
  reopened_count := v_reopened;
  return next;
end;
$$;

revoke all on function public.rollover_overdue_chores(uuid, uuid, timestamptz) from public;
grant execute on function public.rollover_overdue_chores(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.rollover_overdue_chores(uuid, uuid, timestamptz) to service_role;

comment on function public.rollover_overdue_chores(uuid, uuid, timestamptz) is
  'Idempotent nightly-behavior-on-page-load: auto-complete pending chores past their due_at, unless the assigned helper was on leave (then reopen). (Phase 1)';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. reopen_chore
-- ─────────────────────────────────────────────────────────────────────────
--
-- Owner flags a chore as "not actually done." Sets status back to 'pending'
-- (no-op if already pending), stamps reopened_at + reopened_reason, clears
-- completed_at. Valid reasons are the canonical set below; other strings
-- are allowed but discouraged.

create or replace function public.reopen_chore(
  p_household_id uuid,
  p_actor_user_id uuid,
  p_chore_id uuid,
  p_reason text default 'feedback'
)
returns table (
  reopened_at timestamptz,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_reason text;
begin
  if p_household_id is null or p_actor_user_id is null or p_chore_id is null then
    raise exception 'p_household_id, p_actor_user_id, p_chore_id are required';
  end if;

  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = p_actor_user_id
  ) then
    raise exception 'forbidden';
  end if;

  v_reason := coalesce(nullif(trim(p_reason), ''), 'feedback');

  update public.chores
  set status = 'pending',
      reopened_at = v_now,
      reopened_reason = v_reason,
      completed_at = null,
      updated_at = v_now
  where id = p_chore_id
    and household_id = p_household_id
    and deleted_at is null;

  if not found then
    raise exception 'chore % not found in household %', p_chore_id, p_household_id;
  end if;

  reopened_at := v_now;
  reason := v_reason;
  return next;
end;
$$;

revoke all on function public.reopen_chore(uuid, uuid, uuid, text) from public;
grant execute on function public.reopen_chore(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.reopen_chore(uuid, uuid, uuid, text) to service_role;

comment on function public.reopen_chore(uuid, uuid, uuid, text) is
  'Flag a chore as not-done. Sets status=pending, stamps reopened_at + reopened_reason. (Phase 1)';
