import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OnboardingFlow } from "./OnboardingFlow";

// ── Mocks ──────────────────────────────────────────────────────

const navigateMock = vi.fn();
vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
}));

const fetchUserProfileMock = vi.fn().mockResolvedValue({ data: { full_name: "Test User" } });
const updateUserProfileMock = vi.fn().mockResolvedValue({ ok: true });
const markOnboardingCompleteMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock("../../services/profileService", () => ({
  fetchUserProfile: (...args: unknown[]) => fetchUserProfileMock(...args),
  updateUserProfile: (...args: unknown[]) => updateUserProfileMock(...args),
  markOnboardingComplete: (...args: unknown[]) => markOnboardingCompleteMock(...args),
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "user-1", user_metadata: { full_name: "Test User" } },
    accessToken: "tok",
    householdId: "hh-1",
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, lang: "en", setLang: vi.fn() }),
}));

vi.mock("../LanguageSwitcher", () => ({
  LanguageSwitcher: () => null,
}));

// ── Tests ──────────────────────────────────────────────────────

describe("OnboardingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the welcome step initially", async () => {
    render(<OnboardingFlow />);
    expect(await screen.findByText("onboarding.welcome_title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.get_started")).toBeInTheDocument();
  });

  it("navigates to name step when get started is clicked", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await user.click(await screen.findByText("onboarding.get_started"));
    expect(screen.getByText("onboarding.profile_name_title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.continue_to_agent")).toBeInTheDocument();
  });

  it("has a skip button that completes onboarding", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await user.click(await screen.findByText("onboarding.skip_all"));
    expect(markOnboardingCompleteMock).toHaveBeenCalledWith("user-1");
    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
  });

  it("continue button saves profile and redirects to chat onboarding", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    // Go to name step
    await user.click(await screen.findByText("onboarding.get_started"));

    // Name should be pre-filled from mock
    const nameInput = screen.getByRole("textbox");
    expect(nameInput).toHaveValue("Test User");

    // Click continue
    await user.click(screen.getByText("onboarding.continue_to_agent"));

    expect(updateUserProfileMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      full_name: "Test User",
    }));
    expect(navigateMock).toHaveBeenCalledWith("/chat?onboarding=true", { replace: true });
  });

  it("back button returns to welcome from name step", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    await user.click(await screen.findByText("onboarding.get_started"));
    expect(screen.getByText("onboarding.profile_name_title")).toBeInTheDocument();

    await user.click(screen.getByText("home_profile.back"));
    expect(screen.getByText("onboarding.welcome_title")).toBeInTheDocument();
  });
});
