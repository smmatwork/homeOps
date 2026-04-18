# HomeOps Task Tracker

> Last updated: 2026-04-18

Status legend: `[ ]` pending | `[~]` in progress | `[x]` done

---

## Phase 1 — Cognitive Load Reduction (current quarter)

### Agent Hardening
- [x] Improve intent classifier robustness — compound phrase pre-pass, self-assignment patterns ("assign to me", "I'll do it"), cleaner disambiguation for "check off" vs "check", "set up" vs "set", "remove description" vs "remove chore"
- [x] Add hallucination prevention guardrails — `_needs_chores_fetch_override()`, `_needs_spaces_fetch_override()` for detecting invented chore/space/room lists; wired into response flow with auto-retry
- [x] Improve LLM-as-Judge guardrail — structured `failure_type` (intent_mismatch/hallucination/unsafe_action/policy_violation), `severity` (fatal/correctable), fatal failures block with clarification
- [x] Expand missing chore type coverage — fan dusting (kitchen, living, dining, study), glass/mirror clean (bedroom, kitchen, study), carpet vacuum (bedroom), cushion care (terrace), bicycle (chain + tyre), wood floor polish, CCTV lens clean, washing machine drum clean, carpet deep clean
- [x] Policy hardening — `_enforce_assignment_policy()` validates single-assignee constraint (helper_id XOR assignee_person_id), blocks hard violations, policy warnings logged via telemetry spans

