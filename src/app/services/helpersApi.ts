import type { ToolCall } from "./agentActions";
import { executeToolCall } from "./agentApi";

type ExecParams = {
  accessToken: string;
  householdId: string;
};

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function run(params: ExecParams & { toolCall: ToolCall }): Promise<
  | { ok: true; summary: string; toolCallId: string }
  | { ok: false; error: string; status?: number }
> {
  const { accessToken, householdId, toolCall } = params;
  return executeToolCall({ accessToken, householdId, scope: "household", toolCall });
}

export async function createHelper(params: ExecParams & {
  name: string;
  type?: string | null;
  phone?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}): ReturnType<typeof run> {
  const { accessToken, householdId, name, type, phone, notes, metadata } = params;
  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helpers_create"),
      tool: "db.insert",
      args: {
        table: "helpers",
        record: {
          name: name.trim(),
          type: type ? String(type).trim() || null : null,
          phone: phone ? String(phone).trim() || null : null,
          notes: notes ? String(notes).trim() || null : null,
          metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
        },
      },
      reason: "Create helper",
    },
  });
}

export async function updateHelper(params: ExecParams & {
  helperId: string;
  patch: Record<string, unknown>;
}): ReturnType<typeof run> {
  const { accessToken, householdId, helperId, patch } = params;
  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helpers_update"),
      tool: "db.update",
      args: { table: "helpers", id: helperId, patch },
      reason: "Update helper",
    },
  });
}

export async function deleteHelper(params: ExecParams & { helperId: string }): ReturnType<typeof run> {
  const { accessToken, householdId, helperId } = params;
  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helpers_delete"),
      tool: "db.delete",
      args: { table: "helpers", id: helperId },
      reason: "Delete helper",
    },
  });
}

export async function addHelperTimeOff(params: ExecParams & {
  helperId: string;
  startAt: string;
  endAt: string;
  reason?: string | null;
}): ReturnType<typeof run> {
  const { accessToken, householdId, helperId, startAt, endAt, reason } = params;
  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("time_off_create"),
      tool: "db.insert",
      args: {
        table: "member_time_off",
        record: {
          member_kind: "helper",
          helper_id: helperId,
          start_at: startAt,
          end_at: endAt,
          reason: reason ? String(reason).trim() || null : null,
        },
      },
      reason: "Add helper time off",
    },
  });
}

export async function deleteHelperTimeOff(params: ExecParams & { timeOffId: string }): ReturnType<typeof run> {
  const { accessToken, householdId, timeOffId } = params;
  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("time_off_delete"),
      tool: "db.delete",
      args: { table: "member_time_off", id: timeOffId },
      reason: "Delete helper time off",
    },
  });
}

export async function submitHelperFeedback(params: ExecParams & {
  helperId: string;
  rating: number;
  comment?: string | null;
  occurredAt?: string | null;
}): ReturnType<typeof run> {
  const { accessToken, householdId, helperId, rating, comment, occurredAt } = params;
  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helper_feedback"),
      tool: "db.insert",
      args: {
        table: "helper_feedback",
        record: {
          household_id: householdId,
          helper_id: helperId,
          rating,
          comment: comment ? String(comment).trim() || null : null,
          occurred_at: occurredAt ? String(occurredAt).trim() || null : null,
        },
      },
      reason: "Submit helper feedback",
    },
  });
}

export async function createHelperReward(params: ExecParams & {
  helperId: string;
  quarter: string;
  rewardType: string;
  amount?: string | number | null;
  currency?: string | null;
  reason?: string | null;
}): ReturnType<typeof run> {
  const { accessToken, householdId, helperId, quarter, rewardType, amount, currency, reason } = params;
  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helper_reward"),
      tool: "db.insert",
      args: {
        table: "helper_rewards",
        record: {
          household_id: householdId,
          helper_id: helperId,
          quarter: String(quarter).trim(),
          reward_type: String(rewardType).trim(),
          amount: amount === undefined ? null : amount,
          currency: currency ? String(currency).trim() || null : null,
          reason: reason ? String(reason).trim() || null : null,
        },
      },
      reason: "Create helper reward",
    },
  });
}
