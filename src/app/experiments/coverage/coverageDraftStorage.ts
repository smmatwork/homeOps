type CoverageDraft = {
  version: 2;
  devices: Record<string, boolean>;
  otherMachines: string[];
  areas: string[];
  confidenceByDevice: Record<string, "reliable" | "sometimes" | "flaky">;
  schedulesByDevice: Record<
    string,
    {
      type: "none" | "on_demand" | "weekly";
      days: number[];
      time: string;
    }
  >;
  coveredAreasByDevice: Record<string, string[]>;
};

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function coverageDraftKey(householdId: string): string {
  return `homeops.exp.coverage.draft.v1.${householdId || "unknown"}`;
}

export function loadCoverageDraft(householdId: string): CoverageDraft | null {
  try {
    const raw = safeJsonParse<any>(localStorage.getItem(coverageDraftKey(householdId)));
    if (!raw || typeof raw !== "object") return null;
    if (raw.version === 2) return raw as CoverageDraft;

    // Backward compatible: best-effort migrate v1 -> v2.
    const devices = (raw.devices && typeof raw.devices === "object" ? raw.devices : {}) as Record<string, boolean>;
    const confidenceByDevice =
      raw.confidenceByDevice && typeof raw.confidenceByDevice === "object"
        ? (raw.confidenceByDevice as CoverageDraft["confidenceByDevice"])
        : ({} as CoverageDraft["confidenceByDevice"]);
    const areas = Array.isArray(raw.areas) ? (raw.areas as unknown[]).map(String).filter(Boolean) : [];

    const next = defaultCoverageDraft();
    next.devices = { ...next.devices, ...devices };
    next.confidenceByDevice = { ...next.confidenceByDevice, ...confidenceByDevice };
    next.areas = areas;
    next.otherMachines = Array.isArray(raw.otherMachines) ? raw.otherMachines.map(String).filter(Boolean) : [];

    // If the old draft had any area tags, carry them over to robot vacuum as a reasonable default.
    if (raw.coverageByArea && typeof raw.coverageByArea === "object") {
      const coveredAreas = Object.keys(raw.coverageByArea);
      if (coveredAreas.length > 0) {
        next.coveredAreasByDevice.robot_vacuum = coveredAreas;
      }
    }

    return next;
  } catch {
    return null;
  }
}

export function saveCoverageDraft(householdId: string, draft: CoverageDraft): void {
  try {
    localStorage.setItem(coverageDraftKey(householdId), JSON.stringify(draft));
  } catch {
    // ignore
  }
}

export function clearCoverageDraft(householdId: string): void {
  try {
    localStorage.removeItem(coverageDraftKey(householdId));
  } catch {
    // ignore
  }
}

export function defaultCoverageDraft(): CoverageDraft {
  return {
    version: 2,
    devices: {
      robot_vacuum: false,
      robot_mop: false,
      dishwasher: false,
      washing_machine: true,
      clothes_dryer: false,
      air_purifier: false,
      vacuum_cleaner: false,
      steam_mop: false,
      microwave_oven: false,
      water_heater_geyser: false,
      ro_service_contract: false,
      water_purifier: false,
      pest_control_contract: false,
    },
    confidenceByDevice: {
      robot_vacuum: "reliable",
      robot_mop: "reliable",
      dishwasher: "reliable",
      washing_machine: "reliable",
      clothes_dryer: "reliable",
      air_purifier: "reliable",
      vacuum_cleaner: "reliable",
      steam_mop: "reliable",
      microwave_oven: "reliable",
      water_heater_geyser: "reliable",
      ro_service_contract: "reliable",
      water_purifier: "reliable",
      pest_control_contract: "reliable",
    },
    otherMachines: [],
    areas: [],
    schedulesByDevice: {
      robot_vacuum: { type: "weekly", days: [], time: "09:00" },
      robot_mop: { type: "weekly", days: [], time: "10:00" },
      dishwasher: { type: "on_demand", days: [], time: "" },
      washing_machine: { type: "on_demand", days: [], time: "" },
      clothes_dryer: { type: "on_demand", days: [], time: "" },
      air_purifier: { type: "on_demand", days: [], time: "" },
      vacuum_cleaner: { type: "none", days: [], time: "" },
      steam_mop: { type: "none", days: [], time: "" },
      microwave_oven: { type: "none", days: [], time: "" },
      water_heater_geyser: { type: "none", days: [], time: "" },
      ro_service_contract: { type: "none", days: [], time: "" },
      water_purifier: { type: "none", days: [], time: "" },
      pest_control_contract: { type: "none", days: [], time: "" },
    },
    coveredAreasByDevice: {
      robot_vacuum: [],
      robot_mop: [],
    },
  };
}

export type { CoverageDraft };
