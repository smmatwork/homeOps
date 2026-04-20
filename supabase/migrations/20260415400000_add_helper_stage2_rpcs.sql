-- Stage 2 helper onboarding RPCs (Phase 1.1b)
--
-- Two security-definer functions that the magic-link web page calls
-- via the edge function. The RPCs are the security boundary — they
-- validate the invite token internally and return a structured status
-- so the edge function can stay thin.
--
-- Auth model: the token IS the auth. There's no auth.uid() check
-- because the helper has no Supabase user account. Anyone with a
-- valid, non-expired, non-completed, non-revoked token can complete
-- the invite. This is the point.
--
-- Tokens are 256-bit base64url (43 chars) generated client-side via
-- Web Crypto in helpersApi.ts. Probability of guessing a valid token
-- is 2^-256 ≈ 0. We rely on token entropy + expiry + single-use, not
-- on IP-based rate limiting.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. fetch_helper_invite — read-only invite resolution
-- ─────────────────────────────────────────────────────────────────────────
--
-- Called from GET /h/:token. Returns the helper basics and invite
-- metadata so the magic-link page can show the helper their name and
-- the household name before they complete consent capture.
--
-- The helper's phone is intentionally NOT returned — the helper is
-- the helper, they don't need their own phone displayed, and we don't
-- want to leak it through token-only auth.

