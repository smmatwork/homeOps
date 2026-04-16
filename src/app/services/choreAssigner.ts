/**
 * Auto-assignment engine: matches chores to helpers based on
 * helper type/role, chore category/space, estimated duration,
 * and helper daily capacity.
 */

export interface AssignableChore {
  id: string;
  title: string;
  space: string;
  cadence: string;
  estimatedMinutes: number;
  currentHelperId: string | null;
}

export interface AssignableHelper {
  id: string;
  name: string;
  type: string | null;
  dailyCapacityMinutes: number;
  /** Tags like ["cleaning", "kitchen", "outdoor"] */
  roleTags: string[];
}

export interface Assignment {
  choreId: string;
  choreTitle: string;
  space: string;
  cadence: string;
  estimatedMinutes: number;
  helperId: string | null;
  helperName: string | null;
  reason: string;
}

export interface AssignmentPlan {
  assignments: Assignment[];
  byHelper: Array<{
    helper: AssignableHelper;
    chores: Assignment[];
    totalMinutes: number;
    capacityUsedPct: number;
  }>;
  unassigned: Assignment[];
}

/**
 * Infer role tags from the helper's type string.
 * e.g., "Maid" → ["cleaning", "sweeping", "mopping"]
 *        "Cook" → ["cooking", "kitchen"]
 */
export function inferRoleTags(helperType: string | null): string[] {
  if (!helperType) return ["general"];
  const lower = helperType.toLowerCase();

  if (/maid|clean|sweep|housekeeper/.test(lower))
    return ["cleaning", "sweeping", "mopping", "dusting", "bathroom", "bedroom", "living"];
  if (/cook|chef/.test(lower))
    return ["cooking", "kitchen", "dining"];
  if (/driver|chauffeur/.test(lower))
    return ["driving", "garage", "car", "outdoor"];
  if (/garden|lawn|landscap/.test(lower))
    return ["garden", "outdoor", "watering", "lawn"];
  if (/nanny|childcare|babysit/.test(lower))
    return ["childcare", "bedroom", "general"];
  if (/watch|guard|security/.test(lower))
    return ["security", "outdoor", "gate"];
  if (/wash|laundry|iron|dhobi/.test(lower))
    return ["laundry", "washing", "ironing"];
  return ["general"];
}

/**
 * Infer what category a chore belongs to from its title and space.
 */
function inferChoreCategory(title: string, space: string): string[] {
  const text = `${title} ${space}`.toLowerCase();
  const tags: string[] = [];

  if (/kitchen|cook|wipe.*counter|dish|chimney/.test(text)) tags.push("kitchen", "cooking");
  if (/clean|sweep|mop|dust|scrub/.test(text)) tags.push("cleaning", "sweeping", "mopping", "dusting");
  if (/bath|toilet|washroom/.test(text)) tags.push("bathroom", "cleaning");
  if (/bedroom|bed|master/.test(text)) tags.push("bedroom", "cleaning");
  if (/living|hall|drawing/.test(text)) tags.push("living", "cleaning");
  if (/garden|lawn|water.*plant|trim/.test(text)) tags.push("garden", "outdoor");
  if (/balcony|terrace/.test(text)) tags.push("outdoor", "cleaning");
  if (/garage|car|parking/.test(text)) tags.push("garage", "outdoor");
  if (/laundry|wash|iron/.test(text)) tags.push("laundry");
  if (/trash|garbage|disposal/.test(text)) tags.push("cleaning", "general");
  if (/dining|table/.test(text)) tags.push("dining", "cleaning");
  if (/pooja|prayer/.test(text)) tags.push("cleaning", "general");

  return tags.length > 0 ? tags : ["general"];
}

/**
 * Compute a match score between a helper's role tags and a chore's category tags.
 * Higher = better match.
 */
function matchScore(helperTags: string[], choreTags: string[]): number {
  const helperSet = new Set(helperTags);
  let score = 0;
  for (const tag of choreTags) {
    if (helperSet.has(tag)) score += 1;
  }
  // Bonus for "general" — can do anything
  if (helperSet.has("general")) score += 0.1;
  return score;
}

