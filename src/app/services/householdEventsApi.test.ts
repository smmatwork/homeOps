import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseFromMock = vi.fn();
const executeToolCallMock = vi.fn();

vi.mock("./supabaseClient", () => ({
  supabase: {
    from: (...args: any[]) => supabaseFromMock(...args),
  },
}));

vi.mock("./agentApi", () => ({
  executeToolCall: (...args: any[]) => executeToolCallMock(...args),
}));

import { fetchHouseholdEvents, createHouseholdEvent, deleteHouseholdEvent, HOUSEHOLD_EVENT_TYPES } from "./householdEventsApi";

function createBuilder(result: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

describe("householdEventsApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("HOUSEHOLD_EVENT_TYPES exposes expected types", () => {
    expect(HOUSEHOLD_EVENT_TYPES).toEqual([
      "guest_arrival",
      "vacation",
      "occasion",
      "weather",
      "member_health",
      "helper_leave",
    ]);
  });

  describe("fetchHouseholdEvents", () => {
    it("returns events on success", async () => {
      const events = [
        { id: "e1", household_id: "hh_1", type: "guest_arrival", start_at: "2026-04-12T00:00:00Z", end_at: null, metadata: {}, created_by: "u1", created_at: "2026-04-10T00:00:00Z" },
      ];
      supabaseFromMock.mockReturnValue(createBuilder({ data: events, error: null }));

      const result = await fetchHouseholdEvents("hh_1");
      expect(result.error).toBeNull();
      expect(result.events.length).toBe(1);
      expect(result.events[0].type).toBe("guest_arrival");
    });

    it("returns error on supabase failure", async () => {
      supabaseFromMock.mockReturnValue(createBuilder({ data: null, error: { message: "fetch failed" } }));

      const result = await fetchHouseholdEvents("hh_1");
      expect(result.error).toBe("fetch failed");
      expect(result.events).toEqual([]);
    });
  });

  describe("createHouseholdEvent", () => {
    it("calls executeToolCall with insert", async () => {
      executeToolCallMock.mockResolvedValue({ ok: true, summary: "created" });

      const result = await createHouseholdEvent({
        accessToken: "tok",
        householdId: "hh_1",
        type: "guest_arrival",
        startAt: "2026-04-12T00:00:00Z",
        endAt: "2026-04-13T00:00:00Z",
        metadata: { notes: "Family visit" },
      });

      expect(result.ok).toBe(true);
      expect(executeToolCallMock).toHaveBeenCalledTimes(1);
      const call = executeToolCallMock.mock.calls[0][0];
      expect(call.toolCall.tool).toBe("db.insert");
      expect(call.toolCall.args.table).toBe("household_events");
      expect(call.toolCall.args.record.type).toBe("guest_arrival");
      expect(call.toolCall.args.record.metadata.notes).toBe("Family visit");
    });

    it("returns error when executeToolCall fails", async () => {
      executeToolCallMock.mockResolvedValue({ ok: false, error: "insert failed" });

      const result = await createHouseholdEvent({
        accessToken: "tok",
        householdId: "hh_1",
        type: "vacation",
        startAt: "2026-04-12T00:00:00Z",
      });

      expect(result.ok).toBe(false);
      expect("error" in result ? result.error : null).toBe("insert failed");
    });
  });

  describe("deleteHouseholdEvent", () => {
    it("calls executeToolCall with delete", async () => {
      executeToolCallMock.mockResolvedValue({ ok: true, summary: "deleted" });

      const result = await deleteHouseholdEvent({
        accessToken: "tok",
        householdId: "hh_1",
        eventId: "evt_1",
      });

      expect(result.ok).toBe(true);
      const call = executeToolCallMock.mock.calls[0][0];
      expect(call.toolCall.tool).toBe("db.delete");
      expect(call.toolCall.args.id).toBe("evt_1");
    });
  });
});
