import { useEffect, useState, useCallback } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import { Close, Refresh } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { fetchHouseholdEvents } from "../../services/householdEventsApi";
import { fetchCoverageData } from "../../services/coverageApi";
import { fetchHelperWorkloads } from "../../services/helperWorkloadApi";
import { proposeAdjustments, type Proposal, type ProposalSeverity } from "../../services/replanEngine";
import { supabase } from "../../services/supabaseClient";

interface ProposalsDrawerProps {
  open: boolean;
  onClose: () => void;
}

function severityColor(severity: ProposalSeverity): "info" | "warning" | "error" {
  switch (severity) {
    case "critical": return "error";
    case "warning": return "warning";
    default: return "info";
  }
}

export function ProposalsDrawer({ open, onClose }: ProposalsDrawerProps) {
  const { householdId } = useAuth();
  const { t } = useI18n();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  const loadProposals = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    setError(null);

    try {
      const [eventsResult, coverageResult, workloadsResult] = await Promise.all([
        fetchHouseholdEvents(householdId),
        fetchCoverageData(householdId),
        fetchHelperWorkloads(householdId),
      ]);

      const errors = [eventsResult.error, coverageResult.error, workloadsResult.error].filter(Boolean);
      if (errors.length > 0) {
        setError(errors.join("; "));
      }

      // Fetch helpers for name lookups
      const { data: helpersData } = await supabase
        .from("helpers")
        .select("id,name")
        .eq("household_id", householdId);

      const helpers = (helpersData ?? []) as Array<{ id: string; name: string }>;

      const computed = proposeAdjustments({
        events: eventsResult.events,
        coverageRows: coverageResult.rows,
        coverageGaps: coverageResult.gaps,
        workloads: workloadsResult.workloads,
        helpers,
      });

      setProposals(computed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load proposals");
    } finally {
      setLoading(false);
    }
  }, [householdId]);

  useEffect(() => {
    if (open) {
      void loadProposals();
    }
  }, [open, loadProposals]);

  const visibleProposals = proposals.filter((p) => !dismissed[p.id]);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: "100%", sm: 480 } } }}
    >
      <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h6" fontWeight={700}>
              {t("replan.title")}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t("replan.subtitle").replace("{count}", String(visibleProposals.length))}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5}>
            <IconButton size="small" onClick={() => void loadProposals()} disabled={loading}>
              <Refresh fontSize="small" />
            </IconButton>
            <IconButton size="small" onClick={onClose}>
              <Close fontSize="small" />
            </IconButton>
          </Stack>
        </Stack>
      </Box>

      <Box sx={{ p: 2, overflowY: "auto", flex: 1 }}>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {loading ? (
          <Box display="flex" justifyContent="center" py={4}>
            <CircularProgress />
          </Box>
        ) : visibleProposals.length === 0 ? (
          <Box textAlign="center" py={6}>
            <Typography color="text.secondary">{t("replan.empty")}</Typography>
          </Box>
        ) : (
          <Stack spacing={2}>
            {visibleProposals.map((p) => (
              <Card key={p.id} variant="outlined">
                <CardContent>
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip
                        size="small"
                        color={severityColor(p.severity)}
                        label={t(`replan.severity_${p.severity}`)}
                      />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={t(`replan.kind_${p.kind}`)}
                      />
                    </Stack>
                    <Typography variant="body2" fontWeight={600}>
                      {p.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {p.description}
                    </Typography>
                    <Stack direction="row" spacing={1} justifyContent="flex-end">
                      <Button
                        size="small"
                        onClick={() =>
                          setDismissed((prev) => ({ ...prev, [p.id]: true }))
                        }
                      >
                        {t("replan.dismiss")}
                      </Button>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        )}
      </Box>
    </Drawer>
  );
}
