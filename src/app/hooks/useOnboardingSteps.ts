/**
 * Onboarding state machine — determines which inline form to show next
 * based on actual DB state. No keyword detection, fully deterministic.
 */

import { useCallback, useEffect, useState } from "react";
import { detectOnboardingState, type OnboardingState } from "../services/onboardingState";
import type { InlineFormType } from "../services/agentActions";

export type OnboardingStep = InlineFormType | "complete" | "dismissed";

const STEP_ORDER: InlineFormType[] = [
  "home_type_picker",
  "room_editor",
  "feature_selector",
  "household_details",
  "chore_recommendations",
  "helper_form",
];

function computeNextStep(state: OnboardingState): OnboardingStep {
  if (!state.homeProfileExists) return "home_type_picker";
  if (state.roomCount === 0) return "room_editor";
  if (!state.hasFeatures) return "feature_selector";
  // Household details: we consider it done if the home profile exists
  // (pets/kids/bathrooms are optional — skip if home profile exists)
  // But if we haven't been through it yet, show it after features.
  // We track this by checking if the step was explicitly completed.
  if (state.choreCount === 0) return "chore_recommendations";
  if (state.helperCount === 0) return "helper_form";
  return "complete";
}

export interface OnboardingStepsReturn {
  /** The current step to render (or "complete"/"dismissed"). */
  currentStep: OnboardingStep;
  /** The detected onboarding state from the DB. */
  state: OnboardingState | null;
  /** Whether the state is being loaded. */
  loading: boolean;
  /** Advance to the next step after a form submission. Re-reads DB state. */
  advance: () => Promise<void>;
  /** Skip the current step without saving (move to next). */
  skip: () => void;
  /** Dismiss onboarding entirely (user chose to finish later). */
  dismiss: () => void;
  /** List of completed step names (for progress display). */
  completedSteps: InlineFormType[];
  /** Total number of steps. */
  totalSteps: number;
}

export function useOnboardingSteps(
  householdId: string,
  userId: string,
): OnboardingStepsReturn {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState<OnboardingStep>("home_type_picker");
  const [skippedSteps, setSkippedSteps] = useState<Set<string>>(new Set());

  const loadState = useCallback(async () => {
    if (!householdId || !userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const s = await detectOnboardingState(householdId, userId);
    setState(s);
    setLoading(false);

    const next = computeNextStep(s);
    // If the computed next step was skipped, advance past it
    let step = next;
    const idx = STEP_ORDER.indexOf(step as InlineFormType);
    if (idx >= 0 && skippedSteps.has(step)) {
      // Find the next non-skipped step
      for (let i = idx + 1; i < STEP_ORDER.length; i++) {
        if (!skippedSteps.has(STEP_ORDER[i])) {
          step = STEP_ORDER[i];
          break;
        }
      }
      if (step === next) step = "complete"; // all remaining were skipped
    }
    setCurrentStep(step);
  }, [householdId, userId, skippedSteps]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const advance = useCallback(async () => {
    // Re-read DB state to determine next step
    await loadState();
  }, [loadState]);

  const skip = useCallback(() => {
    if (currentStep === "complete" || currentStep === "dismissed") return;
    setSkippedSteps((prev) => new Set(prev).add(currentStep));
    // Move to the next step in order
    const idx = STEP_ORDER.indexOf(currentStep as InlineFormType);
    if (idx >= 0 && idx < STEP_ORDER.length - 1) {
      setCurrentStep(STEP_ORDER[idx + 1]);
    } else {
      setCurrentStep("complete");
    }
  }, [currentStep]);

  const dismiss = useCallback(() => {
    setCurrentStep("dismissed");
  }, []);

  // Compute completed steps for progress display
  const completedSteps: InlineFormType[] = [];
  if (state) {
    if (state.homeProfileExists) completedSteps.push("home_type_picker");
    if (state.roomCount > 0) completedSteps.push("room_editor");
    if (state.hasFeatures) completedSteps.push("feature_selector");
    // household_details is hard to detect separately, include if home profile exists
    if (state.homeProfileExists) completedSteps.push("household_details");
    if (state.choreCount > 0) completedSteps.push("chore_recommendations");
    if (state.helperCount > 0) completedSteps.push("helper_form");
  }

  return {
    currentStep,
    state,
    loading,
    advance,
    skip,
    dismiss,
    completedSteps,
    totalSteps: STEP_ORDER.length,
  };
}
