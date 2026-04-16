import { useEffect, useState, useCallback } from "react";
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { Star, Warning, Schedule } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { fetchHelperWorkloads, type HelperWorkload } from "../../services/helperWorkloadApi";

export function HelperWorkloadCard() {
  const { householdId } = useAuth();
  const { t } = useI18n();
  const [workloads, setWorkloads] = useState<HelperWorkload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    setError(null);
    const result = await fetchHelperWorkloads(householdId);
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setWorkloads(result.workloads);
  }, [householdId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card variant="outlined">
        <CardContent sx={{ display: "flex", justifyContent: "center", py: 3 }}>
          <CircularProgress size={24} />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography variant="body2" color="error">{error}</Typography>
        </CardContent>
      </Card>
    );
  }

  if (workloads.length === 0) {
    return null;
  }

  return (
    <Card variant="outlined">
      <CardHeader
        title={t("helpers.workload_title")}
        subheader={t("helpers.workload_subtitle")}
      />
      <CardContent>
        <Stack spacing={2}>
          {workloads.map((w) => {
            const utilization = Math.min(100, Math.round(w.utilizationPct));
            const color: "primary" | "warning" | "error" =
              w.isOverCapacity ? "error" : utilization > 80 ? "warning" : "primary";
            return (
              <Box key={w.helperId}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={0.5}>
                  <Typography variant="body2" fontWeight={600}>{w.helperName}</Typography>
                  <Stack direction="row" spacing={1} alignItems="center">
                    {w.averageRating !== null && (
                      <Stack direction="row" spacing={0.25} alignItems="center">
                        <Star sx={{ fontSize: 14, color: "warning.main" }} />
                        <Typography variant="caption">{w.averageRating.toFixed(1)}</Typography>
                      </Stack>
                    )}
                    {w.overdueCount > 0 && (
                      <Chip
                        size="small"
                        color="error"
                        icon={<Warning sx={{ fontSize: 12 }} />}
                        label={`${w.overdueCount} ${t("helpers.overdue")}`}
                      />
                    )}
                    <Stack direction="row" spacing={0.25} alignItems="center">
                      <Schedule sx={{ fontSize: 14, color: "text.secondary" }} />
                      <Typography variant="caption" color="text.secondary">
                        {w.estimatedMinutes}
                        {w.capacityMinutes > 0 && `/${w.capacityMinutes}`} min
                      </Typography>
                    </Stack>
                  </Stack>
                </Stack>
                {w.capacityMinutes > 0 ? (
                  <LinearProgress
                    variant="determinate"
                    value={utilization}
                    color={color}
                    sx={{ height: 6, borderRadius: 1 }}
                  />
                ) : (
                  <Typography variant="caption" color="text.disabled">
                    {t("helpers.no_capacity_set")}
                  </Typography>
                )}
                {w.isOverCapacity && (
                  <Typography variant="caption" color="error" display="block" mt={0.25}>
                    {t("helpers.over_capacity")}
                  </Typography>
                )}
              </Box>
            );
          })}
        </Stack>
      </CardContent>
    </Card>
  );
}
