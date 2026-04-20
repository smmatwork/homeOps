import { describe, expect, it } from "vitest";
import {
  inferCategory,
  recommendForSpace,
  recommendForSpaces,
  generateRoomTemplates,
  type SpaceProfile,
} from "./choreRecommendationEngine";

describe("choreRecommendationEngine", () => {
  describe("inferCategory", () => {
    it("recognizes kitchen-like names", () => {
      expect(inferCategory("Kitchen")).toBe("kitchen");
      expect(inferCategory("Pantry")).toBe("kitchen");
    });

    it("recognizes bathroom-like names", () => {
      expect(inferCategory("Master Bathroom")).toBe("bathroom");
      expect(inferCategory("Common Bathroom")).toBe("bathroom");
      expect(inferCategory("Powder Room")).toBe("bathroom");
      expect(inferCategory("Toilet")).toBe("bathroom");
    });

    it("recognizes bedroom names", () => {
      expect(inferCategory("Master Bedroom")).toBe("bedroom");
      expect(inferCategory("Guest Bedroom")).toBe("bedroom");
    });

    it("recognizes outdoor spaces", () => {
      expect(inferCategory("Balcony")).toBe("balcony");
      expect(inferCategory("Terrace")).toBe("terrace");
      expect(inferCategory("Garden")).toBe("garden");
    });

    it("recognizes living and dining areas", () => {
      expect(inferCategory("Living Room")).toBe("living");
      expect(inferCategory("Dining Area")).toBe("dining");
    });

    it("falls back to 'other' for unknown names", () => {
      expect(inferCategory("Random Space")).toBe("other");
    });
  });

  describe("recommendForSpace", () => {
    function profile(overrides: Partial<SpaceProfile> = {}): SpaceProfile {
      return {
        displayName: "Kitchen",
        category: "kitchen",
        intensity: "normal",
        options: {},
        ...overrides,
      };
    }

    it("generates daily wipe-down for kitchen at any intensity", () => {
      const recs = recommendForSpace(profile({ intensity: "light" }));
      const daily = recs.find((r) => r.cadence === "daily");
      expect(daily).toBeDefined();
      expect(daily?.title).toContain("Kitchen");
    });

    it("adds a weekly deep clean for non-light kitchen", () => {
      const lightRecs = recommendForSpace(profile({ intensity: "light" }));
      const heavyRecs = recommendForSpace(profile({ intensity: "heavy" }));
      const lightWeekly = lightRecs.filter((r) => r.cadence === "weekly");
      const heavyWeekly = heavyRecs.filter((r) => r.cadence === "weekly");
      expect(heavyWeekly.length).toBeGreaterThan(lightWeekly.length);
    });

    it("adds fridge cleaning when cooks_at_home is true", () => {
      const recs = recommendForSpace(profile({ options: { cooksAtHome: true } }));
      const fridge = recs.find((r) => r.title.toLowerCase().includes("refrigerator"));
      expect(fridge).toBeDefined();
      expect(fridge?.cadence).toBe("monthly");
    });

    it("recommends weekly cleaning for bathroom", () => {
      const recs = recommendForSpace(profile({ displayName: "Master Bathroom", category: "bathroom" }));
      expect(recs.some((r) => r.cadence === "weekly")).toBe(true);
    });

    it("adds quarterly deep clean for bathroom when option set", () => {
      const recs = recommendForSpace(
        profile({
          displayName: "Master Bathroom",
          category: "bathroom",
          options: { deepCleanQuarterly: true },
        }),
      );
      const deep = recs.find((r) => r.title.toLowerCase().includes("deep clean"));
      expect(deep).toBeDefined();
      expect(deep?.category).toBe("Maintenance");
    });

    it("recommends watering for balcony with plants", () => {
      const recs = recommendForSpace(
        profile({
          displayName: "Balcony",
          category: "balcony",
          options: { hasPlants: true },
        }),
      );
      const watering = recs.find((r) => r.title.toLowerCase().includes("water plants"));
      expect(watering).toBeDefined();
      expect(watering?.cadence).toBe("daily");
    });

    it("recommends furniture wipe for balcony with furniture", () => {
      const recs = recommendForSpace(
        profile({
          displayName: "Balcony",
          category: "balcony",
          options: { hasFurniture: true },
        }),
      );
      const furniture = recs.find((r) => r.title.toLowerCase().includes("furniture"));
      expect(furniture).toBeDefined();
    });

    it("recommends garden upkeep and lawn mowing for garden", () => {
      const recs = recommendForSpace(profile({ displayName: "Garden", category: "garden" }));
      expect(recs.length).toBeGreaterThanOrEqual(2);
      expect(recs.some((r) => r.title.toLowerCase().includes("garden"))).toBe(true);
      expect(recs.some((r) => r.title.toLowerCase().includes("lawn"))).toBe(true);
    });

    it("recommends bedroom tidying daily and cleaning weekly", () => {
      const recs = recommendForSpace(profile({ displayName: "Master Bedroom", category: "bedroom" }));
      expect(recs.some((r) => r.cadence === "daily")).toBe(true);
      expect(recs.some((r) => r.cadence === "weekly")).toBe(true);
    });

    it("adds toy sweep for bedroom marked as child room", () => {
      const recs = recommendForSpace(
        profile({
          displayName: "Children's Room",
          category: "bedroom",
          options: { childRoom: true },
        }),
      );
      const toy = recs.find((r) => r.title.toLowerCase().includes("toy"));
      expect(toy).toBeDefined();
    });

    it("adjusts utility laundry cadence by intensity", () => {
      const light = recommendForSpace(profile({ displayName: "Utility", category: "utility", intensity: "light" }));
      const heavy = recommendForSpace(profile({ displayName: "Utility", category: "utility", intensity: "heavy" }));
      const lightLaundry = light.find((r) => r.title.toLowerCase().includes("laundry"));
      const heavyLaundry = heavy.find((r) => r.title.toLowerCase().includes("laundry"));
      expect(lightLaundry?.cadence).toBe("biweekly");
      expect(heavyLaundry?.cadence).toBe("daily");
    });

    it("falls back to a single generic chore for 'other' category", () => {
      const recs = recommendForSpace(profile({ displayName: "Mystery Room", category: "other" }));
      expect(recs.length).toBe(1);
    });

    it("each recommendation has required fields", () => {
      const recs = recommendForSpace(profile({ displayName: "Master Bathroom", category: "bathroom" }));
      for (const r of recs) {
        expect(r.id).toBeTruthy();
        expect(r.title).toBeTruthy();
        expect(r.description).toBeTruthy();
        expect(r.space).toBe("Master Bathroom");
        expect(["daily", "weekly", "biweekly", "monthly"]).toContain(r.cadence);
        expect(r.estimatedMinutes).toBeGreaterThan(0);
        expect(["Cleaning", "Maintenance", "Cooking food"]).toContain(r.category);
      }
    });

    it("space name is preserved in chore titles", () => {
      const recs = recommendForSpace(profile({ displayName: "Guest Bathroom", category: "bathroom" }));
      expect(recs.some((r) => r.title.includes("Guest Bathroom"))).toBe(true);
    });
  });

  describe("recommendForSpaces", () => {
    it("aggregates recommendations across multiple spaces", () => {
      const profiles: SpaceProfile[] = [
        { displayName: "Kitchen", category: "kitchen", intensity: "normal" },
        { displayName: "Master Bathroom", category: "bathroom", intensity: "normal" },
      ];
      const recs = recommendForSpaces(profiles);
      expect(recs.some((r) => r.space === "Kitchen")).toBe(true);
      expect(recs.some((r) => r.space === "Master Bathroom")).toBe(true);
    });

    it("returns empty for empty input", () => {
      expect(recommendForSpaces([])).toEqual([]);
    });

    it("ids are unique within a single space-name set", () => {
      const profiles: SpaceProfile[] = [
        { displayName: "Kitchen", category: "kitchen", intensity: "heavy", options: { cooksAtHome: true } },
      ];
      const recs = recommendForSpaces(profiles);
      const ids = recs.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("India-context wording (no vacuum, prefer sweep + mop)", () => {
    it("does not recommend vacuuming for any common space", () => {
      const profiles: SpaceProfile[] = [
        { displayName: "Living Room", category: "living", intensity: "normal" },
        { displayName: "Master Bedroom", category: "bedroom", intensity: "normal" },
        { displayName: "Dining Area", category: "dining", intensity: "heavy" },
        { displayName: "Kitchen", category: "kitchen", intensity: "normal" },
      ];
      const recs = recommendForSpaces(profiles);
      const hasVacuum = recs.some((r) =>
        r.title.toLowerCase().includes("vacuum") || r.description.toLowerCase().includes("vacuum"),
      );
      expect(hasVacuum).toBe(false);
    });

    it("uses sweep and mop language for bedrooms", () => {
      const recs = recommendForSpace({
        displayName: "Master Bedroom",
        category: "bedroom",
        intensity: "normal",
      });
      const cleaning = recs.find((r) => r.title.toLowerCase().includes("sweep and mop"));
      expect(cleaning).toBeDefined();
      expect(cleaning?.description.toLowerCase()).toContain("sweep and mop");
    });

    it("uses sweep and mop language for living and dining", () => {
      const livingRecs = recommendForSpace({ displayName: "Living Room", category: "living", intensity: "normal" });
      const diningRecs = recommendForSpace({ displayName: "Dining Area", category: "dining", intensity: "normal" });
      expect(livingRecs.some((r) => r.title.toLowerCase().includes("sweep and mop"))).toBe(true);
      expect(diningRecs.some((r) => r.title.toLowerCase().includes("sweep and mop"))).toBe(true);
    });

    it("kitchen daily chore mentions sweep and mop in description", () => {
      const recs = recommendForSpace({ displayName: "Kitchen", category: "kitchen", intensity: "normal" });
      const daily = recs.find((r) => r.cadence === "daily");
      expect(daily).toBeDefined();
      expect(daily?.description.toLowerCase()).toContain("sweep and mop");
    });

    it("kitchen deep clean mentions chimney (Indian-context exhaust)", () => {
      const recs = recommendForSpace({ displayName: "Kitchen", category: "kitchen", intensity: "normal" });
      const deepClean = recs.find((r) => r.title.toLowerCase().includes("deep clean"));
      expect(deepClean).toBeDefined();
      expect(deepClean?.description.toLowerCase()).toContain("chimney");
    });
  });

  describe("generateRoomTemplates", () => {
    it("produces one RoomTemplate per space", () => {
      const profiles: SpaceProfile[] = [
        { displayName: "Kitchen", category: "kitchen", intensity: "normal" },
        { displayName: "Master Bedroom", category: "bedroom", intensity: "normal" },
      ];
      const rooms = generateRoomTemplates(profiles);
      expect(rooms.length).toBe(2);
      expect(rooms[0].space).toBe("Kitchen");
      expect(rooms[1].space).toBe("Master Bedroom");
    });

    it("each room template has multiple tasks at different cadences", () => {
      const rooms = generateRoomTemplates([
        { displayName: "Kitchen", category: "kitchen", intensity: "normal" },
      ]);
      expect(rooms[0].tasks.length).toBeGreaterThanOrEqual(2); // daily + weekly at minimum
      const cadences = rooms[0].tasks.map((t) => t.cadence);
      expect(cadences).toContain("daily");
      expect(cadences).toContain("weekly");
    });

    it("room template id is derived from space name", () => {
      const rooms = generateRoomTemplates([
        { displayName: "Master Bedroom", category: "bedroom", intensity: "normal" },
      ]);
      expect(rooms[0].id).toContain("master_bedroom");
    });

    it("each task within a room has a unique key", () => {
      const rooms = generateRoomTemplates([
        { displayName: "Kitchen", category: "kitchen", intensity: "heavy", options: { cooksAtHome: true } },
      ]);
      const keys = rooms[0].tasks.map((t) => t.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("returns empty for empty input", () => {
      expect(generateRoomTemplates([])).toEqual([]);
    });
  });
});
