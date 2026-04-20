/**
 * Chore Finite State Machine.
 *
 * Pure transition function — no side effects, no database calls.
 * Given a current state and an event, returns the next state + any
 * side effects the orchestrator should apply.
 *
 * States:
 *   scheduled → assigned → in_progress → done
 *                                       → failed → (redo) → scheduled
 *              → skipped
 *
 * "template" is a conceptual state stored in chore_templates, not in chores.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChoreState =
  | "scheduled"
  | "assigned"
  | "in_progress"
  | "done"
  | "skipped"
  | "failed";

export type ChoreEventType =
  | "assign"
  | "unassign"
  | "start"
  | "complete"
  | "fail"
  | "skip"
  | "redo"
  | "reschedule";

export interface ChoreEvent {
  type: ChoreEventType;
  /** Who or what triggered this transition. */
  triggeredBy: "scheduler" | "reactor" | "user" | "agent";
  /** Why this transition is happening (human-readable). */
  reason?: string;
  /** For assign: the helper being assigned. */
  helperId?: string;
  /** For reschedule: the new due date. */
  newDueAt?: string;
  /** For skip: the event type that caused it (vacation, weather, etc.). */
  skipReason?: string;
}

export type SideEffectType =
  | "log_transition"
  | "update_helper_id"
  | "update_status"
  | "update_due_at"
  | "create_redo_chore"
  | "clear_helper_id";

export interface SideEffect {
  type: SideEffectType;
  payload: Record<string, unknown>;
}

export interface TransitionSuccess {
  ok: true;
  nextState: ChoreState;
  sideEffects: SideEffect[];
}

export interface TransitionError {
  ok: false;
  error: string;
}

export type TransitionResult = TransitionSuccess | TransitionError;

// ---------------------------------------------------------------------------
// Context for guard conditions
// ---------------------------------------------------------------------------

export interface TransitionContext {
  /** The chore's current due_at (ISO string). */
  dueAt?: string | null;
  /** The chore's current helper_id. */
  currentHelperId?: string | null;
  /** Helper time-off periods to check against. */
  helperTimeOff?: Array<{
    helper_id: string;
    start_at: string;
    end_at: string;
  }>;
}

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

function isHelperOnLeave(
  helperId: string,
  dueAt: string | null | undefined,
  timeOff: TransitionContext["helperTimeOff"],
): boolean {
  if (!dueAt || !timeOff || timeOff.length === 0) return false;
  const dueMs = new Date(dueAt).getTime();
  if (Number.isNaN(dueMs)) return false;
  for (const period of timeOff) {
    if (period.helper_id !== helperId) continue;
    const start = new Date(period.start_at).getTime();
    const end = new Date(period.end_at).getTime();
    if (start <= dueMs && dueMs < end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Valid transitions table
// ---------------------------------------------------------------------------

/**
 * The set of valid (fromState, eventType) pairs.
 * Each entry defines the target state and any validation logic.
 */
const TRANSITIONS: Record<
  ChoreState,
  Partial<Record<ChoreEventType, ChoreState>>
> = {
  scheduled: {
    assign: "assigned",
    skip: "skipped",
    reschedule: "scheduled",
  },
  assigned: {
    start: "in_progress",
    unassign: "scheduled",
    skip: "skipped",
    reschedule: "assigned",
  },
  in_progress: {
    complete: "done",
    fail: "failed",
    skip: "skipped",
  },
  done: {
    // Terminal — no transitions out.
  },
  skipped: {
    // Can be rescheduled (user changes their mind).
    reschedule: "scheduled",
  },
  failed: {
    redo: "scheduled",
  },
};

// ---------------------------------------------------------------------------
// Transition function
// ---------------------------------------------------------------------------

export function transition(
  currentState: ChoreState,
  event: ChoreEvent,
  context: TransitionContext = {},
): TransitionResult {
  // 1. Check if this transition is valid.
  const validTargets = TRANSITIONS[currentState];
  if (!validTargets) {
    return { ok: false, error: `Unknown state: ${currentState}` };
  }

  const nextState = validTargets[event.type];
  if (!nextState) {
    return {
      ok: false,
      error: `Invalid transition: cannot "${event.type}" from "${currentState}"`,
    };
  }

  const sideEffects: SideEffect[] = [];

  // 2. Apply guard conditions and build side effects per event type.
  switch (event.type) {
    case "assign": {
      if (!event.helperId) {
        return { ok: false, error: "assign requires a helperId" };
      }
      if (isHelperOnLeave(event.helperId, context.dueAt, context.helperTimeOff)) {
        return {
          ok: false,
          error: `Helper ${event.helperId} is on leave at the chore's due date`,
        };
      }
      sideEffects.push({
        type: "update_helper_id",
        payload: { helperId: event.helperId },
      });
      break;
    }

    case "unassign": {
      sideEffects.push({
        type: "clear_helper_id",
        payload: { reason: event.reason ?? "unassigned" },
      });
      break;
    }

    case "complete": {
      if (!context.currentHelperId) {
        return {
          ok: false,
          error: "Cannot complete a chore without an assigned helper",
        };
      }
      break;
    }

    case "skip": {
      if (!event.skipReason && !event.reason) {
        return { ok: false, error: "skip requires a reason" };
      }
      break;
    }

    case "redo": {
      sideEffects.push({
        type: "create_redo_chore",
        payload: { reason: event.reason ?? "redo after failure" },
      });
      break;
    }

    case "reschedule": {
      if (!event.newDueAt) {
        return { ok: false, error: "reschedule requires a newDueAt" };
      }
      sideEffects.push({
        type: "update_due_at",
        payload: { dueAt: event.newDueAt },
      });
      break;
    }

    case "start":
    case "fail":
      // No special guards.
      break;
  }

  // 3. Always log the transition.
  sideEffects.push({
    type: "log_transition",
    payload: {
      from: currentState,
      to: nextState,
      triggeredBy: event.triggeredBy,
      reason: event.reason ?? event.skipReason ?? null,
    },
  });

  // 4. Always update the status column.
  sideEffects.push({
    type: "update_status",
    payload: { status: nextState },
  });

  return { ok: true, nextState, sideEffects };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** All states that are considered "active" (chore still needs attention). */
export const ACTIVE_STATES: ReadonlySet<ChoreState> = new Set([
  "scheduled",
  "assigned",
  "in_progress",
]);

/** All states that are considered "terminal" (chore is resolved). */
export const TERMINAL_STATES: ReadonlySet<ChoreState> = new Set([
  "done",
  "skipped",
  "failed",
]);

/** Check if a state string is a valid ChoreState. */
export function isValidState(s: string): s is ChoreState {
  return (
    s === "scheduled" ||
    s === "assigned" ||
    s === "in_progress" ||
    s === "done" ||
    s === "skipped" ||
    s === "failed"
  );
}

/** Map legacy status strings to ChoreState. */
export function mapLegacyStatus(status: string): ChoreState {
  switch (status) {
    case "pending":
      return "scheduled";
    case "in-progress":
      return "in_progress";
    case "completed":
    case "done":
      return "done";
    default:
      return isValidState(status) ? status : "scheduled";
  }
}
