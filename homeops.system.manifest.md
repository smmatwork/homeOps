---
description: HomeOps System Manifest
scope: system
version: 1
status: draft
supersedes: none
relates_to: chores.agent.manifest.md
---

# Vision (North Star)

HomeOps is a household operations layer that removes the invisible work of
running a home. Today it runs as a personal chores agent for individual
households. The next version expands into a **community-level operations
fabric**: each home contributes signal (what's running low, what needs
servicing, who's idle), the system aggregates those signals across a
geo-fenced area (housing community / apartment complex), and matches them
against a transparent marketplace of vetted service providers — breaking the
monopoly of horizontal aggregators (UrbanClap, Amazon Home, etc.) that
extract rents without local accountability.

# Primary Objectives

## O1. Reduce cognitive load for house owners by ≥ 70%

The owner should not have to *remember* anything that the system can sense or
infer. The agent's job is to surface the right action at the right moment,
not to be queried. This can be measured in terms of decisions taken.


**In-scope levers:**
- Auto-creation of chores from sensed state (vision, helper check-ins,
  consumable depletion, schedule cadences).
- Pre-confirmed weekly plans (the owner approves once, the system runs the
  week).
- Just-in-time nudges: surface a chore only when (a) it's actionable, (b)
  the relevant helper/supply/condition is present, (c) skipping it incurs
  cost.
- Aggressive dedup, conflict resolution, and auto-rescheduling around
  helper leave / weather / festivals.

**Hard requirement:** every push notification or chat prompt must have a
demonstrable cognitive-cost justification — *"this is something the owner
would have had to remember themselves."* No notification spam.

## O2. Generate community-level demand signal from geo-fenced households

Each household's private state aggregates into a **community signal** scoped
to a housing society / apartment complex / gated community. Signals are
**opt-in**, anonymized at the individual-household level, and surface
collective need:

- *"7 homes in your block need plumbing in the next 14 days"*
- *"23 homes are due for solar panel washing this month"*
- *"4 homes report low water-purifier filter level — bulk buy opportunity"*

Signals must be **cryptographically aggregated** so no single household's
state is exposed to neighbors or service providers without explicit consent.

## O3. Auto-generate signals via vision + tracking

Owners should not type these into the system. Sources:

- **Vision (consumables):** phone camera, smart-shelf cameras, or fridge
  cameras detect depletion of household supplies (rice, oil, detergent,
  water-purifier filters, gas cylinders).
- **Vision (condition):** detect deferred maintenance — solar panel grime,
  paint peeling, plumbing leaks, electrical fixture corrosion, bicycle
  chain rust, terrace cushion fade.
- **Schedule cadence:** time-based triggers for deep clean, painting cycle,
  water tank cleaning, pest control.
- **Helper check-ins:** what was actually done vs. what was planned,
  feedback loop into the next cycle.
- **Aggregator data (read-only):** import known service intervals from
  manufacturer manuals (e.g., "RO filter every 6 months").

Vision pipeline must run **on-device** by default; cloud only with explicit
opt-in. No raw images leave the home.

## O4. GST aggregation on maintenance services — **ON HOLD**

> **Status: ON HOLD.** This objective is parked — no active research, no
> implementation, no phase commitment. Documented here so we don't lose
> the idea, and so any future revisit starts from the same hypothesis
> instead of re-deriving it. The interim value lever for the marketplace
> (O5) is **transparent bulk pricing**, not tax-credit aggregation.

**Original hypothesis (parked):** maintenance services delivered to a
housing society today are billed individually per household with full GST
charged on each invoice, even though the underlying service is identical
and the demand is co-located. If HomeOps aggregates the demand and routes
it as a single B2B procurement on behalf of the society, GST may be
claimable as input credit by the society (or by registered owners),
reducing the effective service cost.

**If/when this is revived**, the gating questions are:
- Legal opinion on whether bundled household services can be invoiced to a
  society as input credit-eligible expenses under Indian GST law.
- Tax structure for the marketplace itself (commission vs. agency model).
- Whether individual households are eligible for input credit; behavior
  with composition-scheme providers.
- How RWAs / housing societies treat such pass-through billing today.

Until then, the marketplace (O5) operates without any GST optimization
plumbing — the interim API/dashboard exposes demand aggregation and
transparent bulk pricing only.

## O5. Bid → procurement → quality-rated marketplace

Replace the take-rate-extracting horizontal aggregators with a transparent
local marketplace:

1. **Demand surfaces** as an aggregated community signal (from O2/O3).
2. **Vetted local providers** receive the signal and bid (price + ETA +
   warranty).
3. **Society / household selects** based on bid + historical rating + local
   reputation.
4. **Service is performed** with helper check-in + photo verification.
5. **Both sides rate**: householders rate the provider, providers rate the
   site (access, payment, behavior).
6. **Ratings are portable** — providers carry their reputation across
   communities; bad actors lose access network-wide.

Anti-monopoly properties:
- Open bidding (no preferred-provider gatekeeping).
- Public price history per category per region.
- No exclusivity contracts.
- API-accessible — micro-startups can build vertical specializations
  (solar, plumbing, painting) on top of the same marketplace.

# Success Metrics

| Objective | Metric | v1 target |
|---|---|---|
| O1 (cognitive load) | **Cognitive-load reduction rate** = # of chore-related decisions in a week where HomeOps did the cognitive work (silent auto-handle or single-tap acknowledgement of a fully pre-computed decision) ÷ total chore-related decisions in that week. Classifier spec is locked — see the note below the table. | **Phased**: ≥ 45% by end of Phase 1 · ≥ 55% by end of Phase 2 · ≥ 65% by end of Phase 3 · ≥ 70% by end of Phase 4 (per onboarded household, rolling 4-week window) |
| O1 | % of recurring chores auto-scheduled without owner input | ≥ 80% by end of Phase 2 |
| O2 | # of opted-in households per community | ≥ 30% of a pilot society |
| O2 | # of community signals generated per week | tracked, no target |
| O3 | % of new chores created via sensed signal vs. manual entry | ≥ 50% by end of phase 2 |
| O3 | False-positive rate of vision detection | ≤ 10% (else owner trust erodes) |
| O4 | — | **on hold, no metric tracked** |
| O5 | # of vetted providers per community | ≥ 5 per category (else no real competition) |
| O5 | Median bid-to-acceptance time | ≤ 24h |
| O5 | Provider rating distribution | Healthy spread, not concentrated at 5★ |
| **H1** (helper check-in adoption) | % of active helper-household relationships with at least one check-in (photo / thumbs-up / voice) per scheduled day | ≥ 70% by end of Phase 1 · ≥ 85% by end of Phase 2 |
| **H2** (compensation ledger adoption) | % of households with at least one helper that have an active tracking-only compensation ledger (≥1 entry in last 30 days) | ≥ 50% by end of Phase 1 · ≥ 75% by end of Phase 2 |
| **H3** (multi-household opt-in — the network-effect wedge) | % of eligible helpers (those working ≥ 2 HomeOps households) who have opted into multi-household coordination | ≥ 30% by end of Phase 3 · ≥ 60% by end of Phase 4 |
| **H4** (helper voice — bidirectional rating coverage) | % of helper-household relationships with at least 1 helper-side rating event in the last 30 days | ≥ 60% by end of Phase 4 |
| **H5** (privacy SLA — helper data export) | Median time from helper data-export request to delivery | ≤ 7 days, with hard ceiling at 14 days |
| **H6** (helper conflict resolution) | % of multi-household scheduling conflicts resolved by the helper without manual escalation | ≥ 80% by end of Phase 3 |
| **H7** (onboarding completion rate) | % of helper invites sent in Stage 1 that are completed by the helper in Stage 2 within 14 days | ≥ 50% by end of Phase 1 · ≥ 70% by end of Phase 2 |
| **A1** (assignment automation) | % of recurring chores assigned via one-tap approval or silent auto-assignment (vs. manual) | ≥ 60% by end of Phase 1 · ≥ 80% by end of Phase 2 |
| **A2** (rules engine accuracy) | % of auto-assignments NOT overridden by the owner within 7 days | ≥ 80% by end of Phase 1 (proxy for "the elicited rules actually match the owner's intent") |
| **A3** (silent auto-assignment graduation) | % of households where at least one chore type has graduated from one-tap to silent auto-assignment | ≥ 30% by end of Phase 1 · ≥ 60% by end of Phase 2 |
| **A4** (learning loop acceptance) | % of "I noticed you prefer X" nudges accepted by the owner | ≥ 50% (proxy for "the override-detection threshold is right") |

**Note on the O1 metric:** every chore-related decision in a week is
classified into one of two buckets — *load-reducing* (HomeOps did the
cognitive work and the owner either never saw it or only had to
acknowledge with a single tap) or *full-effort* (owner had to think,
choose, edit, override, or initiate the action themselves).
Instrumentation lives in the personal layer and emits a per-decision
classification event so the ratio can be computed without owner
self-report.

**Why the target is phased, not flat 70%:** even with tap-to-confirm
counted as load-reducing, the bottleneck is real. Phase 1's levers
(pre-confirmed weekly plans, auto-rescheduling) only shift the part of
the workload that's already system-tracked — chores the owner already
knows about. The bigger wins come from removing decisions the owner
*didn't even know they had*: sensing-driven chore creation in Phase 2,
community-level batching in Phase 3, and silent marketplace bookings in
Phase 4. The phased schedule expects:

- **Phase 1 → 45%**: pre-confirmed weekly plans + auto-rescheduling
  around helper leave + smarter notification gating + tap-to-confirm
  acknowledgements all contribute the first wave of load-reducing
  events. The owner taps once per week to accept a pre-computed plan
  rather than scheduling each chore individually.
- **Phase 2 → 55%**: sensing-driven chore creation (vision +
  consumable depletion + condition tracking) replaces a large chunk of
  manual entry — these never surface as decisions at all.
- **Phase 3 → 65%**: community signals let the system bundle and
  schedule recurring society-wide work without per-household prompts.
- **Phase 4 → 70%**: marketplace bookings flow through silently when
  trusted providers + standing approvals exist. The +5 ceiling is
  intentionally narrow — the last ten points are the hardest because
  they require system trust the owner won't override.

If a phase ships and the cohort doesn't reach the phase target, the
phase is **not done** (see Definition of Done) — we hold and iterate
on the levers in that phase before moving to the next.

**Classifier spec (locked — instrumentation must follow these rules):**

1. **Denominator = total throughput** — the denominator counts *every*
   chore-related decision in the week, including ones HomeOps handled
   silently without ever surfacing them to the owner. This is the honest
   throughput count, not the perceived count. The system is not allowed
   to inflate its own ratio by hiding work from the owner; silent
   auto-handles count in both numerator and denominator.

2. **Owner overrides = full-effort** — when HomeOps auto-decides
   something and the owner overrides it (rejects, edits, reschedules,
   re-assigns), that decision is classified as *full-effort*, not
   load-reducing. The override itself is the cognitive work the owner
   had to do, regardless of how much the system pre-computed. This rule
   intentionally pushes the agent toward conservative auto-decisions —
   if the system overreaches, the metric punishes it.

3. **One-tap confirms = load-reducing** — a single-tap acknowledgement
   on a fully pre-computed decision counts as load-reducing. The owner
   didn't have to think, choose, schedule, or remember — they just
   verified and accepted. The cognitive work was done by the system; the
   tap is a passive acknowledgement. (Multi-step approvals or any
   decision requiring the owner to *choose between options* are still
   full-effort — see rule #2.)

4. **Dismissed nudges = not counted** — if the owner dismisses a nudge
   without acting on it, that event is **not counted in either bucket**
   (numerator or denominator). Dismissal is signal that the nudge
   shouldn't have fired; we don't want it inflating the denominator and
   we don't want to score it as load-reducing either.

5. **Batched decisions count as N** — when a single owner action approves
   N items (e.g., one tap confirms 5 chores at once), the metric emits
   **N events**, not 1. Each event is classified individually per the
   rules above. Combined with rule #3, batching N pre-computed decisions
   into a single tap contributes **N load-reducing events** — the system
   does get full metric credit for batching, since each batched item was
   genuinely a decision the owner would otherwise have made one at a
   time.

6. **Helper-side inputs are out of scope** — when a helper checks in,
   marks a chore done, or reports a problem, those events are *helper
   actions*, not *owner decisions*. They do not enter the O1 metric in
   either bucket. The metric only counts decisions the owner faced.

**Owner-initiated actions** (creating a new chore, manually editing an
existing one, asking a question via chat) are **full-effort** events in
both numerator and denominator, since the owner did the cognitive work
themselves. Rule #3's load-reducing exception only applies to
*system-initiated* decisions the owner taps to acknowledge — it does
not apply to actions the owner started on their own.

# Subsystems

## Personal layer (existing — chores agent)
- Status: live (see [chores.agent.manifest.md](chores.agent.manifest.md)).
- Owner-facing chat agent, deterministic intent extraction, preview-and-
  confirm flow, semantic chore matching, helper management, helper daily
  view, coverage planner.
- This manifest **must not regress** anything in the chores manifest.

## Sensing layer (new — phase 2)
- On-device vision pipeline for consumables and conditions.
- Schedule-cadence engine (already partially exists in
  `src/app/services/choreScheduler.ts` — extend).
- Helper check-in pipeline (already exists — extend with photo capture).
- Privacy boundary: raw frames never leave device; only structured
  events ({type, confidence, timestamp}) reach the server.

## Aggregation layer (new — phase 3)
- Per-household signals → per-community rollup with k-anonymity (suppress
  any rollup with fewer than k=5 contributing households).
- Opt-in registry per signal type per household.
- Time-windowed aggregation (daily, weekly, monthly).

## Marketplace layer (new — phase 4)
- Provider directory with vetting workflow.
- Bid/auction engine (RFQ-style, time-bounded).
- Rating system (bilateral, weighted by recency).
- Dispute resolution hooks.
- Open API for third-party access (rate-limited, authenticated).

## Compliance layer — **deferred (O4 on hold)**
- Not in any current phase. Documented for future revival only.
- If revived, scope: GST input-credit aggregation, society-level
  invoicing workflow, tax compliance reporting per provider.
- The marketplace (O5) operates without this layer in the meantime.

# Helpers as first-class participants

This section is its own top-level concern because helpers — cleaners,
cooks, gardeners, drivers, security staff — are the people who actually
run the house day-to-day. The chores manifest currently treats helpers
as resources that the agent assigns work to. That framing is incomplete
and, long-term, leaves the highest-leverage product surface
unaddressed. Helpers are first-class users of HomeOps with their own
needs, their own cognitive load, their own welfare considerations, and
their own data rights. The objectives in this section are
complementary to O1–O5, not subordinate to them.

## Framing

A helper is a person, not a resource record. The product must:

- Treat the helper as a named individual with continuity across time,
  not as an interchangeable slot on a schedule.
- Recognize that helpers carry their own context (which house, which
  tools, which day, which family preferences) and that this context is
  cognitive work *for the helper*, not just for the owner.
- Acknowledge the asymmetry: helpers typically have less digital
  literacy, less English fluency, less device autonomy, and less
  bargaining power than the owners they work for. Product decisions
  must not amplify that asymmetry.
- Build for **mutual benefit**, not owner-only benefit. A feature that
  helps the owner at the helper's expense (e.g., surveillance, unpaid
  micro-tasks, opaque scheduling) is out of scope on principle, not
  just on feasibility.

## Helper lifecycle

The full arc of a helper's relationship with a household, all
representable in the data model and the UI:

1. **Discovery** — a household needs a helper; a helper is looking for
   work. Today this happens via word-of-mouth, agencies, or apps like
   Urban Company. HomeOps doesn't intermediate this in v1 (see
   "Relationship to O5" below) but it must accept helpers brought in
   through any channel.
