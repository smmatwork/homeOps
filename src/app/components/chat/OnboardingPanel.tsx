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

/** Build step-specific context for the inline form. */
function buildFormContext(step: OnboardingStep, state: OnboardingState): Record<string, unknown> {

  const base = {
    rooms: state.roomNames.map((n, i) => ({ id: `r_${i}`, template_name: n, display_name: n, floor: 0 })),
    floors: 1,
    home_type: state.homeType ?? "apartment",
  };

  if (step === "chore_recommendations") {
    // Generate chore recommendations from room names
    const chores: Array<{ title: string; space: string; cadence: string }> = [];
    const rooms = state.roomNames;

    for (const room of rooms) {
      const lower = room.toLowerCase();
      if (/kitchen/.test(lower)) {
        chores.push({ title: `${room} daily wipe-down`, space: room, cadence: "daily" });
        chores.push({ title: `${room} deep clean`, space: room, cadence: "weekly" });
      } else if (/bath|toilet|washroom|powder/.test(lower)) {
        chores.push({ title: `Clean ${room}`, space: room, cadence: "weekly" });
      } else if (/bedroom|master/.test(lower)) {
        chores.push({ title: `Sweep and mop ${room}`, space: room, cadence: "daily" });
        chores.push({ title: `Dust ${room}`, space: room, cadence: "weekly" });
      } else if (/living|hall|drawing/.test(lower)) {
        chores.push({ title: `Sweep and mop ${room}`, space: room, cadence: "daily" });
        chores.push({ title: `Dust and vacuum ${room}`, space: room, cadence: "weekly" });
      } else if (/balcony|terrace|deck/.test(lower)) {
        chores.push({ title: `Sweep ${room}`, space: room, cadence: "weekly" });
      } else if (/garden|lawn/.test(lower)) {
        chores.push({ title: `Water plants in ${room}`, space: room, cadence: "daily" });
        chores.push({ title: `Garden maintenance`, space: room, cadence: "monthly" });
      } else if (/utility|laundry/.test(lower)) {
        chores.push({ title: `Clean ${room}`, space: room, cadence: "weekly" });
      } else if (/dining/.test(lower)) {
        chores.push({ title: `Wipe ${room} table`, space: room, cadence: "daily" });
      } else if (/pooja|prayer/.test(lower)) {
        chores.push({ title: `Clean ${room}`, space: room, cadence: "weekly" });
      } else if (/garage|parking|car/.test(lower)) {
        chores.push({ title: `Sweep ${room}`, space: room, cadence: "monthly" });
      } else {
        chores.push({ title: `Clean ${room}`, space: room, cadence: "weekly" });
      }
    }

    // Add general chores
    chores.push({ title: "Trash disposal", space: "General", cadence: "daily" });
    chores.push({ title: "Laundry", space: "General", cadence: "daily" });

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
          if (chores.length > 0 && householdId) {
            await dbCall(supabase.from("chores").insert(
              chores.map((c: Record<string, unknown>) => ({
                household_id: householdId,
                user_id: userId,
                title: c.title,
                status: "pending",
                priority: 1,
                metadata: { space: c.space, cadence: c.cadence, source: "onboarding" },
              }))
            ));
          }
          savedMsg = `${chores.length} chores created.`;
        }
      } else if (formType === "helper_form") {
        if (data.skipped) {
          savedMsg = "Helper setup skipped.";
        } else if (householdId) {
          const helpers = Array.isArray(data.helpers) ? data.helpers : [];
          if (helpers.length > 0) {
            await dbCall(supabase.from("helpers").insert(
              helpers.map((h: Record<string, unknown>) => ({
                household_id: householdId,
                name: h.name,
                type: h.type ?? null,
                phone: h.phone ?? null,
              }))
            ));
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
