import { describe, expect, it } from "vitest";
import {
  generateWorkPlans,
  groupByCadence,
  dailyMinutes,
  type HelperWorkPlan,
  type WorkPlanTask,
} from "./helperWorkPlan";

function task(overrides: Partial<WorkPlanTask> = {}): WorkPlanTask {
  return {
    key: "test_task",
    title: "Test task",
    description: "Test",
    space: "Kitchen",
    category: "Cleaning",
    cadence: "daily",
    estimatedMinutes: 20,
    priority: 2,
    ...overrides,
  };
}

describe("helperWorkPlan", () => {
  describe("generateWorkPlans", () => {
    it("returns empty when no helpers", () => {
      expect(generateWorkPlans({ spaces: ["Kitchen"], helpers: [] })).toEqual([]);
    });

    it("returns empty when no spaces", () => {
      expect(generateWorkPlans({ spaces: [], helpers: [{ id: "h1", name: "Alice" }] })).toEqual([]);
    });

    it("distributes spaces round-robin across helpers", () => {
      const plans = generateWorkPlans({
        spaces: ["Kitchen", "Living Room", "Bedroom", "Bathroom"],
        helpers: [
          { id: "h1", name: "Alice" },
          { id: "h2", name: "Bob" },
        ],
      });
      expect(plans.length).toBe(2);
      // Alice gets Kitchen + Bedroom (indices 0, 2)
      // Bob gets Living Room + Bathroom (indices 1, 3)
      const alicePlan = plans.find((p) => p.helperId === "h1");
      const bobPlan = plans.find((p) => p.helperId === "h2");
      expect(alicePlan).toBeDefined();
      expect(bobPlan).toBeDefined();
      expect(alicePlan!.tasks.length).toBeGreaterThan(0);
      expect(bobPlan!.tasks.length).toBeGreaterThan(0);
    });

    it("respects explicit space assignments", () => {
      const plans = generateWorkPlans({
        spaces: ["Kitchen", "Bedroom"],
        helpers: [
          { id: "h1", name: "Alice", assignedSpaces: ["Kitchen", "Bedroom"] },
          { id: "h2", name: "Bob" },
        ],
      });
      const alicePlan = plans.find((p) => p.helperId === "h1");
      const bobPlan = plans.find((p) => p.helperId === "h2");
      // Alice gets both rooms explicitly.
      expect(alicePlan!.tasks.length).toBeGreaterThan(0);
      // Bob gets nothing — no tasks, so no plan.
      expect(bobPlan).toBeUndefined();
    });

    it("generates multiple cadence tasks per space", () => {
      const plans = generateWorkPlans({
        spaces: ["Kitchen"],
        helpers: [{ id: "h1", name: "Alice" }],
      });
      const cadences = new Set(plans[0].tasks.map((t) => t.cadence));
      // Kitchen should have daily + weekly at minimum.
      expect(cadences.has("daily")).toBe(true);
      expect(cadences.has("weekly")).toBe(true);
    });

    it("task keys include helper id for uniqueness", () => {
      const plans = generateWorkPlans({
        spaces: ["Kitchen"],
        helpers: [{ id: "h1", name: "Alice" }],
      });
      for (const t of plans[0].tasks) {
        expect(t.key).toContain("h1");
      }
    });
  });

  describe("groupByCadence", () => {
    it("groups tasks by cadence, ordered most frequent first", () => {
      const tasks = [
        task({ key: "a", cadence: "weekly" }),
        task({ key: "b", cadence: "daily" }),
        task({ key: "c", cadence: "daily" }),
        task({ key: "d", cadence: "monthly" }),
      ];
      const groups = groupByCadence(tasks);
      expect(groups[0].cadence).toBe("daily");
      expect(groups[0].tasks.length).toBe(2);
      expect(groups[1].cadence).toBe("weekly");
      expect(groups[1].tasks.length).toBe(1);
      expect(groups[2].cadence).toBe("monthly");
    });

    it("calculates totalMinutes per group", () => {
      const tasks = [
        task({ key: "a", cadence: "daily", estimatedMinutes: 20 }),
        task({ key: "b", cadence: "daily", estimatedMinutes: 15 }),
      ];
      const groups = groupByCadence(tasks);
      expect(groups[0].totalMinutes).toBe(35);
    });

    it("returns empty for empty input", () => {
      expect(groupByCadence([])).toEqual([]);
    });
  });

  describe("dailyMinutes", () => {
    it("sums only daily-cadence tasks", () => {
      const plan: HelperWorkPlan = {
        helperId: "h1",
        helperName: "Alice",
        tasks: [
          task({ key: "a", cadence: "daily", estimatedMinutes: 20 }),
          task({ key: "b", cadence: "daily", estimatedMinutes: 15 }),
          task({ key: "c", cadence: "weekly", estimatedMinutes: 45 }),
        ],
      };
      expect(dailyMinutes(plan)).toBe(35); // Only daily tasks
    });
  });
});
