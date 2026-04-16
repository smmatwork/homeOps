import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const supabaseFromMock = vi.fn();

vi.mock("../../services/supabaseClient", () => ({
  supabase: {
    from: (...args: any[]) => supabaseFromMock(...args),
  },
}));

const executeToolCallMock = vi.fn();

vi.mock("../../services/agentApi", () => ({
  executeToolCall: (...args: any[]) => executeToolCallMock(...args),
}));

import { useHomeProfileWizard, HOME_PROFILE_TOTAL_STEPS } from "./useHomeProfileWizard";

function createThenableBuilder(result: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => builder,
    limit: () => builder,
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

function createHookParams(overrides?: Partial<Parameters<typeof useHomeProfileWizard>[0]>) {
  return {
    getAgentSetup: () => ({ token: "test-token", householdId: "test-hid" }),
    memoryScope: "household" as const,
    appendAssistantMessage: vi.fn(),
    setToolBusy: vi.fn(),
    setToolError: vi.fn(),
    setToolSuccess: vi.fn(),
    ...overrides,
  };
}

describe("useHomeProfileWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with default state", () => {
    const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));
    expect(result.current.homeProfileDraft).toBeNull();
    expect(result.current.homeProfileWizardOpen).toBe(false);
    expect(result.current.homeProfileWizardStep).toBe(0);
    expect(result.current.homeProfileMode).toBe("edit");
    expect(result.current.homeProfileExists).toBe(false);
    expect(result.current.homeProfileBusy).toBe(false);
    expect(result.current.homeProfileError).toBeNull();
  });

  it("HOME_PROFILE_TOTAL_STEPS is 4", () => {
    expect(HOME_PROFILE_TOTAL_STEPS).toBe(4);
  });

  describe("openHomeProfileWizard", () => {
    it("opens wizard at step 0 in edit mode when no profile exists", () => {
      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      act(() => {
        result.current.openHomeProfileWizard();
      });

      expect(result.current.homeProfileWizardOpen).toBe(true);
      expect(result.current.homeProfileWizardStep).toBe(0);
      expect(result.current.homeProfileMode).toBe("edit");
      expect(result.current.homeProfileDraft).toBeNull();
    });
  });

  describe("closeHomeProfileWizard", () => {
    it("closes wizard and resets newSpace", () => {
      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      act(() => {
        result.current.openHomeProfileWizard();
      });
      expect(result.current.homeProfileWizardOpen).toBe(true);

      act(() => {
        result.current.closeHomeProfileWizard();
      });
      expect(result.current.homeProfileWizardOpen).toBe(false);
      expect(result.current.homeProfileNewSpace).toBe("");
    });
  });

  describe("step navigation", () => {
    it("goNextHomeProfileStep increments step up to max", () => {
      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      act(() => result.current.goNextHomeProfileStep());
      expect(result.current.homeProfileWizardStep).toBe(1);

      act(() => result.current.goNextHomeProfileStep());
      expect(result.current.homeProfileWizardStep).toBe(2);

      act(() => result.current.goNextHomeProfileStep());
      expect(result.current.homeProfileWizardStep).toBe(3);

      // Should not go past max
      act(() => result.current.goNextHomeProfileStep());
      expect(result.current.homeProfileWizardStep).toBe(3);
    });

    it("goBackHomeProfileStep decrements step to minimum 0", () => {
      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      // Start at step 2
      act(() => result.current.goNextHomeProfileStep());
      act(() => result.current.goNextHomeProfileStep());
      expect(result.current.homeProfileWizardStep).toBe(2);

      act(() => result.current.goBackHomeProfileStep());
      expect(result.current.homeProfileWizardStep).toBe(1);

      act(() => result.current.goBackHomeProfileStep());
      expect(result.current.homeProfileWizardStep).toBe(0);

      // Should not go below 0
      act(() => result.current.goBackHomeProfileStep());
      expect(result.current.homeProfileWizardStep).toBe(0);
    });
  });

  describe("updateHomeProfileRecord", () => {
    it("patches the draft record when draft exists", () => {
      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      // Set up a draft
      act(() => {
        result.current.setHomeProfileDraft({
          id: "test",
          action: {
            type: "create",
            table: "home_profiles",
            record: { home_type: "apartment", bhk: 2 },
            reason: "test",
          },
        });
      });

      act(() => {
        result.current.updateHomeProfileRecord({ bhk: 3, has_pets: true });
      });

      const record = result.current.homeProfileDraft?.action.record as Record<string, unknown>;
      expect(record.bhk).toBe(3);
      expect(record.has_pets).toBe(true);
      expect(record.home_type).toBe("apartment"); // unchanged
    });

    it("does nothing when no draft exists", () => {
      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      act(() => {
        result.current.updateHomeProfileRecord({ bhk: 3 });
      });

      expect(result.current.homeProfileDraft).toBeNull();
    });
  });

  describe("refreshHomeProfileExists", () => {
    it("sets homeProfileExists to true when profile found", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({ data: [{ household_id: "test-hid" }], error: null }),
      );

      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      await act(async () => {
        await result.current.refreshHomeProfileExists();
      });

      expect(result.current.homeProfileExists).toBe(true);
      expect(supabaseFromMock).toHaveBeenCalledWith("home_profiles");
    });

    it("sets homeProfileExists to false when no profile found", async () => {
      supabaseFromMock.mockReturnValue(
        createThenableBuilder({ data: [], error: null }),
      );

      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      await act(async () => {
        await result.current.refreshHomeProfileExists();
      });

      expect(result.current.homeProfileExists).toBe(false);
    });

    it("sets homeProfileExists to false when no householdId", async () => {
      const params = createHookParams({
        getAgentSetup: () => ({ token: "t", householdId: "" }),
      });
      const { result } = renderHook(() => useHomeProfileWizard(params));

      await act(async () => {
        await result.current.refreshHomeProfileExists();
      });

      expect(result.current.homeProfileExists).toBe(false);
    });
  });

  describe("saveHomeProfileDraft", () => {
    it("calls executeToolCall with correct params on save", async () => {
      executeToolCallMock.mockResolvedValue({ ok: true, summary: "Home profile saved" });

      const params = createHookParams();
      const { result } = renderHook(() => useHomeProfileWizard(params));

      // Set up a draft
      act(() => {
        result.current.setHomeProfileDraft({
          id: "test",
          action: {
            type: "create",
            table: "home_profiles",
            record: {
              __template_key: "2bhk_apartment",
              home_type: "apartment",
              bhk: 2,
              spaces: [],
            },
            reason: "Create home profile",
          },
        });
      });

      await act(async () => {
        await result.current.saveHomeProfileDraft();
      });

      expect(executeToolCallMock).toHaveBeenCalledTimes(1);
      const call = executeToolCallMock.mock.calls[0][0];
      expect(call.toolCall.tool).toBe("db.insert");
      expect(call.toolCall.args.table).toBe("home_profiles");
      // __template_key should be stripped
      expect(call.toolCall.args.record.__template_key).toBeUndefined();
      expect(call.toolCall.args.record.home_type).toBe("apartment");
      expect(params.setToolBusy).toHaveBeenCalled();
      expect(params.setToolSuccess).toHaveBeenCalledWith("Home profile saved");
      expect(result.current.homeProfileDraft).toBeNull();
      expect(result.current.homeProfileExists).toBe(true);
    });

    it("does nothing when draft is null", async () => {
      const { result } = renderHook(() => useHomeProfileWizard(createHookParams()));

      await act(async () => {
        await result.current.saveHomeProfileDraft();
      });

      expect(executeToolCallMock).not.toHaveBeenCalled();
    });

    it("sets error when executeToolCall fails", async () => {
      executeToolCallMock.mockResolvedValue({ ok: false, error: "save failed" });

      const params = createHookParams();
      const { result } = renderHook(() => useHomeProfileWizard(params));

      act(() => {
        result.current.setHomeProfileDraft({
          id: "test",
          action: { type: "create", table: "home_profiles", record: { home_type: "apartment" }, reason: "test" },
        });
      });

      await act(async () => {
        await result.current.saveHomeProfileDraft();
      });

      expect(params.setToolError).toHaveBeenCalledWith("save failed");
      // Draft should NOT be cleared on failure
      expect(result.current.homeProfileDraft).not.toBeNull();
    });
  });
});
