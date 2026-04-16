/**
 * Onboarding panel rendered inside the chat during onboarding mode.
 * Driven by the state machine (useOnboardingSteps), not keyword detection.
 * Shows: progress bar → current inline form → skip/dismiss buttons.
 */

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
import { OnboardingInlineForm } from "./OnboardingInlineForms";
import { supabase } from "../../services/supabaseClient";
import { markOnboardingComplete } from "../../services/profileService";

interface OnboardingPanelProps {
  householdId: string;
  userId: string;
  /** Notify the chat when a form is submitted (sends status to agent). */
  onFormSubmitted: (message: string) => void;
  /** Called when onboarding is complete or dismissed. */
  onComplete: () => void;
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
    // Mark onboarding complete and notify
    void (async () => {
      await markOnboardingComplete(userId);
      onComplete();
    })();
    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: "success.50", borderColor: "success.200" }}>
        <Stack spacing={1} alignItems="center" textAlign="center">
          <CheckCircle color="success" sx={{ fontSize: 40 }} />
          <Typography variant="subtitle1" fontWeight={700}>
            {t("onboarding.setup_complete")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("onboarding.setup_complete_hint")}
          </Typography>
        </Stack>
      </Paper>
    );
  }

  const progressPct = Math.round((completedSteps.length / totalSteps) * 100);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const formType = String(data.form_type ?? "");
    let savedMsg = "";

    try {
      if (formType === "home_type_picker" && householdId) {
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        await supabase.from("home_profiles").upsert({
          household_id: householdId,
          home_type: data.home_type ?? "apartment",
          bhk: data.bhk ?? 2,
          spaces: rooms,
          floors: data.floors ?? 1,
          has_balcony: rooms.some((r: Record<string, unknown>) => String(r.display_name ?? "").toLowerCase().includes("balcony")),
        }, { onConflict: "household_id" });
        savedMsg = `Home profile saved: ${data.home_type}, ${data.bhk} BHK.`;
      } else if (formType === "room_editor" && householdId) {
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        await supabase.from("home_profiles").update({ spaces: rooms }).eq("household_id", householdId);
        savedMsg = `${rooms.length} rooms saved.`;
      } else if (formType === "feature_selector" && householdId) {
        const features = Array.isArray(data.features) ? data.features : [];
        await supabase.from("home_features").delete().eq("household_id", householdId);
        if (features.length > 0) {
          await supabase.from("home_features").insert(
            features.map((f: Record<string, unknown>) => ({
              household_id: householdId,
              feature_key: f.feature_key,
              quantity: f.quantity ?? 1,
            }))
          );
        }
        savedMsg = `${features.length} features saved.`;
      } else if (formType === "household_details" && householdId) {
        await supabase.from("home_profiles").update({
          has_pets: data.has_pets ?? false,
          has_kids: data.has_kids ?? false,
          num_bathrooms: data.num_bathrooms ?? null,
          flooring_type: data.flooring_type ?? null,
        }).eq("household_id", householdId);
        savedMsg = "Household details saved.";
      } else if (formType === "chore_recommendations") {
        if (data.skipped) {
          savedMsg = "Chore creation skipped.";
        } else {
          const chores = Array.isArray(data.confirmed_chores) ? data.confirmed_chores : [];
          if (chores.length > 0 && householdId) {
            await supabase.from("chores").insert(
              chores.map((c: Record<string, unknown>) => ({
                household_id: householdId,
                title: c.title,
                status: "pending",
                priority: 1,
                metadata: { space: c.space, cadence: c.cadence, source: "onboarding" },
              }))
            );
          }
          savedMsg = `${chores.length} chores created.`;
        }
      } else if (formType === "helper_form") {
        if (data.skipped) {
          savedMsg = "Helper setup skipped.";
        } else if (householdId) {
          await supabase.from("helpers").insert({
            household_id: householdId,
            name: data.name,
            type: data.type ?? null,
            phone: data.phone ?? null,
          });
          savedMsg = `Helper "${data.name}" added.`;
        }
      }
    } catch (e) {
      savedMsg = `Error saving: ${e instanceof Error ? e.message : "unknown"}`;
    }

    if (savedMsg) {
      onFormSubmitted(savedMsg);
    }

    // Re-read DB state to advance to next step
    await advance();
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

        {/* Current form */}
        <OnboardingInlineForm
          formType={currentStep as any}
          context={state ? {
            rooms: state.roomNames.map((n, i) => ({ id: `r_${i}`, template_name: n, display_name: n, floor: 0 })),
            floors: 1,
            home_type: state.homeType ?? "apartment",
          } : undefined}
          onSubmit={handleSubmit}
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
