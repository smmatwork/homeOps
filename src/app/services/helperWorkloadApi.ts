import { supabase } from "./supabaseClient";

export interface HelperWorkload {
  helperId: string;
  helperName: string;
  capacityMinutes: number;
  assignedChores: number;
  estimatedMinutes: number;
  utilizationPct: number;
  averageRating: number | null;
  feedbackCount: number;
  overdueCount: number;
  isOverCapacity: boolean;
}

const DEFAULT_MINUTES_PER_CHORE = 30;

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfTodayIso(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export async function fetchHelperWorkloads(householdId: string): Promise<{
  workloads: HelperWorkload[];
  error: string | null;
}> {
  if (!householdId) {
    return { workloads: [], error: null };
  }

  // Fetch helpers
  const { data: helpersData, error: helpersErr } = await supabase
    .from("helpers")
    .select("id,name,daily_capacity_minutes,metadata")
    .eq("household_id", householdId);

  if (helpersErr) {
    return { workloads: [], error: helpersErr.message };
  }

  const helpers = (helpersData ?? []) as Array<{
    id: string;
    name: string;
    daily_capacity_minutes: number | null;
    metadata: Record<string, unknown> | null;
  }>;

  if (helpers.length === 0) {
    return { workloads: [], error: null };
  }

  const helperIds = helpers.map((h) => h.id);

  // Fetch chores for these helpers (today + overdue)
  const todayStart = startOfTodayIso();
  const todayEnd = endOfTodayIso();

  const { data: choresData, error: choresErr } = await supabase
    .from("chores")
    .select("id,helper_id,status,due_at,metadata")
    .eq("household_id", householdId)
    .in("helper_id", helperIds)
    .is("deleted_at", null);

  if (choresErr) {
    return { workloads: [], error: choresErr.message };
  }

  const chores = (choresData ?? []) as Array<{
    id: string;
    helper_id: string | null;
    status: string;
    due_at: string | null;
    metadata: Record<string, unknown> | null;
  }>;

  // Fetch feedback
  const { data: feedbackData } = await supabase
    .from("helper_feedback")
    .select("helper_id,rating")
    .eq("household_id", householdId)
    .in("helper_id", helperIds);

  const feedback = (feedbackData ?? []) as Array<{ helper_id: string; rating: number | null }>;

  const now = new Date();
  const workloads: HelperWorkload[] = helpers.map((helper) => {
    const myChores = chores.filter((c) => c.helper_id === helper.id);
    const todayChores = myChores.filter((c) => {
      if (!c.due_at) return false;
      return c.due_at >= todayStart && c.due_at <= todayEnd && c.status !== "done";
    });
    const overdueChores = myChores.filter((c) => {
      if (!c.due_at) return false;
      return new Date(c.due_at) < now && c.status !== "done";
    });

    const estimatedMinutes = todayChores.reduce((sum, c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const minutes = typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : DEFAULT_MINUTES_PER_CHORE;
      return sum + minutes;
    }, 0);

    const capacityMinutes = helper.daily_capacity_minutes ?? 0;
    const utilizationPct = capacityMinutes > 0 ? (estimatedMinutes / capacityMinutes) * 100 : 0;

    const myFeedback = feedback.filter((f) => f.helper_id === helper.id && typeof f.rating === "number");
    const avgRating = myFeedback.length > 0
      ? myFeedback.reduce((sum, f) => sum + (f.rating ?? 0), 0) / myFeedback.length
      : null;

    return {
      helperId: helper.id,
      helperName: helper.name,
      capacityMinutes,
      assignedChores: todayChores.length,
      estimatedMinutes,
      utilizationPct,
      averageRating: avgRating,
      feedbackCount: myFeedback.length,
      overdueCount: overdueChores.length,
      isOverCapacity: capacityMinutes > 0 && estimatedMinutes > capacityMinutes,
    };
  });

  return { workloads, error: null };
}
