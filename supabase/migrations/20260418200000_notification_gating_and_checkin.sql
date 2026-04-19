-- Phase 1: Notification gating + helper check-in + multi-user conflict resolution
--
-- 1. notification_config — per-household notification preferences
-- 2. alerts.justification — cognitive-cost justification for every alert
-- 3. helper_checkins — daily check-in log (photo, thumbs-up, voice note)
-- 4. Extend member_availability for multi-user chore conflict resolution

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Notification configuration
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.notification_config (
  household_id uuid primary key references public.households(id) on delete cascade,
  -- Master toggle
  enabled boolean not null default true,
  -- Quiet hours (no notifications during this window)
  quiet_start time without time zone default null,  -- e.g. '22:00'
  quiet_end   time without time zone default null,  -- e.g. '07:00'
  -- Per-category toggles (default all enabled)
  categories jsonb not null default '{
    "assignment": true,
    "coverage_gap": true,
    "helper_leave": true,
    "maintenance_overdue": true,
    "weekly_plan": true,
    "override_nudge": true,
    "helper_checkin": true,
    "low_stock": true
  }'::jsonb,
  -- Rate limit: max notifications per day (0 = unlimited)
  max_per_day int not null default 20,
  -- Track daily count (reset by midnight cron or on first notification of new day)
  today_count int not null default 0,
  count_reset_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notification_config enable row level security;
create policy "Household members can manage notification config"
  on public.notification_config for all
  using (exists (select 1 from public.household_members hm where hm.household_id = notification_config.household_id and hm.user_id = auth.uid()))
  with check (exists (select 1 from public.household_members hm where hm.household_id = notification_config.household_id and hm.user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Add justification to alerts
-- ─────────────────────────────────────────────────────────────────────────

alter table public.alerts
  add column if not exists justification text default null,
  add column if not exists category text default null,
  add column if not exists read_at timestamptz default null,
  add column if not exists dismissed_at timestamptz default null;

comment on column public.alerts.justification is
  'Cognitive-cost justification: why this alert deserves the owner''s attention. Required by O1 manifest.';
comment on column public.alerts.category is
  'Notification category (maps to notification_config.categories toggles)';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Helper check-ins
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.helper_checkins (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  checkin_date date not null default current_date,
  -- Check-in type
  checkin_type text not null check (checkin_type in ('photo', 'thumbs_up', 'voice_note', 'text')),
  -- Content
  photo_url text default null,
  voice_url text default null,
  note text default null,
  -- Which chores were marked done via this check-in
  chore_ids uuid[] default '{}',
  -- Status
  status text not null default 'submitted' check (status in ('submitted', 'reviewed', 'acknowledged')),
  reviewed_by uuid references auth.users(id) default null,
  reviewed_at timestamptz default null,
  -- Metadata
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_helper_checkins_household_date
  on public.helper_checkins (household_id, checkin_date desc);
create index if not exists idx_helper_checkins_helper_date
  on public.helper_checkins (helper_id, checkin_date desc);

alter table public.helper_checkins enable row level security;
create policy "Household members can manage check-ins"
  on public.helper_checkins for all
  using (exists (select 1 from public.household_members hm where hm.household_id = helper_checkins.household_id and hm.user_id = auth.uid()))
  with check (exists (select 1 from public.household_members hm where hm.household_id = helper_checkins.household_id and hm.user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Notification gating RPC
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.should_notify(
  p_household_id uuid,
  p_category text,
  p_justification text
)
returns table (
  allowed boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_config record;
  v_now time;
begin
  -- No justification = no notification (manifest hard requirement)
  if p_justification is null or trim(p_justification) = '' then
    return query select false::boolean, 'missing cognitive-cost justification'::text;
    return;
  end if;

  -- Load config (create default if missing)
  select * into v_config
  from public.notification_config
  where household_id = p_household_id;

  if not found then
    -- No config = allow with defaults
    return query select true::boolean, 'no config — using defaults'::text;
    return;
  end if;

  -- Master toggle
  if not v_config.enabled then
    return query select false::boolean, 'notifications disabled for household'::text;
    return;
  end if;

  -- Category check
  if p_category is not null and v_config.categories is not null then
    if (v_config.categories->>p_category)::boolean is false then
      return query select false::boolean, format('category %s disabled', p_category)::text;
      return;
    end if;
  end if;

  -- Quiet hours
  v_now := localtime;
  if v_config.quiet_start is not null and v_config.quiet_end is not null then
    if v_config.quiet_start > v_config.quiet_end then
      -- Wraps midnight (e.g., 22:00–07:00)
      if v_now >= v_config.quiet_start or v_now < v_config.quiet_end then
        return query select false::boolean, 'quiet hours active'::text;
        return;
      end if;
    else
      if v_now >= v_config.quiet_start and v_now < v_config.quiet_end then
        return query select false::boolean, 'quiet hours active'::text;
        return;
      end if;
    end if;
  end if;

  -- Daily rate limit
  if v_config.max_per_day > 0 then
    -- Reset counter if new day
    if v_config.count_reset_date < current_date then
      update public.notification_config
      set today_count = 0, count_reset_date = current_date
      where household_id = p_household_id;
      -- Fresh day, allow
    elsif v_config.today_count >= v_config.max_per_day then
      return query select false::boolean, format('daily limit reached (%s/%s)', v_config.today_count, v_config.max_per_day)::text;
      return;
    end if;

    -- Increment counter
    update public.notification_config
    set today_count = today_count + 1, updated_at = now()
    where household_id = p_household_id;
  end if;

  return query select true::boolean, 'allowed'::text;
end;
$$;

revoke all on function public.should_notify(uuid, text, text) from public;
grant execute on function public.should_notify(uuid, text, text) to authenticated;
grant execute on function public.should_notify(uuid, text, text) to service_role;
