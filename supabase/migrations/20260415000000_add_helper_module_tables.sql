-- Helper module: Phase 1.0 schema
--
-- Adds the tables and column extensions for the "Helpers as first-class
-- participants" scope in homeops.system.manifest.md and
-- homeops.helper_module.plan.md. No behavior changes to existing tables
-- other than additive columns on `helpers`.
--
-- Tables: helper_invites, helper_consents, helper_compensation_ledger,
--         helper_outreach_attempts
-- Columns: helpers.preferred_language, channel_preferences,
--          preferred_call_window, onboarding_status, id_verified,
--          profile_photo_url

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Extend `helpers` with new columns
-- ─────────────────────────────────────────────────────────────────────────

alter table public.helpers
  add column if not exists preferred_language text,
  add column if not exists channel_preferences text[] not null
    default array['voice','whatsapp_tap','sms']::text[],
  add column if not exists preferred_call_window jsonb,
  add column if not exists onboarding_status text not null
    default 'pending_helper_completion'
    check (onboarding_status in (
      'pending_helper_completion','active','declined','archived'
    )),
  add column if not exists id_verified bool not null default false,
  add column if not exists profile_photo_url text;

-- Validate channel_preferences entries at write time.
alter table public.helpers
  add constraint helpers_channel_preferences_values_chk
    check (
      channel_preferences <@ array[
        'voice','whatsapp_voice','whatsapp_tap',
        'whatsapp_form','web','sms'
      ]::text[]
    );

