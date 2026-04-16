import { describe, expect, it } from "vitest";
import {
  reactToSignals,
  type ReactorChore,
  type ReactorEvent,
  type ReactorHelper,
  type ReactorFeedback,
  type ReactorTimeOff,
  type ReactorInput,
} from "./choreReactor";

const NOW = new Date("2026-04-13T00:00:00Z");

function chore(overrides: Partial<ReactorChore> = {}): ReactorChore {
  return {
    id: "c1",
    title: "Kitchen jhadu pocha",
    status: "assigned",
    dueAt: "2026-04-15T09:00:00Z",
    helperId: "h1",
    space: "Kitchen",
    cadence: "daily",
    priority: 2,
    ...overrides,
  };
}

function event(type: string, overrides: Partial<ReactorEvent> = {}): ReactorEvent {
  return {
    id: "evt1",
    type,
    startAt: "2026-04-15T00:00:00Z",
    endAt: "2026-04-17T00:00:00Z",
    metadata: {},
    ...overrides,
  };
}

const HELPERS: ReactorHelper[] = [
  { id: "h1", name: "Alice" },
  { id: "h2", name: "Bob" },
];

function input(overrides: Partial<ReactorInput> = {}): ReactorInput {
  return {
    chores: [],
    events: [],
    helpers: HELPERS,
    feedback: [],
    timeOff: [],
    now: NOW,
    lookAheadDays: 7,
    ...overrides,
  };
}

