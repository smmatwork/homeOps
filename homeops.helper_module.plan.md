---
description: Helper Module + Helper Chore Assignment — Architecture Plan
scope: helpers, chore assignment
version: 1.1
status: approved
parent: homeops.system.manifest.md
relates_to: chores.agent.manifest.md
---

# Helper Module Architecture Plan (v1.1)

## Status

Approved on 2026-04-15 after a multi-round review. This plan implements
the Phase 1 deliverables for two scopes from the system manifest:

- **Helpers as first-class participants** (helper-facing surface,
  two-stage onboarding, tracking-only compensation ledger, helper
  preferred-channel selection).
- **Chore management → Scope: Assignment** (pattern elicitation,
  rules engine via strategy plug-ins, confidence-graduated operating
  modes, override-driven learning, reassignment on absence).

This document is the implementation reference. It does **not** repeat
the rationale already captured in
[homeops.system.manifest.md](homeops.system.manifest.md); it focuses on
**what to build and in what order**.

# Goals

## In scope (this plan)

- Stage 1 owner-driven onboarding wizard for new helpers
- Stage 2 helper-completion flow across multiple channels (voice,
  WhatsApp, SMS, web magic-link), driven by a per-helper channel chain
  configured by the owner
- Tracking-only compensation ledger
- Pattern elicitation conversation
- Strategy plug-in architecture for the rules engine, with ~23 v1
  strategies and ~10 deferred to Phase 2
- Confidence-graduated operating modes (manual → one-tap → silent)
- Override-tracking with transparent learning nudges
- Reassignment on helper absence
- O1 instrumentation: every assignment event classified per the
  manifest's locked classifier rules

## Out of scope (deferred)

- Multi-household helper coordination (Phase 3)
- Full helper-side native or web app beyond the magic-link page
  (Phase 2/3)
- ML-based assignment (manifest is explicit: deterministic in v1)
- Payroll / payment processing (locked out of scope)
- Helper marketplace / discovery (out of scope for v1)
- Vision-driven assignment (Phase 2)
- 11 strategies marked "Phase 2" in the strategy library below

# Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          PRESENTATION LAYER                          │
│                                                                      │
│  Owner-facing (web)              Helper-facing (multi-channel)       │
│  ┌──────────────────────┐        ┌──────────────────────────────┐    │
│  │ HelperOnboarding     │        │ Voice (Sarvam voice agent)   │    │
│  │ Stepper (Stage 1)    │        │ WhatsApp tap / form / voice  │    │
│  │ ChoreAssignment UI   │        │ SMS (low-bandwidth fallback) │    │
│  │ Settings + Rules UI  │        │ Web magic-link page          │    │
│  └──────────────────────┘        └──────────────────────────────┘    │
└────────────┬──────────────────────────────────┬──────────────────────┘
             │                                  │
             ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      EDGE FUNCTION (Supabase)                        │
│                                                                      │
│  Existing routes (kept):            New routes (this plan):          │
│  - /tools/execute (db.* + RPC)      - POST /helpers/invite           │
│  - /chat/respond                    - POST /helpers/:id/outreach     │
│  - /chat/append + /chat/load        - GET  /h/:token                 │
│                                     - POST /h/:token/complete        │
│                                     - POST /helpers/:id/ledger       │
│                                     - POST /voice/webhook            │
│                                       (telephony provider callback)  │
└────────────┬──────────────────────────────────┬──────────────────────┘
             │                                  │
             ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   AGENT SERVICE (FastAPI)                            │
│                                                                      │
│  Existing modules (unchanged):      New modules (this plan):         │
│  - chores agent extractor           - ChannelDispatcher              │
│  - helper agent                     - VoiceAdapter (Sarvam)          │
│  - preview/confirm + sync flow      - WhatsApp/SMS/Web adapters      │
│  - rolling summary + truncator      - PatternElicitationFlow         │
│                                     - AssignmentRulesEngine          │
│                                     - assignment_strategies/         │
│                                       (23 plug-in classes)           │
│                                     - OverrideObserver + nudges      │
└────────────┬─────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          POSTGRES (Supabase)                         │
│                                                                      │
│  Existing tables (unchanged schema):                                 │
│  - helpers, chores, helper_feedback                                  │
│  - chore_helper_assignments                                          │
│  - member_time_off, member_availability                              │
│  - helper_rewards, helper_reward_snapshots                           │
│                                                                      │
│  New tables (this plan):                                             │
│  - helper_invites                                                    │
│  - helper_consents                                                   │
│  - helper_compensation_ledger                                        │
│  - helper_outreach_attempts          (3-month TTL)                   │
│  - assignment_rules                                                  │
│  - assignment_decisions              (O1 instrumentation source)     │
│  - assignment_overrides                                              │
│  - assignment_strategy_weights                                       │
│                                                                      │
│  New columns on helpers:                                             │
│  - preferred_language text                                           │
│  - channel_preferences text[]        (ordered chain)                 │
│  - preferred_call_window jsonb                                       │
│  - onboarding_status text                                            │
│  - id_verified bool                                                  │
│  - profile_photo_url text                                            │
└──────────────────────────────────────────────────────────────────────┘
```

# Data model

## New tables

### `helper_invites`

Tracks Stage 2 invite state per helper. One row per invite (re-send
creates a new row; old token is revoked).

```sql
CREATE TABLE helper_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  helper_id uuid NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,            -- 256-bit base64url
  channel_chain text[] NOT NULL,         -- snapshot of helpers.channel_preferences at send time
  active_channel text,                   -- the channel currently being attempted
  sent_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,       -- default now() + 30 days
  completed_at timestamptz,
  last_reminder_at timestamptz,
  reminder_count int DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  revoked_at timestamptz
);

