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
      effectiveDailyLoad.set(bestHelper.id, (effectiveDailyLoad.get(bestHelper.id) ?? 0) + effectiveMins);
      assignments.push({
        choreId: chore.id,
        choreTitle: chore.title,
        space: chore.space,
        cadence: finalCadence,
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
