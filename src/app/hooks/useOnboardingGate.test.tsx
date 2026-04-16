import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const navigateMock = vi.fn();

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
}));

const fetchUserProfileMock = vi.fn();

vi.mock("../services/profileService", () => ({
  fetchUserProfile: (...args: any[]) => fetchUserProfileMock(...args),
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

import { useOnboardingGate } from "./useOnboardingGate";

describe("useOnboardingGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /onboarding when onboarding not completed", async () => {
    fetchUserProfileMock.mockResolvedValue({
      data: { onboarding_completed_at: null },
      error: null,
    });

    const { result } = renderHook(() => useOnboardingGate());

    // Initially loading
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith("/onboarding", { replace: true });
    expect(result.current.loading).toBe(false);
  });

  it("does not redirect when onboarding is completed", async () => {
    fetchUserProfileMock.mockResolvedValue({
      data: { onboarding_completed_at: "2026-04-10T00:00:00Z" },
      error: null,
    });

    const { result } = renderHook(() => useOnboardingGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it("does not redirect when profile fetch fails (no data)", async () => {
    fetchUserProfileMock.mockResolvedValue({
      data: null,
      error: "connection failed",
    });

    const { result } = renderHook(() => useOnboardingGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Should redirect since data is null (no onboarding_completed_at)
    expect(navigateMock).toHaveBeenCalledWith("/onboarding", { replace: true });
    expect(result.current.loading).toBe(false);
  });
});