CREATE INDEX helper_invites_helper_idx ON helper_invites (helper_id) WHERE completed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX helper_invites_token_idx ON helper_invites (token);
```

### `helper_consents`

Append-only consent log. **Helper-side fields can only be written via
the helper-self path** (the edge function rejects owner-initiated
writes to `consent_type` values that are helper-controlled).

```sql
CREATE TABLE helper_consents (
  id bigserial PRIMARY KEY,
  helper_id uuid NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id),
  consent_type text NOT NULL CHECK (consent_type IN (
    'id_verification','vision_capture','multi_household_coord',
    'data_export','call_recording','marketing_outreach'
  )),
  granted bool NOT NULL,
  granted_at timestamptz DEFAULT now(),
  revoked_at timestamptz,
  source text NOT NULL CHECK (source IN (
    'helper_self','helper_voice','helper_whatsapp_tap',
    'helper_whatsapp_form','helper_sms','helper_web','system_default'
  )),
  evidence jsonb,                        -- ip, user_agent, call_id, etc.
  created_at timestamptz DEFAULT now()
);

CREATE INDEX helper_consents_helper_idx ON helper_consents (helper_id, consent_type, created_at DESC);
```

Helper-controlled consent types (cannot be set by owner): every
type except none. All consent flips MUST come through a helper-self
channel adapter.

### `helper_compensation_ledger`

Bidirectional, append-only, tracking-only. **HomeOps does not move
money.** The owner and helper see the same view.

```sql
CREATE TABLE helper_compensation_ledger (
  id bigserial PRIMARY KEY,
  helper_id uuid NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id),
  entry_type text NOT NULL CHECK (entry_type IN (
    'salary_set','salary_change','advance','bonus','leave_balance',
    'leave_taken','settlement','adjustment'
  )),
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  effective_date date NOT NULL,
  recorded_by_role text NOT NULL CHECK (recorded_by_role IN ('owner','helper')),
  recorded_by_user_id uuid REFERENCES auth.users(id),  -- owner side
  recorded_via_invite_token text,                       -- helper side (FK to helper_invites.token)
  note text,
  created_at timestamptz DEFAULT now(),
  voided_at timestamptz,
  voided_by_user_id uuid REFERENCES auth.users(id),
  voided_reason text
);

CREATE INDEX helper_comp_ledger_helper_idx ON helper_compensation_ledger (helper_id, effective_date DESC);
```

Corrections happen via void + new entry; never `UPDATE`.

### `helper_outreach_attempts`

Tracks every channel attempt for any outreach intent (onboarding,
daily check-in, balance inquiry, reminder). **3-month TTL** enforced
via a daily cleanup job.

```sql
CREATE TABLE helper_outreach_attempts (
  id bigserial PRIMARY KEY,
  helper_id uuid NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id),
  intent text NOT NULL CHECK (intent IN (
    'stage2_onboarding','daily_checkin','balance_inquiry',
    'reassignment_consent','schedule_change_consent','reminder',
    'pattern_elicitation_followup'
  )),
  direction text NOT NULL CHECK (direction IN ('outbound','inbound')),
  channel_used text NOT NULL CHECK (channel_used IN (
    'voice','whatsapp_voice','whatsapp_tap','whatsapp_form','web','sms'
  )),
  invite_id uuid REFERENCES helper_invites(id),
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz,
  status text NOT NULL CHECK (status IN (
    'in_progress','completed','no_answer','failed','partial','retry_scheduled'
  )),
  language_detected text,
  recording_url text,                    -- only if call_recording consent granted
  transcript_summary text,               -- structured summary; never raw audio
  consents_captured jsonb,               -- what got written to helper_consents
  retry_count int DEFAULT 0,
  next_retry_at timestamptz,
  failure_reason text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX helper_outreach_helper_idx ON helper_outreach_attempts (helper_id, started_at DESC);
CREATE INDEX helper_outreach_invite_idx ON helper_outreach_attempts (invite_id) WHERE invite_id IS NOT NULL;
CREATE INDEX helper_outreach_status_idx ON helper_outreach_attempts (status, next_retry_at) WHERE status = 'retry_scheduled';
```

**TTL enforcement**: a daily `pg_cron` job (Supabase supports it) runs:

```sql
DELETE FROM helper_outreach_attempts
WHERE created_at < now() - interval '3 months';
```

Helper consents and compensation ledger entries are NOT subject to
this TTL — they have indefinite retention because they're records of
fact, not transient delivery state.

### `assignment_rules`

Output of pattern elicitation and accepted learning nudges. Stores
template-instance rows; the strategy plug-in registry interprets them.

```sql
CREATE TABLE assignment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  template_id text NOT NULL,             -- e.g., "preferred_helper_for_floor"
  template_params jsonb NOT NULL,        -- e.g., {"floor":"first","helper_id":"..."}
  helper_id uuid REFERENCES helpers(id), -- denormalized for indexing; null for non-helper-bound rules
  weight numeric(4,2) NOT NULL DEFAULT 1.0,    -- per-rule weight
  conditions jsonb,                      -- e.g., {"days_of_week":["sat"],"time_window":{...}}
  source text NOT NULL CHECK (source IN ('elicitation','accepted_nudge','manual_edit')),
  active bool NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  created_by uuid REFERENCES auth.users(id)
);

