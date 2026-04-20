import { describe, expect, it } from "vitest";
import { proposeAdjustments } from "./replanEngine";
import type { HouseholdEvent } from "./householdEventsApi";
import type { CoverageGap } from "./coverageApi";
import type { HelperWorkload } from "./helperWorkloadApi";

function makeEvent(overrides: Partial<HouseholdEvent>): HouseholdEvent {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    id: "evt_1",
    household_id: "hh_1",
    type: "guest_arrival",
    start_at: tomorrow.toISOString(),
    end_at: null,
    metadata: {},
    created_by: "user_1",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("replanEngine", () => {
  describe("proposeAdjustments", () => {
    it("returns empty when no inputs provided", () => {
      const result = proposeAdjustments({ events: [] });
      expect(result).toEqual([]);
    });

    it("proposes extra cleaning for guest_arrival event", () => {
      const event = makeEvent({ type: "guest_arrival" });
      const result = proposeAdjustments({ events: [event] });
      expect(result.length).toBe(1);
      expect(result[0].kind).toBe("add_chore");
      expect(result[0].triggerType).toBe("guest_arrival");
      expect(result[0].title).toContain("Guests arriving");
    });

    it("proposes skipping chores for vacation event", () => {
      const event = makeEvent({ type: "vacation" });
      const result = proposeAdjustments({ events: [event] });
      expect(result.length).toBe(1);
      expect(result[0].kind).toBe("skip_chore");
      expect(result[0].triggerType).toBe("vacation");
    });

    it("proposes reassign for helper_leave event", () => {
      const event = makeEvent({
        type: "helper_leave",
        metadata: { helper_id: "helper-1" },
      });
      const helpers = [{ id: "helper-1", name: "Alice" }];
      const result = proposeAdjustments({ events: [event], helpers });
      expect(result.length).toBe(1);
      expect(result[0].kind).toBe("reassign_helper");
      expect(result[0].title).toContain("Alice");
      expect(result[0].suggestedAction?.helperId).toBe("helper-1");
    });

    it("proposes preparation for occasion event", () => {
      const event = makeEvent({ type: "occasion" });
      const result = proposeAdjustments({ events: [event] });
      expect(result.length).toBe(1);
      expect(result[0].kind).toBe("add_chore");
      expect(result[0].triggerType).toBe("occasion");
    });

    it("proposes skipping outdoor chores for weather event", () => {
      const event = makeEvent({ type: "weather" });
      const result = proposeAdjustments({ events: [event] });
      expect(result.length).toBe(1);
      expect(result[0].kind).toBe("skip_chore");
      expect(result[0].title).toContain("Weather");
    });

    it("proposes workload adjustment for member_health event", () => {
      const event = makeEvent({ type: "member_health" });
      const result = proposeAdjustments({ events: [event] });
      expect(result.length).toBe(1);
      expect(result[0].kind).toBe("balance_workload");
      expect(result[0].severity).toBe("warning");
    });

    it("ignores events more than 14 days in the future", () => {
      const farFuture = new Date();
      farFuture.setDate(farFuture.getDate() + 30);
      const event = makeEvent({ type: "guest_arrival", start_at: farFuture.toISOString() });
      const result = proposeAdjustments({ events: [event] });
      expect(result).toEqual([]);
    });

    it("ignores past events", () => {
      const past = new Date();
      past.setDate(past.getDate() - 5);
      const event = makeEvent({ type: "guest_arrival", start_at: past.toISOString() });
      const result = proposeAdjustments({ events: [event] });
      expect(result).toEqual([]);
    });

    it("proposes from coverage gaps (limited to 5)", () => {
      const gaps: CoverageGap[] = Array.from({ length: 7 }, (_, i) => ({
        space: `Space ${i}`,
        cadence: "weekly" as const,
        reason: "no helper",
      }));
      const result = proposeAdjustments({ events: [], coverageGaps: gaps });
      expect(result.length).toBe(5);
      expect(result.every((p) => p.kind === "coverage_gap")).toBe(true);
    });

    it("proposes critical rebalance for over-capacity helpers", () => {
      const workloads: HelperWorkload[] = [
        {
          helperId: "h1",
          helperName: "Alice",
          capacityMinutes: 120,
          assignedChores: 5,
          estimatedMinutes: 200,
          utilizationPct: 166,
          averageRating: 4.5,
          feedbackCount: 10,
          overdueCount: 1,
          isOverCapacity: true,
        },
      ];
      const result = proposeAdjustments({ events: [], workloads });
      expect(result.length).toBe(1);
      expect(result[0].kind).toBe("balance_workload");
      expect(result[0].severity).toBe("critical");
      expect(result[0].title).toContain("Alice");
    });

    it("does not propose rebalance for helpers within capacity", () => {
      const workloads: HelperWorkload[] = [
        {
          helperId: "h1",
          helperName: "Alice",
          capacityMinutes: 120,
          assignedChores: 3,
          estimatedMinutes: 90,
          utilizationPct: 75,
          averageRating: 4.5,
          feedbackCount: 10,
          overdueCount: 0,
          isOverCapacity: false,
        },
      ];
      const result = proposeAdjustments({ events: [], workloads });
      expect(result).toEqual([]);
    });

    it("combines proposals from multiple sources", () => {
      const event = makeEvent({ type: "guest_arrival" });
      const gaps: CoverageGap[] = [{ space: "Kitchen", cadence: "daily", reason: "no helper" }];
      const workloads: HelperWorkload[] = [
        {
          helperId: "h1",
          helperName: "Alice",
          capacityMinutes: 120,
          assignedChores: 5,
          estimatedMinutes: 200,
          utilizationPct: 166,
          averageRating: 4.5,
          feedbackCount: 10,
          overdueCount: 1,
          isOverCapacity: true,
        },
      ];
      const result = proposeAdjustments({ events: [event], coverageGaps: gaps, workloads });
      expect(result.length).toBe(3);
      expect(result.map((p) => p.kind).sort()).toEqual(["add_chore", "balance_workload", "coverage_gap"]);
    });
  });
});
