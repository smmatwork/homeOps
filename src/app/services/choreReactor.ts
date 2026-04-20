/**
 * Chore Reactor — Layer 3 of the chore state machine.
 *
 * Watches external signals (events, feedback, time-off) and emits
 * concrete chore adjustments. Unlike the replanEngine (which produces
 * informational proposals), the reactor produces typed mutations that
 * the engine can auto-apply or present for confirmation.
 *
 * Pure function — no side effects, fully testable.
 */

import type { Cadence } from "./choreRecommendationEngine";
import type { ChoreState } from "./choreStateMachine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReactorChore {
  id: string;
  title: string;
  status: ChoreState | string;
  dueAt: string | null;
  helperId: string | null;
  space: string | null;
  cadence: Cadence | null;
  priority: number;
}

export interface ReactorEvent {
  id: string;
  type: string;
  startAt: string;
  endAt: string | null;
  metadata: Record<string, unknown>;
}

export interface ReactorHelper {
  id: string;
  name: string;
}

export interface ReactorFeedback {
  helperId: string;
  space: string | null;
  rating: number;
  createdAt: string;
}

export interface ReactorTimeOff {
  helperId: string;
  startAt: string;
  endAt: string;
}

export interface ReactorInput {
  chores: ReactorChore[];
  events: ReactorEvent[];
  helpers: ReactorHelper[];
  feedback: ReactorFeedback[];
  timeOff: ReactorTimeOff[];
  /** Reference date — default now(). */
  now?: Date;
  /** How many days ahead to look. Default 7. */
  lookAheadDays?: number;
}

export type AdjustmentType =
  | "reassign"
  | "skip"
  | "create"
  | "reprioritize"
  | "upgrade_cadence"
  | "escalate";