2. **Onboarding** — name, phone, role(s), photo, languages spoken,
   preferred communication channel (WhatsApp / voice / SMS), days and
   hours, scope of work. Optional: ID verification (Aadhaar /
   government ID), prior references, skill tags.
3. **Ongoing operations** — the helper does work, the owner reviews,
   both sides give feedback. The chores agent already covers this
   surface; this section extends it.
4. **Time off / leave** — already supported in `member_time_off`. Must
   integrate cleanly with the auto-rescheduling lever from O1.
5. **Replacement / temporary cover** — when a helper is unavailable for
   a planned period, the system must support assigning a temporary
   substitute without losing the original helper's history or
   reassigning their permanent schedule.
6. **Off-boarding** — a helper leaves. Final settlement of pending
   compensation (tracking-only, see below), archival of history,
   handover notes for the next helper. The history must remain visible
   to the household for continuity but must be subject to the helper's
   data-export and erasure rights.

## Helper-facing interface

Most helpers in Indian households cannot use a typical English text
dashboard. The helper-facing surface must be designed for low literacy,
multilingual support, and constrained devices.

- **Channels (in priority order):** WhatsApp first (photos, voice
  notes, simple text), then voice via phone call, then SMS, then a web
  app as a fallback for helpers who request it.
- **Content modalities:** photo-of-task and voice instruction take
  priority over text. *"Clean the room shown in this photo"* is a
  better instruction than *"Clean the master bedroom"* for a helper who
  doesn't read English.
