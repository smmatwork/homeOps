/**
 * Pure chore recommendation engine.
 *
 * Given user input about each space (type, intensity, options), this generates
 * a list of recommended chores with title, cadence, description, priority, and
 * estimated minutes. No side effects — testable and used by the interactive
 * coverage planner.
 */

export type SpaceCategory =
  | "kitchen"
  | "bathroom"
  | "bedroom"
  | "living"
  | "dining"
  | "balcony"
  | "terrace"
  | "garden"
  | "garage"
  | "utility"
  | "study"
  | "pooja"
  | "store"
  | "other";

export type Intensity = "light" | "normal" | "heavy";

export type Cadence =
  | "daily"
  | "every_2_days"
  | "every_3_days"
  | "every_4_days"
  | "every_5_days"
  | "weekly"
  | "biweekly"
  | "monthly";

/** Convert a cadence to its interval in days. Returns null for non-interval cadences. */
export function cadenceIntervalDays(cadence: Cadence): number {
  switch (cadence) {
    case "daily": return 1;
    case "every_2_days": return 2;
    case "every_3_days": return 3;
    case "every_4_days": return 4;
    case "every_5_days": return 5;
    case "weekly": return 7;
    case "biweekly": return 14;
    case "monthly": return 30;
  }
}

/** Human-readable label for a cadence value. */
export function cadenceLabel(cadence: Cadence): string {
  switch (cadence) {
    case "daily": return "Daily";
    case "every_2_days": return "Every 2 days";
    case "every_3_days": return "Every 3 days";
    case "every_4_days": return "Every 4 days";
    case "every_5_days": return "Every 5 days";
    case "weekly": return "Weekly";
    case "biweekly": return "Biweekly";
    case "monthly": return "Monthly";
  }
}

/** All cadence options, ordered from most to least frequent. */
export const ALL_CADENCES: readonly Cadence[] = [
  "daily",
  "every_2_days",
  "every_3_days",
  "every_4_days",
  "every_5_days",
  "weekly",
  "biweekly",
  "monthly",
] as const;

export interface SpaceProfile {
  /** User-facing display name (e.g. "Master Bedroom"). */
  displayName: string;
  /** Inferred or user-selected category. */
  category: SpaceCategory;
  /** How heavily the space is used. */
  intensity: Intensity;
  /** Optional toggles per category. */
  options?: {
    /** Kitchen: cooks regularly at home. */
    cooksAtHome?: boolean;
    /** Balcony/terrace/garden: has plants. */
    hasPlants?: boolean;
    /** Balcony/terrace/garden: has outdoor furniture. */
    hasFurniture?: boolean;
    /** Bathroom: needs deep cleaning quarterly. */
    deepCleanQuarterly?: boolean;
    /** Bedroom: child uses it. */
    childRoom?: boolean;
  };
}

export interface ChoreRecommendation {
  id: string;
  title: string;
  description: string;
  space: string;
  cadence: Cadence;
  priority: number;
  estimatedMinutes: number;
  category: "Cleaning" | "Maintenance" | "Cooking food";
}

const CATEGORY_KEYWORDS: Array<{ category: SpaceCategory; patterns: RegExp[] }> = [
  { category: "kitchen", patterns: [/kitchen/i, /pantry/i] },
  { category: "bathroom", patterns: [/bath/i, /toilet/i, /washroom/i, /restroom/i, /powder/i, /\bwc\b/i] },
  { category: "bedroom", patterns: [/bedroom/i, /master/i] },
  { category: "living", patterns: [/living/i, /lounge/i, /family room/i, /tv room/i] },
  { category: "dining", patterns: [/dining/i, /eating area/i] },
  { category: "balcony", patterns: [/balcony/i] },
  { category: "terrace", patterns: [/terrace/i, /\bdeck\b/i, /rooftop/i] },
  { category: "garden", patterns: [/garden/i, /lawn/i, /yard/i] },
  { category: "garage", patterns: [/garage/i, /parking/i, /car porch/i, /carport/i] },
  { category: "utility", patterns: [/utility/i, /laundry/i] },
  { category: "study", patterns: [/study/i, /office/i, /library/i] },
  { category: "pooja", patterns: [/pooja/i, /prayer/i, /shrine/i] },
  { category: "store", patterns: [/store room/i, /storage/i, /closet/i] },
];

