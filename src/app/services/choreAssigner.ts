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
  /** "helper" or "member" — members are household residents */
  kind?: "helper" | "member";
  /** Days the helper works, e.g., ["mon","tue","wed","thu","fri"] */
  workDays?: string[];
}

export interface Assignment {
  choreId: string;
  choreTitle: string;
  space: string;
  cadence: string;
  estimatedMinutes: number;
  helperId: string | null;
  helperName: string | null;
  /** If the assignee is a household person instead of a helper. */
  assigneePersonId?: string | null;
  /** "helper" or "person" */
  assigneeKind?: "helper" | "person";
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

  // Kitchen
  if (/kitchen|cook|wipe.*counter|dish|chimney|hob|stove|sink|fridge/.test(text)) tags.push("kitchen", "cooking");
  // Cleaning (surface-level)
  if (/clean|sweep|mop|dust|scrub|wipe/.test(text)) tags.push("cleaning", "sweeping", "mopping", "dusting");
  // Glass and mirrors
  if (/glass|mirror|window.*clean/.test(text)) tags.push("cleaning", "glass");
  // Carpet and upholstery
  if (/carpet|rug|vacuum|upholstery|sofa.*wipe|sofa.*clean/.test(text)) tags.push("cleaning", "carpet");
  // Fans and fixtures
  if (/fan.*dust|ceiling.*fan|light.*fixture|switchboard|cobweb/.test(text)) tags.push("cleaning", "fixtures");
  // Bathrooms
  if (/bath|toilet|washroom|powder/.test(text)) tags.push("bathroom", "cleaning");
  // Bedrooms
  if (/bedroom|bed.*mak|master|kids.*room|guest.*room|parent|wardrobe/.test(text)) tags.push("bedroom", "cleaning");
  // Living areas
  if (/living|hall|drawing|foyer|formal/.test(text)) tags.push("living", "cleaning");
  // Garden and outdoor
  if (/garden|lawn|water.*plant|trim|weed|courtyard/.test(text)) tags.push("garden", "outdoor");
  if (/balcony|terrace|deck|verandah|patio/.test(text)) tags.push("outdoor", "cleaning");
  if (/garage|car|parking|porch/.test(text)) tags.push("garage", "outdoor");
  // Laundry
  if (/laundry|wash.*cloth|iron|fold.*cloth|press/.test(text)) tags.push("laundry");
  // General
  if (/trash|garbage|disposal|segregat/.test(text)) tags.push("cleaning", "general");
  if (/dining|table.*wipe/.test(text)) tags.push("dining", "cleaning");
  if (/pooja|prayer|temple/.test(text)) tags.push("cleaning", "general");
  // Study / office
  if (/study|office|library|desk|screen|electronic/.test(text)) tags.push("cleaning", "general");
  // Pantry / store
  if (/pantry|store.*room|expiry|shelf|organize/.test(text)) tags.push("cleaning", "kitchen");
  // Stairs
  if (/stair|railing|banister/.test(text)) tags.push("cleaning", "general");
  // AC / appliances
  if (/ac.*filter|mattress|flip/.test(text)) tags.push("cleaning", "fixtures");
  // Shoe rack
  if (/shoe.*rack/.test(text)) tags.push("cleaning", "general");
  // Bicycle maintenance
  if (/bicycle|bike.*chain|tyre.*pressure/.test(text)) tags.push("maintenance", "outdoor");
  // Cushion care
  if (/cushion.*air|cushion.*clean/.test(text)) tags.push("outdoor", "cleaning");
  // CCTV / security
  if (/cctv|camera.*lens/.test(text)) tags.push("maintenance", "general");
  // Washing machine
  if (/washing\s*machine.*drum|hot\s*cycle/.test(text)) tags.push("maintenance", "laundry");
  // Wood floor
  if (/wood.*floor.*polish|floor.*condition/.test(text)) tags.push("maintenance", "cleaning");
  // Carpet deep clean
  if (/carpet.*deep.*clean/.test(text)) tags.push("cleaning", "general");

