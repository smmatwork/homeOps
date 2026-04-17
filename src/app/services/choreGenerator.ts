/**
 * Chore recommendation generator — produces a comprehensive list of
 * chores based on room names, home features, and household details.
 * Used during onboarding and for coverage gap filling.
 */

export interface GeneratedChore {
  title: string;
  space: string;
  cadence: string;
  category: string;
  estimatedMinutes: number;
}

interface GeneratorInput {
  roomNames: string[];
  homeType?: string;
  hasKids?: boolean;
  hasPets?: boolean;
  featureKeys?: string[];
}

// ── Room pattern matchers ────────────────────────────────────────

type RoomRule = {
  pattern: RegExp;
  chores: Array<{ suffix: string; cadence: string; category: string; minutes: number }>;
};

const ROOM_RULES: RoomRule[] = [
  {
    pattern: /kitchen/i,
    chores: [
      { suffix: "counter and stove wipe", cadence: "daily", category: "kitchen", minutes: 15 },
      { suffix: "sink and drain clean", cadence: "daily", category: "kitchen", minutes: 10 },
      { suffix: "sweep and mop floor", cadence: "daily", category: "cleaning", minutes: 15 },
      { suffix: "deep clean (cabinets, tiles, grout)", cadence: "weekly_sat", category: "kitchen", minutes: 45 },
      { suffix: "chimney and hob clean", cadence: "biweekly_sat", category: "kitchen", minutes: 30 },
      { suffix: "fridge clean and organize", cadence: "monthly", category: "organizing", minutes: 30 },
    ],
  },
  {
    pattern: /bath|toilet|washroom|powder/i,
    chores: [
      { suffix: "scrub toilet, sink, tiles", cadence: "weekly_sat", category: "bathroom", minutes: 30 },
      { suffix: "wipe mirror and glass", cadence: "weekly_sat", category: "cleaning", minutes: 10 },
      { suffix: "mop floor", cadence: "daily", category: "cleaning", minutes: 10 },
    ],
  },
  {
    pattern: /bedroom|master|kids\s*bed|guest\s*bed|parent/i,
    chores: [
      { suffix: "bed making", cadence: "daily", category: "cleaning", minutes: 5 },
      { suffix: "sweep and mop floor", cadence: "daily", category: "cleaning", minutes: 15 },
      { suffix: "dust surfaces and furniture", cadence: "weekly_wed", category: "cleaning", minutes: 15 },
      { suffix: "wardrobe organize", cadence: "monthly", category: "organizing", minutes: 30 },
      { suffix: "ceiling fan dusting", cadence: "biweekly_sat", category: "cleaning", minutes: 10 },
    ],
  },
  {
    pattern: /living|hall|drawing|foyer|formal|lounge/i,
    chores: [
      { suffix: "sweep and mop floor", cadence: "daily", category: "cleaning", minutes: 15 },
      { suffix: "dust furniture and shelves", cadence: "weekly_wed", category: "cleaning", minutes: 15 },
      { suffix: "glass surface and mirror clean", cadence: "weekly_sat", category: "cleaning", minutes: 15 },
      { suffix: "sofa and upholstery wipe", cadence: "biweekly_sat", category: "cleaning", minutes: 20 },
      { suffix: "carpet/rug vacuum", cadence: "weekly_thu", category: "cleaning", minutes: 15 },
      { suffix: "cobweb removal", cadence: "monthly", category: "cleaning", minutes: 10 },
    ],
  },
  {
    pattern: /dining/i,
    chores: [
      { suffix: "wipe table and chairs", cadence: "daily", category: "cleaning", minutes: 10 },
      { suffix: "sweep and mop floor", cadence: "daily", category: "cleaning", minutes: 10 },
    ],
  },
  {
    pattern: /balcony/i,
    chores: [
      { suffix: "sweep and mop", cadence: "weekly_sat", category: "outdoor", minutes: 15 },
      { suffix: "railing wipe and glass clean", cadence: "biweekly_sat", category: "cleaning", minutes: 15 },
      { suffix: "water plants", cadence: "daily", category: "outdoor", minutes: 10 },
    ],
  },
  {
    pattern: /terrace|deck/i,
    chores: [
      { suffix: "sweep", cadence: "weekly_sat", category: "outdoor", minutes: 20 },
      { suffix: "cobweb removal and drain check", cadence: "monthly", category: "outdoor", minutes: 20 },
      { suffix: "furniture wipe", cadence: "weekly_sat", category: "outdoor", minutes: 10 },
    ],
  },
  {
    pattern: /garden|lawn|courtyard/i,
    chores: [
      { suffix: "water plants", cadence: "daily", category: "outdoor", minutes: 15 },
      { suffix: "weed removal and trim", cadence: "weekly_sat", category: "outdoor", minutes: 30 },
      { suffix: "lawn mowing", cadence: "biweekly_sat", category: "outdoor", minutes: 30 },
      { suffix: "sweep pathways", cadence: "daily", category: "outdoor", minutes: 10 },
    ],
  },
  {
    pattern: /utility|laundry/i,
    chores: [
      { suffix: "clean and organize", cadence: "weekly_sat", category: "cleaning", minutes: 20 },
      { suffix: "washing machine drum clean", cadence: "monthly", category: "maintenance", minutes: 20 },
    ],
  },
  {
    pattern: /pooja|prayer|temple/i,
    chores: [
      { suffix: "clean and arrange", cadence: "daily", category: "cleaning", minutes: 10 },
      { suffix: "deep clean (brass, idols, lamps)", cadence: "weekly_fri", category: "cleaning", minutes: 20 },
    ],
  },
  {
    pattern: /garage|parking|car\s*porch/i,
    chores: [
      { suffix: "sweep", cadence: "weekly_sat", category: "outdoor", minutes: 15 },
      { suffix: "cobweb removal", cadence: "monthly", category: "cleaning", minutes: 10 },
      { suffix: "car wash / wipe", cadence: "weekly_sun", category: "outdoor", minutes: 20 },
    ],
  },
  {
    pattern: /study|office|library|home\s*office/i,
    chores: [
      { suffix: "dust desk, shelves, books", cadence: "weekly_wed", category: "cleaning", minutes: 15 },
      { suffix: "sweep and mop floor", cadence: "daily", category: "cleaning", minutes: 10 },
      { suffix: "wipe electronics and screens", cadence: "weekly_sat", category: "cleaning", minutes: 10 },
    ],
  },
  {
    pattern: /pantry|store/i,
    chores: [
      { suffix: "organize and wipe shelves", cadence: "weekly_sat", category: "organizing", minutes: 15 },
      { suffix: "check expiry dates and rotate stock", cadence: "monthly", category: "organizing", minutes: 20 },
    ],
  },
  {
    pattern: /stair/i,
    chores: [
      { suffix: "sweep and mop", cadence: "daily", category: "cleaning", minutes: 10 },
      { suffix: "railing and banister wipe", cadence: "weekly_sat", category: "cleaning", minutes: 10 },
    ],
  },
  {
    pattern: /verandah|patio|outside|entrance/i,
    chores: [
      { suffix: "sweep and mop", cadence: "daily", category: "cleaning", minutes: 10 },
      { suffix: "furniture and fixture wipe", cadence: "weekly_sat", category: "cleaning", minutes: 10 },
    ],
  },
  {
    pattern: /theater|entertainment|media|gym|music/i,
    chores: [
      { suffix: "dust and wipe surfaces", cadence: "weekly_sat", category: "cleaning", minutes: 15 },
      { suffix: "vacuum floor and seating", cadence: "weekly_sat", category: "cleaning", minutes: 15 },
    ],
  },
  {
    pattern: /maid|servant/i,
    chores: [
      { suffix: "clean and organize", cadence: "weekly_sat", category: "cleaning", minutes: 15 },
    ],
  },
  {
    pattern: /lift|elevator/i,
    chores: [
      { suffix: "wipe walls, door, and mirror", cadence: "weekly_sat", category: "cleaning", minutes: 10 },
    ],
  },
  {
    pattern: /solar|battery|inverter|ro\s*room/i,
    chores: [
      { suffix: "dust and wipe equipment", cadence: "weekly_sat", category: "maintenance", minutes: 10 },
      { suffix: "check for leaks or damage", cadence: "monthly", category: "maintenance", minutes: 10 },
    ],
  },
];

