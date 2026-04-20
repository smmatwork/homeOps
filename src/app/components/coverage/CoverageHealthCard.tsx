import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { CheckCircle, Warning, AutoFixHigh } from "@mui/icons-material";
import { useI18n } from "../../i18n";
import type { CoverageHealth } from "../../services/coverageGapEngine";

interface CoverageHealthCardProps {
  health: CoverageHealth;
  busy?: boolean;
  /** Called when the user clicks "Fix all gaps". Disabled if no gaps. */
  onFixAll?: () => void;
}

function scoreColor(score: number): "success" | "warning" | "error" {
  if (score >= 80) return "success";
  if (score >= 50) return "warning";
  return "error";
}

export function CoverageHealthCard({ health, busy, onFixAll }: CoverageHealthCardProps) {
  const { t } = useI18n();
  const color = scoreColor(health.score);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={3}
          alignItems={{ xs: "stretch", sm: "center" }}
        >
          {/* Score ring */}
          <Box
            sx={{
              position: "relative",
              display: "inline-flex",
              alignSelf: "center",
              width: 120,
              height: 120,
            }}
          >
            <CircularProgress
              variant="determinate"
              value={100}
              size={120}
              thickness={4}
              sx={{ color: "action.disabledBackground", position: "absolute" }}
            />
            <CircularProgress
              variant="determinate"
              value={health.score}
              size={120}
              thickness={4}
              color={color}
            />
            <Box
              sx={{
                top: 0,
                left: 0,
                bottom: 0,
                right: 0,
                position: "absolute",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
              }}
            >
              <Typography variant="h4" fontWeight={700} color={`${color}.main`}>
                {health.score}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ mt: -0.5 }}>
                {t("health.score_label")}
              </Typography>
            </Box>
          </Box>

          {/* Summary stats */}
          <Stack flex={1} spacing={1}>
            <Typography variant="h6" fontWeight={600}>
              {t("health.title")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("health.summary")
                .replace("{total}", String(health.totalSpaces))
                .replace("{covered}", String(health.fullyCoveredSpaces))
                .replace("{partial}", String(health.partiallyCoveredSpaces))
                .replace("{gaps}", String(health.spacesWithGaps))}
            </Typography>

            {/* Stats badges */}
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap mt={0.5}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <CheckCircle sx={{ fontSize: 16, color: "success.main" }} />
                <Typography variant="caption" color="text.secondary">
                  {t("health.fully_covered")}: <strong>{health.fullyCoveredSpaces}</strong>
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Warning sx={{ fontSize: 16, color: "warning.main" }} />
                <Typography variant="caption" color="text.secondary">
                  {t("health.partial")}: <strong>{health.partiallyCoveredSpaces}</strong>
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Warning sx={{ fontSize: 16, color: "error.main" }} />
                <Typography variant="caption" color="text.secondary">
                  {t("health.gaps")}: <strong>{health.spacesWithGaps}</strong>
                </Typography>
              </Stack>
            </Stack>
          </Stack>

          {/* Fix all CTA */}
          {health.totalGaps > 0 && (
            <Box sx={{ alignSelf: { xs: "stretch", sm: "center" } }}>
              <Button
                variant="contained"
                size="large"
                startIcon={<AutoFixHigh />}
                onClick={onFixAll}
                disabled={busy}
                fullWidth
              >
                {t("health.fix_all").replace("{count}", String(health.totalGaps))}
              </Button>
              {health.criticalGaps > 0 && (
                <Typography
                  variant="caption"
                  color="error"
                  display="block"
                  textAlign="center"
                  mt={0.5}
                >
                  {t("health.critical_gaps_label").replace("{count}", String(health.criticalGaps))}
                </Typography>
              )}
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
