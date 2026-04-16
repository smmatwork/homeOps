import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { ExpandMore, GridView } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import { normalizeSpacesToRooms } from "../../config/homeProfileTemplates";
import {
  computeCoverageGaps,
  extractDismissedGapIds,
  withDismissedGap,
  type CoverageGap,
  type CoverageHealth,
} from "../../services/coverageGapEngine";
import type { Cadence, ChoreRecommendation } from "../../services/choreRecommendationEngine";
import { CoverageHealthCard } from "./CoverageHealthCard";
import { GapList } from "./GapList";
import { fetchCoverageData, type CoverageRow } from "../../services/coverageApi";
import { CoverageMap } from "./CoverageMap";

interface CoverageDashboardProps {
  /** Notify the parent when chores are added (for cross-page state). */
  onApplied?: () => void;
  /** Refresh trigger from the parent — incrementing this re-fetches data. */
  refreshKey?: number;
}

function computeDueAtIso(cadence: Cadence): string {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  switch (cadence) {
    case "daily": d.setDate(d.getDate() + 1); break;
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": d.setDate(d.getDate() + 14); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
  }
  return d.toISOString();
}

interface DashboardData {
  spaces: string[];
  existingChores: Array<{ title: string; metadata: Record<string, unknown> | null }>;
  metadata: Record<string, unknown> | null;
  rows: CoverageRow[];
}

/**
 * Coverage Health Dashboard.
 *
 * Shows a weighted coverage score, gap list, and an expandable full coverage
 * matrix. Replaces the wizard for users who already have a home profile and
 * any existing chores.
 */
