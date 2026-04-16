// Home profile templates — defines all supported home types with pre-assigned rooms and floor layout.
// Edit this file to add/remove home types or change default room lists.
// Floor numbering: 0 = Ground floor, 1 = First floor, 2 = Second floor, null = unassigned.

export type RoomEntry = {
  /** Stable slug derived from the template (never changes, used as React key). */
  id: string;
  /** Canonical name from the template — shown as greyed hint when display_name differs. */
  template_name: string;
  /** User-editable label — what helpers and the agent will see. */
  display_name: string;
  /** Which floor the room is on. 0 = Ground, 1 = First, 2 = Second, null = not assigned. */
  floor: number | null;
};

export type HomeProfileTemplate = {
  /** Unique key used internally. */
  key: string;
  /** Primary label shown on the card (e.g. "2 BHK"). */
  label: string;
  /** Secondary label shown below (e.g. "Apartment"). */
  subtitle: string;
  /** Stored in home_profiles.home_type. */
  home_type: string;
  /** Stored in home_profiles.bhk. null for types where BHK doesn't apply (e.g. penthouse varies). */
  bhk: number | null;
  /** Pre-filled square_feet lower bound (null = no preset). */
  square_feet_min: number | null;
  /** Pre-filled square_feet upper bound (null = no upper bound). */
  square_feet_max: number | null;
  /** Suggested total number of floors for this template. */
  floors_default: number;
  /** Pre-populated room list with floors. User edits these in Step 1. */
  rooms: RoomEntry[];
};

function r(id: string, name: string, floor: number | null): RoomEntry {
  return { id, template_name: name, display_name: name, floor };
}

// ---------------------------------------------------------------------------
// Shared room building blocks
// ---------------------------------------------------------------------------

function bedroomRooms(count: number, floor: number): RoomEntry[] {
  return Array.from({ length: count }, (_, i) =>
    r(`bedroom_${i + 1}`, `Bedroom ${i + 1}`, floor),
  );
}

function bathroomRooms(count: number, floor: number): RoomEntry[] {
  const labels = ["Master Bathroom", "Common Bathroom", "Attached Bathroom", "Guest Bathroom"];
  return Array.from({ length: count }, (_, i) =>
    r(`bathroom_${i + 1}`, labels[i] ?? `Bathroom ${i + 1}`, floor),
  );
}

const APARTMENT_COMMON_GROUND: RoomEntry[] = [
  r("living_room", "Living Room", 1),
  r("dining_area", "Dining Area", 1),
  r("kitchen", "Kitchen", 1),
  r("balcony_1", "Balcony", 1),
  r("utility_room", "Utility Room", 1),
  r("pooja_room", "Pooja Room", 1),
];

const VILLA_GROUND: RoomEntry[] = [
  r("living_room", "Living Room", 0),
  r("dining_area", "Dining Area", 0),
  r("kitchen", "Kitchen", 0),
  r("pantry", "Pantry", 0),
  r("pooja_room", "Pooja Room", 0),
  r("utility_room", "Utility Room", 0),
  r("servant_room", "Servant Room", 0),
  r("car_porch", "Car Porch", 0),
  r("parking", "Parking", 0),
  r("store_room", "Store Room", 0),
];

const VILLA_UPPER: RoomEntry[] = [
  r("balcony_1", "Balcony 1", 1),
  r("balcony_2", "Balcony 2", 1),
  r("laundry", "Laundry", 1),
];

const VILLA_TERRACE: RoomEntry[] = [
  r("terrace", "Terrace", 2),
];