- **Languages:** match the helper's preferred language. Indian
  households commonly involve helpers speaking Kannada, Hindi, Tamil,
  Telugu, Malayalam, Bengali. The translation work in [src/app/i18n.tsx](src/app/i18n.tsx)
  is the foundation, but the helper-facing interface needs additional
  vocabulary (task descriptions, schedules, payments) that's
  domain-specific.
- **Check-in flow:** the helper marks tasks done with a photo (proof
  of completion), a thumbs-up, or a voice note. No multi-step forms.
- **No assumption of always-on data:** helpers may have intermittent
  connectivity. The interface must work offline and sync when
  connected.

## Helper onboarding flow

A two-party split flow that mirrors the existing user onboarding
wizard ([OnboardingFlow.tsx](src/app/components/onboarding/OnboardingFlow.tsx))
but acknowledges that the owner and the helper are different
participants with different consent requirements. Helper-side fields
are captured from the helper themselves, never filled in by the owner
on their behalf.

**Stage 1 — Owner-driven wizard (in-app)**

The owner adds a helper through a multi-step Stepper wizard, similar
in shape to the existing user-onboarding flow. The owner enters only
the basics:

- Name
- Phone (used to send the Stage 2 invite via WhatsApp)
- Role(s) — cook, cleaner, gardener, driver, security, etc.
- Days and hours
- Scope of work / responsibilities
- Salary (creates the first entry in the tracking-only compensation
  ledger)

