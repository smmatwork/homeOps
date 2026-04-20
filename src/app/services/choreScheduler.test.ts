import { describe, expect, it } from "vitest";
import {
  scheduleChores,
  templateOccursOnDate,
  pickHelper,
  flatToRoomTemplates,
  type ChoreTemplate,
  type RoomTemplate,
  type TemplateTask,
  type HelperInfo,
  type TimeOffPeriod,
} from "./choreScheduler";

const TODAY = new Date("2026-04-13T00:00:00Z"); // Monday

function template(overrides: Partial<ChoreTemplate> = {}): ChoreTemplate {
  return {
    id: "tpl_kitchen_daily",
    title: "Kitchen jhadu pocha",
    space: "Kitchen",
    cadence: "daily",
    priority: 3,
    estimatedMinutes: 20,
    defaultHelperId: null,
    metadata: {},
    ...overrides,
  };
}

function roomTpl(overrides: Partial<RoomTemplate> = {}): RoomTemplate {
  return {
    id: "room_kitchen",
    space: "Kitchen",
    defaultHelperId: null,
    tasks: [
      { key: "kitchen_daily", title: "Kitchen jhadu pocha", cadence: "daily", priority: 3, estimatedMinutes: 20 },
    ],
    metadata: {},
    ...overrides,
  };
}

function task(overrides: Partial<TemplateTask> = {}): TemplateTask {
  return {
    key: "kitchen_daily",
    title: "Kitchen jhadu pocha",
    cadence: "daily",
    priority: 3,
    estimatedMinutes: 20,
    ...overrides,
  };
}

function helper(overrides: Partial<HelperInfo> = {}): HelperInfo {
  return {
    id: "h1",
    name: "Alice",
    capacityMinutes: 120,
    averageRating: 4.5,
    ...overrides,
  };
}