const POOL_GARDEN: RoomEntry[] = [
  r("pool_area", "Pool Area", 0),
  r("pool_deck", "Pool Deck", 0),
  r("garden", "Garden", 0),
  r("gazebo", "Gazebo", 0),
];

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const HOME_PROFILE_TEMPLATES: HomeProfileTemplate[] = [
  // ── Apartments ──────────────────────────────────────────────────────────
  {
    key: "1bhk_apartment",
    label: "1 BHK",
    subtitle: "Apartment",
    home_type: "apartment",
    bhk: 1,
    square_feet_min: null,
    square_feet_max: null,
    floors_default: 1,
    rooms: [
      ...bedroomRooms(1, 1),
      ...bathroomRooms(1, 1),
      ...APARTMENT_COMMON_GROUND,
    ],
  },
  {
    key: "2bhk_apartment",
    label: "2 BHK",
    subtitle: "Apartment",
    home_type: "apartment",
    bhk: 2,
    square_feet_min: null,
    square_feet_max: null,
    floors_default: 1,
    rooms: [
      ...bedroomRooms(2, 1),
      ...bathroomRooms(2, 1),
      ...APARTMENT_COMMON_GROUND,
    ],
  },
  {
    key: "3bhk_apartment",
    label: "3 BHK",
    subtitle: "Apartment",
    home_type: "apartment",
    bhk: 3,
    square_feet_min: null,
    square_feet_max: null,
    floors_default: 1,
    rooms: [
      ...bedroomRooms(3, 1),
      ...bathroomRooms(3, 1),
      ...APARTMENT_COMMON_GROUND,
      r("study", "Study", 1),
    ],
  },
  {
    key: "4bhk_apartment",
    label: "4 BHK",
    subtitle: "Apartment",
    home_type: "apartment",
    bhk: 4,
    square_feet_min: null,
    square_feet_max: null,
    floors_default: 1,
    rooms: [
      ...bedroomRooms(4, 1),
      ...bathroomRooms(4, 1),
      ...APARTMENT_COMMON_GROUND,
      r("study", "Study", 1),
      r("home_office", "Home Office", 1),
    ],
  },

  // ── Penthouse ────────────────────────────────────────────────────────────
  {
    key: "penthouse",
    label: "Penthouse",
    subtitle: "Luxury",
    home_type: "penthouse",
    bhk: 4,
    square_feet_min: 3000,
    square_feet_max: null,
    floors_default: 2,
    rooms: [
      ...bedroomRooms(4, 1),
      ...bathroomRooms(4, 1),
      r("living_room", "Living Room", 1),
      r("dining_area", "Dining Area", 1),
      r("kitchen", "Kitchen", 1),
      r("study", "Study", 1),
      r("home_office", "Home Office", 1),
      r("pooja_room", "Pooja Room", 1),
      r("utility_room", "Utility Room", 1),
      r("balcony_1", "Balcony 1", 1),
      r("balcony_2", "Balcony 2", 1),
      r("terrace", "Terrace", 2),
      r("terrace_garden", "Terrace Garden", 2),
      r("gym", "Gym", 2),
      r("entertainment_room", "Entertainment Room", 2),
    ],
  },

  // ── Villas (by size) ────────────────────────────────────────────────────
  {
    key: "villa_small",
    label: "Villa",
    subtitle: "< 2,500 sq ft",
    home_type: "villa",
    bhk: 3,
    square_feet_min: null,
    square_feet_max: 2499,
    floors_default: 2,
    rooms: [
      ...bedroomRooms(3, 1),
      ...bathroomRooms(3, 1),
      ...VILLA_GROUND,
      ...VILLA_UPPER,
      ...VILLA_TERRACE,
      r("stairs", "Stairs", null),
    ],
  },
  {
    key: "villa_medium",
    label: "Villa",
    subtitle: "2,500 – 4,000 sq ft",
    home_type: "villa",
    bhk: 4,
    square_feet_min: 2500,
    square_feet_max: 3999,
    floors_default: 2,
    rooms: [
      ...bedroomRooms(4, 1),
      ...bathroomRooms(4, 1),
      ...VILLA_GROUND,
      ...VILLA_UPPER,
      ...VILLA_TERRACE,
      r("study", "Study", 1),
      r("stairs", "Stairs", null),
    ],
  },
  {
    key: "villa_large",
    label: "Villa",
    subtitle: "4,000 – 6,000 sq ft",
    home_type: "villa",
    bhk: 5,
    square_feet_min: 4000,
    square_feet_max: 5999,
    floors_default: 3,
    rooms: [
      ...bedroomRooms(5, 1),
      ...bathroomRooms(5, 1),
      ...VILLA_GROUND,
      ...VILLA_UPPER,
      ...VILLA_TERRACE,
      r("study", "Study", 1),
      r("home_office", "Home Office", 1),
      r("gym", "Gym", 2),
      r("stairs", "Stairs", null),
      r("lift", "Lift", null),
    ],
  },
  {
    key: "villa_xlarge",
    label: "Villa",
    subtitle: "6,000+ sq ft",
    home_type: "villa",
    bhk: 6,
    square_feet_min: 6000,
    square_feet_max: null,
    floors_default: 3,
    rooms: [
      ...bedroomRooms(6, 1),
      ...bathroomRooms(6, 1),
      ...VILLA_GROUND,
      ...VILLA_UPPER,
      ...VILLA_TERRACE,
      r("study", "Study", 1),
      r("home_office", "Home Office", 2),
      r("gym", "Gym", 2),
      r("entertainment_room", "Entertainment Room", 2),
      r("basement", "Basement", null),
      r("stairs", "Stairs", null),
      r("lift", "Lift", null),
    ],
  },

  // ── Villa with Pool & Garden ─────────────────────────────────────────────
  {
    key: "villa_pool_garden",
    label: "Villa with Pool & Garden",
    subtitle: "Pool · Garden",
    home_type: "villa_with_pool",
    bhk: 4,
    square_feet_min: 4000,
    square_feet_max: null,
    floors_default: 2,
    rooms: [
      ...bedroomRooms(4, 1),
      ...bathroomRooms(4, 1),
      ...VILLA_GROUND,
      ...POOL_GARDEN,
      ...VILLA_UPPER,
      ...VILLA_TERRACE,
      r("study", "Study", 1),
      r("stairs", "Stairs", null),
    ],
  },

  // ── Independent House ────────────────────────────────────────────────────
  {
    key: "independent_house",
    label: "Independent House",
    subtitle: "Stand-alone",
    home_type: "independent_house",
    bhk: 3,
    square_feet_min: null,
    square_feet_max: null,
    floors_default: 2,
    rooms: [
      ...bedroomRooms(3, 1),
      ...bathroomRooms(3, 1),
      r("living_room", "Living Room", 0),
      r("dining_area", "Dining Area", 0),
      r("kitchen", "Kitchen", 0),
      r("pantry", "Pantry", 0),
      r("pooja_room", "Pooja Room", 0),
      r("utility_room", "Utility Room", 0),
      r("servant_room", "Servant Room", 0),
      r("car_porch", "Car Porch", 0),
      r("parking", "Parking", 0),
      r("garden", "Garden", 0),
      r("balcony_1", "Balcony 1", 1),
      r("terrace", "Terrace", 2),
      r("stairs", "Stairs", null),
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers used by ChatInterface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Locale maps
// ---------------------------------------------------------------------------

export type SupportedLocale = "en" | "hi" | "kn";

/** Localised labels for template cards (label · subtitle). */
const TEMPLATE_LABELS: Record<SupportedLocale, Record<string, { label: string; subtitle: string }>> = {
  en: {
    "1bhk_apartment":    { label: "1 BHK",                  subtitle: "Apartment" },
    "2bhk_apartment":    { label: "2 BHK",                  subtitle: "Apartment" },
    "3bhk_apartment":    { label: "3 BHK",                  subtitle: "Apartment" },
    "4bhk_apartment":    { label: "4 BHK",                  subtitle: "Apartment" },
    "penthouse":         { label: "Penthouse",               subtitle: "Luxury" },
    "villa_small":       { label: "Villa",                   subtitle: "< 2,500 sq ft" },
    "villa_medium":      { label: "Villa",                   subtitle: "2,500 – 4,000 sq ft" },
    "villa_large":       { label: "Villa",                   subtitle: "4,000 – 6,000 sq ft" },
    "villa_xlarge":      { label: "Villa",                   subtitle: "6,000+ sq ft" },
    "villa_pool_garden": { label: "Villa with Pool & Garden",subtitle: "Pool · Garden" },
    "independent_house": { label: "Independent House",       subtitle: "Stand-alone" },
  },
  hi: {
    "1bhk_apartment":    { label: "1 BHK",                  subtitle: "अपार्टमेंट" },
    "2bhk_apartment":    { label: "2 BHK",                  subtitle: "अपार्टमेंट" },
    "3bhk_apartment":    { label: "3 BHK",                  subtitle: "अपार्टमेंट" },
    "4bhk_apartment":    { label: "4 BHK",                  subtitle: "अपार्टमेंट" },
    "penthouse":         { label: "पेंटहाउस",               subtitle: "लग्ज़री" },
    "villa_small":       { label: "विला",                   subtitle: "< 2,500 वर्ग फुट" },
    "villa_medium":      { label: "विला",                   subtitle: "2,500 – 4,000 वर्ग फुट" },
    "villa_large":       { label: "विला",                   subtitle: "4,000 – 6,000 वर्ग फुट" },
    "villa_xlarge":      { label: "विला",                   subtitle: "6,000+ वर्ग फुट" },
    "villa_pool_garden": { label: "विला (पूल और बगीचा)",    subtitle: "पूल · बगीचा" },
    "independent_house": { label: "स्वतंत्र घर",            subtitle: "अलग मकान" },
  },
  kn: {
    "1bhk_apartment":    { label: "1 BHK",                  subtitle: "ಅಪಾರ್ಟ್‌ಮೆಂಟ್" },
    "2bhk_apartment":    { label: "2 BHK",                  subtitle: "ಅಪಾರ್ಟ್‌ಮೆಂಟ್" },
    "3bhk_apartment":    { label: "3 BHK",                  subtitle: "ಅಪಾರ್ಟ್‌ಮೆಂಟ್" },
    "4bhk_apartment":    { label: "4 BHK",                  subtitle: "ಅಪಾರ್ಟ್‌ಮೆಂಟ್" },
    "penthouse":         { label: "ಪೆಂಟ್‌ಹೌಸ್",            subtitle: "ಐಶಾರಾಮಿ" },
    "villa_small":       { label: "ವಿಲ್ಲಾ",                 subtitle: "< 2,500 ಚ.ಅಡಿ" },
    "villa_medium":      { label: "ವಿಲ್ಲಾ",                 subtitle: "2,500 – 4,000 ಚ.ಅಡಿ" },
    "villa_large":       { label: "ವಿಲ್ಲಾ",                 subtitle: "4,000 – 6,000 ಚ.ಅಡಿ" },
    "villa_xlarge":      { label: "ವಿಲ್ಲಾ",                 subtitle: "6,000+ ಚ.ಅಡಿ" },
    "villa_pool_garden": { label: "ವಿಲ್ಲಾ (ಪೂಲ್ & ತೋಟ)",   subtitle: "ಪೂಲ್ · ತೋಟ" },
    "independent_house": { label: "ಸ್ವತಂತ್ರ ಮನೆ",          subtitle: "ಪ್ರತ್ಯೇಕ ಮನೆ" },
  },
};

/**
 * Room name translations keyed by the room's `id`.
 * Only `display_name` is localised — `template_name` stays English (canonical).
 */
const ROOM_NAMES: Record<SupportedLocale, Record<string, string>> = {
  en: {}, // English: display_name === template_name (no override needed)
  hi: {
    bedroom_1: "शयनकक्ष 1", bedroom_2: "शयनकक्ष 2", bedroom_3: "शयनकक्ष 3",
    bedroom_4: "शयनकक्ष 4", bedroom_5: "शयनकक्ष 5", bedroom_6: "शयनकक्ष 6",
    bathroom_1: "स्नानघर 1", bathroom_2: "स्नानघर 2", bathroom_3: "स्नानघर 3",
    bathroom_4: "स्नानघर 4", bathroom_5: "स्नानघर 5",
    living_room: "बैठक कक्ष", dining_area: "भोजन कक्ष", kitchen: "रसोई",
    pantry: "पैंट्री", pooja_room: "पूजा कक्ष", utility_room: "उपयोगिता कक्ष",
    servant_room: "नौकर कक्ष", store_room: "भंडार कक्ष", laundry: "धुलाई कक्ष",
    car_porch: "कार पोर्च", parking: "पार्किंग", garden: "बगीचा",
    pool_area: "स्विमिंग पूल", pool_deck: "पूल डेक", gazebo: "गज़ेबो",
    balcony_1: "बालकनी 1", balcony_2: "बालकनी 2",
    terrace: "छत", terrace_garden: "छत बगीचा", deck: "डेक",
    study: "अध्ययन कक्ष", home_office: "होम ऑफिस", gym: "जिम",
    entertainment_room: "मनोरंजन कक्ष", basement: "तहखाना",
    stairs: "सीढ़ियाँ", lift: "लिफ्ट",
    battery_room: "बैटरी कक्ष", solar_storage: "सोलर स्टोरेज",
  },
  kn: {
    bedroom_1: "ಮಲಗುವ ಕೊಠಡಿ 1", bedroom_2: "ಮಲಗುವ ಕೊಠಡಿ 2", bedroom_3: "ಮಲಗುವ ಕೊಠಡಿ 3",
    bedroom_4: "ಮಲಗುವ ಕೊಠಡಿ 4", bedroom_5: "ಮಲಗುವ ಕೊಠಡಿ 5", bedroom_6: "ಮಲಗುವ ಕೊಠಡಿ 6",
    bathroom_1: "ಶೌಚಾಲಯ 1", bathroom_2: "ಶೌಚಾಲಯ 2", bathroom_3: "ಶೌಚಾಲಯ 3",
    bathroom_4: "ಶೌಚಾಲಯ 4", bathroom_5: "ಶೌಚಾಲಯ 5",
    living_room: "ಉದ್ಯಾನ ಕೊಠಡಿ", dining_area: "ಊಟದ ಕೊಠಡಿ", kitchen: "ಅಡುಗೆಮನೆ",
    pantry: "ಪ್ಯಾಂಟ್ರಿ", pooja_room: "ಪೂಜಾ ಕೊಠಡಿ", utility_room: "ಉಪಯೋಗಿ ಕೊಠಡಿ",
    servant_room: "ಕೆಲಸದವರ ಕೊಠಡಿ", store_room: "ಸಂಗ್ರಹ ಕೊಠಡಿ", laundry: "ಲಾಂಡ್ರಿ",
    car_porch: "ಕಾರ್ ಪೋರ್ಚ್", parking: "ಪಾರ್ಕಿಂಗ್", garden: "ತೋಟ",
    pool_area: "ಈಜುಕೊಳ", pool_deck: "ಪೂಲ್ ಡೆಕ್", gazebo: "ಗೆಜ಼ೆಬೋ",
    balcony_1: "ಬಾಲ್ಕನಿ 1", balcony_2: "ಬಾಲ್ಕನಿ 2",
    terrace: "ಟೆರೇಸ್", terrace_garden: "ಟೆರೇಸ್ ತೋಟ", deck: "ಡೆಕ್",
    study: "ಅಧ್ಯಯನ ಕೊಠಡಿ", home_office: "ಮನೆ ಕಚೇರಿ", gym: "ವ್ಯಾಯಾಮಶಾಲೆ",
    entertainment_room: "ಮನರಂಜನಾ ಕೊಠಡಿ", basement: "ನೆಲಮಾಳಿಗೆ",
    stairs: "ಮೆಟ್ಟಿಲು", lift: "ಲಿಫ್ಟ್",
    battery_room: "ಬ್ಯಾಟರಿ ಕೊಠಡಿ", solar_storage: "ಸೌರ ಸಂಗ್ರಹ",
  },
};

/**
 * Return a copy of the template with label, subtitle, and room display_names
 * translated to the given locale. template_name stays English (canonical for the agent).
 */
export function localizeTemplate(tmpl: HomeProfileTemplate, locale: SupportedLocale): HomeProfileTemplate {
  const labels = TEMPLATE_LABELS[locale]?.[tmpl.key];
  const roomNames = ROOM_NAMES[locale] ?? {};
  return {
    ...tmpl,
    label: labels?.label ?? tmpl.label,
    subtitle: labels?.subtitle ?? tmpl.subtitle,
    rooms: tmpl.rooms.map((rm) => ({
      ...rm,
      display_name: roomNames[rm.id] ?? rm.template_name,
    })),
  };
}

/**
 * Return the floor label for display in the given locale.
 * (0 → "Ground Floor", 1 → "1st Floor", etc.)
 */
export function floorLabel(floor: number | null, locale: SupportedLocale = "en"): string {
  if (floor === null) {
    return { en: "Unassigned", hi: "अनिर्दिष्ट", kn: "ನಿಯೋಜಿಸಿಲ್ಲ" }[locale] ?? "Unassigned";
  }
  if (floor === 0) {
    return { en: "Ground Floor", hi: "भूतल", kn: "ನೆಲ ಮಹಡಿ" }[locale] ?? "Ground Floor";
  }
  // Upper floors
  const ordinals: Record<SupportedLocale, (n: number) => string> = {
    en: (n) => {
      const s = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
      return `${n}${s} Floor`;
    },
    hi: (n) => `${n}वीं मंज़िल`,
    kn: (n) => `${n}ನೇ ಮಹಡಿ`,
  };
  return ordinals[locale](floor);
}

/** Group a room list by floor, returning sorted floor numbers (null last). */
export function groupRoomsByFloor(rooms: RoomEntry[]): Array<{ floor: number | null; rooms: RoomEntry[] }> {
  const map = new Map<string, { floor: number | null; rooms: RoomEntry[] }>();

  for (const room of rooms) {
    const key = room.floor === null ? "null" : String(room.floor);
    if (!map.has(key)) map.set(key, { floor: room.floor, rooms: [] });
    map.get(key)!.rooms.push(room);
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.floor === null) return 1;
    if (b.floor === null) return -1;
    return a.floor - b.floor;
  });
}

/**
 * Normalise a raw `spaces` value from the DB into RoomEntry[].
 * Handles both the new object array format and the old string array format.
 */
export function normalizeSpacesToRooms(raw: unknown): RoomEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, i): RoomEntry | null => {
      if (typeof item === "string" && item.trim()) {
        const name = item.trim();
        return { id: `legacy_${i}`, template_name: name, display_name: name, floor: null };
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const o = item as Record<string, unknown>;
        const id = typeof o.id === "string" ? o.id : `room_${i}`;
        const tn = typeof o.template_name === "string" ? o.template_name : id;
        const dn = typeof o.display_name === "string" ? o.display_name : tn;
        const floor = typeof o.floor === "number" && Number.isFinite(o.floor) ? Math.floor(o.floor) : null;
        return { id, template_name: tn, display_name: dn, floor };
      }
      return null;
    })
    .filter((r): r is RoomEntry => r !== null);
}

