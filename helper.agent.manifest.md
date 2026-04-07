---
description: Helper Management + Assignment Manifest
scope: helpers
version: 1
---

# Objective
Build a complete, modular Helper Management capability and robust Helper Assignment flows **without altering existing Chore functionality** (no behavior changes to chore creation, scheduling, coverage, or list/daily views). The new functionality may introduce **bridge tables** that reference chores, but must not change existing chore semantics.

# Hard Constraints (Regression / Isolation)
- Do **not** change existing chore meaning:
  - Do not reinterpret `chores.status`, `chores.due_at`, `chores.metadata`, cadence logic, coverage logic, or daily/list views.
  - Do not modify chore creation normalization logic.
- Any helper-assignment-related changes must be **additive**:
  - Add new tables/columns/endpoints/components only.
  - If a small chore query must be extended, it must be backwards compatible and covered by tests.
- Helper assignment UI and logic must be **isolated** into helper-specific modules (files/folders), avoiding large edits to `Chores.tsx` and avoiding entangling helper CRUD with chore CRUD.
- Prefer feature-flagging or guarded rollout where appropriate.

# Helper Agent (sub-agent) Scope + Orchestrator Interaction
The “Helper Agent” is a domain sub-agent responsible for translating user intent about helpers into safe, auditable tool calls.

## Responsibilities (must-have)
- Helper directory management (CRUD) for `helpers`.
- Helper availability data entry (time off/leaves) and read-only surfacing.
- Submit and review helper feedback (`helper_feedback`).
- Submit and review helper rewards (`helper_rewards`).
- Helper assignment operations are expressed as updates to `chores.helper_id` (assign/unassign/reassign) but must not change other chore semantics.

## Non-responsibilities (must not)
- Must not implement its own direct database access path that bypasses the Edge tool executor.
- Must not write to `chore_helper_assignments` directly for normal flows.
- Must not mutate chore semantics beyond permitted assignment changes (`chores.helper_id`).

## How the orchestrator uses the Helper Agent
- The orchestrator is responsible for:
  - routing (Helper Agent vs Chores Agent vs other agents)
  - clarification loops
  - validating tool-call shapes
  - executing tool calls via the Edge tool executor (`/tools/execute`)
- The Helper Agent is responsible for:
  - producing a strict JSON response containing either clarifications or tool calls
  - ensuring the tool calls are minimal, safe, and household-scoped

## Helper Agent output contract (strict JSON)
The Helper Agent must output JSON with exactly these keys:
```json
{
  "clarifications": [
    {
      "key": "string",
      "question": "string",
      "options": ["string"],
      "allowMultiple": false
    }
  ],
  "tool_calls": [
    {
      "id": "string",
      "tool": "db.select|db.insert|db.update|db.delete",
      "args": { "table": "string" },
      "reason": "string"
    }
  ],
  "user_summary": "string"
}
```

Rules:
- If `clarifications` is non-empty, `tool_calls` must be empty.
- `args.table` must be one of the Edge allowlisted tables.
- All tool calls must include the correct `household_id` constraints in args/record.

## Critical invariants (enforced by implementation)
- Assignment history must be recorded centrally by the Edge tool executor on any update to `chores.helper_id`.
- Reward creation must be admin-only (enforced by Edge validation and RLS).
- Feedback submission is allowed for any household member (Option A).

# Must-Have Features
## Helper Management (CRUD)
- **List helpers** for the current `household_id`.
- **Create helper**:
  - Name (required)
  - Type (optional; e.g. cleaner/cook/driver)
  - Phone (optional)
  - Notes (optional)
  - Daily capacity minutes (required, default sensible)
- **Edit helper** (all above fields).
- **Deactivate helper** (soft delete or `active=false`) to preserve historical assignments.
- **Validation**:
  - Prevent empty name
  - Normalize phone formatting (optional) but do not block save on formatting
  - Ensure capacity is a non-negative integer

## Helper Assignment
### Core assignment
- Assign a helper to a chore (single helper per chore at a time).
- Unassign helper from a chore.
- View current helper assigned to a chore (in chore detail / chore row rendering, if already present).

### Assignment history (must-have)
- Track assignment history (who was assigned, when, by whom).
- Support the following events:
  - `assigned`
  - `unassigned`
  - `reassigned`

### Rules
- Assignment should not mutate chore meaning; helper is metadata/association.
- If a helper is deactivated, existing chores may still show the historical helper name, but new assignments should not allow selecting inactive helpers.

## Helper Workload / Today View (must-have)
- A helper-centric view that shows:
  - chores due today grouped by helper
  - unassigned chores due today
  - optional time/capacity indicator (sum estimated minutes if available, otherwise count)

