/**
 * Onboarding panel rendered inside the chat during onboarding mode.
 * Driven by the state machine (useOnboardingSteps), not keyword detection.
 * Shows: progress bar → current inline form → skip/dismiss buttons.
 */

import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { CheckCircle, SkipNext, Close } from "@mui/icons-material";
import { useI18n } from "../../i18n";
import { useOnboardingSteps, type OnboardingStep } from "../../hooks/useOnboardingSteps";
import type { OnboardingState } from "../../services/onboardingState";
import { generateChoreRecommendations } from "../../services/choreGenerator";
import { OnboardingInlineForm } from "./OnboardingInlineForms";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import { markOnboardingComplete } from "../../services/profileService";
import { useAuth } from "../../auth/AuthProvider";

interface OnboardingPanelProps {
  householdId: string;
  userId: string;
  /** Notify the chat when a form is submitted (sends status to agent). */
  onFormSubmitted: (message: string) => void;
  /** Called when onboarding is complete or dismissed. */
  onComplete: () => void;
}

/** Build step-specific context for the inline form. */
function buildFormContext(step: OnboardingStep, state: OnboardingState): Record<string, unknown> {

  const base = {
    rooms: state.roomNames.map((n, i) => ({ id: `r_${i}`, template_name: n, display_name: n, floor: 0 })),
    floors: 1,
    home_type: state.homeType ?? "apartment",
  };

  if (step === "chore_recommendations") {
    const chores = generateChoreRecommendations({
      roomNames: state.roomNames,
      homeType: state.homeType ?? "apartment",
      hasKids: false, // Could be enhanced to read from state
      hasPets: false,
      featureKeys: state.featureCount > 0 ? [] : [], // TODO: pass actual feature keys
    });
    return { ...base, chores };
  }

  return base;
}

const STEP_LABELS: Record<string, string> = {
  home_type_picker: "Home Type",
  room_editor: "Rooms",
  feature_selector: "Features",
  household_details: "Details",
  chore_recommendations: "Chores",
  helper_form: "Helpers",
};