CREATE INDEX assignment_rules_household_active_idx
  ON assignment_rules (household_id) WHERE active = true AND deleted_at IS NULL;
CREATE INDEX assignment_rules_template_idx
  ON assignment_rules (household_id, template_id) WHERE active = true;
```

`template_id` is a soft enum validated in code by the strategy
registry, not by the DB. **Adding a new template does not require a
migration.**

### `assignment_strategy_weights`

Per-household tunable weights for each strategy. Defaults to 1.0 for
all strategies. Owners can boost or dampen individual strategies via
the settings panel.

```sql
CREATE TABLE assignment_strategy_weights (
  household_id uuid PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  weights jsonb NOT NULL DEFAULT '{}',   -- {"PreferredHelperForSpaceStrategy": 1.5, ...}
  updated_at timestamptz DEFAULT now()
);
```

Combined scoring uses **both** per-rule weight and per-strategy weight:

```
final_score += partial_score
            * rule.weight
            * household.strategy_weights[strategy.name]
```

Defaults are all 1.0. Owners with no entries in `assignment_strategy_weights`
get equal-weight scoring.

### `assignment_decisions`

Every assignment event, with O1 classification. **This is the source
of truth for the cognitive-load reduction metric.** Every event must
write here.

```sql
CREATE TABLE assignment_decisions (
  id bigserial PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  chore_id uuid NOT NULL REFERENCES chores(id),
  helper_id uuid REFERENCES helpers(id),
  decided_at timestamptz DEFAULT now(),
  mode text NOT NULL CHECK (mode IN (
    'manual','one_tap','silent_auto',
    'reassignment_silent','reassignment_one_tap','bulk',
    'override','elicitation','manual_edit_rules'
  )),
  classification text NOT NULL CHECK (classification IN ('load_reducing','full_effort')),
  rule_ids uuid[],                       -- which assignment_rules influenced this
  contributions jsonb,                   -- [{strategy_name, score}, ...] for explainability
  proposed_helper_id uuid,               -- if owner overrode, what the system originally proposed
  overridden bool DEFAULT false,
  override_recorded_at timestamptz,
  decided_by_user_id uuid REFERENCES auth.users(id)
);

CREATE INDEX assignment_decisions_household_week_idx
  ON assignment_decisions (household_id, decided_at);
CREATE INDEX assignment_decisions_chore_idx ON assignment_decisions (chore_id);
```

The `decided_at` index is critical: the O1 metric query is
`SELECT COUNT(*) FILTER (WHERE classification = 'load_reducing')::float / COUNT(*)
 FROM assignment_decisions WHERE household_id = ? AND decided_at >= now() - interval '4 weeks'`.

### `assignment_overrides`

Compact aggregator that drives the learning nudge. One row per
`(household, chore_predicate_hash, proposed_helper, chosen_helper)`
combination.

```sql
CREATE TABLE assignment_overrides (
  id bigserial PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  chore_predicate_hash text NOT NULL,    -- stable hash of (chore_type, space, etc.)
  chore_predicate_sample jsonb,          -- example chore for explanation
  proposed_helper_id uuid REFERENCES helpers(id),
  chosen_helper_id uuid REFERENCES helpers(id),
  override_count int NOT NULL DEFAULT 1,
  first_override_at timestamptz DEFAULT now(),
  last_override_at timestamptz DEFAULT now(),
  nudge_status text NOT NULL DEFAULT 'none' CHECK (nudge_status IN (
    'none','shown','accepted','declined'
  )),
  nudge_shown_at timestamptz,
  nudge_decline_until timestamptz,       -- 30-day hibernation
  UNIQUE (household_id, chore_predicate_hash, proposed_helper_id, chosen_helper_id)
);
```

When `override_count` reaches 3 and `nudge_status='none'` (or
`nudge_decline_until < now()`), the agent surfaces the nudge. Accepted
→ write to `assignment_rules` and reset. Declined → set
`nudge_decline_until = now() + 30d`.

## New columns on existing tables

```sql
ALTER TABLE helpers
  ADD COLUMN preferred_language text,                 -- en | hi | kn | ta | te | ml | bn
  ADD COLUMN channel_preferences text[]
    NOT NULL DEFAULT ARRAY['voice','whatsapp_tap','sms']::text[],
  ADD COLUMN preferred_call_window jsonb,             -- {"days":["mon",...],"start":"10:00","end":"12:00"}
  ADD COLUMN onboarding_status text
    NOT NULL DEFAULT 'pending_helper_completion'
    CHECK (onboarding_status IN (
      'pending_helper_completion','active','declined','archived'
    )),
  ADD COLUMN id_verified bool NOT NULL DEFAULT false,
  ADD COLUMN profile_photo_url text;