## Helper Leaves (must-have)
- Record helper leave periods (date range, partial day optional).
- If a helper is on leave for a given date:
  - chores assigned to that helper that are due on that date must surface in the UI as **action required**:
    - ready to be re-assigned and/or re-scheduled
  - do **not** change chore semantics in storage (do not rewrite `chores.status` as a side-effect of leave).
- Prevent new assignments to helpers who are on leave for the relevant date/time window.
- Provide a lightweight leave calendar / list view.

## Helper Feedback (must-have)
- Allow household members to submit feedback for helpers.
- Feedback must support at least:
  - rating (1-5)
  - optional text
  - optional tags (e.g., punctuality, quality, communication)
  - association to a date/time window (e.g., week) and optionally to chores
- Provide helper-level aggregates:
  - average rating
  - feedback count
  - recent comments

## Quarterly Rewards (must-have)
- Provide a quarterly “reward” workflow driven by:
  - feedback score / trend
  - leave taken
  - basic reliability metrics (e.g., completed chores count where helper was assigned)
- The rewards program must be configurable per household (enable/disable, reward types).
- Reward actions must not affect chore logic; they are administrative/accounting records.

# Nice-to-Have (Optional)
- Auto-suggest helper based on space or category.
- Recurring helper availability schedules.
- Bulk assignment actions.

# Data Model
## Existing tables (do not alter semantics)
- `helpers` (already exists)
- `chores` (already exists; has `helper_id` today)

## Preferred approach (minimal churn)
- Keep using `chores.helper_id` for the **current** assignment.
- Add a bridge/history table for auditability:

### `chore_helper_assignments` (new)
- `id` (uuid)
- `household_id` (uuid, indexed)
- `chore_id` (uuid, FK -> chores.id)
- `helper_id` (uuid, FK -> helpers.id)
- `action` (text enum: assigned|unassigned|reassigned)
- `assigned_by` (uuid, nullable; profile/user id)
- `created_at` (timestamp)
- `metadata` (jsonb, nullable)

Notes:
- This table must be append-only.
- `chores.helper_id` reflects the current assignment.

## Helper availability / leaves

### `helper_leaves` (new)
- `id` (uuid)
- `household_id` (uuid, indexed)
- `helper_id` (uuid, FK -> helpers.id)
- `start_at` (timestamp)
- `end_at` (timestamp)
- `kind` (text enum: paid|unpaid|sick|vacation|other)
- `reason` (text, nullable)
- `created_by` (uuid, nullable)
- `created_at` (timestamp)
- `metadata` (jsonb, nullable)

Notes:
- Overlapping leaves should be prevented (by validation and/or constraint).
- Leave affects assignment and UI surfacing only; it must not mutate chore meaning.

## Helper feedback

### `helper_feedback` (new)
- `id` (uuid)
- `household_id` (uuid, indexed)
- `helper_id` (uuid, FK -> helpers.id)
- `author_id` (uuid, nullable)
- `rating` (int 1..5)
- `comment` (text, nullable)
- `tags` (text[], nullable)
- `occurred_at` (timestamp; when the feedback applies)
- `chore_ids` (uuid[], nullable) OR `chore_id` (uuid, nullable)
- `created_at` (timestamp)
- `metadata` (jsonb, nullable)

Notes:
- Feedback is append-only.

## Quarterly rewards

### `helper_rewards` (new)
- `id` (uuid)
- `household_id` (uuid, indexed)
- `helper_id` (uuid, FK -> helpers.id)
- `quarter` (text, e.g. 2026-Q2)
- `reward_type` (text; e.g. bonus|gift|recognition)
- `amount` (numeric, nullable)
- `currency` (text, nullable)
- `reason` (text, nullable)
- `awarded_by` (uuid, nullable)
- `created_at` (timestamp)
- `metadata` (jsonb, nullable)

### `helper_reward_snapshots` (optional but recommended)
Persist the computed metrics used to decide the reward so later changes in data do not change history.
- `id` (uuid)
- `household_id` (uuid, indexed)
- `helper_id` (uuid)
- `quarter` (text)
- `avg_rating` (numeric, nullable)
- `feedback_count` (int)
- `leave_days` (numeric)
- `assigned_completed_count` (int)
- `computed_at` (timestamp)
- `metadata` (jsonb, nullable)

## Alternative approach (if you want many-to-many)
If the product ever needs multiple helpers per chore, introduce `chore_helpers` (bridge) and stop using `chores.helper_id`. **Not in scope for v1**.