describe("choreScheduler", () => {
  describe("templateOccursOnDate", () => {
    it("daily templates occur every day", () => {
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(TODAY);
        d.setDate(d.getDate() + i);
        expect(templateOccursOnDate("daily", d, "tpl1")).toBe(true);
      }
    });

    it("weekly templates occur exactly once per week", () => {
      let count = 0;
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(TODAY);
        d.setDate(d.getDate() + i);
        if (templateOccursOnDate("weekly", d, "tpl1")) count += 1;
      }
      expect(count).toBe(1);
    });

    it("monthly templates occur at most once per month", () => {
      let count = 0;
      for (let i = 0; i < 28; i += 1) {
        const d = new Date(TODAY);
        d.setDate(d.getDate() + i);
        if (templateOccursOnDate("monthly", d, "tpl1")) count += 1;
      }
      expect(count).toBe(1);
    });

    it("different template ids may land on different days", () => {
      const d = new Date(TODAY);
      const a = templateOccursOnDate("weekly", d, "tpl_a");
      const b = templateOccursOnDate("weekly", d, "tpl_b");
      // Not guaranteed different, but test that both are boolean.
      expect(typeof a).toBe("boolean");
      expect(typeof b).toBe("boolean");
    });
  });

  describe("pickHelper", () => {
    const helpers: HelperInfo[] = [
      helper({ id: "h1", name: "Alice", capacityMinutes: 120, averageRating: 4.5 }),
      helper({ id: "h2", name: "Bob", capacityMinutes: 120, averageRating: 3.0 }),
    ];
    const defaultRoom = roomTpl();
    const defaultTask = task();

    it("returns null when no helpers available", () => {
      const result = pickHelper(defaultRoom, defaultTask, TODAY, [], [], new Map());
      expect(result).toBeNull();
    });

    it("excludes helpers on leave", () => {
      const timeOff: TimeOffPeriod[] = [
        { helperId: "h1", startAt: "2026-04-12T00:00:00Z", endAt: "2026-04-14T00:00:00Z" },
      ];
      const result = pickHelper(defaultRoom, defaultTask, TODAY, helpers, timeOff, new Map());
      expect(result).toBe("h2");
    });

    it("excludes helpers over capacity", () => {
      const loads = new Map([["h1", 110]]);
      const result = pickHelper(defaultRoom, task({ estimatedMinutes: 20 }), TODAY, helpers, [], loads);
      expect(result).toBe("h2");
    });

    it("prefers the room's default helper", () => {
      const result = pickHelper(
        roomTpl({ defaultHelperId: "h2" }),
        defaultTask,
        TODAY,
        helpers,
        [],
        new Map(),
      );
      expect(result).toBe("h2");
    });

    it("prefers higher-rated helpers when no default", () => {
      const result = pickHelper(defaultRoom, defaultTask, TODAY, helpers, [], new Map());
      expect(result).toBe("h1");
    });

    it("prefers least-loaded when ratings are equal", () => {
      const equalHelpers = [
        helper({ id: "h1", averageRating: 4.0 }),
        helper({ id: "h2", averageRating: 4.0 }),
      ];
      const loads = new Map([["h1", 60], ["h2", 30]]);
      const result = pickHelper(defaultRoom, defaultTask, TODAY, equalHelpers, [], loads);
      expect(result).toBe("h2");
    });

    it("returns null when all helpers are on leave", () => {
      const timeOff: TimeOffPeriod[] = [
        { helperId: "h1", startAt: "2026-04-12T00:00:00Z", endAt: "2026-04-14T00:00:00Z" },
        { helperId: "h2", startAt: "2026-04-12T00:00:00Z", endAt: "2026-04-14T00:00:00Z" },
      ];
      const result = pickHelper(defaultRoom, defaultTask, TODAY, helpers, timeOff, new Map());
      expect(result).toBeNull();
    });
  });

  describe("scheduleChores", () => {
    it("creates daily chore instances for each day in horizon", () => {
      const result = scheduleChores({
        templates: [template({ cadence: "daily" })],
        existingChores: [],
        helpers: [helper()],
        timeOff: [],
        horizon: 3,
        today: TODAY,
      });
      expect(result.mutations.length).toBe(3);
      expect(result.mutations.every((m) => m.type === "create_chore")).toBe(true);
      expect(result.mutations.every((m) => m.status === "assigned")).toBe(true);
    });

    it("is idempotent — skips existing chores", () => {
      const result = scheduleChores({
        templates: [template({ id: "tpl1", cadence: "daily" })],
        existingChores: [
          {
            id: "c1",
            templateId: "tpl1",
            title: "Kitchen jhadu pocha",
            dueAt: "2026-04-13T09:00:00.000Z",
            status: "assigned",
            helperId: "h1",
            metadata: {},
          },
        ],
        helpers: [helper()],
        timeOff: [],
        horizon: 3,
        today: TODAY,
      });
      // Day 1 already exists → only 2 new mutations.
      expect(result.mutations.length).toBe(2);
    });

    it("assigns 'scheduled' status when no helper is available", () => {
      const result = scheduleChores({
        templates: [template({ cadence: "daily" })],
        existingChores: [],
        helpers: [], // no helpers
        timeOff: [],
        horizon: 1,
        today: TODAY,
      });
      expect(result.mutations.length).toBe(1);
      expect(result.mutations[0].status).toBe("scheduled");
      expect(result.mutations[0].helperId).toBeNull();
    });

    it("respects helper time-off when assigning", () => {
      const alice = helper({ id: "h1" });
      const bob = helper({ id: "h2", averageRating: 3.0 });
      const timeOff: TimeOffPeriod[] = [
        { helperId: "h1", startAt: "2026-04-13T00:00:00Z", endAt: "2026-04-14T00:00:00Z" },
      ];
      const result = scheduleChores({
        templates: [template({ cadence: "daily" })],
        existingChores: [],
        helpers: [alice, bob],
        timeOff,
        horizon: 2,
        today: TODAY,
      });
      // Day 1: Alice on leave → Bob assigned
      // Day 2: Alice available → Alice assigned (higher rating)
      const day1 = result.mutations[0];
      const day2 = result.mutations[1];
      expect(day1.helperId).toBe("h2");
      expect(day2.helperId).toBe("h1");
    });

    it("respects helper capacity across multiple templates on the same day", () => {
      const tinyHelper = helper({ id: "h1", capacityMinutes: 30 }); // Only 30 min/day
      const templates = [
        template({ id: "tpl1", title: "Task A", cadence: "daily", estimatedMinutes: 20 }),
        template({ id: "tpl2", title: "Task B", cadence: "daily", estimatedMinutes: 20 }),
      ];
      const result = scheduleChores({
        templates,
        existingChores: [],
        helpers: [tinyHelper],
        timeOff: [],
        horizon: 1,
        today: TODAY,
      });
      // First task gets h1 (20/30), second can't fit (40 > 30) → scheduled without helper.
      const statuses = result.mutations.map((m) => m.status);
      expect(statuses).toContain("assigned");
      expect(statuses).toContain("scheduled");
    });

    it("sets auto_scheduled in metadata", () => {
      const result = scheduleChores({
        templates: [template()],
        existingChores: [],
        helpers: [helper()],
        timeOff: [],
        horizon: 1,
        today: TODAY,
      });
      expect(result.mutations[0].metadata.auto_scheduled).toBe(true);
      expect(result.mutations[0].metadata.template_id).toBe("tpl_kitchen_daily");
    });

    it("produces no mutations when no templates", () => {
      const result = scheduleChores({
        templates: [],
        existingChores: [],
        helpers: [helper()],
        timeOff: [],
        horizon: 7,
        today: TODAY,
      });
      expect(result.mutations).toEqual([]);
    });

    it("running twice with same inputs produces same output", () => {
      const input = {
        templates: [template({ cadence: "daily" })],
        existingChores: [],
        helpers: [helper()],
        timeOff: [],
        horizon: 3,
        today: TODAY,
      };
      const a = scheduleChores(input);
      const b = scheduleChores(input);
      expect(a.mutations.length).toBe(b.mutations.length);
      for (let i = 0; i < a.mutations.length; i += 1) {
        expect(a.mutations[i].templateId).toBe(b.mutations[i].templateId);
        expect(a.mutations[i].dueAt).toBe(b.mutations[i].dueAt);
        expect(a.mutations[i].helperId).toBe(b.mutations[i].helperId);
      }
    });

    it("handles room templates with multiple tasks per room", () => {
      const kitchen = roomTpl({
        id: "room_kitchen",
        space: "Kitchen",
        tasks: [
          { key: "k_daily", title: "Kitchen jhadu pocha", cadence: "daily", priority: 3, estimatedMinutes: 20 },
          { key: "k_weekly", title: "Kitchen deep clean", cadence: "weekly", priority: 2, estimatedMinutes: 45 },
        ],
      });
      const result = scheduleChores({
        roomTemplates: [kitchen],
        existingChores: [],
        helpers: [helper()],
        timeOff: [],
        horizon: 7,
        today: TODAY,
      });
      // 7 daily + 1 weekly = 8 mutations, all for "Kitchen" space
      const dailyCount = result.mutations.filter((m) => m.cadence === "daily").length;
      const weeklyCount = result.mutations.filter((m) => m.cadence === "weekly").length;
      expect(dailyCount).toBe(7);
      expect(weeklyCount).toBe(1);
      expect(result.mutations.every((m) => m.space === "Kitchen")).toBe(true);
      // All should reference the room template id
      expect(result.mutations.every((m) => m.templateId === "room_kitchen")).toBe(true);
    });

    it("flatToRoomTemplates groups flat templates by space", () => {
      const flat = [
        template({ id: "t1", space: "Kitchen", cadence: "daily" }),
        template({ id: "t2", space: "Kitchen", cadence: "weekly", title: "Kitchen deep clean" }),
        template({ id: "t3", space: "Bedroom", cadence: "daily", title: "Tidy Bedroom" }),
      ];
      const rooms = flatToRoomTemplates(flat);
      expect(rooms.length).toBe(2);
      const kitchen = rooms.find((r) => r.space === "Kitchen");
      const bedroom = rooms.find((r) => r.space === "Bedroom");
      expect(kitchen?.tasks.length).toBe(2);
      expect(bedroom?.tasks.length).toBe(1);
    });
  });
});
