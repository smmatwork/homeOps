import { Box, Button, Chip, Paper, Stack, TextField, Typography } from "@mui/material";
import {
  Person,
  Group,
  Visibility,
  HandshakeOutlined,
  CleaningServices,
  Restaurant,
  Savings,
  Schedule,
} from "@mui/icons-material";
import { useI18n, type UiLanguage } from "../../i18n";
import type { HouseholdRole, UserGoal } from "../../services/profileService";
import type { ReactNode } from "react";

export interface UserProfileFormData {
  full_name: string;
  household_role: HouseholdRole | null;
  goals: UserGoal[];
  preferred_language: UiLanguage | null;
  work_schedule: { work_days: string[]; work_hours: string } | null;
}

interface UserProfileStepProps {
  profile: UserProfileFormData;
  onChange: (patch: Partial<UserProfileFormData>) => void;
  subStep: number;
  onSubStepChange: (s: number) => void;
}

const TOTAL_SUB_STEPS = 4;

const ROLE_OPTIONS: { key: HouseholdRole; icon: ReactNode }[] = [
  { key: "primary_manager", icon: <Person /> },
  { key: "shared_responsibility", icon: <Group /> },
  { key: "contributor", icon: <HandshakeOutlined /> },
  { key: "observer", icon: <Visibility /> },
];

const GOAL_OPTIONS: { key: UserGoal; icon: ReactNode }[] = [
  { key: "cleanliness", icon: <CleaningServices /> },
  { key: "health_nutrition", icon: <Restaurant /> },
  { key: "cost_optimization", icon: <Savings /> },
  { key: "time_saving", icon: <Schedule /> },
];

