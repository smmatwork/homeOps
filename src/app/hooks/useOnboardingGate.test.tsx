import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const navigateMock = vi.fn();

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/" }),
}));

const detectOnboardingStateMock = vi.fn();

vi.mock("../services/onboardingState", () => ({
  detectOnboardingState: (...args: unknown[]) => detectOnboardingStateMock(...args),
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "user-1" }, householdId: "hh-1" }),
}));

import { useOnboardingGate } from "./useOnboardingGate";

describe("useOnboardingGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /onboarding when onboarding not completed", async () => {
    detectOnboardingStateMock.mockResolvedValue({
      isComplete: false,
      homeProfileExists: false,
      choreCount: 0,
      helperCount: 0,
    });

    const { result } = renderHook(() => useOnboardingGate());
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith("/onboarding", { replace: true });
    expect(result.current.loading).toBe(false);
  });

  it("redirects to chat onboarding when complete flag set but no chores", async () => {
    detectOnboardingStateMock.mockResolvedValue({
      isComplete: true,
      homeProfileExists: true,
      choreCount: 0,
      helperCount: 0,
    });

    renderHook(() => useOnboardingGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith("/chat?onboarding=true", { replace: true });
  });

  it("does not redirect when setup is complete", async () => {
    detectOnboardingStateMock.mockResolvedValue({
      isComplete: true,
      homeProfileExists: true,
      choreCount: 5,
      helperCount: 2,
    });

    const { result } = renderHook(() => useOnboardingGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