// Default for any room that doesn't match a specific pattern
const DEFAULT_ROOM_CHORES = [
  { suffix: "sweep and mop", cadence: "weekly_sat", category: "cleaning", minutes: 15 },
  { suffix: "dust surfaces", cadence: "weekly_wed", category: "cleaning", minutes: 10 },
];

/**
 * Generate a comprehensive chore list for a household.
 */
export function generateChoreRecommendations(input: GeneratorInput): GeneratedChore[] {
  const chores: GeneratedChore[] = [];
  const { roomNames, hasKids, hasPets, featureKeys = [] } = input;

  // ── Room-specific chores ───────────────────────────────────────
  for (const room of roomNames) {
    let matched = false;
    for (const rule of ROOM_RULES) {
      if (rule.pattern.test(room)) {
        matched = true;
        for (const c of rule.chores) {
          chores.push({
            title: `${room} — ${c.suffix}`,
            space: room,
            cadence: c.cadence,
            category: c.category,
            estimatedMinutes: c.minutes,
          });
        }
        break; // first match wins
      }
    }
    if (!matched) {
      for (const c of DEFAULT_ROOM_CHORES) {
        chores.push({
          title: `${room} — ${c.suffix}`,
          space: room,
          cadence: c.cadence,
          category: c.category,
          estimatedMinutes: c.minutes,
        });
      }
    }
  }

  // ── Cooking chores (always included) ───────────────────────────
  chores.push({ title: "Cook lunch", space: "Kitchen", cadence: "daily", category: "kitchen", estimatedMinutes: 60 });
  chores.push({ title: "Cook dinner", space: "Kitchen", cadence: "daily", category: "kitchen", estimatedMinutes: 60 });
  chores.push({ title: "Prepare breakfast / tea", space: "Kitchen", cadence: "daily", category: "kitchen", estimatedMinutes: 30 });
  chores.push({ title: "Dish washing (after meals)", space: "Kitchen", cadence: "daily", category: "kitchen", estimatedMinutes: 30 });
  chores.push({ title: "Kitchen platform wipe (post-cooking)", space: "Kitchen", cadence: "daily", category: "kitchen", estimatedMinutes: 10 });

  // ── General household chores ───────────────────────────────────
  chores.push({ title: "Trash disposal and garbage segregation", space: "General", cadence: "daily", category: "cleaning", estimatedMinutes: 10 });
  chores.push({ title: "Laundry — wash and dry", space: "General", cadence: "daily", category: "laundry", estimatedMinutes: 30 });
  chores.push({ title: "Iron and fold clothes", space: "General", cadence: "daily", category: "laundry", estimatedMinutes: 30 });
  chores.push({ title: "Shoe rack organize", space: "General", cadence: "weekly_sun", category: "organizing", estimatedMinutes: 10 });
  chores.push({ title: "Wipe switchboards and light fixtures", space: "General", cadence: "monthly", category: "cleaning", estimatedMinutes: 20 });
  chores.push({ title: "Window glass cleaning (all rooms)", space: "General", cadence: "monthly", category: "cleaning", estimatedMinutes: 45 });
  chores.push({ title: "Cobweb check (full house)", space: "General", cadence: "monthly", category: "cleaning", estimatedMinutes: 20 });
  chores.push({ title: "Mattress air and flip", space: "General", cadence: "monthly", category: "cleaning", estimatedMinutes: 15 });
  chores.push({ title: "Doormat wash / replace", space: "General", cadence: "weekly_sun", category: "cleaning", estimatedMinutes: 10 });
  chores.push({ title: "Drinking water filter / refill", space: "General", cadence: "daily", category: "kitchen", estimatedMinutes: 5 });

  // ── Feature-specific chores ────────────────────────────────────
  const feats = new Set(featureKeys);
  if (feats.has("ac_split") || feats.has("ac_window")) {
    chores.push({ title: "Clean AC filters (all units)", space: "General", cadence: "monthly", category: "maintenance", estimatedMinutes: 30 });
  }
  if (feats.has("water_purifier_ro") || feats.has("water_purifier_uv")) {
    chores.push({ title: "Clean RO/UV outer body and drip tray", space: "Kitchen", cadence: "weekly_sat", category: "maintenance", estimatedMinutes: 10 });
  }
  if (feats.has("solar_panels")) {
    chores.push({ title: "Check solar panel surface (visual)", space: "Terrace", cadence: "weekly_sun", category: "maintenance", estimatedMinutes: 5 });
  }
  if (feats.has("inverter_ups")) {
    chores.push({ title: "Check inverter battery water level", space: "General", cadence: "monthly", category: "maintenance", estimatedMinutes: 10 });
  }
  if (feats.has("garden") || feats.has("garden_irrigation")) {
    chores.push({ title: "Check irrigation drip system", space: "Garden", cadence: "weekly_sun", category: "outdoor", estimatedMinutes: 10 });
  }
  if (feats.has("swimming_pool")) {
    chores.push({ title: "Check pool water level and clarity", space: "Pool", cadence: "daily", category: "outdoor", estimatedMinutes: 10 });
    chores.push({ title: "Skim pool debris", space: "Pool", cadence: "daily", category: "outdoor", estimatedMinutes: 15 });
  }

  // ── Kids-specific chores ───────────────────────────────────────
  if (hasKids) {
    chores.push({ title: "Organize toys and play area", space: "General", cadence: "daily", category: "organizing", estimatedMinutes: 15 });
    chores.push({ title: "Sanitize kids' surfaces and handles", space: "General", cadence: "daily", category: "cleaning", estimatedMinutes: 10 });
  }

  // ── Pet-specific chores ────────────────────────────────────────
  if (hasPets) {
    chores.push({ title: "Pet feeding", space: "General", cadence: "daily", category: "pet_care", estimatedMinutes: 10 });
    chores.push({ title: "Pet area clean (bed, bowls, litter)", space: "General", cadence: "daily", category: "pet_care", estimatedMinutes: 15 });
    chores.push({ title: "Pet walk / exercise", space: "General", cadence: "daily", category: "pet_care", estimatedMinutes: 30 });
  }

  return chores;
}
