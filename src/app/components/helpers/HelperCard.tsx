import {
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Phone,
  Schedule,
  Star,
  EventBusy,
  Reviews,
  EmojiEvents,
  MoreVert,
} from "@mui/icons-material";
import { useI18n } from "../../i18n";

export type HelperRow = {
  id: string;
  household_id: string;
  name: string;
  type: string | null;
  phone: string | null;
  notes: string | null;
  daily_capacity_minutes: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function initials(name: string): string {
  return name.split(" ").slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase();
}

function getPreferredLanguage(helper: HelperRow): string {
  const meta = helper.metadata;
  if (meta && typeof meta === "object" && typeof (meta as Record<string, unknown>).preferred_language === "string") {
    return (meta as Record<string, unknown>).preferred_language as string;
  }
  return "en";
}

function hoursPerDay(helper: HelperRow): string {
  const mins = typeof helper.daily_capacity_minutes === "number" && Number.isFinite(helper.daily_capacity_minutes)
    ? helper.daily_capacity_minutes
    : 120;
  return String(mins / 60);
}

interface HelperCardProps {
  helper: HelperRow;
  /** Summary like "Mon–Fri, 9:00–17:00" */
  scheduleSummary: string;
  onMenuOpen: (event: React.MouseEvent<HTMLElement>) => void;
  onCapacity: () => void;
  onSchedule: () => void;
  onTimeOff: () => void;
  onFeedback: () => void;
  onRewards: () => void;
}

export function HelperCard({
  helper,
  scheduleSummary,
  onMenuOpen,
  onCapacity,
  onSchedule,
  onTimeOff,
  onFeedback,
  onRewards,
}: HelperCardProps) {
  const { t } = useI18n();
  const lang = getPreferredLanguage(helper);

  return (
    <Card variant="outlined">
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack spacing={1.5}>
          {/* Header: avatar + name + type + menu */}
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Avatar sx={{ bgcolor: "primary.main", width: 40, height: 40, fontSize: 14, fontWeight: 700 }}>
              {initials(helper.name)}
            </Avatar>
            <Box flex={1} minWidth={0}>
              <Typography variant="subtitle1" fontWeight={700} noWrap>
                {helper.name}
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {helper.type && <Chip label={helper.type} size="small" variant="outlined" />}
                <Chip label={`${t("helpers.language_short")}: ${t(`helpers.lang.${lang}`)}`} size="small" variant="outlined" />
              </Stack>
            </Box>
            <Tooltip title={t("helpers.more_actions")}>
              <IconButton size="small" onClick={onMenuOpen}>
                <MoreVert fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>

          {/* Details row */}
          <Stack direction="row" spacing={2} flexWrap="wrap" sx={{ color: "text.secondary" }}>
            {helper.phone && (
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Phone sx={{ fontSize: 14 }} />
                <Typography variant="caption">{helper.phone}</Typography>
              </Stack>
            )}
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Schedule sx={{ fontSize: 14 }} />
              <Typography variant="caption">{hoursPerDay(helper)}{t("helpers.hours_per_day_suffix")}</Typography>
            </Stack>
            {scheduleSummary && (
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Schedule sx={{ fontSize: 14 }} />
                <Typography variant="caption">{scheduleSummary}</Typography>
              </Stack>
            )}
          </Stack>

          {helper.notes && (
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
              {helper.notes}
            </Typography>
          )}

          {/* Actions row — compact icon buttons with labels */}
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            <Button size="small" variant="outlined" startIcon={<Star sx={{ fontSize: 14 }} />} onClick={onCapacity} sx={{ textTransform: "none" }}>
              {t("helpers.capacity")}
            </Button>
            <Button size="small" variant="outlined" startIcon={<Schedule sx={{ fontSize: 14 }} />} onClick={onSchedule} sx={{ textTransform: "none" }}>
              {t("helpers.schedule")}
            </Button>
            <Button size="small" variant="outlined" startIcon={<EventBusy sx={{ fontSize: 14 }} />} onClick={onTimeOff} sx={{ textTransform: "none" }}>
              {t("helpers.time_off")}
            </Button>
            <Button size="small" variant="outlined" startIcon={<Reviews sx={{ fontSize: 14 }} />} onClick={onFeedback} sx={{ textTransform: "none" }}>
              {t("helpers.feedback")}
            </Button>
            <Button size="small" variant="outlined" startIcon={<EmojiEvents sx={{ fontSize: 14 }} />} onClick={onRewards} sx={{ textTransform: "none" }}>
              {t("helpers.rewards")}
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
