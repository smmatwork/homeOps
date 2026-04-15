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

/**
 * Parse the row id from the edge function's db.insert summary.
 * Edge format: `Inserted 1 row into <table>. id=<uuid>`.
 * Returns null if the summary doesn't contain a recognizable uuid.
 */
export function parseInsertedId(summary: string): string | null {
  const m = /id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(summary || "");
  return m ? m[1] : null;
}

/**
 * Generate a 256-bit random token suitable for a helper_invites.token.
 * URL-safe base64. Works in browser and test (Node 18+) environments.
 */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Deterministic fallback for environments without Web Crypto — tests
    // only. NEVER used in production since browsers always have crypto.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Convert to URL-safe base64 without padding.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

// ────────────────────────────────────────────────────────────────────
// Phase 1.0a / P1.1a — helper onboarding split flow
// ────────────────────────────────────────────────────────────────────

/**
 * Create a helper row with the fields captured in Stage 1 of the
 * onboarding wizard. This is a thin wrapper over `createHelper` that
 * includes the new Phase 1.0 columns. Returns the new helper id on
 * success so the wizard can chain the invite + ledger writes.
 */
export async function createHelperForOnboarding(params: ExecParams & {
  name: string;
  phone: string;
  type: string;                              // cook | cleaner | gardener | ...
  dailyCapacityMinutes?: number | null;
  channelPreferences?: string[];             // default ["voice","whatsapp_tap","sms"]
  preferredLanguage?: string | null;
  preferredCallWindow?: Record<string, unknown> | null;
  notes?: string | null;
}): Promise<
  | { ok: true; helperId: string; summary: string }
  | { ok: false; error: string; status?: number }
> {
  const {
    accessToken, householdId, name, phone, type,
    dailyCapacityMinutes, channelPreferences, preferredLanguage,
    preferredCallWindow, notes,
  } = params;

  // The edge function's db.insert path understands these columns
  // because they're on the helpers table as of migration
  // 20260415000000_add_helper_module_tables.sql.
  const record: Record<string, unknown> = {
    name: name.trim(),
    phone: phone.trim() || null,
    type: type.trim() || null,
    notes: notes ? String(notes).trim() || null : null,
    metadata: {},
  };
  if (typeof dailyCapacityMinutes === "number" && Number.isFinite(dailyCapacityMinutes)) {
    record.daily_capacity_minutes = dailyCapacityMinutes;
  }
  if (Array.isArray(channelPreferences) && channelPreferences.length > 0) {
    record.channel_preferences = channelPreferences;
  }
  if (preferredLanguage) {
    record.preferred_language = preferredLanguage;
  }
  if (preferredCallWindow && typeof preferredCallWindow === "object") {
    record.preferred_call_window = preferredCallWindow;
  }

  const result = await run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helper_onboard"),
      tool: "db.insert",
      args: { table: "helpers", record },
      reason: "Create helper (Stage 1 onboarding)",
    },
  });

  if (result.ok === false) {
    return { ok: false, error: result.error, status: result.status };
  }

  const helperId = parseInsertedId(result.summary);
  if (!helperId) {
    return { ok: false, error: `Helper created but id could not be parsed from summary: "${result.summary}"` };
  }
  return { ok: true, helperId, summary: result.summary };
}

/**
 * Create a helper_invites row and return the generated token and the
 * magic-link URL. The token is generated client-side with
 * crypto.getRandomValues (256-bit, URL-safe base64). Expiry defaults
 * to 30 days, matching the schema default.
 *
 * In P1.1a we only persist the invite — the actual channel delivery
 * happens in P1.1b when the ChannelDispatcher is wired to real
 * provider adapters. Until then the magic-link URL is for the owner
 * to share out-of-band via the "web" channel adapter.
 */
export async function createHelperInvite(params: ExecParams & {
  helperId: string;
  channelChain: string[];
  magicLinkBaseUrl?: string;
}): Promise<
  | { ok: true; inviteId: string; token: string; magicLinkUrl: string }
  | { ok: false; error: string; status?: number }
> {
  const { accessToken, householdId, helperId, channelChain, magicLinkBaseUrl } = params;
  const token = generateInviteToken();

  const result = await run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helper_invite"),
      tool: "db.insert",
      args: {
        table: "helper_invites",
        record: {
          helper_id: helperId,
          token,
          channel_chain: channelChain.length > 0 ? channelChain : ["voice", "whatsapp_tap", "sms"],
          active_channel: channelChain[0] ?? "voice",
        },
      },
      reason: "Create Stage 2 helper invite",
    },
  });

  if (result.ok === false) {
    return { ok: false, error: result.error, status: result.status };
  }

  const inviteId = parseInsertedId(result.summary);
  if (!inviteId) {
    return { ok: false, error: `Invite created but id could not be parsed from summary: "${result.summary}"` };
  }

  const base = (magicLinkBaseUrl || "/h").replace(/\/+$/, "");
  const magicLinkUrl = `${base}/${token}`;
  return { ok: true, inviteId, token, magicLinkUrl };
}

/**
 * Append an entry to the helper_compensation_ledger. Used by the
 * wizard to record the initial salary, and later by the helpers UI
 * for advances/bonuses/settlements.
 */
export async function addCompensationLedgerEntry(params: ExecParams & {
  helperId: string;
  entryType: "salary_set" | "salary_change" | "advance" | "bonus" | "leave_balance" | "leave_taken" | "settlement" | "adjustment";
  amount: number;
  effectiveDate: string;                     // YYYY-MM-DD
  currency?: string;                         // default INR
  recordedByRole?: "owner" | "helper";       // default owner (wizard is owner-driven)
  note?: string | null;
}): ReturnType<typeof run> {
  const {
    accessToken, householdId, helperId, entryType, amount,
    effectiveDate, currency, recordedByRole, note,
  } = params;

  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helper_comp"),
      tool: "db.insert",
      args: {
        table: "helper_compensation_ledger",
        record: {
          helper_id: helperId,
          entry_type: entryType,
          amount: Number(amount.toFixed(2)),
          currency: currency || "INR",
          effective_date: effectiveDate,
          recorded_by_role: recordedByRole || "owner",
          note: note ? String(note).trim() || null : null,
        },
      },
      reason: `Add compensation ledger entry (${entryType})`,
    },
  });
}

/**
 * Void an existing compensation ledger row. The backing trigger
 * `helper_comp_ledger_void_only()` enforces that only void_* fields
 * can change; any other update raises.
 */
export async function voidCompensationLedgerEntry(params: ExecParams & {
  entryId: string;
  reason: string;
}): ReturnType<typeof run> {
  const { accessToken, householdId, entryId, reason } = params;
  return run({
    accessToken,
    householdId,
    toolCall: {
      id: makeId("helper_comp_void"),
      tool: "db.update",
      args: {
        table: "helper_compensation_ledger",
        id: entryId,
        patch: {
          voided_at: new Date().toISOString(),
          voided_reason: reason.trim() || "voided",
        },
      },
      reason: "Void compensation ledger entry",
    },
  });
}