create or replace function public.fetch_helper_invite(
  p_token text
)
returns table (
  helper_id uuid,
  helper_name text,
  household_id uuid,
  channel_chain text[],
  preferred_language text,
  expires_at timestamptz,
  status text  -- 'active' | 'expired' | 'revoked' | 'already_completed' | 'not_found'
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_invite public.helper_invites%rowtype;
  v_helper public.helpers%rowtype;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    helper_id := null;
    helper_name := null;
    household_id := null;
    channel_chain := null;
    preferred_language := null;
    expires_at := null;
    status := 'not_found';
    return next;
    return;
  end if;

  select * into v_invite from public.helper_invites where token = p_token;
  if not found then
    helper_id := null;
    helper_name := null;
    household_id := null;
    channel_chain := null;
    preferred_language := null;
    expires_at := null;
    status := 'not_found';
    return next;
    return;
  end if;

  select * into v_helper from public.helpers where id = v_invite.helper_id;
  if not found then
    helper_id := v_invite.helper_id;
    helper_name := null;
    household_id := v_invite.household_id;
    channel_chain := v_invite.channel_chain;
    preferred_language := null;
    expires_at := v_invite.expires_at;
    status := 'not_found';
    return next;
    return;
  end if;

  helper_id := v_helper.id;
  helper_name := v_helper.name;
  household_id := v_invite.household_id;
  channel_chain := v_invite.channel_chain;
  preferred_language := v_helper.preferred_language;
  expires_at := v_invite.expires_at;

  if v_invite.revoked_at is not null then
    status := 'revoked';
  elsif v_invite.completed_at is not null then
    status := 'already_completed';
  elsif v_invite.expires_at < now() then
    status := 'expired';
  else
    status := 'active';
  end if;

  return next;
end;
$$;

revoke all on function public.fetch_helper_invite(text) from public;
grant execute on function public.fetch_helper_invite(text) to authenticated;
grant execute on function public.fetch_helper_invite(text) to anon;
grant execute on function public.fetch_helper_invite(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. complete_helper_stage2 — atomic Stage 2 completion
-- ─────────────────────────────────────────────────────────────────────────
--
-- Called from POST /h/:token/complete. Atomically:
--
--   1. Validates the token (same status checks as fetch_helper_invite)
--   2. Writes one helper_consents row per valid consent in the payload
--      with source='helper_web'
--   3. Updates helpers.preferred_language / profile_photo_url if
--      provided in the payload
--   4. Updates helpers.onboarding_status to 'active'
--   5. Marks helper_invites.completed_at = now()
--   6. Records a helper_outreach_attempts audit row
--
-- All in one transaction. If any step fails, none of the writes
-- happen. The function always returns a status string so the caller
-- can route the response appropriately.
--
-- Payload shape (jsonb):
-- {
--   "preferred_language": "kn",
--   "profile_photo_url": "https://...",  -- optional
--   "preferred_channel": "voice",        -- optional, sets active_channel
--   "consents": {
--     "id_verification": false,
--     "vision_capture": false,           -- default off (helper opts in)
--     "multi_household_coord": false,    -- default off
--     "call_recording": true,
--     "marketing_outreach": false
--   }
-- }

create or replace function public.complete_helper_stage2(
  p_token text,
  p_payload jsonb
)
returns table (
  helper_id uuid,
  household_id uuid,
  status text  -- 'completed' | 'expired' | 'revoked' | 'already_completed' | 'not_found' | 'invalid_payload'
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.helper_invites%rowtype;
  v_consents jsonb;
  v_consent_keys text[] := array[
    'id_verification','vision_capture','multi_household_coord',
    'call_recording','marketing_outreach'
  ];
  v_consent_type text;
  v_consent_value bool;
  v_lang text;
  v_photo text;
  v_channel text;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    helper_id := null;
    household_id := null;
    status := 'not_found';
    return next;
    return;
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    helper_id := null;
    household_id := null;
    status := 'invalid_payload';
    return next;
    return;
  end if;

  -- Pessimistic-lock the invite row so two concurrent completions
  -- (e.g. helper double-clicks submit) can't both write consent rows.
  select * into v_invite
  from public.helper_invites
  where token = p_token
  for update;

  if not found then
    helper_id := null;
    household_id := null;
    status := 'not_found';
    return next;
    return;
  end if;

  if v_invite.revoked_at is not null then
    helper_id := v_invite.helper_id;
    household_id := v_invite.household_id;
    status := 'revoked';
    return next;
    return;
  end if;

  if v_invite.completed_at is not null then
    helper_id := v_invite.helper_id;
    household_id := v_invite.household_id;
    status := 'already_completed';
    return next;
    return;
  end if;

  if v_invite.expires_at < now() then
    helper_id := v_invite.helper_id;
    household_id := v_invite.household_id;
    status := 'expired';
    return next;
    return;
  end if;

  -- Write helper_consents rows. Iterate the locked allowlist (not the
  -- payload keys directly) so unknown payload keys are silently
  -- ignored rather than failing the whole transaction.
  v_consents := coalesce(p_payload->'consents', '{}'::jsonb);

  if jsonb_typeof(v_consents) <> 'object' then
    helper_id := v_invite.helper_id;
    household_id := v_invite.household_id;
    status := 'invalid_payload';
    return next;
    return;
  end if;

  foreach v_consent_type in array v_consent_keys loop
    if v_consents ? v_consent_type
       and jsonb_typeof(v_consents->v_consent_type) = 'boolean' then
      v_consent_value := (v_consents->>v_consent_type)::bool;
      insert into public.helper_consents (
        helper_id, household_id, consent_type, granted, source, evidence
      ) values (
        v_invite.helper_id,
        v_invite.household_id,
        v_consent_type,
        v_consent_value,
        'helper_web',
        jsonb_build_object(
          'invite_id', v_invite.id,
          'token_prefix', substring(p_token, 1, 8)
        )
      );
    end if;
  end loop;

  -- Update helper preferred fields if provided in the payload.
  v_lang := p_payload->>'preferred_language';
  v_photo := p_payload->>'profile_photo_url';
  v_channel := p_payload->>'preferred_channel';

  update public.helpers
  set
    preferred_language = case
      when v_lang is not null and length(trim(v_lang)) > 0 then v_lang
      else preferred_language
    end,
    profile_photo_url = case
      when v_photo is not null and length(trim(v_photo)) > 0 then v_photo
      else profile_photo_url
    end,
    onboarding_status = 'active'
  where id = v_invite.helper_id;

  -- Mark the invite completed and pin the active_channel if provided.
  update public.helper_invites
  set
    completed_at = now(),
    active_channel = case
      when v_channel is not null and length(trim(v_channel)) > 0 then v_channel
      else active_channel
    end
  where id = v_invite.id;

  -- Audit row for the outreach attempt.
  insert into public.helper_outreach_attempts (
    helper_id, household_id, intent, direction, channel_used,
    invite_id, started_at, ended_at, status, consents_captured
  ) values (
    v_invite.helper_id,
    v_invite.household_id,
    'stage2_onboarding',
    'inbound',
    'web',
    v_invite.id,
    now(),
    now(),
    'completed',
    v_consents
  );

  helper_id := v_invite.helper_id;
  household_id := v_invite.household_id;
  status := 'completed';
  return next;
end;
$$;

revoke all on function public.complete_helper_stage2(text, jsonb) from public;
grant execute on function public.complete_helper_stage2(text, jsonb) to authenticated;
grant execute on function public.complete_helper_stage2(text, jsonb) to anon;
grant execute on function public.complete_helper_stage2(text, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Comments
-- ─────────────────────────────────────────────────────────────────────────

comment on function public.fetch_helper_invite(text) is
  'Resolve a Stage 2 helper magic-link token. Token-only auth; returns helper basics + invite status. (Phase 1.1b)';

comment on function public.complete_helper_stage2(text, jsonb) is
  'Atomic Stage 2 completion: validates token, writes helper_consents rows, updates helpers.onboarding_status, marks invite completed, audits via helper_outreach_attempts. Token-only auth. (Phase 1.1b)';
