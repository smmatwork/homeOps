import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    lang: "en",
    setLang: vi.fn(),
  }),
}));

import { UserProfileStep, type UserProfileFormData } from "./UserProfileStep";

function defaultProfile(): UserProfileFormData {
  return {
    full_name: "",
    household_role: null,
    goals: [],
    preferred_language: null,
    work_schedule: null,
  };
}

describe("UserProfileStep", () => {
  const onChange = vi.fn();
  const onSubStepChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders name and role cards on sub-step 0", () => {
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={0}
        onSubStepChange={onSubStepChange}
      />,
    );

    expect(screen.getByText("onboarding.profile_name_title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.role_title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.role_primary_manager")).toBeInTheDocument();
    expect(screen.getByText("onboarding.role_shared_responsibility")).toBeInTheDocument();
    expect(screen.getByText("onboarding.role_contributor")).toBeInTheDocument();
    expect(screen.getByText("onboarding.role_observer")).toBeInTheDocument();
  });

  it("calls onChange with role when a role card is clicked", async () => {
    const user = userEvent.setup();
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={0}
        onSubStepChange={onSubStepChange}
      />,
    );

    await user.click(screen.getByText("onboarding.role_primary_manager"));
    expect(onChange).toHaveBeenCalledWith({ household_role: "primary_manager" });
  });

  it("renders goal chips on sub-step 1", () => {
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={1}
        onSubStepChange={onSubStepChange}
      />,
    );

    expect(screen.getByText("onboarding.goals_title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.goal_cleanliness")).toBeInTheDocument();
    expect(screen.getByText("onboarding.goal_health_nutrition")).toBeInTheDocument();
    expect(screen.getByText("onboarding.goal_cost_optimization")).toBeInTheDocument();
    expect(screen.getByText("onboarding.goal_time_saving")).toBeInTheDocument();
  });

  it("toggles goals on click", async () => {
    const user = userEvent.setup();
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={1}
        onSubStepChange={onSubStepChange}
      />,
    );

    await user.click(screen.getByText("onboarding.goal_cleanliness"));
    expect(onChange).toHaveBeenCalledWith({ goals: ["cleanliness"] });
  });

  it("removes goal when already selected", async () => {
    const user = userEvent.setup();
    const profile = { ...defaultProfile(), goals: ["cleanliness" as const, "time_saving" as const] };
    render(
      <UserProfileStep
        profile={profile}
        onChange={onChange}
        subStep={1}
        onSubStepChange={onSubStepChange}
      />,
    );

    await user.click(screen.getByText("onboarding.goal_cleanliness"));
    expect(onChange).toHaveBeenCalledWith({ goals: ["time_saving"] });
  });

  it("renders language options on sub-step 2", () => {
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={2}
        onSubStepChange={onSubStepChange}
      />,
    );

    expect(screen.getByText("onboarding.language_title")).toBeInTheDocument();
    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.getByText("हिन्दी")).toBeInTheDocument();
    expect(screen.getByText("ಕನ್ನಡ")).toBeInTheDocument();
  });

  it("calls onChange with language when selected", async () => {
    const user = userEvent.setup();
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={2}
        onSubStepChange={onSubStepChange}
      />,
    );

    await user.click(screen.getByText("हिन्दी"));
    expect(onChange).toHaveBeenCalledWith({ preferred_language: "hi" });
  });

  it("renders schedule step on sub-step 3", () => {
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={3}
        onSubStepChange={onSubStepChange}
      />,
    );

    expect(screen.getByText("onboarding.schedule_title")).toBeInTheDocument();
    // Weekday chips should be rendered
    expect(screen.getByText("weekday.mon")).toBeInTheDocument();
    expect(screen.getByText("weekday.sun")).toBeInTheDocument();
  });

  it("navigates sub-steps with next/back buttons", async () => {
    const user = userEvent.setup();
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={1}
        onSubStepChange={onSubStepChange}
      />,
    );

    // Click next
    await user.click(screen.getByText("home_profile.next"));
    expect(onSubStepChange).toHaveBeenCalledWith(2);

    // Click back
    await user.click(screen.getByText("home_profile.back"));
    expect(onSubStepChange).toHaveBeenCalledWith(0);
  });

  it("does not show back button on first sub-step", () => {
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={0}
        onSubStepChange={onSubStepChange}
      />,
    );

    expect(screen.queryByText("home_profile.back")).not.toBeInTheDocument();
  });

  it("does not show next button on last sub-step", () => {
    render(
      <UserProfileStep
        profile={defaultProfile()}
        onChange={onChange}
        subStep={3}
        onSubStepChange={onSubStepChange}
      />,
    );

    expect(screen.queryByText("home_profile.next")).not.toBeInTheDocument();
  });
});
