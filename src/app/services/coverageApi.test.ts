import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseFromMock = vi.fn();

vi.mock("./supabaseClient", () => ({
  supabase: {
    from: (...args: any[]) => supabaseFromMock(...args),
  },
}));

import { detectCoverageGaps, fetchCoverageBaseline, fetchCoverageData, type CoverageRow } from "./coverageApi";

function createBuilder(result: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    in: () => builder,
    maybeSingle: () => builder,
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

describe("coverageApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("detectCoverageGaps", () => {
    it("returns empty array when all rows have coverage", () => {
      const rows: CoverageRow[] = [
        { space: "Kitchen", cadence: "daily", helperId: "h1", helperName: "Alice", deviceKeys: [], choreCount: 1 },
      ];
      const gaps = detectCoverageGaps(null, [], rows);
      expect(gaps).toEqual([]);
    });

    it("identifies rows with no chores and no devices as gaps", () => {
      const rows: CoverageRow[] = [
        { space: "Kitchen", cadence: "daily", helperId: null, helperName: null, deviceKeys: [], choreCount: 0 },
        { space: "Bedroom", cadence: "weekly", helperId: "h1", helperName: "Bob", deviceKeys: [], choreCount: 1 },
      ];
      const gaps = detectCoverageGaps(null, [], rows);
      expect(gaps.length).toBe(1);
      expect(gaps[0].space).toBe("Kitchen");
      expect(gaps[0].cadence).toBe("daily");
    });

    it("does not flag rows with device coverage as gaps", () => {
      const rows: CoverageRow[] = [
        { space: "Living Room", cadence: "daily", helperId: null, helperName: null, deviceKeys: ["robot_vacuum"], choreCount: 0 },
      ];
      const gaps = detectCoverageGaps(null, [], rows);
      expect(gaps).toEqual([]);
    });
  });

  describe("fetchCoverageBaseline", () => {
    it("returns baseline and spaces from home profile", async () => {
      supabaseFromMock.mockReturnValue(
        createBuilder({
          data: {
            metadata: {
              coverage_baseline: { devices: { robot_vacuum: true }, areas: ["Kitchen"] },
            },
            spaces: ["Kitchen", "Bedroom"],
          },
          error: null,
        }),
      );

      const result = await fetchCoverageBaseline("hh_1");
      expect(result.error).toBeNull();
      expect(result.baseline?.devices?.robot_vacuum).toBe(true);
      expect(result.spaces).toContain("Kitchen");
      expect(result.spaces).toContain("Bedroom");
    });

    it("returns error when supabase fails", async () => {
      supabaseFromMock.mockReturnValue(
        createBuilder({ data: null, error: { message: "permission denied" } }),
      );

      const result = await fetchCoverageBaseline("hh_1");
      expect(result.error).toBe("permission denied");
      expect(result.spaces).toEqual([]);
    });

    it("handles RoomEntry objects in spaces array", async () => {
      supabaseFromMock.mockReturnValue(
        createBuilder({
          data: {
            metadata: null,
            spaces: [
              { id: "kitchen_1", template_name: "Kitchen", display_name: "Main Kitchen", floor: 0 },
            ],
          },
          error: null,
        }),
      );

      const result = await fetchCoverageBaseline("hh_1");
      expect(result.spaces).toContain("Main Kitchen");
    });
  });

  describe("fetchCoverageData", () => {
    it("returns rows with helper coverage when chores are assigned", async () => {
      supabaseFromMock.mockImplementation((table: string) => {
        if (table === "home_profiles") {
          return createBuilder({
            data: {
              metadata: { coverage_baseline: null },
              spaces: ["Kitchen"],
            },
            error: null,
          });
        }
        if (table === "chores") {
          return createBuilder({
            data: [
              { id: "c1", helper_id: "h1", metadata: { space: "Kitchen", cadence: "daily" } },
            ],
            error: null,
          });
        }
        if (table === "helpers") {
          return createBuilder({
            data: [{ id: "h1", name: "Alice" }],
            error: null,
          });
        }
        return createBuilder({ data: [], error: null });
      });

      const result = await fetchCoverageData("hh_1");
      expect(result.error).toBeNull();

      const kitchenDaily = result.rows.find((r) => r.space === "Kitchen" && r.cadence === "daily");
      expect(kitchenDaily?.helperId).toBe("h1");
      expect(kitchenDaily?.helperName).toBe("Alice");
      expect(kitchenDaily?.choreCount).toBe(1);
    });

    it("identifies gaps when no chores and no devices cover a space/cadence", async () => {
      supabaseFromMock.mockImplementation((table: string) => {
        if (table === "home_profiles") {
          return createBuilder({
            data: { metadata: null, spaces: ["Kitchen"] },
            error: null,
          });
        }
        return createBuilder({ data: [], error: null });
      });

      const result = await fetchCoverageData("hh_1");
      // 4 cadences x 1 space = 4 rows, all gaps
      expect(result.gaps.length).toBe(4);
    });
  });
});