export function OnboardingPanel({
  householdId,
  userId,
  onFormSubmitted,
  onComplete,
}: OnboardingPanelProps) {
  const { t } = useI18n();
  const { accessToken } = useAuth();
  const {
    currentStep,
    state,
    loading,
    advance,
    skip,
    dismiss,
    completedSteps,
    totalSteps,
  } = useOnboardingSteps(householdId, userId);

  // All hooks must be called before any early returns
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" py={2}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (currentStep === "dismissed") {
    return null;
  }

  if (currentStep === "complete") {
    // Mark onboarding complete (non-blocking)
    void markOnboardingComplete(userId);
    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: "success.50", borderColor: "success.200" }}>
        <Stack spacing={2} alignItems="center" textAlign="center">
          <CheckCircle color="success" sx={{ fontSize: 40 }} />
          <Typography variant="subtitle1" fontWeight={700}>
            {t("onboarding.setup_complete")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("onboarding.setup_complete_hint")}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="small"
              onClick={() => {
                // Trigger the agent to start the assignment conversation
                onFormSubmitted("My onboarding is complete. I have helpers and chores set up. Help me assign chores to the right helpers based on their roles and schedules. Ask me about each helper's role and working hours, then suggest assignments.");
                onComplete();
              }}
            >
              {t("onboarding.assign_chores_now")}
            </Button>
            <Button variant="outlined" size="small" onClick={onComplete}>
              {t("onboarding.assign_later")}
            </Button>
          </Stack>
        </Stack>
      </Paper>
    );
  }

  const progressPct = Math.round((completedSteps.length / totalSteps) * 100);

  /** Helper: run a Supabase call and throw on error */
  const dbCall = async (op: PromiseLike<{ error: { message: string } | null }>): Promise<void> => {
    const { error: err } = await op;
    if (err) throw new Error(err.message);
  };

  const handleSubmit = async (data: Record<string, unknown>) => {
    const formType = String(data.form_type ?? "");

    let savedMsg = "";
    setSaving(true);
    setSaveError(null);

    try {
      if (formType === "home_type_picker" && householdId) {
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        await dbCall(supabase.from("home_profiles").upsert({
          household_id: householdId,
          home_type: data.home_type ?? "apartment",
          bhk: data.bhk ?? 2,
          spaces: rooms,
          floors: data.floors ?? 1,
          has_balcony: rooms.some((r: Record<string, unknown>) => String(r.display_name ?? "").toLowerCase().includes("balcony")),
        }, { onConflict: "household_id" }));
        savedMsg = `Home profile saved: ${data.home_type}, ${data.bhk} BHK.`;
      } else if (formType === "room_editor" && householdId) {
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        await dbCall(supabase.from("home_profiles").update({ spaces: rooms }).eq("household_id", householdId));
        savedMsg = `${rooms.length} rooms saved.`;
      } else if (formType === "feature_selector" && householdId) {
        const features = Array.isArray(data.features) ? data.features : [];
        await dbCall(supabase.from("home_features").delete().eq("household_id", householdId));
        if (features.length > 0) {
          await dbCall(supabase.from("home_features").insert(
            features.map((f: Record<string, unknown>) => ({
              household_id: householdId,
              feature_key: f.feature_key,
              quantity: f.quantity ?? 1,
            }))
          ));
        }
        savedMsg = `${features.length} features saved.`;
      } else if (formType === "household_details" && householdId) {
        await dbCall(supabase.from("home_profiles").update({
          has_pets: data.has_pets ?? false,
          has_kids: data.has_kids ?? false,
          num_bathrooms: data.num_bathrooms ?? null,
          flooring_type: data.flooring_type ?? null,
        }).eq("household_id", householdId));
        savedMsg = "Household details saved.";
      } else if (formType === "chore_recommendations") {
        if (data.skipped) {
          savedMsg = "Chore creation skipped.";
        } else {
          const chores = Array.isArray(data.confirmed_chores) ? data.confirmed_chores : [];
          if (chores.length > 0 && householdId && accessToken) {
            for (const c of chores as Array<Record<string, unknown>>) {
              await executeToolCall({
                accessToken,
                householdId,
                scope: "household",
                toolCall: {
                  id: `onboard_chore_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  tool: "db.insert",
                  args: {
                    table: "chores",
                    record: {
                      title: c.title,
                      status: "pending",
                      priority: typeof c.priority === "number" ? c.priority : 1,
                      metadata: {
                        space: c.space,
                        cadence: c.cadence,
                        category: c.category ?? null,
                        estimated_minutes: typeof c.estimatedMinutes === "number" ? c.estimatedMinutes : null,
                        source: "onboarding",
                      },
                    },
                  },
                  reason: "Onboarding: create chore",
                },
              });
            }
          }
          savedMsg = `${chores.length} chores created.`;
        }
      } else if (formType === "helper_form") {
        if (data.skipped) {
          savedMsg = "Helper setup skipped.";
        } else if (householdId && accessToken) {
          const helpers = Array.isArray(data.helpers) ? data.helpers : [];
          for (const h of helpers as Array<Record<string, unknown>>) {
            await executeToolCall({
              accessToken,
              householdId,
              scope: "household",
              toolCall: {
                id: `onboard_helper_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                tool: "db.insert",
                args: {
                  table: "helpers",
                  record: {
                    name: h.name,
                    type: h.type ?? null,
                    phone: h.phone ?? null,
                  },
                },
                reason: "Onboarding: create helper",
              },
            });
          }
          savedMsg = `${helpers.length} helper${helpers.length === 1 ? "" : "s"} added.`;
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      setSaveError(errMsg);
      setSaving(false);
      return; // Don't advance on error
    }

    if (savedMsg) {
      onFormSubmitted(savedMsg);
    }

    // Re-read DB state to advance to next step
    await advance();
    setSaving(false);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 540, mx: "auto" }}>
      <Stack spacing={2}>
        {/* Progress bar */}
        <Stack spacing={0.5}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="caption" fontWeight={600} color="text.secondary">
              {t("onboarding.setup_progress")}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {completedSteps.length}/{totalSteps}
            </Typography>
          </Stack>
          <LinearProgress variant="determinate" value={progressPct} sx={{ height: 6, borderRadius: 1 }} />
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {Object.entries(STEP_LABELS).map(([key, label]) => (
              <Chip
                key={key}
                label={label}
                size="small"
                color={completedSteps.includes(key as any) ? "success" : currentStep === key ? "primary" : "default"}
                variant={currentStep === key ? "filled" : "outlined"}
                sx={{ fontSize: 11 }}
              />
            ))}
          </Stack>
        </Stack>

        {/* Error display */}
        {saveError && <Alert severity="error" onClose={() => setSaveError(null)}>{saveError}</Alert>}

        {/* Current form with step-specific context */}
        <OnboardingInlineForm
          formType={currentStep as any}
          context={state ? buildFormContext(currentStep, state) : undefined}
          onSubmit={handleSubmit}
          disabled={saving}
        />

        {/* Skip / Dismiss buttons */}
        <Stack direction="row" justifyContent="space-between">
          <Button
            size="small"
            startIcon={<SkipNext />}
            onClick={skip}
            sx={{ textTransform: "none", color: "text.secondary" }}
          >
            {t("onboarding.skip_step")}
          </Button>
          <Button
            size="small"
            startIcon={<Close />}
            onClick={() => {
              dismiss();
              onComplete();
            }}
            sx={{ textTransform: "none", color: "text.secondary" }}
          >
            {t("onboarding.finish_later")}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
