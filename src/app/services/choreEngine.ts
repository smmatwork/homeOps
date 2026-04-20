/**
 * Chore Engine — orchestrator that composes FSM + Scheduler + Reactor.
 *
 * This is the single entry point for the UI and automation system.
 * It fetches all required data, runs the pure layers, validates through
 * the FSM, and either auto-applies mutations or returns them for user
 * confirmation.
 */

import { supabase } from "./supabaseClient";
import { executeToolCall } from "./agentApi";
import { normalizeSpacesToRooms } from "../config/homeProfileTemplates";
import { inferCategory, type Cadence } from "./choreRecommendationEngine";
import { generateRoomTemplates, type SpaceProfile } from "./choreRecommendationEngine";
import { generateWorkPlans, type HelperWorkPlan } from "./helperWorkPlan";
import { transition, mapLegacyStatus, type ChoreState } from "./choreStateMachine";
import {
  scheduleChores,
  flatToRoomTemplates,
  type ChoreTemplate,
  type RoomTemplate,
  type ChoreMutation,
  type HelperInfo,
  type TimeOffPeriod,
  type ExistingChore,
} from "./choreScheduler";
import {
  reactToSignals,
  type ChoreAdjustment,
  type ReactorChore,
  type ReactorEvent,
  type ReactorFeedback,
  type ReactorTimeOff,
} from "./choreReactor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncOptions {
  /** 'auto' applies immediately; 'confirm' returns mutations for UI review. */
  mode: "auto" | "confirm";
  /** Days to schedule ahead. Default 7. */
  horizon?: number;
  /** What triggered this sync. Used for audit logging. */
  trigger?: "page_load" | "event_insert" | "feedback" | "manual";
}

