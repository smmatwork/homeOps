import { supabase } from "./supabaseClient";
import { normalizeSpacesToRooms } from "../config/homeProfileTemplates";

export type CoverageBaseline = {
  devices?: Record<string, boolean>;
  confidenceByDevice?: Record<string, "reliable" | "sometimes" | "flaky">;
  schedulesByDevice?: Record<string, { type: string; days: number[]; time: string }>;
  coveredAreasByDevice?: Record<string, string[]>;
  areas?: string[];
  otherMachines?: string[];
};

export type CoverageRow = {
  space: string;
  cadence: "daily" | "weekly" | "biweekly" | "monthly";
  helperId: string | null;
  helperName: string | null;
  deviceKeys: string[];
  choreCount: number;
};

export interface CoverageGap {
  space: string;
  cadence: CoverageRow["cadence"];
  reason: string;
}

const CADENCES: CoverageRow["cadence"][] = ["daily", "weekly", "biweekly", "monthly"];

export async function fetchCoverageBaseline(householdId: string): Promise<{
  baseline: CoverageBaseline | null;
  spaces: string[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("home_profiles")
    .select("metadata, spaces")
    .eq("household_id", householdId)
    .maybeSingle();

  if (error) {
    return { baseline: null, spaces: [], error: error.message };
  }

  const metadata = (data?.metadata as Record<string, unknown> | null) ?? null;
  const baseline = (metadata?.coverage_baseline as CoverageBaseline | undefined) ?? null;

  // Spaces may be either string[] (legacy) or RoomEntry[] (current format).
  // Defensive: if the JSONB column comes back as a string, parse it.
  let rawSpacesField: unknown = (data as any)?.spaces;
  if (typeof rawSpacesField === "string") {
    try {
      rawSpacesField = JSON.parse(rawSpacesField);
    } catch {
      // leave as-is, normalizeSpacesToRooms will return []
    }
  }
  const rooms = normalizeSpacesToRooms(rawSpacesField);
  const spaces: string[] = rooms
    .map((rm) => (rm.display_name || rm.template_name || "").trim())
    .filter(Boolean);

  // Merge with baseline.areas if present
  const baselineAreas = baseline?.areas ?? [];
  const allSpaces = Array.from(new Set([...spaces, ...baselineAreas])).filter(Boolean);

  return { baseline, spaces: allSpaces, error: null };
}

type ChoreRow = {
  id: string;
  helper_id: string | null;
  metadata: Record<string, unknown> | null;
};

type HelperRow = {
  id: string;
  name: string;
};

export async function fetchCoverageData(householdId: string): Promise<{
  baseline: CoverageBaseline | null;
  spaces: string[];
  rows: CoverageRow[];
  gaps: CoverageGap[];
  error: string | null;
}> {
  const { baseline, spaces, error } = await fetchCoverageBaseline(householdId);
  if (error) return { baseline: null, spaces: [], rows: [], gaps: [], error };

  // Fetch chores
  const { data: choresData, error: choresErr } = await supabase
    .from("chores")
    .select("id,helper_id,metadata")
    .eq("household_id", householdId)
    .is("deleted_at", null);

  if (choresErr) return { baseline, spaces, rows: [], gaps: [], error: choresErr.message };

  // Fetch helpers
  const { data: helpersData, error: helpersErr } = await supabase
    .from("helpers")
    .select("id,name")
    .eq("household_id", householdId);

  if (helpersErr) return { baseline, spaces, rows: [], gaps: [], error: helpersErr.message };

  const helpers = (helpersData ?? []) as HelperRow[];
  const helpersById = new Map(helpers.map((h) => [h.id, h] as const));
  const chores = (choresData ?? []) as ChoreRow[];

  // Compute device coverage by area
  const devicesByArea: Map<string, string[]> = new Map();
  if (baseline?.coveredAreasByDevice) {
    for (const [device, areas] of Object.entries(baseline.coveredAreasByDevice)) {
      if (!baseline.devices?.[device]) continue;
      for (const area of areas) {
        const list = devicesByArea.get(area) ?? [];
        list.push(device);
        devicesByArea.set(area, list);
      }
    }
  }

  // Build rows: for each (space, cadence) compute coverage
  const rows: CoverageRow[] = [];
  const gaps: CoverageGap[] = [];

  for (const space of spaces) {
    for (const cadence of CADENCES) {
      const matching = chores.filter((c) => {
        const meta = (c.metadata ?? {}) as Record<string, unknown>;
        const choreSpace = typeof meta.space === "string" ? meta.space : "";
        const choreCadence = typeof meta.cadence === "string" ? meta.cadence : "";
        return choreSpace === space && choreCadence === cadence;
      });

      const helperId = matching.find((c) => c.helper_id)?.helper_id ?? null;
      const helperName = helperId ? helpersById.get(helperId)?.name ?? null : null;
      const deviceKeys = devicesByArea.get(space) ?? [];

      rows.push({
        space,
        cadence,
        helperId,
        helperName,
        deviceKeys,
        choreCount: matching.length,
      });

      // Gap detection: no chore AND no device covering it
      if (matching.length === 0 && deviceKeys.length === 0) {
        gaps.push({
          space,
          cadence,
          reason: "No helper assigned and no device covering this space",
        });
      }
    }
  }

  return { baseline, spaces, rows, gaps, error: null };
}

export function detectCoverageGaps(
  baseline: CoverageBaseline | null,
  spaces: string[],
  rows: CoverageRow[],
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const row of rows) {
    if (row.choreCount === 0 && row.deviceKeys.length === 0) {
      gaps.push({
        space: row.space,
        cadence: row.cadence,
        reason: "No helper assigned and no device covering this space",
      });
    }
  }
  // Suppress unused
  void baseline;
  void spaces;
  return gaps;
}