export function CoverageDashboard({ onApplied, refreshKey = 0 }: CoverageDashboardProps) {
  const { householdId, accessToken } = useAuth();
  const { t } = useI18n();

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);

  // ─── Load data ─────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    setError(null);

    // Fetch home profile (spaces + metadata)
    const { data: profileRow, error: profileErr } = await supabase
      .from("home_profiles")
      .select("spaces, metadata")
      .eq("household_id", householdId)
      .maybeSingle();

    if (profileErr) {
      setLoading(false);
      setError(profileErr.message);
      return;
    }

    let rawSpaces: unknown = profileRow?.spaces;
    if (typeof rawSpaces === "string") {
      try { rawSpaces = JSON.parse(rawSpaces); } catch { /* ignore */ }
    }
    const rooms = normalizeSpacesToRooms(rawSpaces);
    const spaces = rooms
      .map((rm) => (rm.display_name || rm.template_name || "").trim())
      .filter(Boolean);

    // Fetch existing chores
    const { data: choresData, error: choresErr } = await supabase
      .from("chores")
      .select("title, metadata")
      .eq("household_id", householdId)
      .is("deleted_at", null);

    if (choresErr) {
      setLoading(false);
      setError(choresErr.message);
      return;
    }

    // Fetch full coverage map data (for the expandable section)
    const coverageResult = await fetchCoverageData(householdId);

    setData({
      spaces,
      existingChores: (choresData ?? []) as Array<{ title: string; metadata: Record<string, unknown> | null }>,
      metadata: (profileRow?.metadata ?? null) as Record<string, unknown> | null,
      rows: coverageResult.rows,
    });
    setLoading(false);
  }, [householdId]);

  useEffect(() => {
    setError(null);
    setSuccess(null);
    void loadData();
    // Re-fetch when parent bumps refreshKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadData, refreshKey]);

  // ─── Compute gaps + health ─────────────────────────────────────────────
  const { gaps, health } = useMemo<{ gaps: CoverageGap[]; health: CoverageHealth }>(() => {
    if (!data) return { gaps: [], health: { score: 0, totalSpaces: 0, fullyCoveredSpaces: 0, partiallyCoveredSpaces: 0, spacesWithGaps: 0, totalGaps: 0, criticalGaps: 0 } };
    const dismissed = extractDismissedGapIds(data.metadata);
    return computeCoverageGaps({
      spaces: data.spaces,
      existingChores: data.existingChores,
      dismissedGapIds: dismissed,
    });
  }, [data]);

  // ─── Add a single gap ──────────────────────────────────────────────────
  const addGapAsChore = useCallback(
    async (gap: CoverageGap, edits?: Partial<ChoreRecommendation>): Promise<boolean> => {
      if (!householdId || !accessToken) {
        setError(t("common.missing_session"));
        return false;
      }
      const rec: ChoreRecommendation = { ...gap.recommendation, ...(edits ?? {}) };
      setBusy(true);
      setError(null);

      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `gap_chore_${gap.id}_${Date.now()}`,
          tool: "db.insert",
          args: {
            table: "chores",
            record: {
              title: rec.title,
              description: rec.description,
              priority: rec.priority,
              status: "pending",
              due_at: computeDueAtIso(rec.cadence),
              metadata: {
                space: rec.space,
                cadence: rec.cadence,
                category: rec.category,
                estimated_minutes: rec.estimatedMinutes,
                source: "coverage_dashboard",
              },
            },
          },
          reason: `Coverage dashboard: add chore "${rec.title}" for ${rec.space}`,
        },
      });
      setBusy(false);

      if (!res.ok) {
        const msg = "error" in res ? res.error : "Failed to add chore";
        setError(msg);
        return false;
      }

      setSuccess(t("gaps.added_success").replace("{title}", rec.title));
      // Reload to recompute gaps + health
      await loadData();
      onApplied?.();
      return true;
    },
    [householdId, accessToken, loadData, onApplied, t],
  );

  // ─── Dismiss a single gap ──────────────────────────────────────────────
  const dismissGap = useCallback(
    async (gap: CoverageGap): Promise<boolean> => {
      if (!householdId || !accessToken || !data) {
        setError(t("common.missing_session"));
        return false;
      }
      setBusy(true);
      setError(null);

      const nextMetadata = withDismissedGap(data.metadata, gap.id);
      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `gap_dismiss_${gap.id}_${Date.now()}`,
          tool: "db.insert",
          args: {
            table: "home_profiles",
            record: {
              household_id: householdId,
              metadata: nextMetadata,
            },
          },
          reason: `Coverage dashboard: dismiss gap "${gap.id}"`,
        },
      });
      setBusy(false);

      if (!res.ok) {
        const msg = "error" in res ? res.error : "Failed to dismiss gap";
        setError(msg);
        return false;
      }

      setSuccess(t("gaps.dismissed_success"));
      await loadData();
      return true;
    },
    [householdId, accessToken, data, loadData, t],
  );

  // ─── Fix all gaps in one go ────────────────────────────────────────────
  const fixAllGaps = useCallback(async () => {
    if (gaps.length === 0) return;
    setBusy(true);
    setError(null);

    let added = 0;
    let failed = 0;
    for (const gap of gaps) {
      const ok = await addGapAsChore(gap);
      if (ok) added += 1;
      else failed += 1;
    }
    setBusy(false);

    if (failed > 0) {
      setError(
        t("gaps.fix_all_partial").replace("{added}", String(added)).replace("{failed}", String(failed)),
      );
    } else {
      setSuccess(t("gaps.fix_all_success").replace("{count}", String(added)));
    }
  }, [gaps, addGapAsChore, t]);

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>
          {success}
        </Alert>
      )}

      {loading || !data ? (
        <Box display="flex" justifyContent="center" py={6}>
          <CircularProgress />
        </Box>
      ) : data.spaces.length === 0 ? (
        // Spaces empty → tell the user to set up the home profile first.
        <Alert severity="info">
          {t("coverage_audit.no_spaces")}
        </Alert>
      ) : (
        <Stack spacing={3}>
          {/* Health card with score + Fix all button */}
          <CoverageHealthCard
            health={health}
            busy={busy}
            onFixAll={fixAllGaps}
          />

          {/* Gap list — the action area */}
          <Box>
            <Typography variant="h6" fontWeight={600} mb={1}>
              {t("coverage_audit.gaps_section")}
            </Typography>
            <GapList
              gaps={gaps}
              onAddGap={addGapAsChore}
              onDismissGap={dismissGap}
              busy={busy}
            />
          </Box>

          {/* Expandable: full coverage matrix for power users */}
          <Accordion variant="outlined">
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <GridView fontSize="small" />
                <Typography variant="body2" fontWeight={600}>
                  {t("coverage_audit.full_map_title")}
                </Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <CoverageMap spaces={data.spaces} rows={data.rows} />
            </AccordionDetails>
          </Accordion>

          {/* Reload button at the bottom */}
          <Box display="flex" justifyContent="center">
            <Button variant="text" size="small" onClick={() => void loadData()} disabled={busy}>
              {t("common.refresh")}
            </Button>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