/**
 * Default estimated minutes by cadence if not specified.
 */
function defaultMinutes(cadence: string): number {
  switch (cadence) {
    case "daily": return 15;
    case "weekly": return 30;
    case "biweekly": return 45;
    case "monthly": return 60;
    default: return 20;
  }
}

/**
 * Build an assignment plan: match chores to helpers based on role,
 * capacity, and chore requirements. Uses a greedy best-fit algorithm.
 */
export function buildAssignmentPlan(
  chores: AssignableChore[],
  helpers: AssignableHelper[],
): AssignmentPlan {
  // Pre-compute helper tags (include inferred tags from type)
  const helperTags = new Map<string, string[]>();
  for (const h of helpers) {
    const tags = h.roleTags.length > 0 ? h.roleTags : inferRoleTags(h.type);
    helperTags.set(h.id, tags);
  }

  // Track remaining capacity per helper (daily equivalent)
  const remainingCapacity = new Map<string, number>();
  for (const h of helpers) {
    remainingCapacity.set(h.id, h.dailyCapacityMinutes);
  }

  const assignments: Assignment[] = [];

  // Sort chores: daily first (highest frequency = most important to assign),
  // then by estimated minutes descending (bigger tasks first for bin-packing)
  const cadenceOrder: Record<string, number> = { daily: 0, weekly: 1, biweekly: 2, monthly: 3 };
  const sorted = [...chores].sort((a, b) => {
    const ca = cadenceOrder[a.cadence] ?? 4;
    const cb = cadenceOrder[b.cadence] ?? 4;
    if (ca !== cb) return ca - cb;
    return b.estimatedMinutes - a.estimatedMinutes;
  });

  for (const chore of sorted) {
    const choreTags = inferChoreCategory(chore.title, chore.space);
    const mins = chore.estimatedMinutes || defaultMinutes(chore.cadence);

    // Find best matching helper with capacity
    let bestHelper: AssignableHelper | null = null;
    let bestScore = -1;

    for (const h of helpers) {
      const remaining = remainingCapacity.get(h.id) ?? 0;
      if (remaining < mins) continue; // no capacity

      const score = matchScore(helperTags.get(h.id) ?? [], choreTags);
      if (score > bestScore) {
        bestScore = score;
        bestHelper = h;
      }
    }

    if (bestHelper) {
      remainingCapacity.set(bestHelper.id, (remainingCapacity.get(bestHelper.id) ?? 0) - mins);
      assignments.push({
        choreId: chore.id,
        choreTitle: chore.title,
        space: chore.space,
        cadence: chore.cadence,
        estimatedMinutes: mins,
        helperId: bestHelper.id,
        helperName: bestHelper.name,
        reason: bestScore > 0 ? `Matched by role (${choreTags.slice(0, 2).join(", ")})` : "Best available capacity",
      });
    } else {
      assignments.push({
        choreId: chore.id,
        choreTitle: chore.title,
        space: chore.space,
        cadence: chore.cadence,
        estimatedMinutes: mins,
        helperId: null,
        helperName: null,
        reason: "No helper with matching role/capacity",
      });
    }
  }

  // Group by helper
  const byHelperMap = new Map<string, Assignment[]>();
  const unassigned: Assignment[] = [];
  for (const a of assignments) {
    if (a.helperId) {
      const list = byHelperMap.get(a.helperId) ?? [];
      list.push(a);
      byHelperMap.set(a.helperId, list);
    } else {
      unassigned.push(a);
    }
  }

  const byHelper = helpers.map((h) => {
    const hChores = byHelperMap.get(h.id) ?? [];
    const totalMinutes = hChores.reduce((s, c) => s + c.estimatedMinutes, 0);
    return {
      helper: h,
      chores: hChores,
      totalMinutes,
      capacityUsedPct: h.dailyCapacityMinutes > 0 ? Math.round((totalMinutes / h.dailyCapacityMinutes) * 100) : 0,
    };
  });

  return { assignments, byHelper, unassigned };
}
