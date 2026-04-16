import { useState, useCallback, useEffect } from "react";
import {
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Home, CheckCircleOutline } from "@mui/icons-material";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { fetchUserProfile, markOnboardingComplete, updateUserProfile } from "../../services/profileService";
import type { UiLanguage } from "../../i18n";

/**
 * Simplified onboarding: welcome screen → collect name & language → redirect
 * to the chat in onboarding mode where the agent drives the full setup.
 */
export function OnboardingFlow() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t, setLang, lang } = useI18n();

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"welcome" | "name">("welcome");

  // Load existing name from profile or auth metadata
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await fetchUserProfile(user.id);
      if (data?.full_name) {
        setName(data.full_name);
        return;
      }
      const metaName = typeof (user.user_metadata as Record<string, unknown>)?.full_name === "string"
        ? String((user.user_metadata as Record<string, unknown>).full_name)
        : "";
      if (metaName) setName(metaName);
    })();
  }, [user?.id]);

  const handleStart = useCallback(() => {
    setStep("name");
  }, []);

  const handleContinue = useCallback(async () => {
    if (!user?.id) return;
    setBusy(true);
    await updateUserProfile(user.id, {
      full_name: name.trim() || null,
      preferred_language: lang as UiLanguage,
    });
    setBusy(false);
    // Redirect to chat in onboarding mode — the agent takes over from here
    navigate("/chat?onboarding=true", { replace: true });
  }, [user?.id, name, lang, navigate]);

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
        sx={{ width: "100%", maxWidth: 520, p: { xs: 3, sm: 4 }, borderRadius: 3 }}
      >
        {step === "welcome" && (
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
            <Button variant="contained" size="large" onClick={handleStart}>
              {t("onboarding.get_started")}
            </Button>
          </Stack>
        )}

        {step === "name" && (
          <Stack spacing={3}>
            <Typography variant="h5" fontWeight={700}>
              {t("onboarding.profile_name_title")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("onboarding.name_hint")}
            </Typography>
            <TextField
              label={t("onboarding.your_name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              fullWidth
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) void handleContinue();
              }}
            />
            <Stack direction="row" justifyContent="space-between">
              <Button variant="text" onClick={() => setStep("welcome")} disabled={busy}>
                {t("home_profile.back")}
              </Button>
              <Button variant="contained" onClick={handleContinue} disabled={busy || !name.trim()}>
                {t("onboarding.continue_to_agent")}
              </Button>
            </Stack>
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