const LANGUAGE_OPTIONS: { key: UiLanguage; label: string }[] = [
  { key: "en", label: "English" },
  { key: "hi", label: "हिन्दी" },
  { key: "kn", label: "ಕನ್ನಡ" },
];

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function UserProfileStep({ profile, onChange, subStep, onSubStepChange }: UserProfileStepProps) {
  const { t } = useI18n();

  return (
    <Stack spacing={3}>
      {/* Sub-step 0: Name + Role */}
      {subStep === 0 && (
        <Stack spacing={2}>
          <Typography variant="h6">{t("onboarding.profile_name_title")}</Typography>
          <TextField
            label={t("onboarding.profile_name_label")}
            value={profile.full_name}
            onChange={(e) => onChange({ full_name: e.target.value })}
            fullWidth
            size="small"
          />
          <Typography variant="body1" fontWeight={500} mt={1}>
            {t("onboarding.role_title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("onboarding.role_subtitle")}
          </Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 1.5 }}>
            {ROLE_OPTIONS.map(({ key, icon }) => {
              const selected = profile.household_role === key;
              return (
                <Paper
                  key={key}
                  variant="outlined"
                  onClick={() => onChange({ household_role: key })}
                  sx={{
                    p: 2,
                    cursor: "pointer",
                    borderColor: selected ? "primary.main" : undefined,
                    borderWidth: selected ? 2 : 1,
                    transition: "border-color 0.15s, background 0.15s",
                    "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <Box sx={{ color: selected ? "primary.main" : "text.secondary" }}>{icon}</Box>
                  <Typography variant="body2" fontWeight={600} align="center">
                    {t(`onboarding.role_${key}`)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" align="center">
                    {t(`onboarding.role_${key}_desc`)}
                  </Typography>
                </Paper>
              );
            })}
          </Box>
        </Stack>
      )}

      {/* Sub-step 1: Goals */}
      {subStep === 1 && (
        <Stack spacing={2}>
          <Typography variant="h6">{t("onboarding.goals_title")}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t("onboarding.goals_subtitle")}
          </Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 1.5 }}>
            {GOAL_OPTIONS.map(({ key, icon }) => {
              const selected = profile.goals.includes(key);
              return (
                <Paper
                  key={key}
                  variant="outlined"
                  onClick={() => {
                    const next = selected
                      ? profile.goals.filter((g) => g !== key)
                      : [...profile.goals, key];
                    onChange({ goals: next });
                  }}
                  sx={{
                    p: 2,
                    cursor: "pointer",
                    borderColor: selected ? "primary.main" : undefined,
                    borderWidth: selected ? 2 : 1,
                    transition: "border-color 0.15s, background 0.15s",
                    "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <Box sx={{ color: selected ? "primary.main" : "text.secondary" }}>{icon}</Box>
                  <Typography variant="body2" fontWeight={600} align="center">
                    {t(`onboarding.goal_${key}`)}
                  </Typography>
                </Paper>
              );
            })}
          </Box>
        </Stack>
      )}

      {/* Sub-step 2: Language */}
      {subStep === 2 && (
        <Stack spacing={2}>
          <Typography variant="h6">{t("onboarding.language_title")}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t("onboarding.language_subtitle")}
          </Typography>
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
            {LANGUAGE_OPTIONS.map(({ key, label }) => {
              const selected = profile.preferred_language === key;
              return (
                <Paper
                  key={key}
                  variant="outlined"
                  onClick={() => onChange({ preferred_language: key })}
                  sx={{
                    px: 3,
                    py: 2,
                    cursor: "pointer",
                    borderColor: selected ? "primary.main" : undefined,
                    borderWidth: selected ? 2 : 1,
                    transition: "border-color 0.15s, background 0.15s",
                    "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
                    textAlign: "center",
                    minWidth: 100,
                  }}
                >
                  <Typography variant="body1" fontWeight={600}>{label}</Typography>
                </Paper>
              );
            })}
          </Stack>
        </Stack>
      )}

      {/* Sub-step 3: Schedule (optional) */}
      {subStep === 3 && (
        <Stack spacing={2}>
          <Typography variant="h6">{t("onboarding.schedule_title")}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t("onboarding.schedule_subtitle")}
          </Typography>

          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {WEEKDAYS.map((day) => {
              const selected = profile.work_schedule?.work_days?.includes(day) ?? false;
              return (
                <Chip
                  key={day}
                  label={t(`weekday.${day}`)}
                  onClick={() => {
                    const current = profile.work_schedule?.work_days ?? [];
                    const next = selected ? current.filter((d) => d !== day) : [...current, day];
                    onChange({
                      work_schedule: {
                        work_days: next,
                        work_hours: profile.work_schedule?.work_hours ?? "9-18",
                      },
                    });
                  }}
                  color={selected ? "primary" : "default"}
                  variant={selected ? "filled" : "outlined"}
                  sx={{ fontWeight: 500 }}
                />
              );
            })}
          </Stack>

          <TextField
            label={t("onboarding.schedule_hours")}
            value={profile.work_schedule?.work_hours ?? ""}
            onChange={(e) =>
              onChange({
                work_schedule: {
                  work_days: profile.work_schedule?.work_days ?? [],
                  work_hours: e.target.value,
                },
              })
            }
            size="small"
            placeholder="e.g. 9-18"
            helperText={t("onboarding.schedule_hours_help")}
            fullWidth
          />

          <Button
            variant="text"
            size="small"
            onClick={() => onChange({ work_schedule: null })}
            sx={{ alignSelf: "flex-start" }}
          >
            {t("onboarding.schedule_skip")}
          </Button>
        </Stack>
      )}

      {/* Navigation */}
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        {subStep > 0 && (
          <Button variant="text" onClick={() => onSubStepChange(subStep - 1)}>
            {t("home_profile.back")}
          </Button>
        )}
        {subStep < TOTAL_SUB_STEPS - 1 && (
          <Button variant="contained" onClick={() => onSubStepChange(subStep + 1)}>
            {t("home_profile.next")}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

export { TOTAL_SUB_STEPS as USER_PROFILE_TOTAL_SUB_STEPS };