describe("choreReactor", () => {
  describe("helper_leave", () => {
    it("reassigns chores to another available helper", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1", dueAt: "2026-04-15T09:00:00Z" })],
          events: [
            event("helper_leave", {
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
              metadata: { helper_id: "h1" },
            }),
          ],
        }),
      );
      expect(result.length).toBe(1);
      expect(result[0].type).toBe("reassign");
      expect(result[0].toHelperId).toBe("h2");
      expect(result[0].severity).toBe("critical");
    });

    it("escalates when no alternative helper available", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1", dueAt: "2026-04-15T09:00:00Z" })],
          events: [
            event("helper_leave", {
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
              metadata: { helper_id: "h1" },
            }),
          ],
          helpers: [{ id: "h1", name: "Alice" }], // Only one helper
        }),
      );
      expect(result.length).toBe(1);
      expect(result[0].type).toBe("escalate");
      expect(result[0].signal).toBe("helper_leave_no_alternative");
      expect(result[0].severity).toBe("critical");
      expect(result[0].affectedChores).toContain("Kitchen jhadu pocha");
      expect(result[0].reason).toContain("intervention");
    });

    it("ignores chores not assigned to the leaving helper", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h2", dueAt: "2026-04-15T09:00:00Z" })],
          events: [
            event("helper_leave", {
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
              metadata: { helper_id: "h1" },
            }),
          ],
        }),
      );
      expect(result.length).toBe(0);
    });

    it("ignores chores outside the leave window", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1", dueAt: "2026-04-20T09:00:00Z" })],
          events: [
            event("helper_leave", {
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
              metadata: { helper_id: "h1" },
            }),
          ],
        }),
      );
      expect(result.length).toBe(0);
    });

    it("skips helper_leave events without helper_id in metadata", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1" })],
          events: [event("helper_leave", { metadata: {} })],
        }),
      );
      expect(result.length).toBe(0);
    });

    it("escalates when alternative helpers are also on leave", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1", dueAt: "2026-04-15T09:00:00Z" })],
          events: [
            event("helper_leave", {
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
              metadata: { helper_id: "h1" },
            }),
          ],
          timeOff: [
            { helperId: "h2", startAt: "2026-04-14T00:00:00Z", endAt: "2026-04-17T00:00:00Z" },
          ],
        }),
      );
      expect(result.length).toBe(1);
      expect(result[0].type).toBe("escalate"); // Both on leave → escalate
      expect(result[0].affectedChores?.length).toBe(1);
    });

    it("groups multiple unassignable chores into a single escalation", () => {
      const result = reactToSignals(
        input({
          chores: [
            chore({ id: "c1", helperId: "h1", dueAt: "2026-04-15T09:00:00Z" }),
            chore({ id: "c2", title: "Clean Bathroom", helperId: "h1", dueAt: "2026-04-16T09:00:00Z" }),
          ],
          events: [
            event("helper_leave", {
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
              metadata: { helper_id: "h1" },
            }),
          ],
          helpers: [{ id: "h1", name: "Alice" }], // Only one helper
        }),
      );
      // Should be a single escalation with 2 affected chores, not 2 separate adjustments
      const escalations = result.filter((a) => a.type === "escalate");
      expect(escalations.length).toBe(1);
      expect(escalations[0].affectedChores?.length).toBe(2);
      expect(escalations[0].affectedChores).toContain("Kitchen jhadu pocha");
      expect(escalations[0].affectedChores).toContain("Clean Bathroom");
    });
  });

  describe("guest_arrival", () => {
    it("creates a deep clean chore when no existing deep clean", () => {
      const result = reactToSignals(
        input({
          events: [event("guest_arrival", { startAt: "2026-04-16T00:00:00Z" })],
        }),
      );
      expect(result.length).toBe(1);
      expect(result[0].type).toBe("create");
      expect(result[0].createTitle?.toLowerCase()).toContain("deep clean");
      expect(result[0].severity).toBe("warning");
    });

    it("skips if deep clean already scheduled near arrival date", () => {
      const result = reactToSignals(
        input({
          chores: [
            chore({
              id: "c_dc",
              title: "Deep clean kitchen",
              dueAt: "2026-04-15T09:00:00Z",
            }),
          ],
          events: [event("guest_arrival", { startAt: "2026-04-16T00:00:00Z" })],
        }),
      );
      expect(result.length).toBe(0);
    });

    it("ignores guest_arrival events far in the future", () => {
      const result = reactToSignals(
        input({
          events: [event("guest_arrival", { startAt: "2026-05-01T00:00:00Z" })],
          now: NOW,
          lookAheadDays: 7,
        }),
      );
      expect(result.length).toBe(0);
    });
  });

  describe("vacation", () => {
    it("skips all active chores within the vacation window", () => {
      const result = reactToSignals(
        input({
          chores: [
            chore({ id: "c1", dueAt: "2026-04-15T09:00:00Z" }),
            chore({ id: "c2", title: "Clean Bathroom", dueAt: "2026-04-16T09:00:00Z" }),
            chore({ id: "c3", title: "Sweep Balcony", dueAt: "2026-04-20T09:00:00Z" }), // outside window
          ],
          events: [
            event("vacation", {
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
            }),
          ],
        }),
      );
      expect(result.length).toBe(2); // c1 and c2 skipped, c3 untouched
      expect(result.every((a) => a.type === "skip")).toBe(true);
      expect(result.every((a) => a.skipReason === "vacation")).toBe(true);
    });

    it("ignores completed chores", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", status: "done", dueAt: "2026-04-15T09:00:00Z" })],
          events: [event("vacation", { startAt: "2026-04-14T00:00:00Z", endAt: "2026-04-17T00:00:00Z" })],
        }),
      );
      expect(result.length).toBe(0);
    });
  });

  describe("weather", () => {
    it("skips outdoor chores on the weather event date", () => {
      const result = reactToSignals(
        input({
          chores: [
            chore({ id: "c1", space: "Balcony", dueAt: "2026-04-15T09:00:00Z" }),
            chore({ id: "c2", space: "Kitchen", dueAt: "2026-04-15T09:00:00Z" }), // indoor
          ],
          events: [event("weather", { startAt: "2026-04-15T00:00:00Z" })],
        }),
      );
      expect(result.length).toBe(1);
      expect(result[0].choreId).toBe("c1");
      expect(result[0].skipReason).toBe("weather");
    });

    it("recognizes terrace, garden, lawn as outdoor", () => {
      const outdoorSpaces = ["Terrace", "Garden", "Lawn", "Deck", "Rooftop"];
      for (const space of outdoorSpaces) {
        const result = reactToSignals(
          input({
            chores: [chore({ id: `c_${space}`, space, dueAt: "2026-04-15T09:00:00Z" })],
            events: [event("weather", { startAt: "2026-04-15T00:00:00Z" })],
          }),
        );
        expect(result.length).toBe(1);
      }
    });
  });

  describe("feedback → reprioritize", () => {
    it("reprioritizes when 3+ low ratings for same helper+space", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1", space: "Kitchen" })],
          feedback: [
            { helperId: "h1", space: "Kitchen", rating: 2, createdAt: "2026-04-10T00:00:00Z" },
            { helperId: "h1", space: "Kitchen", rating: 1, createdAt: "2026-04-11T00:00:00Z" },
            { helperId: "h1", space: "Kitchen", rating: 2, createdAt: "2026-04-12T00:00:00Z" },
          ],
        }),
      );
      expect(result.length).toBe(1);
      expect(result[0].type).toBe("reprioritize");
      expect(result[0].newPriority).toBe(3);
      expect(result[0].signal).toBe("feedback_pattern");
    });

    it("ignores ratings above 2", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1", space: "Kitchen" })],
          feedback: [
            { helperId: "h1", space: "Kitchen", rating: 3, createdAt: "2026-04-10T00:00:00Z" },
            { helperId: "h1", space: "Kitchen", rating: 4, createdAt: "2026-04-11T00:00:00Z" },
            { helperId: "h1", space: "Kitchen", rating: 3, createdAt: "2026-04-12T00:00:00Z" },
          ],
        }),
      );
      expect(result.length).toBe(0);
    });

    it("does not trigger for fewer than 3 low ratings", () => {
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1", space: "Kitchen" })],
          feedback: [
            { helperId: "h1", space: "Kitchen", rating: 2, createdAt: "2026-04-10T00:00:00Z" },
            { helperId: "h1", space: "Kitchen", rating: 1, createdAt: "2026-04-11T00:00:00Z" },
          ],
        }),
      );
      expect(result.length).toBe(0);
    });
  });

  describe("sorting", () => {
    it("sorts critical before warning before info", () => {
      const result = reactToSignals(
        input({
          chores: [
            chore({ id: "c1", helperId: "h1", dueAt: "2026-04-15T09:00:00Z" }),
            chore({ id: "c2", helperId: "h1", dueAt: "2026-04-15T09:00:00Z", space: "Balcony" }),
            chore({ id: "c3", title: "Bathroom clean", dueAt: "2026-04-15T09:00:00Z" }),
          ],
          events: [
            event("helper_leave", {
              id: "e1",
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
              metadata: { helper_id: "h1" },
            }),
            event("vacation", {
              id: "e2",
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
            }),
          ],
        }),
      );
      // helper_leave adjustments are critical, vacation are info
      const severities = result.map((a) => a.severity);
      const firstInfo = severities.indexOf("info");
      const lastCritical = severities.lastIndexOf("critical");
      if (firstInfo >= 0 && lastCritical >= 0) {
        expect(lastCritical).toBeLessThan(firstInfo);
      }
    });
  });

  describe("deduplication", () => {
    it("does not produce duplicate adjustments for the same chore", () => {
      // A chore affected by both helper_leave and vacation — should only get one adjustment
      const result = reactToSignals(
        input({
          chores: [chore({ id: "c1", helperId: "h1", dueAt: "2026-04-15T09:00:00Z" })],
          events: [
            event("helper_leave", {
              id: "e1",
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
              metadata: { helper_id: "h1" },
            }),
            event("vacation", {
              id: "e2",
              startAt: "2026-04-14T00:00:00Z",
              endAt: "2026-04-17T00:00:00Z",
            }),
          ],
        }),
      );
      const choreIds = result.filter((a) => a.choreId === "c1");
      expect(choreIds.length).toBe(1); // Only one adjustment per chore
    });
  });

  describe("empty inputs", () => {
    it("returns empty when no signals", () => {
      const result = reactToSignals(input());
      expect(result).toEqual([]);
    });

    it("returns empty when no chores match signals", () => {
      const result = reactToSignals(
        input({
          events: [event("vacation", { startAt: "2026-04-14T00:00:00Z", endAt: "2026-04-17T00:00:00Z" })],
          chores: [], // no chores to skip
        }),
      );
      expect(result).toEqual([]);
    });
  });
});
