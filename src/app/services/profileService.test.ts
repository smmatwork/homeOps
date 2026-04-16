import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseFromMock = vi.fn();

vi.mock("./supabaseClient", () => ({
  supabase: {
    from: (...args: any[]) => supabaseFromMock(...args),
  },
}));

import { fetchUserProfile, updateUserProfile, markOnboardingComplete } from "./profileService";

function createThenableBuilder(result: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    update: () => builder,
    eq: () => builder,
    maybeSingle: () => builder,
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

describe("profileService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fetchUserProfile", () => {
    it("returns profile data on success", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({
          data: {
            full_name: "Alice",
            household_role: "primary_manager",
            goals: ["cleanliness", "time_saving"],
            preferred_language: "en",
            work_schedule: { work_days: ["mon", "tue"], work_hours: "9-18" },
            onboarding_completed_at: "2026-04-10T00:00:00Z",
          },
          error: null,
        }),
      );

      const { data, error } = await fetchUserProfile("user-1");
      expect(error).toBeNull();
      expect(data).toEqual({
        full_name: "Alice",
        household_role: "primary_manager",
        goals: ["cleanliness", "time_saving"],
        preferred_language: "en",
        work_schedule: { work_days: ["mon", "tue"], work_hours: "9-18" },
        onboarding_completed_at: "2026-04-10T00:00:00Z",
      });
      expect(supabaseFromMock).toHaveBeenCalledWith("profiles");
    });

    it("returns null data when profile does not exist", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({ data: null, error: null }),
      );

      const { data, error } = await fetchUserProfile("user-1");
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("returns error on supabase failure", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({ data: null, error: { message: "connection failed" } }),
      );

      const { data, error } = await fetchUserProfile("user-1");
      expect(data).toBeNull();
      expect(error).toBe("connection failed");
    });

    it("handles missing new columns gracefully", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({
          data: { full_name: "Bob" },
          error: null,
        }),
      );

      const { data } = await fetchUserProfile("user-1");
      expect(data).toEqual({
        full_name: "Bob",
        household_role: null,
        goals: [],
        preferred_language: null,
        work_schedule: null,
        onboarding_completed_at: null,
      });
    });
  });

  describe("updateUserProfile", () => {
    it("updates profile and returns no error on success", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({ data: null, error: null }),
      );

      const { error } = await updateUserProfile("user-1", {
        household_role: "contributor",
        goals: ["health_nutrition"],
      });
      expect(error).toBeNull();
      expect(supabaseFromMock).toHaveBeenCalledWith("profiles");
    });

    it("returns error string on supabase failure", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({ data: null, error: { message: "permission denied" } }),
      );

      const { error } = await updateUserProfile("user-1", { full_name: "Test" });
      expect(error).toBe("permission denied");
    });
  });

  describe("markOnboardingComplete", () => {
    it("sets onboarding_completed_at via updateUserProfile", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({ data: null, error: null }),
      );

      const { error } = await markOnboardingComplete("user-1");
      expect(error).toBeNull();
      expect(supabaseFromMock).toHaveBeenCalledWith("profiles");
    });
  });
});