  return tags.length > 0 ? tags : ["general"];
}

/**
 * Compute a match score between a helper's role tags and a chore's category tags.
 * Higher = better match.
 */
function matchScore(helperTags: string[], choreTags: string[], helperType: string | null): number {
  const helperSet = new Set(helperTags);
  let score = 0;
  for (const tag of choreTags) {
    if (helperSet.has(tag)) score += 1;
  }
  // Bonus for "general" — can do anything
  if (helperSet.has("general")) score += 0.1;

  // Strong bonus: if the helper's type directly matches the chore category
  // e.g., Cook + kitchen/cooking chores → big boost to ensure cook gets cooking tasks
  const typeLower = (helperType ?? "").toLowerCase();
  if (typeLower === "cook" && choreTags.includes("cooking")) score += 5;
  if (typeLower === "cook" && choreTags.includes("kitchen")) score += 3;
  if ((typeLower === "maid" || typeLower === "cleaner") && choreTags.includes("cleaning")) score += 2;
  if (typeLower === "gardener" && choreTags.includes("garden")) score += 5;
  if (typeLower === "driver" && choreTags.includes("driving")) score += 5;
  if ((typeLower === "washer" || typeLower === "dhobi") && choreTags.includes("laundry")) score += 5;

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

/** Days of the week for distributing weekly chores */
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** What fraction of daily capacity does this cadence consume? */
function cadenceLoadFactor(cadence: string): number {
  if (cadence === "daily" || cadence === "alternate_days") return 1.0;
  if (cadence.startsWith("weekly")) return 1.0 / 6; // spreads across ~6 working days
  if (cadence.startsWith("biweekly")) return 1.0 / 12;
  if (cadence === "monthly") return 1.0 / 26; // ~26 working days/month
  if (/every_\d_days/.test(cadence)) {
    const n = parseInt(cadence.split("_")[1], 10) || 3;
    return 1.0 / n;
  }
  return 1.0 / 6;
}

/** Monthly day options — first Saturday, first Sunday, or specific dates */
const MONTHLY_SLOTS = [
  "monthly_1st_sat", "monthly_1st_sun", "monthly_2nd_sat",
  "monthly_3rd_sat", "monthly_last_sat",
] as const;

/** Pick a specific day for weekly/biweekly/monthly cadence, distributing across days */
function assignDay(
  cadence: string,
  helperDayLoads: Map<string, Record<string, number>>,
  helperId: string,
  mins: number,
): string {
  // If cadence already has a specific day, keep it
  if (/_(mon|tue|wed|thu|fri|sat|sun)$/.test(cadence)) return cadence;
  if (/monthly_/.test(cadence)) return cadence;

  if (!helperDayLoads.has(helperId)) helperDayLoads.set(helperId, {});
  const dayLoads = helperDayLoads.get(helperId)!;

  if (cadence === "monthly") {
    // Distribute monthly chores across different weekends
    let bestSlot: string = MONTHLY_SLOTS[0];
    let bestLoad = Infinity;
    for (const slot of MONTHLY_SLOTS) {
      const load = dayLoads[slot] ?? 0;
      if (load < bestLoad) { bestLoad = load; bestSlot = slot; }
    }
    dayLoads[bestSlot] = (dayLoads[bestSlot] ?? 0) + mins;
    return bestSlot;
  }

  // For generic "weekly" or "biweekly", find the least-loaded day
  const prefix = cadence.startsWith("biweekly") ? "biweekly" : "weekly";
  let bestDay = "sat";
  let bestLoad = Infinity;
  for (const day of WEEKDAYS) {
    const load = dayLoads[`${prefix}_${day}`] ?? 0;
    if (load < bestLoad) { bestLoad = load; bestDay = day; }
  }

  const key = `${prefix}_${bestDay}`;
  dayLoads[key] = (dayLoads[key] ?? 0) + mins;
  return `${prefix}_${bestDay}`;
}

/**
 * Build an assignment plan: match chores to helpers based on role,
 * capacity, schedule, and estimated duration. Distributes weekly/monthly
 * chores across different days to avoid overloading any single day.
 */
export function buildAssignmentPlan(
  chores: AssignableChore[],
  helpers: AssignableHelper[],
): AssignmentPlan {
  // Pre-compute helper tags
  const helperTags = new Map<string, string[]>();
  for (const h of helpers) {
    const tags = h.roleTags.length > 0 ? h.roleTags : inferRoleTags(h.type);
    helperTags.set(h.id, tags);
  }

  // Track effective daily load per helper (accounting for cadence frequency)
  const effectiveDailyLoad = new Map<string, number>();
  for (const h of helpers) {
    effectiveDailyLoad.set(h.id, 0);
  }

  // Track per-day loads for distributing weekly/biweekly chores
  const helperDayLoads = new Map<string, Record<string, number>>();

  const assignments: Assignment[] = [];

  // Sort: daily first, then by estimated minutes desc (bin-packing)
  const cadenceOrder: Record<string, number> = {
    daily: 0, alternate_days: 1,
    every_2_days: 1, every_3_days: 2, every_4_days: 2, every_5_days: 2,
    weekly: 3, biweekly: 4, monthly: 5,
  };
  const sorted = [...chores].sort((a, b) => {
    const ca = cadenceOrder[a.cadence.split("_")[0]] ?? (cadenceOrder[a.cadence] ?? 4);
    const cb = cadenceOrder[b.cadence.split("_")[0]] ?? (cadenceOrder[b.cadence] ?? 4);
    if (ca !== cb) return ca - cb;
    return b.estimatedMinutes - a.estimatedMinutes;
  });

  for (const chore of sorted) {
    const choreTags = inferChoreCategory(chore.title, chore.space);
    const mins = chore.estimatedMinutes || defaultMinutes(chore.cadence);
    const loadFactor = cadenceLoadFactor(chore.cadence);
    const effectiveMins = mins * loadFactor; // daily equivalent load

    // Find best matching helper with capacity
    let bestHelper: AssignableHelper | null = null;
    let bestScore = -1;

    for (const h of helpers) {
      const currentLoad = effectiveDailyLoad.get(h.id) ?? 0;
      const remaining = h.dailyCapacityMinutes - currentLoad;
      if (remaining < effectiveMins) continue; // no capacity

      // Check if the helper works on the day this chore is scheduled
      if (h.workDays && h.workDays.length > 0) {
        const choreDay = chore.cadence.match(/_(mon|tue|wed|thu|fri|sat|sun)$/)?.[1];
        if (choreDay && !h.workDays.includes(choreDay)) continue; // doesn't work this day
        // For daily chores, helper must work at least some days
        if (chore.cadence === "daily" && h.workDays.length === 0) continue;
      }

      const score = matchScore(helperTags.get(h.id) ?? [], choreTags, h.type);
      if (score > bestScore) {
        bestScore = score;
        bestHelper = h;
      }
    }

    // Pick a specific day for weekly/biweekly/monthly chores
    let finalCadence = chore.cadence;
    if (bestHelper && (chore.cadence === "weekly" || chore.cadence === "biweekly" || chore.cadence === "monthly")) {
      finalCadence = assignDay(chore.cadence, helperDayLoads, bestHelper.id, mins);
    }

    if (bestHelper) {
      const isPerson = bestHelper.kind === "member";
      effectiveDailyLoad.set(bestHelper.id, (effectiveDailyLoad.get(bestHelper.id) ?? 0) + effectiveMins);
      assignments.push({
        choreId: chore.id,
        choreTitle: chore.title,
        space: chore.space,
        cadence: finalCadence,
        estimatedMinutes: mins,
        helperId: isPerson ? null : bestHelper.id,
        helperName: bestHelper.name,
        assigneePersonId: isPerson ? bestHelper.id : null,
        assigneeKind: isPerson ? "person" : "helper",
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
        assigneeKind: undefined,
        reason: "No helper or member with matching role/capacity",
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
    // Effective daily load = sum of (minutes * cadence frequency factor)
    const dailyLoad = effectiveDailyLoad.get(h.id) ?? 0;
    const totalMinutes = Math.round(dailyLoad); // daily equivalent
    return {
      helper: h,
      chores: hChores,
      totalMinutes,
      capacityUsedPct: h.dailyCapacityMinutes > 0 ? Math.round((dailyLoad / h.dailyCapacityMinutes) * 100) : 0,
    };
  });

  return { assignments, byHelper, unassigned };
}

/**
 * Detect and resolve assignment conflicts for user-only households.
 *
 * When chores are distributed among household members (not professional helpers),
 * members have limited daily capacity. This function:
 * 1. Detects over-allocation: a member has more daily-equivalent minutes than capacity
 * 2. Redistributes: moves excess chores to less-loaded members
 * 3. Reports: returns a list of conflicts that couldn't be auto-resolved
 */
export interface ConflictReport {
  resolved: Array<{
    choreId: string;
    choreTitle: string;
    fromMemberId: string;
    fromMemberName: string;
    toMemberId: string;
    toMemberName: string;
    reason: string;
  }>;
  unresolved: Array<{
    choreId: string;
    choreTitle: string;
    memberId: string;
    memberName: string;
    reason: string;
  }>;
}

// ─── Capacity-Aware Schedule Adjustment ─────────────────────────

export interface CapacityAdjustment {
  choreId: string;
  choreTitle: string;
  originalHelperId: string;
  originalHelperName: string;
  action: "defer" | "reassign" | "flag";
  newHelperId?: string;
  newHelperName?: string;
  reason: string;
}

/**
 * Adjust a generated schedule based on available helper capacity.
 * Identifies over-allocated helpers and either defers, reassigns, or
 * flags chores that exceed capacity on a given day.
 */
export function adjustScheduleForCapacity(
  assignments: Assignment[],
  helpers: AssignableHelper[],
  timeOff: Array<{ helperId: string; startAt: string; endAt: string }>,
  targetDate: Date,
): CapacityAdjustment[] {
  const adjustments: CapacityAdjustment[] = [];
  const helperMap = new Map(helpers.map((h) => [h.id, h]));

  // Compute load per helper for the target date
  const helperLoad = new Map<string, number>();
  const helperChores = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const hid = a.helperId ?? a.assigneePersonId;
    if (!hid) continue;
    const factor = cadenceLoadFactor(a.cadence);
    helperLoad.set(hid, (helperLoad.get(hid) ?? 0) + a.estimatedMinutes * factor);
    if (!helperChores.has(hid)) helperChores.set(hid, []);
    helperChores.get(hid)!.push(a);
  }

  // Check time-off exclusions
  const dateMs = targetDate.getTime();
  const onLeave = new Set<string>();
  for (const to of timeOff) {
    if (new Date(to.startAt).getTime() <= dateMs && dateMs < new Date(to.endAt).getTime()) {
      onLeave.add(to.helperId);
    }
  }

  for (const [hid, load] of helperLoad) {
    const helper = helperMap.get(hid);
    if (!helper) continue;

    // If helper is on leave, reassign all their chores
    if (onLeave.has(hid)) {
      for (const chore of helperChores.get(hid) ?? []) {
        const replacement = findReplacementHelper(chore, hid, helpers, helperLoad, onLeave);
        adjustments.push({
          choreId: chore.choreId,
          choreTitle: chore.choreTitle,
          originalHelperId: hid,
          originalHelperName: helper.name,
          action: replacement ? "reassign" : "flag",
          newHelperId: replacement?.id,
          newHelperName: replacement?.name,
          reason: replacement
            ? `${helper.name} on leave — reassigned to ${replacement.name}`
            : `${helper.name} on leave — no replacement available`,
        });
      }
      continue;
    }

    // If over capacity, shed lowest-priority chores
    if (load > helper.dailyCapacityMinutes) {
      const excess = load - helper.dailyCapacityMinutes;
      let shed = 0;
      const chores = (helperChores.get(hid) ?? [])
        .sort((a, b) => a.estimatedMinutes - b.estimatedMinutes);

      for (const chore of chores) {
        if (shed >= excess) break;
        const factor = cadenceLoadFactor(chore.cadence);
        const replacement = findReplacementHelper(chore, hid, helpers, helperLoad, onLeave);
        adjustments.push({
          choreId: chore.choreId,
          choreTitle: chore.choreTitle,
          originalHelperId: hid,
          originalHelperName: helper.name,
          action: replacement ? "reassign" : "defer",
          newHelperId: replacement?.id,
          newHelperName: replacement?.name,
          reason: replacement
            ? `${helper.name} over capacity — reassigned to ${replacement.name}`
            : `${helper.name} over capacity — deferred to next available slot`,
        });
        shed += chore.estimatedMinutes * factor;
      }
    }
  }

  return adjustments;
}

function findReplacementHelper(
  chore: Assignment,
  excludeId: string,
  helpers: AssignableHelper[],
  currentLoads: Map<string, number>,
  onLeave: Set<string>,
): AssignableHelper | null {
  const choreTags = inferChoreCategory(chore.choreTitle, chore.space);
  let best: AssignableHelper | null = null;
  let bestScore = -1;

  for (const h of helpers) {
    if (h.id === excludeId || onLeave.has(h.id)) continue;
    const load = currentLoads.get(h.id) ?? 0;
    const factor = cadenceLoadFactor(chore.cadence);
    if (load + chore.estimatedMinutes * factor > h.dailyCapacityMinutes) continue;

    const tags = h.roleTags.length > 0 ? h.roleTags : inferRoleTags(h.type);
    const score = matchScore(tags, choreTags, h.type);
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

// ─── Optimal Schedule Recommendation ────────────────────────────

export interface ScheduleRecommendation {
  choreId: string;
  choreTitle: string;
  recommendedHelperId: string;
  recommendedHelperName: string;
  recommendedCadence: string;
  score: number;
  reason: string;
}

/**
 * Recommend the optimal schedule for a set of chores considering
 * helper capacity, role fit, and existing load distribution.
 * Returns a sorted list of recommendations (highest score first).
 */
export function recommendOptimalSchedule(
  chores: AssignableChore[],
  helpers: AssignableHelper[],
): ScheduleRecommendation[] {
  const recommendations: ScheduleRecommendation[] = [];

  // Build current plan to understand load
  const plan = buildAssignmentPlan(chores, helpers);
  const usedCapacity = new Map<string, number>();
  for (const bh of plan.byHelper) {
    usedCapacity.set(bh.helper.id, bh.totalMinutes);
  }

  for (const chore of chores) {
    const choreTags = inferChoreCategory(chore.title, chore.space);
    const mins = chore.estimatedMinutes || defaultMinutes(chore.cadence);

    // Score each helper
    const scored: Array<{ helper: AssignableHelper; score: number; reason: string }> = [];

    for (const h of helpers) {
      const tags = h.roleTags.length > 0 ? h.roleTags : inferRoleTags(h.type);
      const roleScore = matchScore(tags, choreTags, h.type);
      const load = usedCapacity.get(h.id) ?? 0;
      const remaining = h.dailyCapacityMinutes - load;
      if (remaining < mins * cadenceLoadFactor(chore.cadence)) continue;

      // Capacity score: prefer helpers with more headroom (0-5 scale)
      const capacityScore = h.dailyCapacityMinutes > 0
        ? (remaining / h.dailyCapacityMinutes) * 5
        : 0;

      // Work-day fit
      let dayFitScore = 1;
      if (h.workDays && h.workDays.length > 0) {
        const choreDay = chore.cadence.match(/_(mon|tue|wed|thu|fri|sat|sun)$/)?.[1];
        if (choreDay && h.workDays.includes(choreDay)) dayFitScore = 2;
        else if (choreDay && !h.workDays.includes(choreDay)) dayFitScore = 0;
      }

      const totalScore = roleScore * 3 + capacityScore + dayFitScore;
      const reasons: string[] = [];
      if (roleScore > 2) reasons.push("strong role match");
      else if (roleScore > 0) reasons.push("partial role match");
      if (capacityScore > 3) reasons.push("ample capacity");
      if (dayFitScore === 2) reasons.push("works on scheduled day");

      scored.push({
        helper: h,
        score: Math.round(totalScore * 100) / 100,
        reason: reasons.length > 0 ? reasons.join(", ") : "available",
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best) {
      recommendations.push({
        choreId: chore.id,
        choreTitle: chore.title,
        recommendedHelperId: best.helper.id,
        recommendedHelperName: best.helper.name,
        recommendedCadence: chore.cadence,
        score: best.score,
        reason: best.reason,
      });
    }
  }

  recommendations.sort((a, b) => b.score - a.score);
  return recommendations;
}

// ─── Multi-User Conflict Resolution ───────���────────────────────

export function resolveMultiUserConflicts(
  assignments: Assignment[],
  members: AssignableHelper[],
): ConflictReport {
  const report: ConflictReport = { resolved: [], unresolved: [] };
  if (members.length <= 1) return report;

  // Only process person assignments
  const personAssignments = assignments.filter((a) => a.assigneeKind === "person" && a.assigneePersonId);
  if (personAssignments.length === 0) return report;

  // Compute daily-equivalent load per member
  const memberLoad = new Map<string, number>();
  for (const m of members) memberLoad.set(m.id, 0);
  for (const a of personAssignments) {
    const pid = a.assigneePersonId!;
    const factor = cadenceLoadFactor(a.cadence);
    memberLoad.set(pid, (memberLoad.get(pid) ?? 0) + a.estimatedMinutes * factor);
  }

  // Find over-loaded members
  for (const member of members) {
    if (member.kind !== "member") continue;
    const load = memberLoad.get(member.id) ?? 0;
    if (load <= member.dailyCapacityMinutes) continue;

    // This member is over-loaded — find chores to move
    const excess = load - member.dailyCapacityMinutes;
    let moved = 0;

    // Sort this member's chores: lowest priority first (move the least important)
    const memberChores = personAssignments
      .filter((a) => a.assigneePersonId === member.id)
      .sort((a, b) => a.estimatedMinutes - b.estimatedMinutes);

    for (const chore of memberChores) {
      if (moved >= excess) break;

      // Find least-loaded other member with capacity
      let bestTarget: AssignableHelper | null = null;
      let bestLoadDelta = Infinity;
      for (const other of members) {
        if (other.id === member.id || other.kind !== "member") continue;
        const otherLoad = memberLoad.get(other.id) ?? 0;
        const factor = cadenceLoadFactor(chore.cadence);
        const addedLoad = chore.estimatedMinutes * factor;
        if (otherLoad + addedLoad > other.dailyCapacityMinutes) continue;
        if (otherLoad < bestLoadDelta) {
          bestLoadDelta = otherLoad;
          bestTarget = other;
        }
      }

      if (bestTarget) {
        const factor = cadenceLoadFactor(chore.cadence);
        const addedLoad = chore.estimatedMinutes * factor;
        // Move the chore
        chore.assigneePersonId = bestTarget.id;
        chore.helperName = bestTarget.name;
        memberLoad.set(member.id, (memberLoad.get(member.id) ?? 0) - addedLoad);
        memberLoad.set(bestTarget.id, (memberLoad.get(bestTarget.id) ?? 0) + addedLoad);
        moved += addedLoad;
        report.resolved.push({
          choreId: chore.choreId,
          choreTitle: chore.choreTitle,
          fromMemberId: member.id,
          fromMemberName: member.name,
          toMemberId: bestTarget.id,
          toMemberName: bestTarget.name,
          reason: `${member.name} over capacity — moved to ${bestTarget.name}`,
        });
      } else {
        report.unresolved.push({
          choreId: chore.choreId,
          choreTitle: chore.choreTitle,
          memberId: member.id,
          memberName: member.name,
          reason: "All members at capacity — cannot redistribute",
        });
      }
    }
  }

  return report;
}