```

Backfill: `metadata.preferred_language` (currently set by
[Helpers.tsx](src/app/components/helpers/Helpers.tsx)) is migrated
into the new column on first migration run; the metadata path is then
deprecated.

# New RPCs

| RPC | Purpose | Caller |
|---|---|---|
| `score_helpers_for_chore(p_household_id, p_actor_user_id, p_chore_id)` | Run the rules engine for one chore. Returns ranked candidates with scores and `contributions` array. | Agent service when proposing assignments. Synchronous, must be fast (<50ms). |
| `apply_assignment_decision(p_household_id, p_actor_user_id, p_chore_id, p_helper_id, p_mode, p_classification, p_rule_ids[], p_contributions)` | Atomic: update `chores.helper_id`, write `chore_helper_assignments`, write `assignment_decisions`. | Agent service after owner approval (or silent execution). |
| `record_assignment_override(p_household_id, p_actor_user_id, p_chore_id, p_proposed_helper_id, p_chosen_helper_id)` | Update `assignment_overrides` aggregator, increment counter, return `should_nudge` boolean. | Agent service when owner overrides. |
| `find_chores_needing_reassignment(p_household_id, p_actor_user_id, p_helper_id, p_start, p_end)` | When a helper is marked on leave, return chores in window needing reassignment. | Agent service when `member_time_off` is created. |
| `compensation_ledger_summary(p_household_id, p_actor_user_id, p_helper_id)` | Compute current salary, advances outstanding, leave balance, last settlement. Same numbers regardless of caller (owner vs helper). | Settings UI + helper-side voice/web readback. |

All five follow the existing pattern: security definer, household
membership check, edge allowlist update.

# Channel architecture

## `helpers.channel_preferences`

A single ordered `text[]` column. The first entry is the **primary**;
the rest are **fallbacks** in order. The system tries each in turn
until one succeeds.

Allowed channel values:

| Value | Description |
|---|---|
| `voice` | Outbound voice call via Sarvam voice agent + telephony provider |
| `whatsapp_voice` | WhatsApp voice note (async, no live call) |
| `whatsapp_tap` | WhatsApp one-tap confirmation (✅ button, no form) |
| `whatsapp_form` | WhatsApp link to the structured magic-link web form |
| `web` | Direct web magic-link URL |
| `sms` | Plain text SMS with callback number |

**Default chain** (set on `helpers` insert): `["voice","whatsapp_tap","sms"]`.

## Stage 1 wizard channel step

A new step in the Stage 1 owner wizard between "Schedule" and "Salary":

- Default chain pre-selected as `["voice","whatsapp_tap","sms"]`
- Drag-to-reorder UI to change priority
- Per-channel one-line tooltips
- Preferred call window picker shown when `voice` or
  `whatsapp_voice` is in the chain
- Owner can also pre-select `preferred_language` based on what they
  know about the helper (the helper can change this in Stage 2)

## `ChannelDispatcher` module (agent service)

```python
# services/agent-service/channel_dispatcher.py

class ChannelDispatcher:
    def __init__(self, adapters: dict[str, ChannelAdapter]):
        self.adapters = adapters

    def initiate_outreach(
        self,
        helper: Helper,
        intent: OutreachIntent,
        invite: Optional[HelperInvite] = None,
    ) -> OutreachResult:
        """Walk channel_preferences until one succeeds."""
        for channel in helper.channel_preferences:
            adapter = self.adapters[channel]
            attempt = adapter.deliver(helper, intent, invite)
            self._record_attempt(helper, channel, intent, attempt)
            if attempt.success:
                return attempt
            if attempt.failure_kind == "permanent":
                continue  # try next channel
            # transient failure: schedule retry within helper's call window
            self._schedule_retry(helper, channel, attempt.retry_after)
            return attempt
        return OutreachResult(success=False, reason="all_channels_exhausted")
```

## `ChannelAdapter` interface

```python
class ChannelAdapter(Protocol):
    name: str

    def deliver(
        self,
        helper: Helper,
        intent: OutreachIntent,
        invite: Optional[HelperInvite],
    ) -> DeliveryResult:
        ...

    def handle_inbound(self, payload: dict) -> InboundEvent:
        ...
