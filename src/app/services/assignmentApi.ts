import { supabase } from "./supabaseClient";
import {
  buildAssignmentPlan,
  helperRowToAssignable,
  type AssignableChore,
  type AssignmentRule,
} from "./choreAssigner";
import { useHelpersStore } from "../stores/helpersStore";

export type ReassignmentMode =
  | "manual"
  | "one_tap"
  | "silent_auto"
  | "reassignment_silent"
  | "reassignment_one_tap"
  | "bulk"
  | "override"
  | "elicitation"
  | "manual_edit_rules";

export type ReassignChoreParams = {
  householdId: string;
  actorUserId: string;
  choreId: string;
  newHelperId: string | null;
  mode?: ReassignmentMode;
  proposedHelperId?: string | null;
};

export type OperatingMode = "manual" | "one_tap" | "silent_auto";

export type ReassignChoreResult =
  | {
      ok: true;
      decisionId: number;
      overridden: boolean;
      shouldNudge: boolean;
      overrideId: number | null;
      effectiveMode: ReassignmentMode;
      modeChangedTo: OperatingMode | null;
    }
  | { ok: false; error: string };

export async function reassignChore(params: ReassignChoreParams): Promise<ReassignChoreResult> {
  const hid = params.householdId.trim();
  const uid = params.actorUserId.trim();
  const cid = params.choreId.trim();
  if (!hid || !uid || !cid) {
    return { ok: false, error: "Missing required arguments" };
  }

  const { data, error } = await supabase.rpc("reassign_chore", {
    p_household_id: hid,
    p_actor_user_id: uid,
    p_chore_id: cid,
    p_new_helper_id: params.newHelperId,
    p_mode: params.mode ?? "manual",
    p_proposed_helper_id: params.proposedHelperId ?? null,
  });

  if (error) {
    return { ok: false, error: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { ok: false, error: "reassign_chore returned no row" };
  }
  return {
    ok: true,
    decisionId: Number(row.decision_id),
    overridden: Boolean(row.overridden),
    shouldNudge: Boolean(row.should_nudge),
    overrideId: row.override_id != null ? Number(row.override_id) : null,
    effectiveMode: row.effective_mode as ReassignmentMode,
    modeChangedTo: (row.mode_changed_to ?? null) as OperatingMode | null,
  };
}

export async function fetchChorePredicateHash(choreId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("compute_chore_predicate_hash", {
    p_chore_id: choreId,
  });
  if (error || typeof data !== "string") return null;
  return data;
}

export async function fetchAssignmentMode(params: {
  householdId: string;
  actorUserId: string;
  chorePredicateHash: string;
  helperId: string;
}): Promise<OperatingMode> {
  const { data, error } = await supabase.rpc("get_assignment_mode", {
    p_household_id: params.householdId,
    p_actor_user_id: params.actorUserId,
    p_chore_predicate_hash: params.chorePredicateHash,
    p_helper_id: params.helperId,
  });
  if (error || typeof data !== "string") return "manual";
  if (data === "silent_auto" || data === "one_tap") return data;
  return "manual";
}

export async function setAssignmentModeRpc(params: {
  householdId: string;
  actorUserId: string;
  chorePredicateHash: string;
  helperId: string;
  mode: OperatingMode;
}): Promise<{ ok: true; mode: OperatingMode } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("set_assignment_mode", {
    p_household_id: params.householdId,
    p_actor_user_id: params.actorUserId,
    p_chore_predicate_hash: params.chorePredicateHash,
    p_helper_id: params.helperId,
    p_mode: params.mode,
  });
  if (error) return { ok: false, error: error.message };
  const mode = (typeof data === "string" ? data : "manual") as OperatingMode;
  return { ok: true, mode };
}

export type PendingNudge = {
  overrideId: number;
  chorePredicate: Record<string, unknown>;
  proposedHelperId: string | null;
  proposedHelperName: string | null;
  chosenHelperId: string | null;
  chosenHelperName: string | null;
  overrideCount: number;
  firstOverrideAt: string;
  lastOverrideAt: string;
};