export interface ChoreAdjustment {
  type: AdjustmentType;
  /** Which signal triggered this. */
  signal: string;
  /** Human-readable reason. */
  reason: string;
  /** Severity for ordering in the UI. */
  severity: "critical" | "warning" | "info";
  // Type-specific payload:
  choreId?: string;
  /** For escalate: list of chore titles that won't be done. */
  affectedChores?: string[];
  toHelperId?: string;
  skipReason?: string;
  newPriority?: number;
  /** For 'create' adjustments: */
  createTitle?: string;
  createSpace?: string;
  createCadence?: Cadence;
  createDueAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWithinWindow(iso: string, now: Date, daysAhead: number): boolean {
  const target = new Date(iso);
  const startMs = now.getTime();
  const endMs = startMs + daysAhead * 24 * 60 * 60 * 1000;
  return target.getTime() >= startMs && target.getTime() <= endMs;
}

function isActiveChore(c: ReactorChore): boolean {
  return c.status === "scheduled" || c.status === "assigned" || c.status === "in_progress" ||
         c.status === "pending";
}

function isOutdoorSpace(space: string | null): boolean {
  if (!space) return false;
  return /balcony|terrace|garden|deck|rooftop|lawn|yard|porch/i.test(space);
}

// ---------------------------------------------------------------------------
// Reactor
// ---------------------------------------------------------------------------

export function reactToSignals(input: ReactorInput): ChoreAdjustment[] {
  const {
    chores,
    events,
    helpers,
    feedback,
    timeOff,
    now = new Date(),
    lookAheadDays = 7,
  } = input;

  const adjustments: ChoreAdjustment[] = [];
  const helpersById = new Map(helpers.map((h) => [h.id, h]));
  const processedIds = new Set<string>(); // Prevent duplicate adjustments per chore

  // ── 1. Helper leave → reassign affected chores ─────────────────────
  // Collect chores with no alternative helper per leave event so we can
  // emit a single escalation signal listing all affected tasks.

  for (const event of events) {
    if (event.type !== "helper_leave") continue;
    if (!isWithinWindow(event.startAt, now, lookAheadDays)) continue;

    const helperId = typeof event.metadata.helper_id === "string" ? event.metadata.helper_id : null;
    if (!helperId) continue;

    const helperName = helpersById.get(helperId)?.name ?? "Helper";
    const leaveStart = new Date(event.startAt).getTime();
    const leaveEnd = event.endAt ? new Date(event.endAt).getTime() : leaveStart + 7 * 24 * 60 * 60 * 1000;

    const unassignable: { chore: ReactorChore }[] = [];

    for (const chore of chores) {
      if (!isActiveChore(chore)) continue;
      if (chore.helperId !== helperId) continue;
      if (!chore.dueAt) continue;
      if (processedIds.has(chore.id)) continue;

      const dueMs = new Date(chore.dueAt).getTime();
      if (dueMs >= leaveStart && dueMs < leaveEnd) {
        // Find an alternative helper.
        const alt = helpers.find((h) => {
          if (h.id === helperId) return false;
          // Check this helper isn't also on leave.
          return !timeOff.some((to) => {
            if (to.helperId !== h.id) return false;
            const s = new Date(to.startAt).getTime();
            const e = new Date(to.endAt).getTime();
            return dueMs >= s && dueMs < e;
          });
        });

        if (alt) {
          adjustments.push({
            type: "reassign",
            signal: "helper_leave",
            severity: "critical",
            reason: `${helperName} is on leave — reassign "${chore.title}" to ${alt.name}`,
            choreId: chore.id,
            toHelperId: alt.id,
          });
        } else {
          unassignable.push({ chore });
        }
        processedIds.add(chore.id);
      }
    }

    // Emit a single escalation for all chores that can't be reassigned.
    if (unassignable.length > 0) {
      const titles = unassignable.map((u) => u.chore.title);
      adjustments.push({
        type: "escalate",
        signal: "helper_leave_no_alternative",
        severity: "critical",
        reason: `${helperName} is on leave and no other helper is available. ${unassignable.length} task(s) will not be done and need your intervention: ${titles.join(", ")}`,
        affectedChores: titles,
      });
    }
  }

  // ── 2. Guest arrival → add deep clean chores ───────────────────────

  for (const event of events) {
    if (event.type !== "guest_arrival") continue;
    if (!isWithinWindow(event.startAt, now, lookAheadDays)) continue;

    const arrivalDate = new Date(event.startAt);
    const prepDate = new Date(arrivalDate);
    prepDate.setUTCDate(prepDate.getUTCDate() - 1);
    const prepIso = prepDate.toISOString();

    // Check if a deep clean is already scheduled around this date.
    const hasDeepClean = chores.some((c) =>
      isActiveChore(c) &&
      c.title.toLowerCase().includes("deep clean") &&
      c.dueAt &&
      Math.abs(new Date(c.dueAt).getTime() - arrivalDate.getTime()) < 2 * 24 * 60 * 60 * 1000,
    );

    if (!hasDeepClean) {
      adjustments.push({
        type: "create",
        signal: "guest_arrival",
        severity: "warning",
        reason: `Guests arriving ${arrivalDate.toLocaleDateString()} — schedule a deep clean beforehand`,
        createTitle: "Deep clean for guests",
        createSpace: "Kitchen",
        createCadence: "daily",
        createDueAt: prepIso,
      });
    }
  }

  // ── 3. Vacation → skip non-critical chores ─────────────────────────

  for (const event of events) {
    if (event.type !== "vacation") continue;
    if (!isWithinWindow(event.startAt, now, lookAheadDays)) continue;

    const vacStart = new Date(event.startAt).getTime();
    const vacEnd = event.endAt ? new Date(event.endAt).getTime() : vacStart + 7 * 24 * 60 * 60 * 1000;

    for (const chore of chores) {
      if (!isActiveChore(chore)) continue;
      if (!chore.dueAt) continue;
      if (processedIds.has(chore.id)) continue;

      const dueMs = new Date(chore.dueAt).getTime();
      if (dueMs >= vacStart && dueMs < vacEnd) {
        adjustments.push({
          type: "skip",
          signal: "vacation",
          severity: "info",
          reason: `Vacation — skip "${chore.title}"`,
          choreId: chore.id,
          skipReason: "vacation",
        });
        processedIds.add(chore.id);
      }
    }
  }

  // ── 4. Weather → skip outdoor chores ───────────────────────────────

  for (const event of events) {
    if (event.type !== "weather") continue;
    if (!isWithinWindow(event.startAt, now, lookAheadDays)) continue;

    const weatherDate = new Date(event.startAt);

    for (const chore of chores) {
      if (!isActiveChore(chore)) continue;
      if (!isOutdoorSpace(chore.space)) continue;
      if (!chore.dueAt) continue;
      if (processedIds.has(chore.id)) continue;

      const dueDate = new Date(chore.dueAt);
      if (
        dueDate.getUTCFullYear() === weatherDate.getUTCFullYear() &&
        dueDate.getUTCMonth() === weatherDate.getUTCMonth() &&
        dueDate.getUTCDate() === weatherDate.getUTCDate()
      ) {
        adjustments.push({
          type: "skip",
          signal: "weather",
          severity: "info",
          reason: `Weather event — skip outdoor chore "${chore.title}"`,
          choreId: chore.id,
          skipReason: "weather",
        });
        processedIds.add(chore.id);
      }
    }
  }

  // ── 5. Bad feedback → reprioritize + redo ──────────────────────────

  // Group negative feedback (≤ 2) by helper + space.
  const negFeedback = feedback.filter((f) => f.rating <= 2);
  const feedbackCounts = new Map<string, number>(); // "helperId::space" → count

  for (const fb of negFeedback) {
    const key = `${fb.helperId}::${fb.space ?? "all"}`;
    feedbackCounts.set(key, (feedbackCounts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of feedbackCounts) {
    const [helperId, space] = key.split("::");

    // Find active chores for this helper in this space.
    const affected = chores.filter(
      (c) =>
        isActiveChore(c) &&
        c.helperId === helperId &&
        (space === "all" || c.space === space),
    );

    for (const chore of affected) {
      if (processedIds.has(chore.id)) continue;

      // If 3+ negative reviews, this is a pattern — reprioritize to max.
      if (count >= 3) {
        adjustments.push({
          type: "reprioritize",
          signal: "feedback_pattern",
          severity: "warning",
          reason: `${count} low ratings for ${helpersById.get(helperId)?.name ?? "helper"} in ${space} — increasing priority`,
          choreId: chore.id,
          newPriority: 3,
        });
        processedIds.add(chore.id);
      }
    }
  }

  // Sort: critical first, then warning, then info.
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  adjustments.sort(
    (a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9),
  );

  return adjustments;
}
