import { useState, useCallback, useEffect } from "react";
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Add, Delete, Home, CheckCircleOutline, People } from "@mui/icons-material";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { supabase } from "../../services/supabaseClient";
import { fetchUserProfile, markOnboardingComplete, updateUserProfile } from "../../services/profileService";
import type { UiLanguage } from "../../i18n";

/**
 * Simplified onboarding: welcome screen → collect name & language → redirect
 * to the chat in onboarding mode where the agent drives the full setup.
 */
interface MemberEntry { name: string; type: "adult" | "kid" }

export function OnboardingFlow() {
  const navigate = useNavigate();
  const { user, householdId } = useAuth();
  const { t, setLang, lang } = useI18n();

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"welcome" | "name" | "members">("welcome");
  const [members, setMembers] = useState<MemberEntry[]>([{ name: "", type: "adult" }]);

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
    setStep("members");
  }, [user?.id, name, lang]);

  const handleSaveMembers = useCallback(async () => {
    if (!householdId) return;
    setBusy(true);

    const validMembers = members.filter((m) => m.name.trim());
    if (validMembers.length > 0) {
      const rows = validMembers.map((m) => ({
        household_id: householdId,
        display_name: m.name.trim(),
        person_type: m.type,
      }));
      await supabase.from("household_people").insert(rows);
    }

    setBusy(false);
    navigate("/chat?onboarding=true", { replace: true });
  }, [householdId, members, navigate]);

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

        {step === "members" && (
          <Stack spacing={3}>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <People color="primary" sx={{ fontSize: 32 }} />
              <Box>
                <Typography variant="h5" fontWeight={700}>
                  {t("onboarding.members_title")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("onboarding.members_hint")}
                </Typography>
              </Box>
            </Stack>

            <Stack spacing={1.5}>
              {members.map((m, i) => (
                <Stack key={i} direction="row" spacing={1} alignItems="center">
                  <TextField
                    size="small" fullWidth
                    label={t("onboarding.member_name")}
                    value={m.name}
                    onChange={(e) => setMembers((prev) => prev.map((p, j) => j === i ? { ...p, name: e.target.value } : p))}
                    autoFocus={i === 0}
                  />
                  <TextField
                    select size="small" sx={{ minWidth: 100 }}
                    value={m.type}
                    onChange={(e) => setMembers((prev) => prev.map((p, j) => j === i ? { ...p, type: e.target.value as "adult" | "kid" } : p))}
                  >
                    <MenuItem value="adult">{t("onboarding.adult")}</MenuItem>
                    <MenuItem value="kid">{t("onboarding.kid")}</MenuItem>
                  </TextField>
                  {members.length > 1 && (
                    <IconButton size="small" onClick={() => setMembers((prev) => prev.filter((_, j) => j !== i))}>
                      <Delete fontSize="small" />
                    </IconButton>
                  )}
                </Stack>
              ))}
            </Stack>

            <Button
              size="small" startIcon={<Add />} variant="text"
              onClick={() => setMembers((prev) => [...prev, { name: "", type: "adult" }])}
              sx={{ alignSelf: "flex-start" }}
            >
              {t("onboarding.add_member")}
            </Button>

            <Stack direction="row" justifyContent="space-between">
              <Button variant="text" onClick={() => setStep("name")} disabled={busy}>
                {t("home_profile.back")}
              </Button>
              <Stack direction="row" spacing={1}>
                <Button variant="text" onClick={() => void handleSaveMembers()} disabled={busy} sx={{ color: "text.secondary" }}>
                  {t("onboarding.skip_members")}
                </Button>
                <Button variant="contained" onClick={() => void handleSaveMembers()} disabled={busy}>
                  {t("onboarding.continue_to_agent")}
                </Button>
              </Stack>
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