export async function fetchPendingNudges(params: {
  householdId: string;
  actorUserId: string;
}): Promise<{ ok: true; nudges: PendingNudge[] } | { ok: false; error: string }> {
  const hid = params.householdId.trim();
  const uid = params.actorUserId.trim();
  if (!hid || !uid) return { ok: false, error: "Missing required arguments" };

  const { data, error } = await supabase.rpc("get_pending_nudges", {
    p_household_id: hid,
    p_actor_user_id: uid,
  });
  if (error) return { ok: false, error: error.message };

  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  const nudges: PendingNudge[] = rows.map((r) => ({
    overrideId: Number(r.override_id),
    chorePredicate: (r.chore_predicate_sample ?? {}) as Record<string, unknown>,
    proposedHelperId: r.proposed_helper_id ? String(r.proposed_helper_id) : null,
    proposedHelperName: r.proposed_helper_name ? String(r.proposed_helper_name) : null,
    chosenHelperId: r.chosen_helper_id ? String(r.chosen_helper_id) : null,
    chosenHelperName: r.chosen_helper_name ? String(r.chosen_helper_name) : null,
    overrideCount: Number(r.override_count),
    firstOverrideAt: String(r.first_override_at),
    lastOverrideAt: String(r.last_override_at),
  }));
  return { ok: true, nudges };
}

export async function acceptNudge(params: {
  overrideId: number;
  actorUserId: string;
  conditions?: Record<string, unknown> | null;
}): Promise<{ ok: true; ruleId: string; acceptedAt: string } | { ok: false; error: string }> {
  const uid = params.actorUserId.trim();
  if (!uid || !params.overrideId) return { ok: false, error: "Missing required arguments" };

  const { data, error } = await supabase.rpc("accept_nudge", {
    p_override_id: params.overrideId,
    p_actor_user_id: uid,
    p_conditions: params.conditions ?? null,
  });
  if (error) return { ok: false, error: error.message };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "accept_nudge returned no row" };
  return { ok: true, ruleId: String(row.rule_id), acceptedAt: String(row.accepted_at) };
}

export async function declineNudge(params: {
  overrideId: number;
  actorUserId: string;
}): Promise<{ ok: true; declinedAt: string; hibernateUntil: string } | { ok: false; error: string }> {
  const uid = params.actorUserId.trim();
  if (!uid || !params.overrideId) return { ok: false, error: "Missing required arguments" };

  const { data, error } = await supabase.rpc("decline_nudge", {
    p_override_id: params.overrideId,
    p_actor_user_id: uid,
  });
  if (error) return { ok: false, error: error.message };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "decline_nudge returned no row" };
  return {
    ok: true,
    declinedAt: String(row.declined_at),
    hibernateUntil: String(row.hibernate_until),
  };
}

export type AssignmentRuleRow = {
  id: string;
  template_id: string;
  template_params: Record<string, unknown>;
  helper_id: string | null;
  weight: number;
  active: boolean;
  source: string;
};

export async function fetchAssignmentRules(
  householdId: string,
): Promise<{ ok: true; rules: AssignmentRuleRow[] } | { ok: false; error: string }> {
  const hid = householdId.trim();
  if (!hid) return { ok: false, error: "Missing householdId" };
  const { data, error } = await supabase
    .from("assignment_rules")
    .select("id, template_id, template_params, helper_id, weight, active, source")
    .eq("household_id", hid)
    .eq("active", true)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const rules: AssignmentRuleRow[] = rows.map((r) => ({
    id: String(r.id),
    template_id: String(r.template_id),
    template_params: (r.template_params ?? {}) as Record<string, unknown>,
    helper_id: r.helper_id ? String(r.helper_id) : null,
    weight: Number(r.weight ?? 1),
    active: Boolean(r.active),
    source: String(r.source ?? "manual_edit"),
  }));
  return { ok: true, rules };
}

/**
 * Runtime auto-assignment hook — call after creating a chore (or on page
 * load for unassigned chores). Loads rules + helpers, runs the engine for
 * this single chore, looks up the (predicate, helper) mode, and either:
 *   • silent_auto → assigns the chore via reassignChore (mode='silent_auto')
 *   • one_tap     → returns the proposal so a "Proposed: {helper}" chip can
 *                   render on the chore card with Confirm/Change
 *   • manual/none → no-op; chore stays unassigned
 *
 * Skips chores that already have a helper or a non-pending status.
 */
export type AutoAssignResult =
  | { ok: true; action: "silent_auto"; helperId: string; ruleIds: string[] }
  | { ok: true; action: "one_tap_proposed"; helperId: string; helperName: string; ruleIds: string[] }
  | { ok: true; action: "none" }
  | { ok: false; error: string };