```

## Adapters shipped in P1.0a

| Adapter | Provider / mechanism | Notes |
|---|---|---|
| `VoiceAdapter` | Sarvam voice agent + telephony provider (Twilio India / Exotel / Knowlarity TBD) | Most complex — dialog manager, STT, TTS, retry policy. Conversational, not IVR. |
| `WhatsAppTapAdapter` | WhatsApp Business API | Single-button confirmation. One-tap accepts onboarding with default consents. |
| `WhatsAppFormAdapter` | WhatsApp Business API | Sends a magic-link to the existing web form. |
| `WhatsAppVoiceAdapter` | WhatsApp Business API | Records and posts a voice-note prompt. Async. |
| `WebMagicLinkAdapter` | Email or direct URL | Owner shares the URL out-of-band with the helper. Backwards path; rarely used. |
| `SMSAdapter` | Telephony provider | Plain SMS with the helper's preferred-language text + a callback number. |

The web magic-link page (`HelperMagicLinkPage.tsx`) is **kept** — it's
the consumer of `WhatsAppFormAdapter` and `WebMagicLinkAdapter`. It
was almost-deleted in an earlier draft of this plan; it stays in.

## Voice flow specifics

- Heads-up SMS sent 5 minutes before the call so the helper recognizes
  the incoming number.
- Voice agent opens with a context-setting line: *"Hi {name}, this is
  HomeOps calling on behalf of the {household} household."*
- Each consent field is captured with a yes/no question + clarification
  turn if response is unclear.
- Recording is **off by default**. Recording consent is requested at
  the start of every call as a separate question.
- Caller-ID matching to `helpers.phone` for inbound calls.
- For sensitive ops (compensation, settlement), require a 4-digit PIN
  read out to the owner who shares it with the helper out-of-band.
  Single-use, 10-minute expiry.

# Strategy library

## Architecture

Each pattern is a `AssignmentStrategy` plug-in:

```python
class AssignmentStrategy(Protocol):
    name: str
    description: str
    template_id: str   # links to elicitation registry

    def applies_to(self, chore: Chore, household: Household) -> bool:
        """Cheap precheck — does this strategy have anything to say about this chore?"""

    def score(
        self,
        chore: Chore,
        candidates: list[Helper],
        household: Household,
        rules: list[AssignmentRule],
    ) -> dict[helper_id, float]:
        """Return a score for each candidate. Higher = stronger match. Range [0.0, 10.0]."""

    def explain(
        self,
        chore: Chore,
        helper: Helper,
        rules: list[AssignmentRule],
    ) -> str:
        """Human-readable explanation for the explainability surface."""