# API / Tooling Contracts
## Client service layer
- Add helper-specific API functions under `src/app/services/helpersApi.ts`:
  - `listHelpers(householdId)`
  - `createHelper(payload)`
  - `updateHelper(id, patch)`
  - `deactivateHelper(id)`
  - `assignHelperToChore(choreId, helperId)`
  - `unassignHelperFromChore(choreId)`
  - `listChoreHelperAssignments(choreId)`
  - `listHelperLeaves(householdId, helperId)`
  - `createHelperLeave(payload)`
  - `deleteHelperLeave(id)` (or deactivate)
  - `listHelperFeedback(householdId, helperId)`
  - `createHelperFeedback(payload)`
  - `listHelperRewards(householdId, helperId, quarter?)`
  - `createHelperReward(payload)`
  - `computeQuarterlyRewardCandidates(householdId, quarter)` (pure computation; does not mutate chores)

## Supabase / Edge
- Prefer using existing `executeToolCall` patterns (db.insert/db.update/db.select) rather than introducing bespoke endpoints.
- Any new Edge function logic must be:
  - scoped to helper features
  - not modify chore creation logic

# UI Requirements
## Helper Management UI
- Add a dedicated page or section (route) for helpers:
  - list + create/edit/deactivate
  - searchable list
  - empty state guidance

## Helper Assignment UI
- In Chores list/daily:
  - show assigned helper (read-only label)
  - an action to assign/unassign (dialog or inline select)

## Helper Leaves UI
- In helper detail:
  - create/edit/delete leave entries
  - simple list/calendar view
- In chores list/daily:
  - if chore is assigned to a helper who is on leave at the due date, show a clear “helper on leave” state and provide quick actions:
    - reassign
    - reschedule

## Helper Feedback UI
- In helper detail:
  - submit feedback (rating + comment)
  - display aggregate and recent feedback

## Rewards UI
- Quarterly view:
  - show candidates with computed metrics
  - allow awarding a reward and capturing reason/amount
  - show reward history per helper

## UX Guidelines
- Prefer inline selection with `Autocomplete` for helpers (searchable).
- Provide clear confirmation on assign/unassign.
- Avoid modal stacking.
- Persist minimal state; avoid global side-effects.

# Modularity / File Structure (required)
Implement helper features in isolated modules:
- `src/app/services/helpersApi.ts`
- `src/app/components/helpers/HelpersPage.tsx` (or similar)
- `src/app/components/helpers/HelperForm.tsx`
- `src/app/components/helpers/HelperAssignmentDialog.tsx`
- `src/app/components/helpers/helpersTypes.ts`

Chores page changes must be limited to:
- importing helper assignment component(s)
- passing chore id + household id
- rendering assignment UI and helper label

# Migration Strategy
- Add new table migration for `chore_helper_assignments`.
- Ensure RLS policies align with `household_id` scoping.
- Backfill is optional (only if needed). Do not rewrite existing chores.

# Test Requirements (must-have)
## Unit tests (Vitest)
- Helpers API/service layer:
  - list/create/update/deactivate request shapes
- Helper Assignment logic:
  - assigning updates `chores.helper_id`
  - assignment history row inserted
  - unassigning clears `chores.helper_id` and writes history

- Leaves logic:
  - cannot create overlapping leaves for the same helper
  - assignment API rejects assigning a helper on leave for the chore due window (or client prevents)
  - chores assigned to helper on leave are surfaced as “action required” without mutating `chores.status`

- Feedback logic:
  - create feedback validates rating bounds
  - list/aggregate calculations are correct

- Rewards computation:
  - quarter key normalization (e.g., 2026-Q2)
  - deterministic candidate scoring given feedback + leaves + completed chores
  - awarding reward writes reward row and optional snapshot

## Component tests (Vitest + React Testing Library)
- HelpersPage:
  - empty state
  - create helper
  - edit helper
  - deactivate helper
- Assignment dialog:
  - only active helpers shown
  - selecting helper triggers assignment tool calls
  - unassign flow

- Leaves UI:
  - add leave -> appears in helper detail
  - chore assigned to helper on leave shows “on leave” badge and action prompts

- Feedback UI:
  - submit rating/comment
  - aggregate rating updates

- Rewards UI:
  - candidate list renders
  - award reward persists and shows in history

## E2E tests (Playwright)
- Create a helper, assign it to a chore, verify:
  - chore shows helper label
  - helper workload view shows the chore
  - unassign removes label
- Regression guard:
  - existing chore creation + daily view still works
  - coverage view unaffected

- Leaves + reassignment:
  - mark helper on leave today
  - verify chores assigned to that helper appear as needing reassignment/reschedule
  - reassign to another helper and verify it persists

- Feedback + rewards:
  - submit feedback
  - compute quarterly candidates
  - award reward and verify it appears in history

# Definition of Done
- All helper CRUD and assignment flows implemented.
- No changes to chore semantics; chores UX remains correct.
- Tests added and passing:
  - unit + component + e2e
- Code is modular and isolated per the file structure rules above.
