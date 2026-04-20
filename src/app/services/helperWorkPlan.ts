/**
 * Helper Work Plan — the primary scheduling abstraction.
 *
 * A work plan describes one helper's complete task list, grouped by frequency.
 * The scheduler materializes daily chore instances from these plans.
 * The UI renders "Alice's day today" from this structure.
 *
 * Pure types + builder functions — no side effects.
 */

import {
  type Cadence,
  ALL_CADENCES,
  cadenceIntervalDays,
  cadenceLabel,
  inferCategory,
  recommendForSpace,
  type SpaceCategory,
} from "./choreRecommendationEngine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single task in a helper's work plan. */
export interface WorkPlanTask {
  /** Stable key for dedup + idempotency. */
  key: string;
  title: string;
  description: string;
  space: string;
  category: SpaceCategory | string;
  cadence: Cadence;
  estimatedMinutes: number;
  priority: number;
}

/** A helper's complete work plan — all tasks across all frequencies. */
export interface HelperWorkPlan {
  helperId: string;
  helperName: string;
  tasks: WorkPlanTask[];
}

/** Tasks grouped by cadence for display. */
export interface CadenceGroup {
  cadence: Cadence;
  label: string;
  tasks: WorkPlanTask[];
  totalMinutes: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Group a plan's tasks by cadence, ordered from most to least frequent. */
export function groupByCadence(tasks: WorkPlanTask[]): CadenceGroup[] {
  const map = new Map<Cadence, WorkPlanTask[]>();
  for (const task of tasks) {
    const existing = map.get(task.cadence);
    if (existing) existing.push(task);
    else map.set(task.cadence, [task]);
  }

  const groups: CadenceGroup[] = [];
  for (const cadence of ALL_CADENCES) {
    const cadenceTasks = map.get(cadence);
    if (!cadenceTasks || cadenceTasks.length === 0) continue;
    groups.push({
      cadence,
      label: cadenceLabel(cadence),
      tasks: cadenceTasks,
      totalMinutes: cadenceTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0),
    });
  }

  return groups;
}

/** Get the total daily minutes for a helper (daily cadence tasks only). */
export function dailyMinutes(plan: HelperWorkPlan): number {
  return plan.tasks
    .filter((t) => t.cadence === "daily")
    .reduce((sum, t) => sum + t.estimatedMinutes, 0);
}

/**
 * Get the total minutes for a specific day.
 * Pass `occursOnDate` from the scheduler to avoid circular dependency.
 */
export function dayTotalMinutes(
  plan: HelperWorkPlan,
  date: Date,
  occursOnDate: (cadence: Cadence, date: Date, taskKey: string) => boolean,
): number {
  return plan.tasks
    .filter((t) => occursOnDate(t.cadence, date, t.key))
    .reduce((sum, t) => sum + t.estimatedMinutes, 0);
}

// ---------------------------------------------------------------------------
// Builder: generate work plans from spaces + helper assignments
// ---------------------------------------------------------------------------

export interface WorkPlanInput {
  /** Spaces from the home profile. */
  spaces: string[];
  /** Available helpers. */
  helpers: Array<{
    id: string;
    name: string;
    /** Spaces assigned to this helper (if any). Empty = auto-distribute. */
    assignedSpaces?: string[];
  }>;
}

/**
 * Generate helper work plans by distributing spaces across helpers.
 *
 * If helpers have `assignedSpaces`, those are respected.
 * Remaining spaces are distributed round-robin to balance load.
 *
 * Each space produces 2-4 tasks via the recommendation engine.
 */
export function generateWorkPlans(input: WorkPlanInput): HelperWorkPlan[] {
  const { spaces, helpers } = input;

  if (helpers.length === 0 || spaces.length === 0) return [];

  // Build space → helper mapping.
  const spaceToHelper = new Map<string, string>();
  const unassignedSpaces: string[] = [];

  // First pass: respect explicit assignments.
  for (const helper of helpers) {
    if (helper.assignedSpaces) {
      for (const space of helper.assignedSpaces) {
        spaceToHelper.set(space, helper.id);
      }
    }
  }

  // Second pass: find unassigned spaces.
  for (const space of spaces) {
    if (!spaceToHelper.has(space)) {
      unassignedSpaces.push(space);
    }
  }

  // Third pass: distribute unassigned spaces round-robin.
  for (let i = 0; i < unassignedSpaces.length; i += 1) {
    const helper = helpers[i % helpers.length];
    spaceToHelper.set(unassignedSpaces[i], helper.id);
  }

  // Generate tasks per helper.
  const planMap = new Map<string, WorkPlanTask[]>();
  for (const helper of helpers) {
    planMap.set(helper.id, []);
  }

  for (const space of spaces) {
    const helperId = spaceToHelper.get(space);
    if (!helperId) continue;

    const category = inferCategory(space);
    const recs = recommendForSpace({
      displayName: space,
      category,
      intensity: "normal",
    });

    const tasks = planMap.get(helperId);
    if (!tasks) continue;

    for (const rec of recs) {
      tasks.push({
        key: `${slugify(helperId)}_${rec.id}`,
        title: rec.title,
        description: rec.description,
        space: rec.space,
        category: rec.category,
        cadence: rec.cadence,
        estimatedMinutes: rec.estimatedMinutes,
        priority: rec.priority,
      });
    }
  }

  // Build the plan objects.
  const plans: HelperWorkPlan[] = [];
  for (const helper of helpers) {
    const tasks = planMap.get(helper.id) ?? [];
    if (tasks.length === 0) continue;
    plans.push({
      helperId: helper.id,
      helperName: helper.name,
      tasks,
    });
  }

  return plans;
}
