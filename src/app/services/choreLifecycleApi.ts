import { supabase } from "./supabaseClient";
import { rolloverCutoffIso } from "./dateRange";

export type RolloverResult =
  | { ok: true; autoCompleted: number; reopened: number }
  | { ok: false; error: string };

/**
 * Runs the idempotent next-day rollover: auto-completes pending chores past
 * their due_at, or reopens them if the assigned helper was on leave. Call
 * at Chores page load; safe to call more than once per day.
 */
export async function rolloverOverdueChores(params: {
  householdId: string;
  actorUserId: string;
}): Promise<RolloverResult> {
  const hid = params.householdId.trim();
  const uid = params.actorUserId.trim();
  if (!hid || !uid) return { ok: false, error: "Missing required arguments" };

  const { data, error } = await supabase.rpc("rollover_overdue_chores", {
    p_household_id: hid,
    p_actor_user_id: uid,
    p_cutoff_iso: rolloverCutoffIso(),
  });
  if (error) return { ok: false, error: error.message };

  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    autoCompleted: Number(row?.auto_completed_count ?? 0),
    reopened: Number(row?.reopened_count ?? 0),
  };
}

export type ReopenReason = "feedback" | "helper_leave" | "manual";

export async function reopenChore(params: {
  householdId: string;
  actorUserId: string;
  choreId: string;
  reason?: ReopenReason;
}): Promise<{ ok: true; reopenedAt: string; reason: string } | { ok: false; error: string }> {
  const hid = params.householdId.trim();
  const uid = params.actorUserId.trim();
  const cid = params.choreId.trim();
  if (!hid || !uid || !cid) return { ok: false, error: "Missing required arguments" };

  const { data, error } = await supabase.rpc("reopen_chore", {
    p_household_id: hid,
    p_actor_user_id: uid,
    p_chore_id: cid,
    p_reason: params.reason ?? "feedback",
  });
  if (error) return { ok: false, error: error.message };

  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    reopenedAt: String(row?.reopened_at ?? ""),
    reason: String(row?.reason ?? "feedback"),
  };
}
