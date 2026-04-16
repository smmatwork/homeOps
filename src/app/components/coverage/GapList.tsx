import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  Add,
  Block,
  CheckCircleOutline,
  Edit,
  PriorityHigh,
} from "@mui/icons-material";
import { useI18n } from "../../i18n";
import { ALL_CADENCES, cadenceLabel, type Cadence } from "../../services/choreRecommendationEngine";
import type { CoverageGap, GapSeverity } from "../../services/coverageGapEngine";

interface GapListProps {
  gaps: CoverageGap[];
  /** Add a single gap as a chore. Returns true on success. */
  onAddGap: (gap: CoverageGap, edits?: Partial<CoverageGap["recommendation"]>) => Promise<boolean>;
  /** Mark a gap as "not needed" — persists across sessions. */
  onDismissGap: (gap: CoverageGap) => Promise<boolean>;
  busy?: boolean;
}

const CADENCE_OPTIONS = ALL_CADENCES;

function severityChip(severity: GapSeverity, t: (k: string) => string): {
  label: string;
  color: "error" | "warning" | "info";
  icon?: React.ReactElement;
} {
  switch (severity) {
    case "critical":
      return { label: t("gaps.severity_critical"), color: "error", icon: <PriorityHigh sx={{ fontSize: 14 }} /> };
    case "important":
      return { label: t("gaps.severity_important"), color: "warning" };
    case "nice_to_have":
      return { label: t("gaps.severity_nice"), color: "info" };
  }
}

interface GapCardProps {
  gap: CoverageGap;
  onAdd: (edits?: Partial<CoverageGap["recommendation"]>) => Promise<boolean>;
  onDismiss: () => Promise<boolean>;
  busy?: boolean;
}

function GapCard({ gap, onAdd, onDismiss, busy }: GapCardProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(gap.recommendation.title);
  const [cadence, setCadence] = useState<Cadence>(gap.recommendation.cadence);
  const [localBusy, setLocalBusy] = useState(false);

  const sev = severityChip(gap.severity, t);

  const handleAdd = async () => {
    setLocalBusy(true);
    const edits: Partial<CoverageGap["recommendation"]> = {};
    if (title !== gap.recommendation.title) edits.title = title;
    if (cadence !== gap.recommendation.cadence) edits.cadence = cadence;
    await onAdd(Object.keys(edits).length > 0 ? edits : undefined);
    setLocalBusy(false);
  };

  const handleDismiss = async () => {
    setLocalBusy(true);
    await onDismiss();
    setLocalBusy(false);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        {/* Header: severity + space + category */}
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip
            size="small"
            color={sev.color}
            icon={sev.icon}
            label={sev.label}
            sx={{ fontWeight: 600 }}
          />
          <Typography variant="body2" fontWeight={600}>
            {gap.space}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={t(`chores.${gap.cadence}`)}
          />
        </Stack>

        {/* Reason */}
        <Typography variant="body2" color="text.secondary">
          {gap.reason}
        </Typography>

        {/* Recommended chore — editable when in edit mode */}
        <Box
          sx={{
            p: 1.5,
            bgcolor: "action.hover",
            borderRadius: 1,
          }}
        >
          {editing ? (
            <Stack spacing={1}>
              <TextField
                size="small"
                fullWidth
                label={t("gaps.chore_title")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Select
                size="small"
                fullWidth
                value={cadence}
                onChange={(e) => setCadence(e.target.value as Cadence)}
              >
                {CADENCE_OPTIONS.map((c) => (
                  <MenuItem key={c} value={c}>{cadenceLabel(c)}</MenuItem>
                ))}
              </Select>
            </Stack>
          ) : (
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Box>
                <Typography variant="body2" fontWeight={600}>
                  {title}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  ~{gap.recommendation.estimatedMinutes} min
                </Typography>
              </Box>
              <IconButton size="small" onClick={() => setEditing(true)} disabled={busy || localBusy}>
                <Edit fontSize="small" />
              </IconButton>
            </Stack>
          )}
        </Box>

        {/* Actions */}
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            size="small"
            startIcon={<Block />}
            onClick={handleDismiss}
            disabled={busy || localBusy}
            color="inherit"
          >
            {t("gaps.dismiss")}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<Add />}
            onClick={handleAdd}
            disabled={busy || localBusy || !title.trim()}
          >
            {t("gaps.add_chore")}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

export function GapList({ gaps, onAddGap, onDismissGap, busy }: GapListProps) {
  const { t } = useI18n();

  if (gaps.length === 0) {
    return (
      <Card variant="outlined">
        <CardContent sx={{ textAlign: "center", py: 6 }}>
          <CheckCircleOutline sx={{ fontSize: 64, color: "success.main", mb: 2 }} />
          <Typography variant="h6" gutterBottom>
            {t("gaps.empty_title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("gaps.empty_subtitle")}
          </Typography>
        </CardContent>
      </Card>
    );
  }

  // Group by severity for visual sectioning
  const groups: Array<{ severity: GapSeverity; gaps: CoverageGap[] }> = [];
  const severityOrder: GapSeverity[] = ["critical", "important", "nice_to_have"];
  for (const sev of severityOrder) {
    const sevGaps = gaps.filter((g) => g.severity === sev);
    if (sevGaps.length > 0) groups.push({ severity: sev, gaps: sevGaps });
  }

  return (
    <Stack spacing={3}>
      {groups.map((group) => (
        <Box key={group.severity}>
          <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}
            >
              {severityChip(group.severity, t).label} ({group.gaps.length})
            </Typography>
          </Stack>
          {group.severity === "critical" && (
            <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>
              {t("gaps.critical_intro")}
            </Alert>
          )}
          <Stack spacing={1.5}>
            {group.gaps.map((gap) => (
              <GapCard
                key={gap.id}
                gap={gap}
                onAdd={(edits) => onAddGap(gap, edits)}
                onDismiss={() => onDismissGap(gap)}
                busy={busy}
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
