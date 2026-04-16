import { describe, expect, it } from "vitest";
import {
  transition,
  isValidState,
  mapLegacyStatus,
  ACTIVE_STATES,
  TERMINAL_STATES,
  type ChoreEvent,
  type ChoreState,
  type TransitionContext,
} from "./choreStateMachine";

function event(type: ChoreEvent["type"], overrides: Partial<ChoreEvent> = {}): ChoreEvent {
  return { type, triggeredBy: "user", ...overrides };
}

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return { dueAt: "2026-04-15T09:00:00Z", currentHelperId: null, helperTimeOff: [], ...overrides };
}

describe("choreStateMachine", () => {
  // ─── Valid transitions ───────────────────────────────────────────────

  describe("scheduled →", () => {
    it("assign → assigned (with helperId)", () => {
      const result = transition("scheduled", event("assign", { helperId: "h1" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.nextState).toBe("assigned");
        expect(result.sideEffects.some((e) => e.type === "update_helper_id")).toBe(true);
      }
    });

    it("skip → skipped (with reason)", () => {
      const result = transition("scheduled", event("skip", { skipReason: "vacation" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe("skipped");
    });

    it("reschedule → scheduled (with new date)", () => {
      const result = transition("scheduled", event("reschedule", { newDueAt: "2026-04-20T09:00:00Z" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.nextState).toBe("scheduled");
        expect(result.sideEffects.some((e) => e.type === "update_due_at")).toBe(true);
      }
    });
  });

  describe("assigned →", () => {
    it("start → in_progress", () => {
      const result = transition("assigned", event("start"), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe("in_progress");
    });

    it("unassign → scheduled (clears helper)", () => {
      const result = transition("assigned", event("unassign", { reason: "helper_on_leave" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.nextState).toBe("scheduled");
        expect(result.sideEffects.some((e) => e.type === "clear_helper_id")).toBe(true);
      }
    });

    it("skip → skipped", () => {
      const result = transition("assigned", event("skip", { reason: "weather" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe("skipped");
    });

    it("reschedule → assigned (keeps helper)", () => {
      const result = transition("assigned", event("reschedule", { newDueAt: "2026-04-20T09:00:00Z" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe("assigned");
    });
  });

  describe("in_progress →", () => {
    it("complete → done (when helper is assigned)", () => {
      const result = transition("in_progress", event("complete"), ctx({ currentHelperId: "h1" }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe("done");
    });

    it("fail → failed", () => {
      const result = transition("in_progress", event("fail"), ctx({ currentHelperId: "h1" }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe("failed");
    });

    it("skip → skipped", () => {
      const result = transition("in_progress", event("skip", { reason: "emergency" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe("skipped");
    });
  });

  describe("done →", () => {
    it("no transitions allowed (terminal)", () => {
      const result = transition("done", event("assign", { helperId: "h1" }), ctx());
      expect(result.ok).toBe(false);
    });

    it("cannot complete again", () => {
      const result = transition("done", event("complete"), ctx());
      expect(result.ok).toBe(false);
    });
  });

  describe("skipped →", () => {
    it("reschedule → scheduled", () => {
      const result = transition("skipped", event("reschedule", { newDueAt: "2026-04-20T09:00:00Z" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe("scheduled");
    });

    it("cannot assign directly", () => {
      const result = transition("skipped", event("assign", { helperId: "h1" }), ctx());
      expect(result.ok).toBe(false);
    });
  });

  describe("failed →", () => {
    it("redo → scheduled (creates redo chore)", () => {
      const result = transition("failed", event("redo", { reason: "low quality" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.nextState).toBe("scheduled");
        expect(result.sideEffects.some((e) => e.type === "create_redo_chore")).toBe(true);
      }
    });

    it("cannot complete", () => {
      const result = transition("failed", event("complete"), ctx());
      expect(result.ok).toBe(false);
    });
  });

  // ─── Guard conditions ────────────────────────────────────────────────

  describe("guard: assign requires helperId", () => {
    it("rejects assign without helperId", () => {
      const result = transition("scheduled", event("assign"), ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect((result as any).error).toContain("helperId");
    });
  });

  describe("guard: assign blocked by helper on leave", () => {
    it("rejects when helper is on leave at due_at", () => {
      const result = transition(
        "scheduled",
        event("assign", { helperId: "h1" }),
        ctx({
          dueAt: "2026-04-15T09:00:00Z",
          helperTimeOff: [
            { helper_id: "h1", start_at: "2026-04-14T00:00:00Z", end_at: "2026-04-16T00:00:00Z" },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect((result as any).error).toContain("on leave");
    });

    it("allows when helper is NOT on leave", () => {
      const result = transition(
        "scheduled",
        event("assign", { helperId: "h1" }),
        ctx({
          dueAt: "2026-04-20T09:00:00Z",
          helperTimeOff: [
            { helper_id: "h1", start_at: "2026-04-14T00:00:00Z", end_at: "2026-04-16T00:00:00Z" },
          ],
        }),
      );
      expect(result.ok).toBe(true);
    });

    it("allows when a different helper is on leave", () => {
      const result = transition(
        "scheduled",
        event("assign", { helperId: "h1" }),
        ctx({
          dueAt: "2026-04-15T09:00:00Z",
          helperTimeOff: [
            { helper_id: "h2", start_at: "2026-04-14T00:00:00Z", end_at: "2026-04-16T00:00:00Z" },
          ],
        }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("guard: complete requires assigned helper", () => {
    it("rejects when no helper assigned", () => {
      const result = transition("in_progress", event("complete"), ctx({ currentHelperId: null }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect((result as any).error).toContain("assigned helper");
    });

    it("allows when helper is assigned", () => {
      const result = transition("in_progress", event("complete"), ctx({ currentHelperId: "h1" }));
      expect(result.ok).toBe(true);
    });
  });

  describe("guard: skip requires reason", () => {
    it("rejects skip without any reason", () => {
      const result = transition("scheduled", event("skip"), ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect((result as any).error).toContain("reason");
    });

    it("allows skip with reason", () => {
      const result = transition("scheduled", event("skip", { reason: "not needed" }), ctx());
      expect(result.ok).toBe(true);
    });

    it("allows skip with skipReason", () => {
      const result = transition("scheduled", event("skip", { skipReason: "vacation" }), ctx());
      expect(result.ok).toBe(true);
    });
  });

  describe("guard: reschedule requires newDueAt", () => {
    it("rejects without newDueAt", () => {
      const result = transition("scheduled", event("reschedule"), ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect((result as any).error).toContain("newDueAt");
    });
  });

  // ─── Side effects ────────────────────────────────────────────────────

  describe("side effects", () => {
    it("every successful transition produces log_transition + update_status", () => {
      const result = transition("scheduled", event("assign", { helperId: "h1" }), ctx());
      expect(result.ok).toBe(true);
      if (result.ok) {
        const types = result.sideEffects.map((e) => e.type);
        expect(types).toContain("log_transition");
        expect(types).toContain("update_status");
      }
    });

    it("assign produces update_helper_id", () => {
      const result = transition("scheduled", event("assign", { helperId: "h1" }), ctx());
      if (result.ok) {
        const helper = result.sideEffects.find((e) => e.type === "update_helper_id");
        expect(helper).toBeDefined();
        expect(helper?.payload.helperId).toBe("h1");
      }
    });

    it("redo produces create_redo_chore", () => {
      const result = transition("failed", event("redo", { reason: "bad quality" }), ctx());
      if (result.ok) {
        expect(result.sideEffects.some((e) => e.type === "create_redo_chore")).toBe(true);
      }
    });
  });

  // ─── Utility functions ───────────────────────────────────────────────

  describe("isValidState", () => {
    it("recognizes all valid states", () => {
      expect(isValidState("scheduled")).toBe(true);
      expect(isValidState("assigned")).toBe(true);
      expect(isValidState("in_progress")).toBe(true);
      expect(isValidState("done")).toBe(true);
      expect(isValidState("skipped")).toBe(true);
      expect(isValidState("failed")).toBe(true);
    });

    it("rejects invalid states", () => {
      expect(isValidState("pending")).toBe(false);
      expect(isValidState("")).toBe(false);
      expect(isValidState("completed")).toBe(false);
    });
  });

  describe("mapLegacyStatus", () => {
    it("maps pending → scheduled", () => {
      expect(mapLegacyStatus("pending")).toBe("scheduled");
    });
    it("maps in-progress → in_progress", () => {
      expect(mapLegacyStatus("in-progress")).toBe("in_progress");
    });
    it("maps completed → done", () => {
      expect(mapLegacyStatus("completed")).toBe("done");
    });
    it("maps done → done", () => {
      expect(mapLegacyStatus("done")).toBe("done");
    });
    it("passes through valid new states", () => {
      expect(mapLegacyStatus("assigned")).toBe("assigned");
      expect(mapLegacyStatus("failed")).toBe("failed");
    });
    it("falls back to scheduled for unknown", () => {
      expect(mapLegacyStatus("garbage")).toBe("scheduled");
    });
  });

  describe("ACTIVE_STATES and TERMINAL_STATES", () => {
    it("active and terminal are disjoint", () => {
      for (const s of ACTIVE_STATES) {
        expect(TERMINAL_STATES.has(s as any)).toBe(false);
      }
    });

    it("active + terminal covers all states", () => {
      const allStates: ChoreState[] = ["scheduled", "assigned", "in_progress", "done", "skipped", "failed"];
      for (const s of allStates) {
        expect(ACTIVE_STATES.has(s) || TERMINAL_STATES.has(s)).toBe(true);
      }
    });
  });
});