On submit, the helper record is saved with status
`pending_helper_completion` and a WhatsApp message is sent to the
helper containing a magic link.

**Stage 2 — Helper-driven (WhatsApp + lightweight web link)**

The helper opens the magic link on their phone and completes the
helper-side fields:

- Preferred language (from a short list — sets the language for all
  future helper-facing communication)
- Profile photo (optional, helper can skip)
- ID verification consent (optional — helper can decline; the system
  must keep working without it)
- **Vision-camera opt-out** (default: **opted out** — vision frames
  must not capture this helper unless they explicitly opt in)
- **Multi-household coordination opt-in** (default: **off** — helper
  must explicitly enable it)
- Preferred communication channel (WhatsApp default, with phone call
  / SMS as alternatives)

Stage 2 takes ~2 minutes and is voice/photo-friendly so it works for
helpers with low literacy.

**Async completion handling**

Helpers may not complete Stage 2 immediately, or at all. The system
must degrade gracefully:

- If Stage 2 is incomplete after **7 days**, the owner gets a single
  reminder nudge ("your helper hasn't finished onboarding yet — would
  you like to resend the invite?"). After that, no further nudges.
- **Sane defaults** apply for any field the helper never completes:
  preferred language = household's default UI language, ID verification
  = none, vision opt-out = ON (camera will not capture them), multi-
  household coordination = OFF, channel = WhatsApp.
- The helper can complete or update *any* field at *any* time later
  via a stable link the system sends them on request.
- Owners must **never** be able to fill in helper-side fields on the
  helper's behalf. The data model rejects owner-initiated writes to
  those fields.

**Helper opt-out paths**

- The helper can decline the invite entirely. The household record
  stays (the owner still needs to schedule chores) but is flagged as
  *"helper not onboarded — operating with default consents."* Defaults
  always favor the helper (vision off, multi-household off, no ID
  verification).
- The helper can revoke individual consents later (vision opt-in,
  multi-household coordination, etc.) and the system honors the
  revocation immediately for all future events.
- The helper can request data export and erasure at any time, subject
  only to retention of pending compensation records (see Privacy &
  dignity above).

**Hard rules (locked)**

- Helper-side consent fields can only be set by the helper themselves.
- ID verification is opt-in, never required by the system to function.
- Vision capture default is **opt-out** (helper consent required to
  appear in any vision frame).
- Multi-household coordination default is **off**.
- The owner-facing Stage 1 wizard cannot proceed without entering at
  minimum: name, phone, and at least one role. All other Stage 1
  fields are optional and can be edited later.

## Multi-household coordination (helper-controlled)

This is the highest-leverage network effect in the entire manifest.
Most helpers in Indian metros work 4–6 households across the day.
Today, each household runs its own scheduling on its own — the helper
mentally juggles all of them. This is where HomeOps can deliver
**helper-side cognitive load reduction**, which then drives helper
adoption, which then makes the platform stickier for households.

**Locked design (per the design choice resolved before this section
was written):**

- **Opt-in, helper-controlled.** The helper chooses whether to enable
  multi-household coordination. Default is off. The helper can toggle
  it per-household.
- **The helper sees their own cross-household schedule.** When the
  helper opens the helper app, they see today's full day across all
  enabled households — *"7am–8am Sharma, 8:30am–10am Iyer,
  10:30am–12pm Reddy"* — with each task pre-assigned.
- **Employers stay invisible to each other.** Households that share a
  helper see only their own schedule. They do not see which other
  households the helper works at, what tasks are scheduled there, or
  any other identifying detail. The helper is the only party with the
  cross-household view.
- **Conflict resolution.** If two households schedule the same helper
  for overlapping times, the system flags the conflict to the helper
  (only). The helper resolves it by choosing which household to honor;
  the other household sees only that *"the helper has flagged this
  slot as unavailable — please reschedule or arrange a substitute."*
  The losing household never learns *why*.
- **Helper's identity & contact across households is not aggregated.**
  Each household's record of the helper stays local to that household;
  only the *helper themselves* sees the union, and only after opt-in.

This design protects helper autonomy and household privacy
simultaneously. The helper is the bridge; the system is the schedule
optimizer behind the bridge.

## Compensation, welfare & compliance

**Locked design (per the design choice resolved before this section
was written): tracking-only.** HomeOps records compensation and welfare
events as a shared source of truth between the owner and the helper.
HomeOps does **not** move money, hold money, process payments, issue
tax receipts, or take any action that would require FinTech licensing,
RBI registration, or money-transmitter compliance. Money flows outside
HomeOps via whatever channel the owner and helper already use (cash,
UPI, bank transfer).

What the tracking-only system captures:

- **Salary** — agreed monthly amount, currency, effective date,
  revisions over time.
- **Advances** — date, amount, marked as "given by owner" / "received
  by helper", reason if any.
- **Bonuses** — festival bonuses (Diwali, Onam, Pongal etc.), one-off
  incentives, ad-hoc gifts. Both sides can record.
- **Leave balance** — paid leave taken vs. earned vs. owed.
- **Settlement on departure** — final amount due, items returned,
  acknowledgement from both sides.
- **Compliance flags (advisory only)** — minimum wage per state, PF /
  ESI applicability where formal employment thresholds are met. These
  are surfaced as nudges to the owner, never enforced. HomeOps is not
  a compliance-as-a-service product.

What is explicitly not in scope:
- Holding money in escrow.
- Payment processing or routing.
- Filing tax returns or generating Form 16 / similar.
- Auto-deducting amounts from owner accounts.
- Any feature that requires becoming a "payment system" under RBI
  rules.

The bidirectional ledger (both sides can record entries; both sides
see the same view) is the trust mechanism. Disputes show up as
mismatched entries and can be resolved between the two parties without
HomeOps adjudicating.

## Trust & quality (bidirectional)

Mirrors the marketplace rating system from O5, but applies to the
ongoing personal helper relationship rather than per-RFQ provider
work.

- **Owner → helper feedback** — quality of work, attendance,
  reliability, attitude. Already partially supported via
  `helper_feedback`. Must remain *within the household* by default;
  not aggregated across households without helper opt-in.
- **Helper → owner feedback** — was access provided on time, was
  payment timely, was the workspace safe and respectful, were
  unreasonable demands made. The helper rates the household.
- **Both sides see both directions.** A household with a 2-star helper
  rating from past helpers should know that. A helper considering a
  new household should know its rating. Symmetry is the trust
  mechanism.
- **Aggregated reputation only with explicit per-side opt-in.** A
  helper can choose to make their rating portable across HomeOps; a
  household can choose the same. Default is local to the relationship.
- **Recency-weighted.** Old ratings decay; both sides have a chance to
  improve.

## Privacy & dignity

Helpers are the most privacy-sensitive group in the system because
they are physically present in homes that may contain cameras, smart
shelves, and other sensors. The product must protect them from
becoming surveillance subjects.

- **Vision pipelines must not be used for helper monitoring.** The
  vision layer (O3) is for consumables and conditions, not for
  watching helpers. Cameras must not be used to verify whether a
  helper showed up, how long they stayed, or what they did, unless the
  helper has explicitly consented.
- **On-device processing is non-negotiable** for any feed that could
  capture a helper. Even with consent, raw frames never leave the
  device.
- **Helper has agency over their own data.** The helper can request
  export of all data the system holds about them, and can request
  erasure (subject to a household's right to retain pending
  compensation records — that's a lawful basis exception, not a
  blanket loophole).
- **No covert tracking.** Geofencing, phone-location tracking, "did
  the helper come on time" passive monitoring — all of this is out of
  scope unless the helper opts in for their *own* benefit (e.g., a
  helper opting in to commute-time tracking so the system can warn
  households of unavoidable delays).
- **Voice and image content** generated by helpers (check-in photos,
  voice notes) is owned by the helper and visible only to the
  household it was created for, never aggregated.

## Relationship to O5 (marketplace)

The marketplace (O5) and the helpers section are different products
serving different needs:

| | Marketplace (O5) | Helpers section |
|---|---|---|
| Who participates | Service businesses (companies) | Individual people |
| Engagement model | Per-job RFQ + bid + rate | Long-term recurring relationship |
| Discovery | Open to any vetted bidder | Owner brings their own helper, or word-of-mouth |
| Compensation | Per-job, settled via marketplace flow | Monthly salary, tracked-only, paid outside HomeOps |
| Reputation | Portable across communities by default | Local to each relationship by default; portable only with helper opt-in |
| Privacy posture | Provider-side data is somewhat public (so households can choose) | Helper-side data is private by default |

**Helpers are not in the marketplace, and marketplace providers are
not helpers.** Conflating them would put individual workers into a
race-to-the-bottom bidding system, which contradicts the dignity
principle above. If a helper wants to advertise their availability to
new households, that's a separate (out-of-scope-for-v1) feature, not
the marketplace surface.

# Chore management

This section captures chore-management capabilities at the *system*
level — beyond the per-chore CRUD contract documented in
[chores.agent.manifest.md](chores.agent.manifest.md). It's organized
as a set of **scopes** (Assignment, Scheduling, Completion
Verification, Recurrence/Templates, Conflict Resolution). v1 only
fleshes out the **Assignment** scope; the others are listed as
placeholders so the structure is open for incremental expansion.

## Scope: Assignment

Assignment is the bridge between chores and helpers. Today it's a
manual `helper_id` field on the chores table, populated either via
the chat agent or the chores UI. This scope makes assignment a
first-class capability with multiple operating modes, a deterministic
rules engine, learning from owner overrides, and explicit O1
classification rules for every assignment event.

### Pattern elicitation (locked for v1)

Before any auto-assignment runs in a household, the agent runs a
**pattern elicitation conversation** with the owner. This is a
chat-driven dialog (matches the rest of the product's agent-first UX,
not a form), and it builds a per-household `assignment_rules` object
that drives the rules engine.

The agent asks clarifying questions about:

- Preferred helper for kitchen tasks (cooking, cleaning, dishwashing)
- Preferred helper for outdoor tasks (gardening, sweeping, deck/terrace)
- Preferred helper for cleaning tasks (rooms, bathrooms, common areas)
- Any chore-type → helper exclusions (*"don't assign cooking to
  Rajesh"*)
- Helper capacity preferences and limits (max hours/day per helper)
- Standing scheduling preferences (*"always do deep clean on
  Saturdays"*)
- Special handling for high-priority tasks

When elicitation runs:

- **Onboarding**: triggered as the final step after at least one
  helper has been added (Stage 1 of helper onboarding). The owner can
  skip and rely on one-tap approval for a while.
- **New helper added**: incremental questions about that specific
  helper's specialties, asked once when the helper enters
  `pending_helper_completion` or `active`.
- **Just-in-time**: when a new chore type appears that doesn't match
  any existing rule, the agent asks once for that chore type instead
  of guessing.

Elicitation answers are stored as structured rules and can be edited
or replaced at any time via chat or a settings panel.

### Operating modes (confidence-graduated)

A given chore is assigned in one of three modes, **chosen by the
system based on rule confidence**, not by global toggle:

1. **Manual** — when no rule matches and the owner hasn't approved a
   recent similar assignment. The agent surfaces the chore as
   unassigned and asks the owner to choose. Counts as full-effort.
2. **One-tap approval** — when partial rules apply (e.g., role matches
   but capacity is borderline) or when this is a chore type the owner
   has only tapped a few times. The agent proposes an assignment with
   a single tap to confirm. Counts as load-reducing per O1 rule #3.
3. **Silent auto-assignment** — when all rules cleanly apply *and* the
   owner has confirmed similar proposals at least 5 times without
   override. The system assigns silently; the owner sees the result
   in the daily view but is never prompted. Counts as load-reducing
   per O1 rule #1.

This confidence ramp is intentional: the system never goes silent
until the owner has demonstrated trust by repeatedly approving
similar proposals. New households start in mostly one-tap mode and
graduate to silent assignments as patterns stabilize.

### Rules engine

The rules engine is **deterministic** in v1 (no ML, no embeddings).
It scores candidate helpers for each chore using these inputs in
priority order:

1. Per-household assignment rules from elicitation (highest weight)
2. Helper role tags (cook / cleaner / gardener / driver / security)
3. Helper capacity (`daily_capacity_minutes` minus already-assigned
   work for that day)
4. Helper time-off (`member_time_off`) — hard exclusion during planned
   absence
5. Helper preferences captured from the helper side (lower weight, but
   non-zero)
6. Chore metadata (`space`, `cadence`, `estimated_minutes`, `priority`)

If multiple helpers qualify, the engine prefers (in order):

1. Helper explicitly mapped to this chore type by owner rules
2. Helper with the most recent successful completion of this chore type
3. Helper with the most available capacity today
4. Helper with the longest tenure in this household (stability bias)

If **no** helper qualifies, the chore stays unassigned and surfaces
to the owner as a manual decision. The system never auto-assigns by
guessing.

### Learning from overrides

When the owner overrides an auto-assignment or one-tap proposal, the
override is recorded as a training signal. The system **does not
silently shift weights**. Instead:

- After **3 consistent overrides** for the same `(chore_type,
  preferred_helper)` pattern, the agent surfaces a transparent nudge:
  *"I noticed you've assigned the kitchen clean to Rajesh the last 3
  times instead of Sunita. Should I make Rajesh the default for
  kitchen tasks?"*
- The owner can: **accept** (rule is added to elicitation table),
  **decline** (the system stops asking about this pattern for 30
  days), or **accept with conditions** (*"only on weekdays"* — the
  rule is added with a time qualifier).
- Declined nudges are not surfaced again for the same `(chore_type,
  helper)` pattern for 30 days.
- **Every learned preference must be explicitly confirmed by the
  owner.** The system never silently shifts behavior based on
  override history.

This rule keeps the learning loop transparent: the owner always
knows why the system is making a particular choice, and they always
have to consent to behavioral changes.

### Reassignment on absence

When a helper is on planned leave (`member_time_off`), affected
chores auto-reassign per the rules engine the moment the leave is
recorded. Reassignment behavior:

- If a clear rule-based replacement exists, the reassignment is
  **silent** (load-reducing).
- If multiple replacements qualify, **one-tap approval** of the
  proposed substitute.
- If no replacement qualifies, the chore is flagged for owner
  attention with options to: (a) reschedule to after the helper
  returns, (b) manually assign someone else, (c) skip the chore for
  this cycle.

### Bulk assignment

Owners can select N chores in the daily view (or the chores list)
and assign all to one helper in a single action. Counts as **N
load-reducing events** per O1 rule #5 — each chore is a separate
underlying decision, unified by one tap.

### Multi-household conflict resolution

When a helper is opted into multi-household coordination (see
helpers section), the assignment engine must respect their
cross-household schedule. If two households would book the same slot:

- **Helper's manual choice always wins** (locked design from
  helpers section).
- If the helper hasn't actively chosen between conflicting requests,
  **FIFO** is the tiebreaker — first booking wins.
- The losing household sees only *"the helper has flagged this slot
  as unavailable — please reschedule or arrange a substitute."* They
  never see why or which other household is involved.
- The assignment engine for the losing household automatically tries
  to find a replacement helper or proposes rescheduling, in line with
  the reassignment-on-absence flow above.

### Hard rules (locked)

- **Pattern elicitation runs before any auto-assignment** in a new
  household. Owner can skip; the system defaults to one-tap mode in
  that case.
- **Manual mode must always remain available** as a fallback, even
  for households that have graduated to silent auto-assignment.
- **Owner overrides always work** and are recorded as training
  signals (subject to the explicit-confirmation rule).
- **Learned preferences require explicit owner confirmation** —
  system never silently shifts weights.
- **Multi-household conflicts**: helper choice always wins.
- **No helper qualifies → manual decision**: the system never
  guesses an assignment.

### O1 classification of assignment events

Per the locked classifier rules in the O1 metric note:

| Assignment event | Classification |
|---|---|
| Manual assignment by owner | **full-effort** (rule #2) |
| One-tap approval of a system proposal | **load-reducing** (rule #3) |
| Silent auto-assignment (no owner action) | **load-reducing** (rule #1) |
| Auto-assignment + owner override | **full-effort** (rule #2 — override is the work) |
| Bulk assignment of N items in one tap | **N load-reducing events** (rule #5) |
| Pattern elicitation answers during onboarding | **full-effort** (owner did the cognitive work) |
| Reassignment on absence (silent, rule-based) | **load-reducing** (rule #1) |
| Reassignment on absence (one-tap proposed) | **load-reducing** (rule #3) |

Pattern elicitation is intentionally classified as full-effort even
though it's a one-time cost. The owner *is* doing cognitive work
during elicitation. The justification for the cost is that each
elicitation answer unlocks **many** future load-reducing events,
making the long-term ratio more favorable. The cost is real, the
amortization is the payoff.

## Other scopes (placeholders for future passes)

- **Scope: Scheduling** — when chores fire, calendar conflict
  detection, weather-aware rescheduling, helper schedule alignment.
- **Scope: Completion verification** — photo proof, helper check-in
  cadence, anomaly detection (chore marked done in 30 seconds when
  it usually takes 30 minutes).
- **Scope: Recurrence and templates** — chore templates, recurrence
  rules, template library per home type.
- **Scope: Conflict resolution beyond multi-household** — overlapping
  chore requirements, contradictory owner instructions, helper
  capacity overflow.

These are deliberately left as placeholders. The Assignment scope is
the v1 priority because it's the load-bearing piece for both helper
participation and the O1 metric.

# Phased Rollout

## Phase 0 — Live today
- Personal chores agent (see chores manifest)
- Helper management, daily view, coverage planner
- Chat-based interaction with preview/approve flow
- **Helpers**: helpers table, time off, daily capacity, owner→helper
  feedback, chat-based assignment

## Phase 1 — Cognitive-load reduction (current quarter)
- Pre-confirmed weekly plans
- Auto-rescheduling around helper leave
- Smarter notification gate (cognitive-cost justification per nudge)
- **Per-decision classification instrumentation** so the O1 ratio
  (load-reducing decisions ÷ total decisions) can be computed
  automatically per household per week
- Baseline measurement: 4-week rolling window before any new
  load-reducing feature ships, so we can attribute each shipped lever
  to its delta on the ratio
- **Helpers (critical path — phase metric won't move without these):**
  - **Helper onboarding split flow**: owner-driven Stage 1 wizard
    (mirrors the existing user-onboarding Stepper pattern) +
    helper-completed Stage 2 via WhatsApp magic link. See "Helper
    onboarding flow" subsection in the helpers section for the locked
    field split, default-consent rules, and async completion handling.
  - Helper-facing check-in flow (photo + thumbs-up + voice note,
    delivered via WhatsApp as the primary channel)
  - Tracking-only compensation ledger MVP: salary, advances, leave
    balance, bidirectional entries (first salary entry is created in
    Stage 1 of the onboarding flow)
  - Helper preferred language captured during Stage 2 of onboarding
    and used for all helper-facing messages (leveraging the
    [src/app/i18n.tsx](src/app/i18n.tsx) work)
  - WhatsApp notification channel for helpers (one-way push for v1,
    plus the bidirectional Stage 2 onboarding link)
- **Chore assignment (critical path — also blocks the phase metric):**
  - **Pattern elicitation conversation**: chat-driven dialog after
    helper onboarding that builds the per-household
    `assignment_rules` object. See "Chore management → Scope:
    Assignment" for the locked design.
  - **Deterministic rules engine** (no ML in v1) that scores
    candidate helpers using rule weights, role tags, capacity, and
    time-off
  - **Confidence-graduated operating modes**: manual → one-tap
    approval → silent auto-assignment, promoted automatically as the
    owner approves similar proposals
  - **Reassignment on absence**: when a helper is on planned leave,
    affected chores auto-reassign per the rules engine
  - **Override-tracking + transparent learning nudge**: 3 consistent
    overrides → agent asks if the new pattern should become the
    default. No silent weight shifting.
  - **O1 classification events** for every assignment, override, and
    bulk action, so the assignment surface contributes correctly to
    the cognitive-load reduction metric

## Phase 2 — Sensing layer
- On-device vision MVP for one consumable category (e.g., RO filter level)
- Helper check-in photo capture
- Auto-chore creation from sensed events
- Calibrate false-positive rate before expanding categories
- **Helpers:**
  - Photo-of-task instruction generation: when a chore has a
    location/object captured by sensing, pass that image to the
    helper as the instruction instead of a text description
  - Explicit guardrail: vision events tagged "helper present" are
    discarded, never stored — sensing must not become surveillance
  - Compensation ledger: festival bonus + ad-hoc entry support

## Phase 3 — Community aggregation
- Single pilot society, opt-in
- k-anonymity rollup with k=5
- Signal feed (read-only) for the society admin
- Validate "30% opt-in" target before expanding
- **Helpers (the network-effect wedge):**
  - Multi-household coordination opt-in flow (helper-controlled,
    employers stay invisible to each other — see helpers section)
  - Helper's own cross-household daily schedule view
  - Conflict detection + helper-side resolution
  - This phase's success depends on helper opt-in as much as on
    household opt-in — track both metrics independently

## Phase 4 — Marketplace MVP
- Vetted-provider onboarding for 1-2 categories (start with high-volume,
  low-dispute categories like deep cleaning or solar washing)
- RFQ + bid + rate flow
- Public API (rate-limited)
- No GST optimization yet — simple commission or flat fee
- **Helpers:**
  - Bidirectional ratings: helper rates household (timely payment,
    safe workspace, reasonable demands), recency-weighted, default
    local to the relationship
  - Off-boarding / settlement workflow: final compensation
    reconciliation, handover notes, mutual acknowledgement
  - Helper-controlled portable reputation: opt-in to make their
    rating visible to new households (still does NOT enroll them in
    the marketplace bidding system)

## Phase 5 — **Removed (O4 on hold)**
- No phase 5 in this version of the manifest. The marketplace (Phase 4)
  is the terminal phase and uses transparent bulk pricing as its value
  lever instead of any GST optimization. If O4 is ever revived, a new
  phase will be added at that time.

# Hard Constraints

## Privacy
- Vision frames never leave the device unless the owner explicitly opts in.
- Per-household state never exposed to neighbors or providers without
  consent.
- k-anonymity rollups (k ≥ 5) for all community signals.
- Right to export and delete all data.
- No third-party tracking pixels, no behavioral ad surfaces.

## Backwards compatibility
- Must not change `chores.status`, `chores.due_at`, or `chores.metadata`
  semantics.
- Must not break the existing chat agent contract (see chores manifest).
- New tables and RPCs only; no destructive migrations on existing tables.

## Open standards
- Community signal API must be **open-spec** — not locked to HomeOps as
  the only consumer.
- Provider rating data is portable: a provider can take their reputation
  if the marketplace shuts down.
- No exclusivity clauses with providers, societies, or households.

## Trust & safety
- Provider vetting includes ID verification, prior-customer references,
  insurance/license checks where applicable.
- Bilateral ratings — providers can rate sites too.
- Bad-actor escalation path with clear evidence requirements.

# Open Questions / Research Items

> Active items only. O4 (GST input-credit feasibility) is on hold and is
> not in this list — see the O4 section above for the parked hypothesis.
> The O1 classifier spec is locked (see the O1 metric note above) and is
> no longer an open question.

1. **Vision hardware strategy** — phone-only vs. low-cost smart shelves
   vs. leveraging existing in-home cameras. Needs cost / accuracy /
   privacy trade-off analysis.
2. **k-anonymity threshold** — k=5 is a starting guess. Validate with
   privacy review and a pilot society's tolerance.
3. **Pilot society selection** — what makes a society a good pilot?
   Density, demographics, existing RWA digital maturity, willingness to
   onboard.
4. **Provider onboarding TAM** — how many vetted providers are
   realistically available per category in a given metro area? Below
   some threshold the marketplace doesn't have meaningful competition.
5. **Liability model** — when a provider damages property, who carries
   the risk? HomeOps, the society, the provider, or insurance?
6. **Dispute resolution** — at what scale does this need a human ops
   team vs. algorithmic resolution?

# Out of Scope (this version)

- White-label deployments for non-residential properties (offices,
  hotels).
- Energy/water utility integration beyond conservation nudges.
- Insurance product origination.
- Financial services (lending, credit) tied to maintenance spending.
- International / non-India markets (the marketplace and pilot focus is
  India-first; expansion is out of this version).
- **GST input-credit aggregation** (O4) — parked, not pursued in this
  version. See the O4 section for the parked hypothesis.
- Hardware design and manufacturing (we integrate with existing devices,
  not build them).

# Definition of Done (per phase)

Each phase is "done" when:
1. All success metrics for that phase are measured (not necessarily hit,
   but instrumented).
2. The relevant subsystem has automated tests covering happy path + the
   top 3 failure modes.
3. A privacy review has signed off on any new data collection.
4. Documentation in this manifest is updated to reflect what shipped vs.
   what was deferred.

# Relationship to chores.agent.manifest.md

The chores manifest remains the authoritative spec for the personal-layer
chat agent. This system manifest describes the broader product the chores
agent slots into. Any contract changes that affect the chores agent must
update both files.
