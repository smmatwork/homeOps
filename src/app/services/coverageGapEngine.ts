/**
 * Pure coverage gap engine.
 *
 * Given the user's home profile spaces and their existing chores, computes
 * the *missing* coverage as a list of actionable gaps. The output drives the
 * Coverage Health dashboard.
 *
 * Goals:
 *  - Audit-anytime: shows what's missing, not what could exist
 *  - Severity-aware: critical rooms (kitchen, bathroom) are weighted higher
 *  - Idempotent: dismissed gaps stay dismissed across sessions
 *  - Pure: no Supabase, fully testable
 */

import {
  recommendForSpace,
  inferCategory,
  type SpaceCategory,
  type Cadence,
  type ChoreRecommendation,
} from "./choreRecommendationEngine";

export type GapSeverity = "critical" | "important" | "nice_to_have";

export interface CoverageGap {
  /** Stable id used for dismiss persistence: `${space}::${cadence}::${title}`, lowercased. */
  id: string;
  space: string;
  category: SpaceCategory;
  cadence: Cadence;
  /** Default chore that would close this gap. Editable in the UI before applying. */
  recommendation: ChoreRecommendation;
  severity: GapSeverity;
  /** Short user-facing reason this matters. */
  reason: string;
}

export interface CoverageHealth {
  /** 0-100. Weighted by critical-room priority. */
  score: number;
  totalSpaces: number;
  fullyCoveredSpaces: number;
  partiallyCoveredSpaces: number;
  spacesWithGaps: number;
  totalGaps: number;
  criticalGaps: number;
}

export interface GapEngineInput {
  /** User's spaces — display names from home_profiles.spaces. */
  spaces: string[];
  /** Existing non-deleted chores from the chores table. */
  existingChores: Array<{
    title: string;
    metadata: Record<string, unknown> | null;
  }>;
  /** Set of dismissed gap ids (from home_profiles.metadata.dismissed_gaps). */
  dismissedGapIds?: Set<string>;
}

export interface GapEngineOutput {
  gaps: CoverageGap[];
  health: CoverageHealth;
}

// ---------------------------------------------------------------------------
// Critical-room weighting
// ---------------------------------------------------------------------------

/**
 * How much a room category counts toward the overall health score.
 * Critical rooms (kitchen, bathroom) are 2x; outdoor / nice-to-have rooms
 * (study, store, garden) are 0.5x. Average rooms are 1x.
 */
const CATEGORY_WEIGHT: Record<SpaceCategory, number> = {
  kitchen: 2.0,
  bathroom: 2.0,
  bedroom: 1.5,
  living: 1.5,
  dining: 1.0,
  utility: 1.0,
  pooja: 1.0,
  balcony: 0.75,
  terrace: 0.75,
  garage: 0.5,
  garden: 0.5,
  study: 0.5,
  store: 0.25,
  other: 0.5,
};

/** Categories considered "critical" — gaps in these rooms are high severity. */
const CRITICAL_CATEGORIES: ReadonlySet<SpaceCategory> = new Set(["kitchen", "bathroom"]);