/** Best-effort category detection from a free-text space name. */
export function inferCategory(name: string): SpaceCategory {
  for (const { category, patterns } of CATEGORY_KEYWORDS) {
    if (patterns.some((p) => p.test(name))) return category;
  }
  return "other";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function makeId(space: string, title: string): string {
  return `${slugify(space)}__${slugify(title)}`;
}

/**
 * Generate chore recommendations for a single space.
 * Returns 0 to 4 chores depending on category and intensity.
 */
export function recommendForSpace(profile: SpaceProfile): ChoreRecommendation[] {
  const { displayName, category, intensity, options = {} } = profile;
  const recs: ChoreRecommendation[] = [];

  const push = (
    title: string,
    description: string,
    cadence: Cadence,
    priority: number,
    estimatedMinutes: number,
    cat: ChoreRecommendation["category"] = "Cleaning",
  ) => {
    recs.push({
      id: makeId(displayName, title),
      title,
      description,
      space: displayName,
      cadence,
      priority,
      estimatedMinutes,
      category: cat,
    });
  };

  switch (category) {
    case "kitchen": {
      push(
        `Kitchen jhadu pocha`,
        "Sweep and mop kitchen floor, wipe counters and stove, quick sink scrub.",
        "daily",
        3,
        20,
      );
      if (intensity !== "light") {
        push(
          `Kitchen deep clean`,
          "Scrub stove, clean exhaust hood (chimney), wipe cabinets and shelves.",
          "weekly",
          2,
          45,
        );
      }
      if (options.cooksAtHome || intensity === "heavy") {
        push(
          `Clean refrigerator`,
          "Discard expired items, wipe shelves and door seals.",
          "monthly",
          1,
          20,
        );
      }
      break;
    }

    case "bathroom": {
      push(
        `Clean ${displayName}`,
        "Scrub toilet, sink, tiles, and mop the floor.",
        intensity === "heavy" ? "weekly" : "weekly",
        3,
        25,
      );
      if (intensity === "heavy") {
        push(
          `Quick refresh ${displayName}`,
          "Wipe surfaces, restock supplies, empty trash.",
          "daily",
          1,
          5,
        );
      }
      if (options.deepCleanQuarterly) {
        push(
          `Deep clean ${displayName}`,
          "Descale fixtures, scrub grout, clean exhaust fan.",
          "monthly",
          1,
          60,
          "Maintenance",
        );
      }
      break;
    }

    case "bedroom": {
      push(
        `Tidy ${displayName}`,
        "Make bed, put away clothes, clear surfaces.",
        "daily",
        1,
        5,
      );
      push(
        `Sweep and mop ${displayName}`,
        "Sweep and mop floor, dust surfaces, change linens.",
        intensity === "heavy" ? "weekly" : "weekly",
        2,
        25,
      );
      if (options.childRoom) {
        push(
          `Toy and clutter sweep`,
          "Pick up toys, sort clutter, restock supplies.",
          "daily",
          1,
          10,
        );
      }
      break;
    }

    case "living":
    case "dining": {
      push(
        `Daily sweep ${displayName}`,
        "Sweep floor, clear surfaces, fluff cushions.",
        "daily",
        2,
        15,
      );
      push(
        `Sweep and mop ${displayName}`,
        "Sweep, mop, dust surfaces and electronics (TV, fan, switchboards).",
        intensity === "heavy" ? "weekly" : "weekly",
        2,
        30,
      );
      break;
    }

    case "balcony":
    case "terrace": {
      push(
        `Sweep ${displayName}`,
        "Sweep, remove dust and cobwebs, wipe railing.",
        intensity === "heavy" ? "weekly" : "monthly",
        1,
        20,
      );
      if (options.hasPlants) {
        push(
          `Water plants on ${displayName}`,
          "Water plants, remove dead leaves, check pots.",
          "daily",
          2,
          10,
        );
      }
      if (options.hasFurniture) {
        push(
          `Wipe furniture on ${displayName}`,
          "Clean outdoor chairs, table, and cushions.",
          "weekly",
          1,
          15,
        );
      }
      break;
    }

    case "garden": {
      push(
        `Garden upkeep`,
        "Water plants, weed beds, sweep paths.",
        "weekly",
        2,
        45,
        "Maintenance",
      );
      push(
        `Lawn mowing`,
        "Mow grass, trim edges, blow clippings.",
        "biweekly",
        1,
        60,
        "Maintenance",
      );
      break;
    }

    case "garage": {
      push(
        `Sweep ${displayName}`,
        "Sweep floor, organize tools and shelves.",
        "monthly",
        1,
        30,
      );
      if (intensity !== "light") {
        push(
          `Wash car`,
          "Rinse, soap, scrub, and dry the car.",
          "weekly",
          1,
          30,
          "Maintenance",
        );
      }
      break;
    }

    case "utility": {
      push(
        `Clean utility area`,
        "Wipe surfaces, sweep floor, clean drain.",
        "weekly",
        1,
        15,
      );
      push(
        `Laundry routine`,
        "Wash, dry, and fold laundry.",
        intensity === "heavy" ? "daily" : intensity === "normal" ? "weekly" : "biweekly",
        2,
        45,
      );
      break;
    }

    case "study": {
      push(
        `Tidy ${displayName}`,
        "Clear desk, file papers, dust electronics.",
        "weekly",
        1,
        15,
      );
      break;
    }

    case "pooja": {
      push(
        `Clean ${displayName}`,
        "Wipe surfaces, change flowers, refill oil.",
        "daily",
        2,
        10,
      );
      break;
    }

    case "store": {
      push(
        `Tidy ${displayName}`,
        "Sort items, dust shelves, discard expired goods.",
        "monthly",
        1,
        20,
      );
      break;
    }

    case "other":
    default: {
      push(
        `Sweep and mop ${displayName}`,
        "Sweep, mop, and dust the space.",
        intensity === "heavy" ? "weekly" : intensity === "normal" ? "biweekly" : "monthly",
        1,
        20,
      );
      break;
    }
  }

  return recs;
}

/**
 * Generate chore recommendations for a list of spaces.
 */
export function recommendForSpaces(profiles: SpaceProfile[]): ChoreRecommendation[] {
  const all: ChoreRecommendation[] = [];
  for (const p of profiles) {
    all.push(...recommendForSpace(p));
  }
  return all;
}

// ---------------------------------------------------------------------------
// Room-based template generation
// ---------------------------------------------------------------------------

import type { RoomTemplate, TemplateTask } from "./choreScheduler";

/**
 * Generate room-based templates from a list of space profiles.
 * Each space produces ONE RoomTemplate with multiple tasks.
 * This is the preferred output for the scheduler.
 */
export function generateRoomTemplates(profiles: SpaceProfile[]): RoomTemplate[] {
  const templates: RoomTemplate[] = [];

  for (const profile of profiles) {
    const recs = recommendForSpace(profile);
    if (recs.length === 0) continue;

    const roomId = `room_${slugify(profile.displayName)}`;
    const tasks: TemplateTask[] = recs.map((rec) => ({
      key: rec.id,
      title: rec.title,
      description: rec.description,
      cadence: rec.cadence,
      priority: rec.priority,
      estimatedMinutes: rec.estimatedMinutes,
      category: rec.category,
    }));

    templates.push({
      id: roomId,
      space: profile.displayName,
      defaultHelperId: null,
      tasks,
      metadata: { category: profile.category },
    });
  }

  return templates;
}
