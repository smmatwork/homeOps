import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agentApi", () => ({
  executeToolCall: vi.fn(),
}));

import { executeToolCall } from "./agentApi";
import {
  addHelperTimeOff,
  createHelper,
  createHelperReward,
  deleteHelper,
  deleteHelperTimeOff,
  submitHelperFeedback,
  updateHelper,
} from "./helpersApi";

describe("helpersApi", () => {
  const executeToolCallMock = executeToolCall as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    executeToolCallMock.mockResolvedValue({ ok: true, summary: "ok", toolCallId: "tc" });
  });

  it("createHelper calls executeToolCall with db.insert helpers", async () => {
    await createHelper({
      accessToken: "token",
      householdId: "hid",
      name: " Alice ",
      type: " Cleaning ",
      phone: " 123 ",
      notes: " note ",
      metadata: { preferred_language: "en" },
    });

    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.scope).toBe("household");
    expect(call.householdId).toBe("hid");
    expect(call.toolCall.tool).toBe("db.insert");
    expect(call.toolCall.args.table).toBe("helpers");
    expect(call.toolCall.args.record.name).toBe("Alice");
    expect(call.toolCall.args.record.type).toBe("Cleaning");
    expect(call.toolCall.args.record.phone).toBe("123");
  });

  it("updateHelper calls executeToolCall with db.update helpers", async () => {
    await updateHelper({ accessToken: "token", householdId: "hid", helperId: "helper-1", patch: { notes: "updated" } });
    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.toolCall.tool).toBe("db.update");
    expect(call.toolCall.args.table).toBe("helpers");
    expect(call.toolCall.args.id).toBe("helper-1");
    expect(call.toolCall.args.patch).toEqual({ notes: "updated" });
  });

  it("deleteHelper calls executeToolCall with db.delete helpers", async () => {
    await deleteHelper({ accessToken: "token", householdId: "hid", helperId: "helper-1" });
    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.toolCall.tool).toBe("db.delete");
    expect(call.toolCall.args.table).toBe("helpers");
    expect(call.toolCall.args.id).toBe("helper-1");
  });

  it("addHelperTimeOff calls executeToolCall with db.insert member_time_off", async () => {
    await addHelperTimeOff({
      accessToken: "token",
      householdId: "hid",
      helperId: "helper-1",
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-01-02T00:00:00.000Z",
      reason: "vacation",
    });
    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.toolCall.tool).toBe("db.insert");
    expect(call.toolCall.args.table).toBe("member_time_off");
    expect(call.toolCall.args.record.member_kind).toBe("helper");
    expect(call.toolCall.args.record.helper_id).toBe("helper-1");
  });

  it("deleteHelperTimeOff calls executeToolCall with db.delete member_time_off", async () => {
    await deleteHelperTimeOff({ accessToken: "token", householdId: "hid", timeOffId: "to-1" });
    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.toolCall.tool).toBe("db.delete");
    expect(call.toolCall.args.table).toBe("member_time_off");
    expect(call.toolCall.args.id).toBe("to-1");
  });

  it("submitHelperFeedback calls executeToolCall with db.insert helper_feedback", async () => {
    await submitHelperFeedback({
      accessToken: "token",
      householdId: "hid",
      helperId: "helper-1",
      rating: 5,
      comment: " Great ",
    });

    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.toolCall.tool).toBe("db.insert");
    expect(call.toolCall.args.table).toBe("helper_feedback");
    expect(call.toolCall.args.record.household_id).toBe("hid");
    expect(call.toolCall.args.record.helper_id).toBe("helper-1");
    expect(call.toolCall.args.record.rating).toBe(5);
    expect(call.toolCall.args.record.comment).toBe("Great");
  });

  it("createHelperReward calls executeToolCall with db.insert helper_rewards", async () => {
    await createHelperReward({
      accessToken: "token",
      householdId: "hid",
      helperId: "helper-1",
      quarter: "2026-Q2",
      rewardType: "bonus",
      amount: "500",
      currency: "INR",
      reason: "Nice",
    });

    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.toolCall.tool).toBe("db.insert");
    expect(call.toolCall.args.table).toBe("helper_rewards");
    expect(call.toolCall.args.record.household_id).toBe("hid");
    expect(call.toolCall.args.record.helper_id).toBe("helper-1");
    expect(call.toolCall.args.record.quarter).toBe("2026-Q2");
    expect(call.toolCall.args.record.reward_type).toBe("bonus");
  });
});
