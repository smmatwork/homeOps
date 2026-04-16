import { useState, useCallback, useEffect } from "react";
import {
  Box,
  Button,
  Paper,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Typography,
} from "@mui/material";
import { SmartToy, Home, CheckCircleOutline } from "@mui/icons-material";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { UserProfileStep, USER_PROFILE_TOTAL_SUB_STEPS, type UserProfileFormData } from "./UserProfileStep";
import { HomeProfileWizard } from "../home-profile/HomeProfileWizard";
import { useHomeProfileWizard } from "../home-profile/useHomeProfileWizard";
import { fetchUserProfile, markOnboardingComplete, updateUserProfile } from "../../services/profileService";
import type { UiLanguage } from "../../i18n";

const STEPS = ["step_welcome", "step_profile", "step_home", "step_agent"] as const;

export function OnboardingFlow() {
  const navigate = useNavigate();
  const { user, accessToken, householdId } = useAuth();
  const { t, setLang, lang } = useI18n();

  const [activeStep, setActiveStep] = useState(0);
  const [busy, setBusy] = useState(false);

  // User profile state
  const [profileSubStep, setProfileSubStep] = useState(0);
  const [profileData, setProfileData] = useState<UserProfileFormData>({
    full_name: "",
    household_role: null,
    goals: [],
    preferred_language: lang as UiLanguage,
    work_schedule: null,
  });

  // Load existing profile data
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await fetchUserProfile(user.id);
      if (data) {
        setProfileData((prev) => ({
          ...prev,
          full_name: data.full_name ?? prev.full_name,
          household_role: (data.household_role as any) ?? prev.household_role,
          goals: data.goals as any ?? prev.goals,
          preferred_language: (data.preferred_language as UiLanguage) ?? prev.preferred_language,
          work_schedule: data.work_schedule as any ?? prev.work_schedule,
        }));
      }
      // Also use auth metadata for name
      const metaName = typeof (user.user_metadata as any)?.full_name === "string"
        ? String((user.user_metadata as any).full_name)
        : "";
      if (metaName && !data?.full_name) {
        setProfileData((prev) => ({ ...prev, full_name: metaName }));
      }
    })();
  }, [user?.id]);

  // Tool state for home profile wizard
  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolSuccess, setToolSuccess] = useState<string | null>(null);

  const homeProfileHook = useHomeProfileWizard({
    getAgentSetup: () => ({
      token: accessToken ?? "",
      householdId: householdId ?? "",
    }),
    memoryScope: "household",
    appendAssistantMessage: () => {},
    setToolBusy,
    setToolError,
    setToolSuccess,
  });

  const handleProfileChange = useCallback((patch: Partial<UserProfileFormData>) => {
    setProfileData((prev) => ({ ...prev, ...patch }));
    // If language changed, update the UI language
    if (patch.preferred_language) {
      setLang(patch.preferred_language);
    }
  }, [setLang]);

  const saveProfile = useCallback(async () => {
    if (!user?.id) return;
    setBusy(true);
    await updateUserProfile(user.id, {
      full_name: profileData.full_name.trim() || null,
      household_role: profileData.household_role,
      goals: profileData.goals,
      preferred_language: profileData.preferred_language,
      work_schedule: profileData.work_schedule,
    });
    setBusy(false);
  }, [user?.id, profileData]);

  const handleNext = useCallback(async () => {
    // Save profile when leaving the profile step
    if (activeStep === 1) {
      await saveProfile();
    }
    setActiveStep((s) => Math.min(STEPS.length - 1, s + 1));
  }, [activeStep, saveProfile]);

  const handleBack = useCallback(() => {
    setActiveStep((s) => Math.max(0, s - 1));
  }, []);

  const handleFinish = useCallback(async () => {
    if (!user?.id) return;
    setBusy(true);
    await saveProfile();
    await markOnboardingComplete(user.id);
    setBusy(false);
    navigate("/", { replace: true });
  }, [user?.id, saveProfile, navigate]);

  const handleSkip = useCallback(async () => {
    if (!user?.id) return;
    setBusy(true);
    await markOnboardingComplete(user.id);
    setBusy(false);
    navigate("/", { replace: true });
  }, [user?.id, navigate]);

  return (
    <Box
      sx={{
        minHeight: "100vh",
        background: "linear-gradient(to bottom right, #e3f2fd, #c5cae9)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        py: 4,
        px: 2,
      }}
    >
      <Box sx={{ position: "fixed", top: 12, right: 12, zIndex: 10 }}>
        <LanguageSwitcher />
      </Box>

      <Paper
        elevation={3}
        sx={{
          width: "100%",
          maxWidth: 640,
          p: { xs: 3, sm: 4 },
          borderRadius: 3,
        }}
      >
        {/* Stepper */}
        <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 4 }}>
          {STEPS.map((key) => (
            <Step key={key}>
              <StepLabel>{t(`onboarding.${key}`)}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {/* Step 0: Welcome */}
        {activeStep === 0 && (
          <Stack spacing={3} alignItems="center" textAlign="center">
            <Home sx={{ fontSize: 64, color: "primary.main" }} />
            <Typography variant="h4" fontWeight={700}>
              {t("onboarding.welcome_title")}
            </Typography>
            <Typography variant="body1" color="text.secondary">
              {t("onboarding.welcome_subtitle")}
            </Typography>
            <Stack spacing={1} alignItems="flex-start" sx={{ maxWidth: 400, width: "100%" }}>
              {[1, 2, 3].map((n) => (
                <Stack key={n} direction="row" spacing={1} alignItems="center">
                  <CheckCircleOutline color="primary" fontSize="small" />
                  <Typography variant="body2">{t(`onboarding.welcome_bullet_${n}`)}</Typography>
                </Stack>
              ))}
            </Stack>
            <Button variant="contained" size="large" onClick={handleNext}>
              {t("onboarding.get_started")}
            </Button>
          </Stack>
        )}

        {/* Step 1: User Profile */}
        {activeStep === 1 && (
          <UserProfileStep
            profile={profileData}
            onChange={handleProfileChange}
            subStep={profileSubStep}
            onSubStepChange={setProfileSubStep}
          />
        )}

        {/* Step 2: Home Profile */}
        {activeStep === 2 && (
          <Stack spacing={2}>
            <Typography variant="h6">{t("onboarding.step_home")}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t("home_profile.pick_type")}
            </Typography>
            <HomeProfileWizard
              embedded
              open
              onClose={() => {
                // When wizard is "closed" in embedded mode, advance to next onboarding step
                setActiveStep(3);
              }}
              draft={homeProfileHook.homeProfileDraft}
              setDraft={homeProfileHook.setHomeProfileDraft}
              mode={homeProfileHook.homeProfileMode}
              setMode={homeProfileHook.setHomeProfileMode}
              step={homeProfileHook.homeProfileWizardStep}
              setStep={homeProfileHook.setHomeProfileWizardStep}
              newSpace={homeProfileHook.homeProfileNewSpace}
              setNewSpace={homeProfileHook.setHomeProfileNewSpace}
              busy={homeProfileHook.homeProfileBusy}
              error={homeProfileHook.homeProfileError}
              toolBusy={toolBusy}
              updateRecord={homeProfileHook.updateHomeProfileRecord}
              goNext={homeProfileHook.goNextHomeProfileStep}
              goBack={() => {
                // If we're on the first wizard step, go back to onboarding step 1
                if (homeProfileHook.homeProfileWizardStep === 0) {
                  setActiveStep(1);
                } else {
                  homeProfileHook.goBackHomeProfileStep();
                }
              }}
              onSave={async () => {
                const ok = await homeProfileHook.saveHomeProfileDraft();
                if (ok) setActiveStep(3);
                return ok;
              }}
            />
          </Stack>
        )}

        {/* Step 3: Meet the Agent */}
        {activeStep === 3 && (
          <Stack spacing={3} alignItems="center" textAlign="center">
            <SmartToy sx={{ fontSize: 64, color: "primary.main" }} />
            <Typography variant="h5" fontWeight={700}>
              {t("onboarding.agent_title")}
            </Typography>
            <Typography variant="body1" color="text.secondary">
              {t("onboarding.agent_subtitle")}
            </Typography>
            <Stack spacing={1.5} sx={{ maxWidth: 420, width: "100%" }}>
              {[1, 2, 3, 4].map((n) => (
                <Paper
                  key={n}
                  variant="outlined"
                  sx={{ p: 1.5, borderRadius: 2, textAlign: "left" }}
                >
                  <Typography variant="body2" color="text.secondary" fontStyle="italic">
                    {t(`onboarding.agent_example_${n}`)}
                  </Typography>
                </Paper>
              ))}
            </Stack>
            <Button
              variant="contained"
              size="large"
              disabled={busy}
              onClick={handleFinish}
            >
              {t("onboarding.finish")}
            </Button>
          </Stack>
        )}

        {/* Bottom navigation (step 1 only — step 2 has its own via HomeProfileWizard) */}
        {activeStep === 1 && (
          <Stack direction="row" justifyContent="space-between" mt={3}>
            <Button variant="text" onClick={handleBack} disabled={busy}>
              {t("home_profile.back")}
            </Button>
            <Button variant="contained" onClick={handleNext} disabled={busy}>
              {t("home_profile.next")}
            </Button>
          </Stack>
        )}

        {/* Skip link */}
        <Box textAlign="center" mt={3}>
          <Button variant="text" size="small" onClick={handleSkip} disabled={busy} sx={{ color: "text.secondary" }}>
            {t("onboarding.skip_all")}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