/** All room-suggestion strings for the "add room" autocomplete, keyed by locale. */
const ROOM_SUGGESTIONS_BY_LOCALE: Record<SupportedLocale, string[]> = {
  en: [
    "Bedroom", "Master Bedroom", "Guest Bedroom", "Children's Room",
    "Living Room", "Dining Area", "Kitchen", "Pantry",
    "Master Bathroom", "Common Bathroom", "Attached Bathroom", "Guest Bathroom", "Powder Room",
    "Balcony", "Terrace", "Deck", "Garden", "Pool Area", "Pool Deck", "Gazebo",
    "Study", "Home Office", "Library",
    "Gym", "Yoga Room", "Entertainment Room",
    "Utility Room", "Laundry", "Store Room",
    "Servant Room", "Driver Room",
    "Pooja Room", "Prayer Room",
    "Basement", "Garage", "Car Porch", "Parking",
    "Lift", "Stairs",
    "Battery Room", "Solar Storage",
  ],
  hi: [
    "शयनकक्ष", "मुख्य शयनकक्ष", "अतिथि शयनकक्ष", "बच्चों का कमरा",
    "बैठक कक्ष", "भोजन कक्ष", "रसोई", "पैंट्री",
    "मुख्य स्नानघर", "सामान्य स्नानघर", "संलग्न स्नानघर", "अतिथि स्नानघर", "पाउडर रूम",
    "बालकनी", "छत", "डेक", "बगीचा", "स्विमिंग पूल", "पूल डेक", "गज़ेबो",
    "अध्ययन कक्ष", "होम ऑफिस", "पुस्तकालय",
    "जिम", "योग कक्ष", "मनोरंजन कक्ष",
    "उपयोगिता कक्ष", "धुलाई कक्ष", "भंडार कक्ष",
    "नौकर कक्ष", "ड्राइवर कक्ष",
    "पूजा कक्ष", "प्रार्थना कक्ष",
    "तहखाना", "गैरेज", "कार पोर्च", "पार्किंग",
    "लिफ्ट", "सीढ़ियाँ",
    "बैटरी कक्ष", "सोलर स्टोरेज",
  ],
  kn: [
    "ಮಲಗುವ ಕೊಠಡಿ", "ಮುಖ್ಯ ಮಲಗುವ ಕೊಠಡಿ", "ಅತಿಥಿ ಕೊಠಡಿ", "ಮಕ್ಕಳ ಕೊಠಡಿ",
    "ಉದ್ಯಾನ ಕೊಠಡಿ", "ಊಟದ ಕೊಠಡಿ", "ಅಡುಗೆಮನೆ", "ಪ್ಯಾಂಟ್ರಿ",
    "ಮುಖ್ಯ ಶೌಚಾಲಯ", "ಸಾಮಾನ್ಯ ಶೌಚಾಲಯ", "ಸಂಲಗ್ನ ಶೌಚಾಲಯ", "ಅತಿಥಿ ಶೌಚಾಲಯ", "ಪೌಡರ್ ರೂಮ್",
    "ಬಾಲ್ಕನಿ", "ಟೆರೇಸ್", "ಡೆಕ್", "ತೋಟ", "ಈಜುಕೊಳ", "ಪೂಲ್ ಡೆಕ್", "ಗೆಜ಼ೆಬೋ",
    "ಅಧ್ಯಯನ ಕೊಠಡಿ", "ಮನೆ ಕಚೇರಿ", "ಗ್ರಂಥಾಲಯ",
    "ವ್ಯಾಯಾಮಶಾಲೆ", "ಯೋಗ ಕೊಠಡಿ", "ಮನರಂಜನಾ ಕೊಠಡಿ",
    "ಉಪಯೋಗಿ ಕೊಠಡಿ", "ಲಾಂಡ್ರಿ", "ಸಂಗ್ರಹ ಕೊಠಡಿ",
    "ಕೆಲಸದವರ ಕೊಠಡಿ", "ಚಾಲಕನ ಕೊಠಡಿ",
    "ಪೂಜಾ ಕೊಠಡಿ", "ಪ್ರಾರ್ಥನಾ ಕೊಠಡಿ",
    "ನೆಲಮಾಳಿಗೆ", "ಗ್ಯಾರೇಜ್", "ಕಾರ್ ಪೋರ್ಚ್", "ಪಾರ್ಕಿಂಗ್",
    "ಲಿಫ್ಟ್", "ಮೆಟ್ಟಿಲು",
    "ಬ್ಯಾಟರಿ ಕೊಠಡಿ", "ಸೌರ ಸಂಗ್ರಹ",
  ],
};

export function getRoomSuggestions(locale: SupportedLocale = "en"): string[] {
  return ROOM_SUGGESTIONS_BY_LOCALE[locale] ?? ROOM_SUGGESTIONS_BY_LOCALE.en;
}