```

## Catalogued strategies (full list, with v1 / Phase 2 split)

### A. Spatial patterns

| ID | Strategy | Example | v1 |
|---|---|---|---|
| A1 | `PreferredHelperForSpaceStrategy` | *"Sunita does all bathrooms"* | ✅ |
| A2 | `PreferredHelperForFloorStrategy` | *"Lakshmi → first floor; Rajesh → ground floor"* | ✅ |
| A3 | `PreferredHelperForZoneStrategy` | *"Outdoor → gardener; indoor → cleaner"* | ✅ |
| A4 | `PreferredHelperForSurfaceStrategy` | *"Floors → mopping; windows → glass; furniture → polishing"* | ✅ |
| A5 | `PreferredHelperForRoomTypeStrategy` | *"Bedrooms / common areas / utility room"* | Phase 2 |
| A6 | `RouteOptimizationStrategy` | *"Group geographically close chores"* | Phase 2 |

### B. Task-type and skill patterns

| ID | Strategy | Example | v1 |
|---|---|---|---|
| B1 | `PreferredHelperForChoreTypeStrategy` | *"Rajesh does kitchen tasks; Sunita does laundry"* | ✅ |
| B2 | `PreferredHelperForToolStrategy` | *"Only Lakshmi uses the high ladder"* | ✅ |
| B3 | `PreferredHelperForSkillTagStrategy` | *"Plumbing-light → A; electrical-light → B"* | ✅ |
| B4 | `HelperExclusionStrategy` | *"Don't assign cooking to anyone except Rajesh"* | ✅ |
| B5 | `CertificationRequiredStrategy` | *"Only certified helpers for electrical"* | Phase 2 |
| B6 | `LanguageMatchStrategy` | *"Tamil-speaking helper for Tamil-only households"* | Phase 2 |

### C. Effort and intensity patterns

| ID | Strategy | Example | v1 |
|---|---|---|---|
| C1 | `IntensityTierStrategy` | *"Heavy/physical → Rajesh; light → Sunita"* | ✅ |
| C2 | `DurationTierStrategy` | *"Quick (<15 min) vs medium vs long"* | ✅ |
| C3 | `ComplexityTierStrategy` | *"Simple → assistant; requires-judgment → primary"* | ✅ |
| C4 | `WeightLiftingStrategy` | *"Lifting tasks → physically capable helpers only"* | Phase 2 |

### D. Temporal patterns

| ID | Strategy | Example | v1 |
|---|---|---|---|
| D1 | `TimeOfDayStrategy` | *"Morning → cook; evening → cleaner"* | ✅ |
| D2 | `DayOfWeekStrategy` | *"Saturday is Lakshmi's deep-clean day"* | ✅ |
| D3 | `DateOfMonthStrategy` | *"1st of month → financial chores"* | Phase 2 |
| D4 | `SeasonStrategy` | *"Monsoon → mold check; summer → AC clean"* | Phase 2 |
| D5 | `FestivalCalendarStrategy` | *"Pre-Diwali deep clean → all hands"* | Phase 2 |

### E. Capacity and fairness patterns

| ID | Strategy | Example | v1 |
|---|---|---|---|
| E1 | `CapacityAwareStrategy` | *"Don't assign if helper is at >90% of `daily_capacity_minutes`"* | ✅ |
| E2 | `WorkloadBalanceStrategy` | *"Target equal hours/week across helpers"* | ✅ |
| E3 | `FairnessStrategy` | *"Distribute equally across N cleaners (round-robin)"* | Phase 2 |
| E4 | `BurnoutAvoidanceStrategy` | *"Don't give Rajesh deep-clean two days in a row"* | Phase 2 |

### F. Priority and urgency patterns

| ID | Strategy | Example | v1 |
|---|---|---|---|
| F1 | `PriorityTierStrategy` | *"P1 chores → senior helper"* | ✅ |
| F2 | `UrgencyStrategy` | *"Immediate tasks → whoever is on-site"* | Phase 2 |
| F3 | `FrequencyTierStrategy` | *"Daily → primary; weekly → assistant; monthly → backup"* | ✅ |

### G. Continuity and preference patterns

| ID | Strategy | Example | v1 |
|---|---|---|---|
| G1 | `ContinuityStrategy` | *"Whoever started this multi-day chore finishes it"* | ✅ |
| G2 | `RecentSuccessStrategy` | *"Helper who most recently completed this chore type gets preference"* | ✅ |
| G3 | `HelperPreferenceStrategy` | *"Helpers can opt into specific task types"* | Phase 2 |

### H. Constraint and fallback patterns

| ID | Strategy | Example | v1 |
|---|---|---|---|
| H1 | `BackupChainStrategy` | *"If A is unavailable, try B, then C"* | ✅ |
| H2 | `TimeOffAwareStrategy` | *"Hard exclusion when helper is on `member_time_off`"* | ✅ |
| H3 | `RoleRequirementStrategy` | *"Only helpers with role 'cook' can do meal prep"* | ✅ |
| H4 | `OwnerStandingInstructionStrategy` | *"Override-everything standing instructions from the owner"* | ✅ |

## v1 ship list (P1.4)

23 strategies in v1: A1, A2, A3, A4, B1, B2, B3, B4, C1, C2, C3, D1,
D2, E1, E2, F1, F3, G1, G2, H1, H2, H3, H4. The remaining 11 are
Phase 2.

Each strategy ships with: implementation class, template registry
entry, elicitation prompt, unit tests, and one entry in the rules
engine combination logic.

## Combination logic

```python
def score_helpers_for_chore(chore, candidates, household, rules):
    # 1. Hard exclusions first
    for s in HARD_EXCLUSION_STRATEGIES:  # H2 (TimeOff), B4 (Helper exclusion)
        candidates = s.filter(chore, candidates, household, rules)
    if not candidates:
        return []  # surfaces as manual decision

    # 2. Owner standing instructions short-circuit (H4)
    standing = OwnerStandingInstructionStrategy.score(chore, candidates, household, rules)
    if any(score > STANDING_OVERRIDE_THRESHOLD for score in standing.values()):
        return ranked_by_score(standing)

    # 3. Collect scores from all applicable scoring strategies
    scores = defaultdict(float)
    contributions = defaultdict(list)
    strategy_weights = household.strategy_weights  # from assignment_strategy_weights
    rule_index = build_rule_index(rules)

    for s in SCORING_STRATEGIES:
        if not s.applies_to(chore, household):
            continue
        partial = s.score(chore, candidates, household, rules)
        s_weight = strategy_weights.get(s.name, 1.0)
        for helper_id, partial_score in partial.items():
            applicable_rules = rule_index.for_strategy_and_helper(s.template_id, helper_id)
            r_weight = max(r.weight for r in applicable_rules) if applicable_rules else 1.0
            final = partial_score * r_weight * s_weight
            scores[helper_id] += final
            contributions[helper_id].append({
                "strategy": s.name,
                "raw_score": partial_score,
                "rule_weight": r_weight,
                "strategy_weight": s_weight,
                "final": final,
            })

    # 4. Threshold check — system never guesses
    ranked = sorted(scores.items(), key=lambda x: -x[1])
    if not ranked or ranked[0][1] < MIN_ASSIGNABLE_SCORE:
        return []  # surfaces as manual

    # 5. Tiebreaker chain
    if len(ranked) > 1 and ranked[0][1] - ranked[1][1] < TIE_THRESHOLD:
        ranked = apply_tiebreakers(ranked, chore, candidates)

    return [
        {
            "helper_id": h,
            "score": s,
            "contributions": contributions[h],
            "explanation": explain(chore, h, contributions[h]),
        }
        for h, s in ranked
    ]