/** Categories where missing daily/weekly coverage is more impactful. */
const HIGH_FREQUENCY_MATTERS: ReadonlySet<SpaceCategory> = new Set([
  "kitchen", "bathroom", "bedroom", "living", "dining",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGapId(space: string, cadence: string, title: string): string {
  return `${space.toLowerCase().trim()}::${cadence.toLowerCase().trim()}::${title.toLowerCase().trim()}`;
}

function severityFor(category: SpaceCategory, cadence: Cadence): GapSeverity {
  // Critical room + high-frequency cadence = critical
  if (CRITICAL_CATEGORIES.has(category)) {
    if (cadence === "daily" || cadence === "weekly") return "critical";
    return "important";
  }
  // High-frequency-matters rooms with daily/weekly missing = important
  if (HIGH_FREQUENCY_MATTERS.has(category)) {
    if (cadence === "daily" || cadence === "weekly") return "important";
    return "nice_to_have";
  }
  return "nice_to_have";
}

function reasonFor(category: SpaceCategory, cadence: Cadence): string {
  if (category === "kitchen" && cadence === "daily") {
    return "Daily kitchen cleaning prevents grease buildup and pests.";
  }
  if (category === "bathroom" && cadence === "weekly") {
    return "Weekly bathroom cleaning is essential for hygiene.";
  }
  if (category === "kitchen") return "Keeps your kitchen safe and functional.";
  if (category === "bathroom") return "Maintains hygiene standards.";
  if (cadence === "daily") return "Daily care for spaces you use every day.";
  if (cadence === "weekly") return "Weekly upkeep keeps surfaces in good shape.";
  if (cadence === "monthly") return "Monthly attention prevents bigger maintenance later.";
  return "Recommended for a well-maintained home.";
}

/** Build a lookup of existing chores keyed by (space, cadence). */
function indexExistingChores(
  chores: GapEngineInput["existingChores"],
): Map<string, Set<string>> {
  // key: "space::cadence" → set of normalized titles
  const index = new Map<string, Set<string>>();
  for (const c of chores) {
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    const space = typeof meta.space === "string" ? meta.space.toLowerCase().trim() : "";
    const cadence = typeof meta.cadence === "string" ? meta.cadence.toLowerCase().trim() : "";
    if (!space || !cadence) continue;
    const key = `${space}::${cadence}`;
    const set = index.get(key) ?? new Set<string>();
    set.add(c.title.toLowerCase().trim());
    index.set(key, set);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function computeCoverageGaps(input: GapEngineInput): GapEngineOutput {
  const { spaces, existingChores, dismissedGapIds = new Set() } = input;

  if (spaces.length === 0) {
    return {
      gaps: [],
      health: emptyHealth(),
    };
  }

  const choreIndex = indexExistingChores(existingChores);
  const gaps: CoverageGap[] = [];

  // Per-space score: how covered is this space (0..1)?
  const perSpaceCoverage: Array<{ category: SpaceCategory; coveredRatio: number }> = [];

  for (const space of spaces) {
    const category = inferCategory(space);

    // Get the full set of recommended chores for this space at "normal" intensity.
    // These represent the baseline coverage we expect.
    const baseline = recommendForSpace({
      displayName: space,
      category,
      intensity: "normal",
      options: {},
    });

    if (baseline.length === 0) {
      perSpaceCoverage.push({ category, coveredRatio: 1 });
      continue;
    }

    let covered = 0;
    for (const rec of baseline) {
      const key = `${rec.space.toLowerCase().trim()}::${rec.cadence.toLowerCase().trim()}`;
      const existingTitles = choreIndex.get(key);
      // A baseline cadence is "covered" if the user has ANY chore with that
      // (space, cadence) combination — title doesn't have to match exactly.
      // This avoids false-positive gaps when the user has renamed a chore.
      const isCovered = existingTitles && existingTitles.size > 0;

      if (isCovered) {
        covered += 1;
        continue;
      }

      // It's a gap. Build the gap object unless it's been dismissed.
      const gapId = buildGapId(rec.space, rec.cadence, rec.title);
      if (dismissedGapIds.has(gapId)) {
        // Treat dismissed gaps as "covered" for scoring purposes — the user
        // explicitly said they don't need this, so it shouldn't drag the score down.
        covered += 1;
        continue;
      }

      gaps.push({
        id: gapId,
        space: rec.space,
        category,
        cadence: rec.cadence,
        recommendation: rec,
        severity: severityFor(category, rec.cadence),
        reason: reasonFor(category, rec.cadence),
      });
    }

    perSpaceCoverage.push({
      category,
      coveredRatio: baseline.length === 0 ? 1 : covered / baseline.length,
    });
  }

  // Sort gaps: critical first, then important, then nice-to-have.
  // Within a severity level, sort by category importance (kitchen first, etc.).
  const severityOrder: GapSeverity[] = ["critical", "important", "nice_to_have"];
  gaps.sort((a, b) => {
    const sa = severityOrder.indexOf(a.severity);
    const sb = severityOrder.indexOf(b.severity);
    if (sa !== sb) return sa - sb;
    const wa = CATEGORY_WEIGHT[a.category] ?? 1;
    const wb = CATEGORY_WEIGHT[b.category] ?? 1;
    if (wa !== wb) return wb - wa;
    return a.space.localeCompare(b.space);
  });

  // Compute weighted health score.
  let weightedSum = 0;
  let totalWeight = 0;
  let fullyCovered = 0;
  let partiallyCovered = 0;
  let withGaps = 0;
  for (const sp of perSpaceCoverage) {
    const weight = CATEGORY_WEIGHT[sp.category] ?? 1;
    weightedSum += sp.coveredRatio * weight;
    totalWeight += weight;
    if (sp.coveredRatio >= 0.999) fullyCovered += 1;
    else if (sp.coveredRatio > 0) partiallyCovered += 1;
    else withGaps += 1;
  }
  const score = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 100;

  return {
    gaps,
    health: {
      score,
      totalSpaces: spaces.length,
      fullyCoveredSpaces: fullyCovered,
      partiallyCoveredSpaces: partiallyCovered,
      spacesWithGaps: withGaps,
      totalGaps: gaps.length,
      criticalGaps: gaps.filter((g) => g.severity === "critical").length,
    },
  };
}

function emptyHealth(): CoverageHealth {
  return {
    score: 0,
    totalSpaces: 0,
    fullyCoveredSpaces: 0,
    partiallyCoveredSpaces: 0,
    spacesWithGaps: 0,
    totalGaps: 0,
    criticalGaps: 0,
  };
}

// ---------------------------------------------------------------------------
// Dismissed gap persistence
// ---------------------------------------------------------------------------

/** Read dismissed gap ids from a home_profiles.metadata blob. */
export function extractDismissedGapIds(
  metadata: Record<string, unknown> | null | undefined,
): Set<string> {
  if (!metadata) return new Set();
  const raw = (metadata as Record<string, unknown>).dismissed_gaps;
  if (!Array.isArray(raw)) return new Set();
  const ids = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) ids.add(v);
  }
  return ids;
}

/** Merge a new dismissed id into an existing metadata blob (immutably). */
export function withDismissedGap(
  metadata: Record<string, unknown> | null | undefined,
  gapId: string,
): Record<string, unknown> {
  const base = (metadata && typeof metadata === "object" && !Array.isArray(metadata))
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  const existing = extractDismissedGapIds(base);
  existing.add(gapId);
  base.dismissed_gaps = Array.from(existing);
  return base;
}

/** Remove a dismissed gap id (e.g., user changes their mind). */
export function withoutDismissedGap(
  metadata: Record<string, unknown> | null | undefined,
  gapId: string,
): Record<string, unknown> {
  const base = (metadata && typeof metadata === "object" && !Array.isArray(metadata))
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  const existing = extractDismissedGapIds(base);
  existing.delete(gapId);
  base.dismissed_gaps = Array.from(existing);
  return base;
}