-- Backfill helpers.preferred_language from existing metadata.preferred_language.
-- The Helpers.tsx UI has been writing this into metadata; we promote it to
-- a first-class column now. Metadata path becomes deprecated.
update public.helpers
set preferred_language = metadata->>'preferred_language'
where preferred_language is null
  and metadata ? 'preferred_language'
  and length(trim(coalesce(metadata->>'preferred_language',''))) > 0;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. helper_invites — Stage 2 invite tokens
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.helper_invites (
  id uuid primary key default gen_random_uuid(),
  helper_id uuid not null references public.helpers(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  token text not null unique,
  channel_chain text[] not null,
  active_channel text,
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  completed_at timestamptz,
  last_reminder_at timestamptz,
  reminder_count int not null default 0,
  created_by uuid references auth.users(id),
  revoked_at timestamptz
);

create index if not exists helper_invites_helper_active_idx
  on public.helper_invites (helper_id)
  where completed_at is null and revoked_at is null;

create index if not exists helper_invites_token_idx
  on public.helper_invites (token);

alter table public.helper_invites enable row level security;

drop policy if exists helper_invites_select on public.helper_invites;
create policy helper_invites_select on public.helper_invites
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists helper_invites_insert on public.helper_invites;
create policy helper_invites_insert on public.helper_invites
  for insert
  with check (public.is_household_member(household_id));

drop policy if exists helper_invites_update on public.helper_invites;
create policy helper_invites_update on public.helper_invites
  for update
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 3. helper_consents — append-only consent log
-- ─────────────────────────────────────────────────────────────────────────
--
-- Helper-side consent fields can only be written through the helper-self
-- channel adapters. The edge function enforces this at write time via
-- the `source` column; RLS cannot discriminate on the caller channel
-- since writes come via the service-role token from the agent service.

create table if not exists public.helper_consents (
  id bigserial primary key,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  consent_type text not null check (consent_type in (
    'id_verification','vision_capture','multi_household_coord',
    'data_export','call_recording','marketing_outreach'
  )),
  granted bool not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  source text not null check (source in (
    'helper_self','helper_voice','helper_whatsapp_tap',
    'helper_whatsapp_form','helper_sms','helper_web','system_default'
  )),
  evidence jsonb,
  created_at timestamptz not null default now()
);

create index if not exists helper_consents_helper_idx
  on public.helper_consents (helper_id, consent_type, created_at desc);

alter table public.helper_consents enable row level security;

drop policy if exists helper_consents_select on public.helper_consents;
create policy helper_consents_select on public.helper_consents
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists helper_consents_insert on public.helper_consents;
create policy helper_consents_insert on public.helper_consents
  for insert
  with check (public.is_household_member(household_id));

-- No update/delete policies — append-only.

-- ─────────────────────────────────────────────────────────────────────────
-- 4. helper_compensation_ledger — tracking-only, bidirectional
-- ─────────────────────────────────────────────────────────────────────────
--
-- Append-only. Corrections happen via void + new entry; never UPDATE the
-- amount or effective_date of an existing row. HomeOps does not move
-- money; this is a shared source of truth between owner and helper.

create table if not exists public.helper_compensation_ledger (
  id bigserial primary key,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  entry_type text not null check (entry_type in (
    'salary_set','salary_change','advance','bonus','leave_balance',
    'leave_taken','settlement','adjustment'
  )),
  amount numeric(12,2) not null,
  currency text not null default 'INR',
  effective_date date not null,
  recorded_by_role text not null check (recorded_by_role in ('owner','helper')),
  recorded_by_user_id uuid references auth.users(id),
  recorded_via_invite_token text,
  note text,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by_user_id uuid references auth.users(id),
  voided_reason text
);

create index if not exists helper_comp_ledger_helper_date_idx
  on public.helper_compensation_ledger (helper_id, effective_date desc);

create index if not exists helper_comp_ledger_household_date_idx
  on public.helper_compensation_ledger (household_id, effective_date desc);

alter table public.helper_compensation_ledger enable row level security;

drop policy if exists helper_comp_ledger_select on public.helper_compensation_ledger;
create policy helper_comp_ledger_select on public.helper_compensation_ledger
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists helper_comp_ledger_insert on public.helper_compensation_ledger;
create policy helper_comp_ledger_insert on public.helper_compensation_ledger
  for insert
  with check (public.is_household_member(household_id));

-- Void uses an UPDATE that sets voided_at / voided_by / voided_reason;
-- other columns are immutable after insert. A column-level check would
-- be heavy here — enforce via trigger instead.
drop policy if exists helper_comp_ledger_void_update on public.helper_compensation_ledger;
create policy helper_comp_ledger_void_update on public.helper_compensation_ledger
  for update
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

create or replace function public.helper_comp_ledger_void_only()
returns trigger
language plpgsql
as $$
begin
  if (new.amount is distinct from old.amount
      or new.currency is distinct from old.currency
      or new.effective_date is distinct from old.effective_date
      or new.entry_type is distinct from old.entry_type
      or new.helper_id is distinct from old.helper_id
      or new.household_id is distinct from old.household_id
      or new.recorded_by_role is distinct from old.recorded_by_role
      or new.recorded_by_user_id is distinct from old.recorded_by_user_id
      or new.recorded_via_invite_token is distinct from old.recorded_via_invite_token
      or new.created_at is distinct from old.created_at) then
    raise exception 'helper_compensation_ledger rows are append-only; only void_* fields may be updated';
  end if;
  return new;
end;
$$;

drop trigger if exists helper_comp_ledger_void_only_trg on public.helper_compensation_ledger;
create trigger helper_comp_ledger_void_only_trg
  before update on public.helper_compensation_ledger
  for each row
  execute function public.helper_comp_ledger_void_only();

-- ─────────────────────────────────────────────────────────────────────────
-- 5. helper_outreach_attempts — every channel delivery attempt
-- ─────────────────────────────────────────────────────────────────────────
--
-- Tracks all outreach attempts across all channels. Subject to a 3-month
-- TTL via a pg_cron job (see the separate TTL migration) because this is
-- transient delivery state, not a record-of-fact.

create table if not exists public.helper_outreach_attempts (
  id bigserial primary key,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  intent text not null check (intent in (
    'stage2_onboarding','daily_checkin','balance_inquiry',
    'reassignment_consent','schedule_change_consent','reminder',
    'pattern_elicitation_followup'
  )),
  direction text not null check (direction in ('outbound','inbound')),
  channel_used text not null check (channel_used in (
    'voice','whatsapp_voice','whatsapp_tap','whatsapp_form','web','sms'
  )),
  invite_id uuid references public.helper_invites(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null check (status in (
    'in_progress','completed','no_answer','failed','partial','retry_scheduled'
  )),
  language_detected text,
  recording_url text,
  transcript_summary text,
  consents_captured jsonb,
  retry_count int not null default 0,
  next_retry_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index if not exists helper_outreach_helper_started_idx
  on public.helper_outreach_attempts (helper_id, started_at desc);

create index if not exists helper_outreach_invite_idx
  on public.helper_outreach_attempts (invite_id)
  where invite_id is not null;

create index if not exists helper_outreach_retry_idx
  on public.helper_outreach_attempts (status, next_retry_at)
  where status = 'retry_scheduled';

create index if not exists helper_outreach_ttl_idx
  on public.helper_outreach_attempts (created_at);

alter table public.helper_outreach_attempts enable row level security;

drop policy if exists helper_outreach_select on public.helper_outreach_attempts;
create policy helper_outreach_select on public.helper_outreach_attempts
  for select
  using (public.is_support_user() or public.is_household_member(household_id));

drop policy if exists helper_outreach_insert on public.helper_outreach_attempts;
create policy helper_outreach_insert on public.helper_outreach_attempts
  for insert
  with check (public.is_household_member(household_id));

drop policy if exists helper_outreach_update on public.helper_outreach_attempts;
create policy helper_outreach_update on public.helper_outreach_attempts
  for update
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 6. updated_at triggers (where needed)
-- ─────────────────────────────────────────────────────────────────────────
-- helper_invites doesn't have updated_at; no trigger needed.
-- helper_consents is append-only.
-- helper_compensation_ledger is append-only (void triggers handle mutability).
-- helper_outreach_attempts is mutable (status transitions) but doesn't
--   have an updated_at column; state is tracked via started_at/ended_at.

comment on table public.helper_invites is 'Stage 2 onboarding invite tokens per helper (Phase 1.0)';
comment on table public.helper_consents is 'Append-only consent log; helper-side consents only written via helper-self channels (Phase 1.0)';
comment on table public.helper_compensation_ledger is 'Tracking-only compensation ledger; HomeOps does not move money (Phase 1.0)';
comment on table public.helper_outreach_attempts is 'Channel delivery attempts for helper outreach; 3-month TTL via pg_cron (Phase 1.0)';