export async function autoAssignIfSilent(params: {
  householdId: string;
  actorUserId: string;
  choreId: string;
}): Promise<AutoAssignResult> {
  const hid = params.householdId.trim();
  const uid = params.actorUserId.trim();
  const cid = params.choreId.trim();
  if (!hid || !uid || !cid) return { ok: false, error: "Missing required arguments" };

  // 1. Load the chore. Skip if already assigned, not pending, or deleted.
  const { data: choreRow, error: choreErr } = await supabase
    .from("chores")
    .select("id, title, status, helper_id, metadata, deleted_at")
    .eq("id", cid)
    .eq("household_id", hid)
    .is("deleted_at", null)
    .maybeSingle();
  if (choreErr) return { ok: false, error: choreErr.message };
  if (!choreRow) return { ok: true, action: "none" };
  if (choreRow.helper_id) return { ok: true, action: "none" };
  if (choreRow.status !== "pending") return { ok: true, action: "none" };

  // 2. Helpers from the store (already loaded by page mount).
  const helperRows = useHelpersStore.getState().helpers;
  if (helperRows.length === 0) return { ok: true, action: "none" };

  // 3. Rules.
  const rulesResult = await fetchAssignmentRules(hid);
  const rules: AssignmentRule[] = rulesResult.ok === true
    ? rulesResult.rules.filter((r) => r.active).map((r) => ({
        id: r.id,
        template_id: r.template_id,
        template_params: r.template_params as AssignmentRule["template_params"],
        helper_id: r.helper_id,
        weight: r.weight,
        active: r.active,
      }))
    : [];

  // 4. Build the assignable inputs.
  const meta = (choreRow.metadata ?? {}) as Record<string, unknown>;
  const chore: AssignableChore = {
    id: String(choreRow.id),
    title: String(choreRow.title ?? ""),
    space: typeof meta.space === "string" ? meta.space : "",
    cadence: typeof meta.cadence === "string" ? meta.cadence : "weekly",
    estimatedMinutes: typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : 0,
    currentHelperId: null,
  };
  const assignableHelpers = helperRows.map(helperRowToAssignable);

  // 5. Run the engine on this single chore.
  const plan = buildAssignmentPlan([chore], assignableHelpers, rules);
  const a = plan.assignments[0];
  if (!a || !a.helperId) return { ok: true, action: "none" };

  // 6. Only act if a rule actually contributed. Pure tag-match picks are
  //    not confident enough to auto-assign or propose — they'd fire for
  //    every new chore and become noise.
  if (!a.ruleIds || a.ruleIds.length === 0) return { ok: true, action: "none" };

  // 7. Look up mode for (household, predicate, helper).
  const predicateHash = await fetchChorePredicateHash(cid);
  if (!predicateHash) return { ok: true, action: "none" };
  const mode = await fetchAssignmentMode({
    householdId: hid,
    actorUserId: uid,
    chorePredicateHash: predicateHash,
    helperId: a.helperId,
  });

  const helperName = helperRows.find((h) => h.id === a.helperId)?.name ?? "";

  if (mode === "silent_auto") {
    // Assign silently via reassign_chore with mode='silent_auto'.
    const r = await reassignChore({
      householdId: hid,
      actorUserId: uid,
      choreId: cid,
      newHelperId: a.helperId,
      mode: "silent_auto",
      proposedHelperId: a.helperId,
    });
    if (r.ok === false) return { ok: false, error: r.error };
    return { ok: true, action: "silent_auto", helperId: a.helperId, ruleIds: a.ruleIds };
  }

  if (mode === "one_tap") {
    return {
      ok: true,
      action: "one_tap_proposed",
      helperId: a.helperId,
      helperName,
      ruleIds: a.ruleIds,
    };
  }

  return { ok: true, action: "none" };
}

/** Dispatched after a reassignment returns `shouldNudge=true`. The NudgeCard
 *  listens and re-fetches pending nudges. */
export const NUDGE_AVAILABLE_EVENT = "homeops:nudge-available";

export function broadcastNudgeAvailable(overrideId: number): void {
  try {
    window.dispatchEvent(
      new CustomEvent(NUDGE_AVAILABLE_EVENT, { detail: { overrideId, ts: Date.now() } }),
    );
  } catch {
    // non-browser environment
  }
}