export interface SyncResult {
  /** New chore instances the scheduler wants to create. */
  schedulerMutations: ChoreMutation[];
  /** Adjustments the reactor wants to make to existing chores. */
  reactorAdjustments: ChoreAdjustment[];
  /** How many were actually applied (0 if mode='confirm'). */
  applied: number;
  /** How many failed to apply. */
  failed: number;
  /** How many are pending user confirmation (all of them if mode='confirm'). */
  pendingConfirmation: number;
  /** Errors encountered during apply. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface FetchedData {
  workPlans: HelperWorkPlan[];
  roomTemplates: RoomTemplate[];
  existingChores: ExistingChore[];
  helpers: HelperInfo[];
  timeOff: TimeOffPeriod[];
  events: ReactorEvent[];
  feedback: ReactorFeedback[];
  reactorChores: ReactorChore[];
}

async function fetchAllData(householdId: string): Promise<{ data: FetchedData | null; error: string | null }> {
  // Run all queries in parallel.
  const [
    templatesRes,
    choresRes,
    helpersRes,
    timeOffRes,
    eventsRes,
    feedbackRes,
    profileRes,
  ] = await Promise.all([
    supabase.from("chore_templates").select("*").eq("household_id", householdId).eq("active", true),
    supabase.from("chores").select("id,title,status,due_at,helper_id,metadata,template_id").eq("household_id", householdId).is("deleted_at", null),
    supabase.from("helpers").select("id,name,daily_capacity_minutes,metadata").eq("household_id", householdId),
    supabase.from("member_time_off").select("helper_id,start_at,end_at").eq("member_kind", "helper"),
    supabase.from("household_events").select("id,type,start_at,end_at,metadata").eq("household_id", householdId).order("start_at", { ascending: false }).limit(50),
    supabase.from("helper_feedback").select("helper_id,rating,created_at").eq("household_id", householdId).order("created_at", { ascending: false }).limit(100),
    supabase.from("home_profiles").select("spaces").eq("household_id", householdId).maybeSingle(),
  ]);

  // Check for fatal errors (any single query failing aborts).
  const errors = [templatesRes.error, choresRes.error, helpersRes.error, timeOffRes.error, eventsRes.error, feedbackRes.error]
    .filter(Boolean)
    .map((e) => e!.message);
  if (errors.length > 0) {
    return { data: null, error: errors.join("; ") };
  }

  // Parse helpers with feedback ratings.
  const helpersRaw = (helpersRes.data ?? []) as Array<{
    id: string;
    name: string;
    daily_capacity_minutes: number | null;
    metadata: Record<string, unknown> | null;
  }>;
  const feedbackRows = (feedbackRes.data ?? []) as Array<{
    helper_id: string;
    rating: number;
    created_at: string;
  }>;

  // Compute average rating per helper.
  const ratingsMap = new Map<string, number[]>();
  for (const fb of feedbackRows) {
    const arr = ratingsMap.get(fb.helper_id) ?? [];
    arr.push(fb.rating);
    ratingsMap.set(fb.helper_id, arr);
  }

  const helpers: HelperInfo[] = helpersRaw.map((h) => {
    const ratings = ratingsMap.get(h.id);
    return {
      id: h.id,
      name: h.name,
      capacityMinutes: h.daily_capacity_minutes ?? 0,
      averageRating: ratings ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    };
  });

  // Build helper work plans: the preferred scheduling unit.
  // Each helper gets a plan with tasks distributed from the home profile spaces.
  let workPlans: HelperWorkPlan[] = [];

  // Extract spaces from home profile.
  let profileSpaces: string[] = [];
  if (profileRes.data) {
    let rawSpaces: unknown = (profileRes.data as any)?.spaces;
    if (typeof rawSpaces === "string") {
      try { rawSpaces = JSON.parse(rawSpaces); } catch { /* ignore */ }
    }
    profileSpaces = normalizeSpacesToRooms(rawSpaces)
      .map((rm) => (rm.display_name || rm.template_name || "").trim())
      .filter(Boolean);
  }

  if (helpers.length > 0 && profileSpaces.length > 0) {
    // Generate work plans from helpers + spaces.
    workPlans = generateWorkPlans({
      spaces: profileSpaces,
      helpers: helpers.map((h) => ({ id: h.id, name: h.name })),
    });
  }

  // Legacy fallback: if no helpers, use room templates.
  let roomTemplates: RoomTemplate[] = [];
  if (workPlans.length === 0) {
    const flatTemplates = ((templatesRes.data ?? []) as Array<Record<string, unknown>>).map((r): ChoreTemplate => ({
      id: String(r.id),
      title: String(r.title ?? ""),
      space: typeof r.space === "string" ? r.space : null,
      cadence: (String(r.cadence ?? "weekly")) as Cadence,
      priority: typeof r.priority === "number" ? r.priority : 1,
      estimatedMinutes: typeof r.estimated_minutes === "number" ? r.estimated_minutes : null,
      defaultHelperId: typeof r.default_helper_id === "string" ? r.default_helper_id : null,
      metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>,
    }));

    if (flatTemplates.length > 0) {
      roomTemplates = flatToRoomTemplates(flatTemplates);
    } else if (profileSpaces.length > 0) {
      const profiles: SpaceProfile[] = profileSpaces.map((name) => ({
        displayName: name,
        category: inferCategory(name),
        intensity: "normal" as const,
      }));
      roomTemplates = generateRoomTemplates(profiles);
    }
  }

  // Parse existing chores.
  const choresRaw = (choresRes.data ?? []) as Array<Record<string, unknown>>;
  const existingChores: ExistingChore[] = choresRaw.map((c) => ({
    id: String(c.id),
    templateId: typeof c.template_id === "string" ? c.template_id : null,
    title: String(c.title ?? ""),
    dueAt: typeof c.due_at === "string" ? c.due_at : null,
    status: String(c.status ?? "pending"),
    helperId: typeof c.helper_id === "string" ? c.helper_id : null,
    metadata: (c.metadata && typeof c.metadata === "object" ? c.metadata : null) as Record<string, unknown> | null,
  }));

  // Build reactor-compatible chore list.
  const reactorChores: ReactorChore[] = existingChores.map((c) => {
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    return {
      id: c.id,
      title: c.title,
      status: mapLegacyStatus(c.status),
      dueAt: c.dueAt,
      helperId: c.helperId,
      space: typeof meta.space === "string" ? meta.space : null,
      cadence: typeof meta.cadence === "string" ? meta.cadence as Cadence : null,
      priority: typeof meta.priority === "number" ? meta.priority : 1,
    };
  });

  // Parse time-off.
  const timeOff: TimeOffPeriod[] = ((timeOffRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    helperId: String(r.helper_id ?? ""),
    startAt: String(r.start_at ?? ""),
    endAt: String(r.end_at ?? ""),
  }));

  // Parse events.
  const events: ReactorEvent[] = ((eventsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    type: String(r.type ?? ""),
    startAt: String(r.start_at ?? ""),
    endAt: typeof r.end_at === "string" ? r.end_at : null,
    metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>,
  }));

  // Parse feedback for reactor (with space info from chores).
  const choreHelpersSpaces = new Map<string, string | null>();
  for (const c of reactorChores) {
    if (c.helperId && c.space) choreHelpersSpaces.set(c.helperId, c.space);
  }
  const reactorFeedback: ReactorFeedback[] = feedbackRows.map((fb) => ({
    helperId: fb.helper_id,
    space: choreHelpersSpaces.get(fb.helper_id) ?? null,
    rating: fb.rating,
    createdAt: fb.created_at,
  }));

  return {
    data: {
      workPlans,
      roomTemplates,
      existingChores,
      helpers,
      timeOff,
      events,
      feedback: reactorFeedback,
      reactorChores,
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Apply mutations
// ---------------------------------------------------------------------------

async function applySchedulerMutation(
  mutation: ChoreMutation,
  accessToken: string,
  householdId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await executeToolCall({
    accessToken,
    householdId,
    scope: "household",
    toolCall: {
      id: `engine_sched_${mutation.templateId}_${Date.now()}`,
      tool: "db.insert",
      args: {
        table: "chores",
        record: {
          title: mutation.title,
          status: mutation.status === "assigned" ? "pending" : "pending", // Map to legacy until migration is applied
          priority: mutation.priority,
          due_at: mutation.dueAt,
          helper_id: mutation.helperId,
          template_id: mutation.templateId,
          metadata: mutation.metadata,
        },
      },
      reason: `Chore engine: schedule "${mutation.title}" for ${mutation.dueAt.slice(0, 10)}`,
    },
  });
  return res.ok ? { ok: true } : { ok: false, error: "error" in res ? res.error : "Failed" };
}

async function applyReactorAdjustment(
  adj: ChoreAdjustment,
  accessToken: string,
  householdId: string,
): Promise<{ ok: boolean; error?: string }> {
  switch (adj.type) {
    case "reassign": {
      if (!adj.choreId || !adj.toHelperId) return { ok: false, error: "Missing choreId or toHelperId" };
      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `engine_react_reassign_${adj.choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: adj.choreId, patch: { helper_id: adj.toHelperId } },
          reason: `Chore engine: ${adj.reason}`,
        },
      });
      return res.ok ? { ok: true } : { ok: false, error: "error" in res ? res.error : "Failed" };
    }

    case "skip": {
      if (!adj.choreId) return { ok: false, error: "Missing choreId" };
      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `engine_react_skip_${adj.choreId}_${Date.now()}`,
          tool: "db.update",
          args: {
            table: "chores",
            id: adj.choreId,
            patch: {
              status: "done", // Map "skipped" to "done" for legacy compatibility
              metadata: { skip_reason: adj.skipReason, skipped_by: "engine" },
            },
          },
          reason: `Chore engine: ${adj.reason}`,
        },
      });
      return res.ok ? { ok: true } : { ok: false, error: "error" in res ? res.error : "Failed" };
    }

    case "create": {
      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `engine_react_create_${Date.now()}`,
          tool: "db.insert",
          args: {
            table: "chores",
            record: {
              title: adj.createTitle ?? "Untitled chore",
              status: "pending",
              priority: 3,
              due_at: adj.createDueAt,
              metadata: {
                space: adj.createSpace,
                cadence: adj.createCadence,
                source: "chore_reactor",
                signal: adj.signal,
              },
            },
          },
          reason: `Chore engine: ${adj.reason}`,
        },
      });
      return res.ok ? { ok: true } : { ok: false, error: "error" in res ? res.error : "Failed" };
    }

    case "reprioritize": {
      if (!adj.choreId) return { ok: false, error: "Missing choreId" };
      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `engine_react_reprio_${adj.choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: adj.choreId, patch: { priority: adj.newPriority ?? 3 } },
          reason: `Chore engine: ${adj.reason}`,
        },
      });
      return res.ok ? { ok: true } : { ok: false, error: "error" in res ? res.error : "Failed" };
    }

    default:
      return { ok: false, error: `Unknown adjustment type: ${adj.type}` };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function syncChoreSchedule(
  householdId: string,
  accessToken: string,
  options: SyncOptions = { mode: "confirm" },
): Promise<SyncResult> {
  const { mode, horizon = 7, trigger = "manual" } = options;

  // 1. Fetch all data.
  const { data, error } = await fetchAllData(householdId);
  if (error || !data) {
    return {
      schedulerMutations: [],
      reactorAdjustments: [],
      applied: 0,
      failed: 0,
      pendingConfirmation: 0,
      errors: [error ?? "Failed to fetch data"],
    };
  }

  // 2. Run the scheduler.
  const schedulerOutput = scheduleChores({
    workPlans: data.workPlans.length > 0 ? data.workPlans : undefined,
    roomTemplates: data.workPlans.length > 0 ? undefined : (data.roomTemplates.length > 0 ? data.roomTemplates : undefined),
    existingChores: data.existingChores,
    helpers: data.helpers,
    timeOff: data.timeOff,
    horizon,
  });

  // 3. Run the reactor.
  const reactorAdjustments = reactToSignals({
    chores: data.reactorChores,
    events: data.events,
    helpers: data.helpers.map((h) => ({ id: h.id, name: h.name })),
    feedback: data.feedback,
    timeOff: data.timeOff.map((t) => ({
      helperId: t.helperId,
      startAt: t.startAt,
      endAt: t.endAt,
    })),
  });

  const totalActions = schedulerOutput.mutations.length + reactorAdjustments.length;

  // 4. If confirm mode, return everything for the UI.
  if (mode === "confirm") {
    return {
      schedulerMutations: schedulerOutput.mutations,
      reactorAdjustments,
      applied: 0,
      failed: 0,
      pendingConfirmation: totalActions,
      errors: [],
    };
  }

  // 5. Auto mode: apply everything.
  let applied = 0;
  let failed = 0;
  const applyErrors: string[] = [];

  for (const mutation of schedulerOutput.mutations) {
    const res = await applySchedulerMutation(mutation, accessToken, householdId);
    if (res.ok) applied += 1;
    else {
      failed += 1;
      if (res.error) applyErrors.push(res.error);
    }
  }

  for (const adj of reactorAdjustments) {
    const res = await applyReactorAdjustment(adj, accessToken, householdId);
    if (res.ok) applied += 1;
    else {
      failed += 1;
      if (res.error) applyErrors.push(res.error);
    }
  }

  return {
    schedulerMutations: schedulerOutput.mutations,
    reactorAdjustments,
    applied,
    failed,
    pendingConfirmation: 0,
    errors: applyErrors,
  };
}
