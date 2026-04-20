import { describe, expect, it } from "vitest";
import {
  computeCoverageGaps,
  extractDismissedGapIds,
  withDismissedGap,
  withoutDismissedGap,
} from "./coverageGapEngine";

function chore(space: string, cadence: string, title: string) {
  return { title, metadata: { space, cadence } };
}

describe("coverageGapEngine", () => {
  describe("computeCoverageGaps", () => {
    it("returns empty when there are no spaces", () => {
      const result = computeCoverageGaps({ spaces: [], existingChores: [] });
      expect(result.gaps).toEqual([]);
      expect(result.health.score).toBe(0);
      expect(result.health.totalSpaces).toBe(0);
    });

    it("flags every baseline cadence as a gap when there are no chores", () => {
      const result = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [],
      });
      // Kitchen baseline (normal intensity) → daily wipe-down + weekly deep clean
      expect(result.gaps.length).toBeGreaterThanOrEqual(2);
      expect(result.health.score).toBe(0);
      expect(result.health.criticalGaps).toBeGreaterThan(0);
    });

    it("treats space+cadence with any matching chore as covered (title-agnostic)", () => {
      const result = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [
          // User renamed it but the space+cadence matches the daily kitchen baseline
          chore("Kitchen", "daily", "My custom daily kitchen routine"),
          chore("Kitchen", "weekly", "Deep clean kitchen weekend"),
        ],
      });
      // Both daily and weekly are now covered → no gaps for those
      const dailyGaps = result.gaps.filter((g) => g.cadence === "daily");
      const weeklyGaps = result.gaps.filter((g) => g.cadence === "weekly");
      expect(dailyGaps.length).toBe(0);
      expect(weeklyGaps.length).toBe(0);
    });

    it("kitchen daily gap is severity=critical", () => {
      const result = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [],
      });
      const dailyKitchen = result.gaps.find((g) => g.category === "kitchen" && g.cadence === "daily");
      expect(dailyKitchen).toBeDefined();
      expect(dailyKitchen?.severity).toBe("critical");
    });

    it("study weekly gap is severity=nice_to_have", () => {
      const result = computeCoverageGaps({
        spaces: ["Study"],
        existingChores: [],
      });
      const studyGap = result.gaps.find((g) => g.category === "study");
      expect(studyGap).toBeDefined();
      expect(studyGap?.severity).toBe("nice_to_have");
    });

    it("sorts gaps by severity (critical first, then important, then nice_to_have)", () => {
      const result = computeCoverageGaps({
        spaces: ["Kitchen", "Study", "Master Bathroom"],
        existingChores: [],
      });
      const severities = result.gaps.map((g) => g.severity);
      // Verify critical comes before nice_to_have
      const firstCritical = severities.indexOf("critical");
      const firstNice = severities.indexOf("nice_to_have");
      if (firstCritical >= 0 && firstNice >= 0) {
        expect(firstCritical).toBeLessThan(firstNice);
      }
    });

    it("weighted health score reflects critical-room weighting", () => {
      // 100% covered Study (weight 0.5) vs 100% covered Kitchen (weight 2.0)
      // should both be 100, but a half-covered Kitchen should hurt the score
      // more than a half-covered Study.
      const halfCoveredKitchen = computeCoverageGaps({
        spaces: ["Kitchen", "Study"],
        existingChores: [
          // Kitchen has only weekly, missing daily → ~50% covered
          chore("Kitchen", "weekly", "Kitchen deep clean"),
          // Study fully covered
          chore("Study", "weekly", "Tidy Study"),
        ],
      });

      const halfCoveredStudy = computeCoverageGaps({
        spaces: ["Kitchen", "Study"],
        existingChores: [
          // Kitchen fully covered
          chore("Kitchen", "daily", "Kitchen jhadu pocha"),
          chore("Kitchen", "weekly", "Kitchen deep clean"),
          // Study has nothing → 0% covered
        ],
      });

      // The kitchen-half-covered scenario should score LOWER than the
      // study-uncovered scenario, because kitchen has 4x the weight of study.
      expect(halfCoveredKitchen.health.score).toBeLessThan(halfCoveredStudy.health.score);
    });

    it("score is 100 when all spaces are fully covered", () => {
      const result = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [
          chore("Kitchen", "daily", "Daily kitchen"),
          chore("Kitchen", "weekly", "Weekly kitchen"),
        ],
      });
      expect(result.health.score).toBe(100);
      expect(result.gaps.length).toBe(0);
    });

    it("dismissed gaps are excluded from the gap list", () => {
      const initial = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [],
      });
      expect(initial.gaps.length).toBeGreaterThan(0);

      // Dismiss the first gap and re-run
      const dismissedId = initial.gaps[0].id;
      const after = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [],
        dismissedGapIds: new Set([dismissedId]),
      });
      expect(after.gaps.find((g) => g.id === dismissedId)).toBeUndefined();
      expect(after.gaps.length).toBe(initial.gaps.length - 1);
    });

    it("dismissed gaps are treated as covered for scoring purposes", () => {
      // Same kitchen, no chores, but dismiss everything → score should be 100
      const initial = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [],
      });
      const allIds = new Set(initial.gaps.map((g) => g.id));
      const after = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [],
        dismissedGapIds: allIds,
      });
      expect(after.gaps.length).toBe(0);
      expect(after.health.score).toBe(100);
    });

    it("health stats split spaces correctly", () => {
      const result = computeCoverageGaps({
        spaces: ["Kitchen", "Study"],
        existingChores: [
          chore("Kitchen", "daily", "Daily"),
          chore("Kitchen", "weekly", "Weekly"),
          // Study has nothing
        ],
      });
      expect(result.health.totalSpaces).toBe(2);
      expect(result.health.fullyCoveredSpaces).toBe(1); // Kitchen
      expect(result.health.spacesWithGaps).toBe(1); // Study
    });

    it("chores with missing space or cadence metadata are ignored as coverage", () => {
      const result = computeCoverageGaps({
        spaces: ["Kitchen"],
        existingChores: [
          { title: "Random thing", metadata: null },
          { title: "Another", metadata: { something: "else" } },
        ],
      });
      // Kitchen still has gaps because the chores above don't match anything.
      expect(result.gaps.length).toBeGreaterThan(0);
    });

    it("gap id is stable across runs (good for dismiss persistence)", () => {
      const a = computeCoverageGaps({ spaces: ["Kitchen"], existingChores: [] });
      const b = computeCoverageGaps({ spaces: ["Kitchen"], existingChores: [] });
      expect(a.gaps.map((g) => g.id)).toEqual(b.gaps.map((g) => g.id));
    });

    it("provides a non-empty reason for every gap", () => {
      const result = computeCoverageGaps({
        spaces: ["Kitchen", "Master Bathroom", "Study", "Bedroom"],
        existingChores: [],
      });
      for (const gap of result.gaps) {
        expect(gap.reason).toBeTruthy();
        expect(gap.reason.length).toBeGreaterThan(5);
      }
    });
  });

  describe("dismissed gap persistence helpers", () => {
    it("extractDismissedGapIds returns empty for null/undefined metadata", () => {
      expect(extractDismissedGapIds(null).size).toBe(0);
      expect(extractDismissedGapIds(undefined).size).toBe(0);
      expect(extractDismissedGapIds({}).size).toBe(0);
    });

    it("extractDismissedGapIds reads array of strings", () => {
      const ids = extractDismissedGapIds({ dismissed_gaps: ["a", "b", "c"] });
      expect(ids.size).toBe(3);
      expect(ids.has("a")).toBe(true);
    });

    it("extractDismissedGapIds filters non-strings and empty strings", () => {
      const ids = extractDismissedGapIds({ dismissed_gaps: ["a", 42, "", null, "b"] });
      expect(ids.size).toBe(2);
      expect(ids.has("a")).toBe(true);
      expect(ids.has("b")).toBe(true);
    });

    it("withDismissedGap adds an id to fresh metadata", () => {
      const next = withDismissedGap(null, "kitchen::daily::wipe");
      expect(extractDismissedGapIds(next).has("kitchen::daily::wipe")).toBe(true);
    });

    it("withDismissedGap adds an id without clobbering other metadata fields", () => {
      const next = withDismissedGap({ existing_field: "keep_me" }, "id1");
      expect(next.existing_field).toBe("keep_me");
      expect(extractDismissedGapIds(next).has("id1")).toBe(true);
    });

    it("withDismissedGap is idempotent (no duplicate ids)", () => {
      let m: Record<string, unknown> | null = null;
      m = withDismissedGap(m, "id1");
      m = withDismissedGap(m, "id1");
      expect(extractDismissedGapIds(m).size).toBe(1);
    });

    it("withoutDismissedGap removes an id", () => {
      let m: Record<string, unknown> | null = withDismissedGap(null, "id1");
      m = withDismissedGap(m, "id2");
      m = withoutDismissedGap(m, "id1");
      const ids = extractDismissedGapIds(m);
      expect(ids.has("id1")).toBe(false);
      expect(ids.has("id2")).toBe(true);
    });
  });
});