```

Tiebreaker chain (when top scores are within `TIE_THRESHOLD` of each
other):

1. Helper explicitly mapped to this chore type by owner rules
2. Helper with most recent successful completion of this chore type
3. Helper with most available capacity today
4. Helper with longest tenure in the household (stability bias)

# Pattern elicitation flow

## Trigger conditions

- **Onboarding**: triggered as the final step after at least one
  helper has reached `active` status (i.e., Stage 2 completed or
  defaults applied).
- **New helper added**: incremental questions about the new helper's
  specialties, asked once when the helper enters `active`.
- **Just-in-time**: when a chore type appears that doesn't match any
  existing rule, the agent asks once for that chore type.

## Conversation shape

A new state machine in the agent service: `PatternElicitationFlow`.
It walks through the v1 strategies' template prompts in order:

1. *"Who usually handles kitchen tasks?"* → `B1` rule
2. *"Who handles bathroom cleaning?"* → `A1` rule
3. *"Are there different floors with different helpers?"* → `A2`
4. *"Are there specific tools only certain helpers should use?"* → `B2`
5. *"Are some tasks heavier/more physical than others, and should they go to specific helpers?"* → `C1`
6. *"Are morning and evening shifts handled by different helpers?"* → `D1`
7. *"Is there a Saturday or any specific weekday routine?"* → `D2`
8. *"Should P1 / urgent chores always go to a specific helper?"* → `F1`
9. *"Who's the backup if your primary helper is unavailable?"* → `H1`
10. *"Are there any tasks a specific helper should never do?"* → `B4`

Each question:
- Owner can answer or skip ("not applicable")
- Answers produce one or more `assignment_rules` rows
- Owner can edit later via the `AssignmentRulesPanel`

The whole conversation can be skipped — defaults to one-tap mode for
everything until rules accumulate via override-learning.

## Persistence

A new table tracks elicitation state so it's resumable across sessions:

```sql
CREATE TABLE pattern_elicitation_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  template_id text NOT NULL,            -- which template we're currently asking about
  status text NOT NULL CHECK (status IN ('pending','in_progress','completed','skipped')),
  answer jsonb,
  asked_at timestamptz,
  answered_at timestamptz,
  UNIQUE (household_id, template_id)
);
```

# Frontend changes

## New components

| Component | Path | Purpose |
|---|---|---|
| `HelperOnboardingFlow.tsx` | `src/app/components/helpers/` | Stage 1 wizard mirroring `OnboardingFlow.tsx` |
| `ChannelChainStep.tsx` | `src/app/components/helpers/onboarding/` | Drag-to-reorder channel chain step in the wizard |
| `HelperMagicLinkPage.tsx` | `src/app/pages/` | Stage 2 web form (consumer of `WhatsAppFormAdapter` and `WebMagicLinkAdapter`) |
| `PatternElicitationCard.tsx` | `src/app/components/chat/` | Chat-surfaced multi-question elicitation card |
| `AssignmentRulesPanel.tsx` | `src/app/components/helpers/` | Settings panel showing current `assignment_rules`, edit/delete/add |
| `StrategyWeightsPanel.tsx` | `src/app/components/helpers/` | Settings panel for per-strategy weight tuning |
| `CompensationLedgerView.tsx` | `src/app/components/helpers/` | Owner-facing ledger view + add/edit/void |
| `AssignmentExplanationCard.tsx` | `src/app/components/chores/` | Shows *why* a chore was assigned (the contributions array) |

## Updates to existing components

- `Helpers.tsx`: surface `onboarding_status` per helper, link to
  compensation ledger, link to assignment rules + strategy weights
- `Chores.tsx` and `HelperDailyView.tsx`: show assignment mode badge
  (manual / one-tap / silent) per chore; one-tap proposals get a
  confirm button; silent assignments just show the helper

# Phased implementation order

| Sub-phase | Scope | Critical path? |
|---|---|---|
| **P1.0 Schema** | All new tables, columns, RPCs, edge allowlist, `pg_cron` TTL job for `helper_outreach_attempts`. Migration tests. | ✅ blocking |
| **P1.0a Channel infrastructure** | `ChannelDispatcher` + 6 channel adapters. `VoiceAdapter` is the most complex (Sarvam voice agent + telephony provider abstraction). The other 5 are thin. | ✅ blocking for P1.1 |
| **P1.1 Helper onboarding split flow** | Stage 1 wizard (with channel chain step) + Stage 2 across all enabled channels + `helper_consents` writes + retry policy across the chain | ✅ blocking |
| **P1.2 Compensation ledger MVP** | Ledger writes from Stage 1 (initial salary), helper-facing read via preferred channel (voice readout, WhatsApp text, web view), owner-facing edit + add advance/bonus + settlement | parallel with P1.3 |
| **P1.3 Pattern elicitation flow** | Conversational elicitation, template registry consumption, `assignment_rules` writes, manual-edit settings panel, `pattern_elicitation_state` writes | ✅ blocking for P1.4 |
| **P1.4 Rules engine + 23 strategies + one-tap mode** | `score_helpers_for_chore` RPC, agent-service `AssignmentRulesEngine`, all 23 strategy classes, combination logic with rule + strategy weights, one-tap proposal flow | ✅ blocking for P1.5/P1.6 |
| **P1.5 Confidence graduation + silent mode** | One-tap → silent promotion based on owner approval streak (≥5 consecutive approvals on similar patterns) | depends on P1.4 |
| **P1.6 Override-tracking + learning nudge** | `assignment_overrides` aggregator, `record_assignment_override` RPC, transparent nudge flow, accept/decline/conditional handling | depends on P1.4 |
| **P1.7 Reassignment on absence** | `find_chores_needing_reassignment` RPC, automatic re-run on `member_time_off` create, fallback to one-tap when ambiguous | depends on P1.4 |

P1.0 → P1.0a → P1.1 are sequential. P1.2 and P1.3 can run in parallel
after P1.1. P1.4 onward is sequential.

# O1 instrumentation

The `assignment_decisions` table is the source of truth for the O1
metric. Every assignment event MUST write a row, with the
`classification` field set per the locked classifier rules in the
system manifest:

| Event | Mode | Classification |
|---|---|---|
| Owner manually picks helper | `manual` | `full_effort` |
| Owner taps to confirm system proposal | `one_tap` | `load_reducing` |
| System assigns silently (no owner action) | `silent_auto` | `load_reducing` |
| Owner overrides system proposal | `override` | `full_effort` |
| Owner taps to approve N items in batch | `bulk` | `load_reducing` × N |
| Helper goes on leave; system reassigns silently | `reassignment_silent` | `load_reducing` |
| Helper goes on leave; system proposes one-tap reassignment | `reassignment_one_tap` | `load_reducing` |
| Owner answers a pattern elicitation question | `elicitation` | `full_effort` |
| Owner manually edits assignment rules | `manual_edit_rules` | `full_effort` |

The 4-week rolling baseline measurement starts the moment P1.0 ships
(even though only manual events will be written until P1.4 lands), so
we have a clean baseline to attribute the P1.4 load-reducing wins to.

# Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pattern elicitation produces sparse rules → engine has nothing to score with | Default to one-tap mode for everything until enough rules exist. Owner can always override. |
| Magic-link / invite token leaks (helper forwards link to someone else) | Token is single-use for completion; expires in 30 days; rotates on first successful use. Helper can request a new one anytime. |
| Owner over-delegates and stops checking | Confidence-graduated silent mode requires 5 consecutive approvals before promotion. |
| Rules engine drifts from owner intent | A2 metric (% of auto-assignments not overridden in 7 days) is the alarm — if it drops below 80%, the engine pauses silent promotion until rules are re-elicited. |
| Helper never completes Stage 2 | Sane defaults (vision off, multi-household off, no ID, household default language). System works without helper completion. |
| Voice channel reliability | All channels have fallbacks via `channel_preferences` chain. Voice failure → WhatsApp tap → SMS. H7 metric stays at 50% target. |
| STT misinterprets helper response in code-mixed languages | Voice agent confirms ambiguous answers explicitly; Sarvam tuned for Indian code-mix. Fallback IVR ("press 1 for yes") for edge cases. |
| Strategy combination produces unexpected results | `contributions` array stored on every `assignment_decisions` row; explanation surface in UI. Owner can always inspect *why*. |
| Per-strategy weights tuned poorly by owner | Defaults are 1.0 across the board; reset-to-default button in `StrategyWeightsPanel`. |
| Phone number spoofing for inbound calls | Sensitive ops (compensation queries) require a 4-digit PIN out-of-band. Caller-ID alone is sufficient only for low-stakes ops. |
| `helper_outreach_attempts` table grows unbounded | 3-month TTL via daily `pg_cron` job. Audit rows for compensation/consent are in different tables and not subject to TTL. |

# Definition of Done (per sub-phase)

Each sub-phase is "done" when:

1. All schema/code/UI changes for that sub-phase have shipped to a
   pilot household.
2. Unit tests cover happy path + the top 3 failure modes.
3. Integration tests cover at least one end-to-end flow (e.g., P1.1:
   add helper → send invite → helper completes via voice → consent
   row written).
4. Privacy review has signed off on any new data collection.
5. The relevant phase metric (H1/H2/H7/A1/A2) has been instrumented
   and is producing data, even if the target hasn't yet been hit.

Phase 1 as a whole is done when:

- All seven sub-phases are individually done.
- The O1 cognitive-load reduction rate for the pilot cohort is ≥ 45%
  (per the system manifest's Phase 1 target).
- A1 ≥ 60%, A2 ≥ 80%, H1 ≥ 70%, H2 ≥ 50%, H7 ≥ 50%.

# Open questions resolved (decision log)

| # | Question | Decision | Date |
|---|---|---|---|
| 1 | Pattern elicitation state storage: chat_summaries or dedicated table? | Dedicated table `pattern_elicitation_state` | 2026-04-15 |
| 2 | Magic-link route hosting: React app or server-rendered? | React app with unauthenticated route guard | 2026-04-15 |
| 3 | Compensation ledger data residency: same DB or separate schema? | Same DB, separate schema (`finance.helper_compensation_ledger`) — flag for boundary visibility | 2026-04-15 |
| 4 | WhatsApp delivery provider | Defer to P1.0a implementation; abstract via `WhatsAppAdapter` interface | 2026-04-15 |
| 5 | O1 instrumentation timing | Ship instrumentation in P1.0 schema work so 4-week baseline starts before P1.4 | 2026-04-15 |
| 6 | Helper interaction model: web only / voice only / multi-channel? | Multi-channel with owner-driven selection during Stage 1, default `["voice","whatsapp_tap","sms"]` | 2026-04-15 |
| 7 | Strategy library scope | Exhaustive catalog (~34 strategies); ship 23 in v1, 11 in Phase 2 | 2026-04-15 |
| 8 | Rule weights vs strategy weights | Both — per-rule weight in `assignment_rules`, per-strategy weight in `assignment_strategy_weights` | 2026-04-15 |
| 9 | Rename `helper_voice_calls` → ? | `helper_outreach_attempts` (covers all channel attempts, not just voice) | 2026-04-15 |
| 10 | `helper_outreach_attempts` retention | 3-month TTL via daily `pg_cron` job | 2026-04-15 |

# Relationship to other documents

- [homeops.system.manifest.md](homeops.system.manifest.md) — strategic
  context, success metrics, classifier rules, Phase 1 target.
- [chores.agent.manifest.md](chores.agent.manifest.md) — per-chore CRUD
  contract that the assignment surface plugs into.

This plan is the implementation reference for everything in the
"Helpers as first-class participants" and "Chore management → Scope:
Assignment" sections of the system manifest.