### Weekly Plans & Notifications
- [x] Pre-confirmed weekly plans — `WeeklyPlanCard` component on Dashboard generates 7-day schedule from chore_templates, grouped by day, single-tap "Approve all" creates N chores (N load-reducing O1 events per rule #5)
- [x] Smarter notification gating — `notification_config` table (per-household toggles, quiet hours, rate limit), `justification` + `category` + `read_at` + `dismissed_at` columns on alerts, `should_notify()` RPC enforces cognitive-cost justification, replanEngine proposals all carry justification strings, Alerts UI shows justification + mark-read + dismiss

### Chore Assignment
- [x] Silent auto-assignment graduation — `check_auto_assignment_graduation` RPC counts consecutive one_tap approvals (threshold=5), `_check_graduation_status()` utility in agent service
- [x] **User-only households** — `assignee_person_id` column on chores (FK to household_people), constraint `chk_single_assignee` (XOR with helper_id), updated RPCs (apply_assignment_decision, list_chores_enriched, count_chores_assigned_to), choreScheduler/choreAssigner support person kind, AssignmentPanel writes person assignments correctly
- [x] Conflict resolution when multiple users share chore load — `resolveMultiUserConflicts()` in choreAssigner.ts detects over-allocated members and redistributes to least-loaded members, returns resolved + unresolved conflict report

### Helper Onboarding & Communication
- [x] Wire WhatsApp channel dispatcher end-to-end — all 3 WhatsApp adapters (Tap, Form, Voice) now send real Meta Cloud API v19.0 HTTP calls with E.164 phone formatting, interactive buttons, magic-link messages, and text fallback; proper error handling with transient/permanent/auth failure classification
- [ ] **Helper onboarding magic link** — generate secure token + expiry for Stage 2, build lightweight helper-facing web form (preferred language, photo, consent fields), token validation + field write-back, async completion handling with 7-day reminder nudge
- [x] Complete helper-facing UI polish — `HelperDailyView` (today's chores with completion toggles), `HelperCheckinCard` (log photo/thumbs-up/voice-note check-ins with 7-day history), `CompensationLedger` (full ledger view with add/void), all wired into Helpers page via expandable tabs per helper card
- [x] Helper check-in flow — `helper_checkins` table (photo/thumbs_up/voice_note/text types, chore_ids linkage, review status), `HelperCheckinCard` component with today's status chip and quick-log dialog
- [x] Compensation ledger MVP — `CompensationLedger` component shows salary/advances/bonuses summary + full entry list with add dialog (advance/bonus/salary_change/leave/settlement) and void support

### O1 Metric Instrumentation
- [x] Per-decision classification event emission — `apply_assignment_decision` RPC writes to `assignment_decisions` with mode + classification on every assignment
- [x] 4-week rolling window RPC — `get_o1_cognitive_load_ratio` computes load_reducing/total from assignment_decisions
- [x] Dashboard — `CognitiveLoadCard` component on OwnerAnalytics page shows O1 ratio, progress bar, phase target

---

## Phase 1.5 — Services & Maintenance Focus

### Home Maintenance Services
- [x] Service catalog with 100+ services seeded (plumbing, electrical, pest control, deep cleaning, carpentry, AC, RO, solar, chimney, etc.) — `service_catalog` table + `fetchServiceCatalog()` + `filterServicesForHome()`
- [x] Maintenance templates (50+) with cadence, season affinity, cost ranges, feature/home-type filtering — `maintenance_templates` table + seed data
- [x] Maintenance plan generation — deterministic, deduped, feature-aware via `generateMaintenancePlan()` in `maintenanceApi.ts`
- [x] Maintenance plan UI — seasonal calendar view with status tracking, schedule/complete dialogs, actual cost + notes capture — `MaintenancePage.tsx`
- [x] Vendor/provider directory — full CRUD with contact (phone, WhatsApp, email, UPI), service/supply categories, languages, rating, payment terms — `vendors` table + `ServicesPage.tsx` Tab 1
- [x] Preferred vendor assignment — service → vendor mapping with AMC tracking, last service date/cost — `preferred_vendors` table + ServicesPage Tab 0
- [x] Auto-generate maintenance chores from schedule cadences — `fetchMaintenanceChoreDue()` in `maintenanceApi.ts` bridges scheduled maintenance plan entries to chore-compatible objects for daily/weekly views
- [x] Maintenance cost tracking dashboard — `fetchMaintenanceCostSummary()` API + Cost Tracking tab in `MaintenancePage.tsx` with estimated vs actual, by-category progress bars, by-vendor breakdown
- [x] Service history log — `fetchServiceHistory()` API + Service History tab in `MaintenancePage.tsx` with filterable completed maintenance audit trail

### Household Items & Consumables
- [x] Home feature inventory schema — `home_features` table (feature_key, quantity, brand, model, install_date, warranty_until) + `fetchHomeFeatures()` / `saveHomeFeatures()`
- [x] Feature catalog — 38 features across 7 groups with multilingual labels (EN/HI/KN) in `homeFeatures.ts`
- [x] Procurement schema — `procurement_lists` + `procurement_items` tables with source_type support for maintenance/chore_supply/manual
- [x] Consumable depletion tracking UI — `fetchConsumables()` / `upsertConsumable()` / `restockConsumable()` APIs + Consumables tab in `ServicesPage.tsx` with level sliders, restock buttons, add/edit dialogs
- [x] Procurement integration — `createProcurementFromMaintenance()` auto-creates procurement list + items from maintenance template `procurement_items`; shopping cart button on each calendar item
- [x] Reorder reminders — `fetchReorderAlerts()` surfaces low-stock items as warning alerts on the Consumables tab with estimated days remaining

### Services Page
- [x] Service catalog UI — filtered by home type + features, grouped by category, vendor assignment status — `ServicesPage.tsx` Tab 0
- [x] Vendor directory UI — grid card view with create/edit/delete — `ServicesPage.tsx` Tab 1
- [x] Vendor performance metrics — `fetchVendorPerformance()` API + Performance tab in `ServicesPage.tsx` with completion rate, cost ratio, total spent per vendor
- [x] Feature warranty/age tracking in UI — `fetchWarrantyAlerts()` API + Warranty tab in `ServicesPage.tsx` showing expiring/expired warranties with days remaining

### Scheduling & Capacity
- [x] Capacity-aware schedule adjustment — `adjustScheduleForCapacity()` in `choreAssigner.ts` detects over-allocated and on-leave helpers, reassigns or defers chores with replacement helper selection
- [x] Optimal schedule recommendation — `recommendOptimalSchedule()` in `choreAssigner.ts` scores helper-chore fit by role match, capacity headroom, and work-day alignment

### Helper Communication
- [x] Proxy number fallback — `WhatsAppProxyAdapter` in `whatsapp.py` sends pending task lists to a configured proxy number (per-helper `proxy_phone` or `HELPER_PROXY_PHONE` env) when the helper's primary contact is unreachable

### Translations
- [x] Full services + maintenance i18n — 45+ new translation keys added for EN/HI/KN covering all services tabs (performance, consumables, warranty), maintenance tabs (cost tracking, history, procurement), and replaced all TODO: t() placeholders in `ServicesPage.tsx`

---

## Phase 2 — Sensing Layer

### Vision Pipeline
- [ ] On-device vision MVP for one consumable category (e.g., RO filter level)
- [ ] False-positive rate calibration framework (target: <= 10%)
- [ ] Privacy guardrail: vision events tagged "helper present" are discarded (no surveillance)
- [ ] Photo-of-task instruction generation for helpers (pass sensed image as chore instruction)

### Auto-chore Creation
- [ ] Auto-create chores from sensed events (consumable depletion, condition detection)
- [ ] Expand schedule cadence engine for time-based triggers
- [ ] Helper check-in photo capture integration

---

## Phase 3 — Community Aggregation

### Community Signals
- [ ] Pilot society selection criteria and onboarding
- [ ] Opt-in registry per signal type per household
- [ ] k-anonymity rollup (k=5) for community signal aggregation
- [ ] Time-windowed aggregation (daily, weekly, monthly)
- [ ] Community signal feed (read-only) for society admin

### Multi-household Helper Coordination
- [ ] Multi-household coordination opt-in flow (helper-controlled)
- [ ] Cross-household daily schedule view for helpers
- [ ] Conflict detection + helper-side resolution (employers stay invisible)
- [ ] FIFO tiebreaker when helper hasn't actively chosen between conflicts

---

## Phase 4 — Marketplace MVP

### Provider Management
- [ ] Provider directory with vetting workflow (ID verification, references, insurance)
- [ ] Vetted-provider onboarding for 1-2 categories (deep cleaning, solar washing)

### Bidding & Procurement
- [ ] RFQ + bid + rate flow (time-bounded auctions)
- [ ] Public price history per category per region
- [ ] Transparent bulk pricing (no GST optimization — O4 on hold)

### Ratings & Trust
- [ ] Bilateral ratings system (household rates provider, provider rates site)
- [ ] Recency-weighted rating decay
- [ ] Helper-controlled portable reputation (opt-in, separate from marketplace)
- [ ] Bidirectional helper ratings (helper rates household — timely payment, safe workspace)

### Lifecycle
- [ ] Off-boarding / settlement workflow (final compensation reconciliation, handover notes)
- [ ] Dispute resolution hooks
- [ ] Public API (rate-limited, authenticated)

---

## Open Research Questions

- [ ] Vision hardware strategy (phone vs. smart shelves vs. existing cameras)
- [ ] Validate k-anonymity threshold (k=5 is a starting guess)
- [ ] Pilot society selection (density, demographics, RWA digital maturity)
- [ ] Provider onboarding TAM per metro area
- [ ] Liability model for property damage during service
- [ ] Dispute resolution scaling (algorithmic vs. human ops team)
