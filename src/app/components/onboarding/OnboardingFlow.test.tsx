import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.fn();

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "user-1", user_metadata: { full_name: "Test User" } },
    accessToken: "test-token",
    householdId: "test-hid",
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    lang: "en",
    setLang: vi.fn(),
  }),
}));

vi.mock("../LanguageSwitcher", () => ({
  LanguageSwitcher: () => null,
}));

const fetchUserProfileMock = vi.fn();
const updateUserProfileMock = vi.fn();
const markOnboardingCompleteMock = vi.fn();

vi.mock("../../services/profileService", () => ({
  fetchUserProfile: (...args: any[]) => fetchUserProfileMock(...args),
  updateUserProfile: (...args: any[]) => updateUserProfileMock(...args),
  markOnboardingComplete: (...args: any[]) => markOnboardingCompleteMock(...args),
}));

const supabaseFromMock = vi.fn();

vi.mock("../../services/supabaseClient", () => ({
  supabase: {
    from: (...args: any[]) => supabaseFromMock(...args),
  },
}));

vi.mock("../../services/agentApi", () => ({
  executeToolCall: vi.fn(async () => ({ ok: true, summary: "ok" })),
}));

import { OnboardingFlow } from "./OnboardingFlow";

describe("OnboardingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchUserProfileMock.mockResolvedValue({
      data: {
        full_name: "Test User",
        household_role: null,
        goals: [],
        preferred_language: "en",
        work_schedule: null,
        onboarding_completed_at: null,
      },
      error: null,
    });
    updateUserProfileMock.mockResolvedValue({ error: null });
    markOnboardingCompleteMock.mockResolvedValue({ error: null });
  });

  it("renders the welcome step initially", async () => {
    render(<OnboardingFlow />);

    expect(await screen.findByText("onboarding.welcome_title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.welcome_subtitle")).toBeInTheDocument();
    expect(screen.getByText("onboarding.get_started")).toBeInTheDocument();
  });

  it("shows all 4 stepper labels", async () => {
    render(<OnboardingFlow />);

    expect(await screen.findByText("onboarding.step_welcome")).toBeInTheDocument();
    expect(screen.getByText("onboarding.step_profile")).toBeInTheDocument();
    expect(screen.getByText("onboarding.step_home")).toBeInTheDocument();
    expect(screen.getByText("onboarding.step_agent")).toBeInTheDocument();
  });

  it("renders welcome bullet points", async () => {
    render(<OnboardingFlow />);

    expect(await screen.findByText("onboarding.welcome_bullet_1")).toBeInTheDocument();
    expect(screen.getByText("onboarding.welcome_bullet_2")).toBeInTheDocument();
    expect(screen.getByText("onboarding.welcome_bullet_3")).toBeInTheDocument();
  });

  it("navigates to profile step when get started is clicked", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    await user.click(await screen.findByText("onboarding.get_started"));

    // Should now show profile step content
    expect(screen.getByText("onboarding.profile_name_title")).toBeInTheDocument();
  });

  it("has a skip button that completes onboarding", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    const skipButton = await screen.findByText("onboarding.skip_all");
    await user.click(skipButton);

    expect(markOnboardingCompleteMock).toHaveBeenCalledWith("user-1");
    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
  });

  it("navigates through welcome -> profile -> home -> agent steps", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    // Step 0: Welcome -> click Get Started
    await user.click(await screen.findByText("onboarding.get_started"));

    // Step 1: Profile -> click the outer/bottom Next button
    expect(screen.getByText("onboarding.profile_name_title")).toBeInTheDocument();
    const nextButtons1 = screen.getAllByText("home_profile.next");
    await user.click(nextButtons1[nextButtons1.length - 1]);

    // Step 2: Home profile should appear (text appears in both stepper and heading)
    expect(screen.getAllByText("onboarding.step_home").length).toBeGreaterThanOrEqual(2);

    // Click the outer/bottom Next to go to agent step (last "next" button)
    const nextButtons2 = screen.getAllByText("home_profile.next");
    await user.click(nextButtons2[nextButtons2.length - 1]);

    // Step 3: Agent intro
    expect(screen.getByText("onboarding.agent_title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.agent_subtitle")).toBeInTheDocument();
    expect(screen.getByText("onboarding.finish")).toBeInTheDocument();
  });

  it("saves profile when moving from profile to home step", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    // Go to profile step
    await user.click(await screen.findByText("onboarding.get_started"));

    // Navigate to home step (triggers save)
    const nextButtons = screen.getAllByText("home_profile.next");
    await user.click(nextButtons[nextButtons.length - 1]);

    expect(updateUserProfileMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      full_name: "Test User",
    }));
  });

  it("finish button marks onboarding complete and navigates to /", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    // Navigate through all steps to reach agent step
    await user.click(await screen.findByText("onboarding.get_started"));
    const nextButtons1 = screen.getAllByText("home_profile.next");
    await user.click(nextButtons1[nextButtons1.length - 1]);
    const nextButtons2 = screen.getAllByText("home_profile.next");
    await user.click(nextButtons2[nextButtons2.length - 1]);

    // Click finish
    await user.click(screen.getByText("onboarding.finish"));

    expect(markOnboardingCompleteMock).toHaveBeenCalledWith("user-1");
    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
  });

  it("shows agent example prompts on the final step", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    // Navigate to agent step
    await user.click(await screen.findByText("onboarding.get_started"));
    const nextButtons1 = screen.getAllByText("home_profile.next");
    await user.click(nextButtons1[nextButtons1.length - 1]);
    const nextButtons2 = screen.getAllByText("home_profile.next");
    await user.click(nextButtons2[nextButtons2.length - 1]);

    expect(screen.getByText("onboarding.agent_example_1")).toBeInTheDocument();
    expect(screen.getByText("onboarding.agent_example_2")).toBeInTheDocument();
    expect(screen.getByText("onboarding.agent_example_3")).toBeInTheDocument();
    expect(screen.getByText("onboarding.agent_example_4")).toBeInTheDocument();
  });
});
