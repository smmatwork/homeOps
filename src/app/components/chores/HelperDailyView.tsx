/**
 * Helper Daily View — shows each helper's tasks for a given day,
 * grouped by cadence, with one-tap completion checkboxes.
 *
 * This is the primary way users interact with chores day-to-day.
 */

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { CheckCircle, AccessTime, ErrorOutline } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import { cadenceLabel, type Cadence } from "../../services/choreRecommendationEngine";
import { templateOccursOnDate } from "../../services/choreScheduler";

interface HelperDailyViewProps {
  /** ISO date string (YYYY-MM-DD). */
  date: string;
}

interface ChoreRow {
  id: string;
  title: string;
  description: string | null;
  priority: number | null;
  status: string;
  helper_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown> | null;
}

const getStatusIcon = (status: string) => {
  switch (status) {
    case "completed":
    case "done":
      return <CheckCircle color="success" fontSize="small" />;
    case "in-progress":
      return <AccessTime color="warning" fontSize="small" />;
    default:
      return <ErrorOutline color="action" fontSize="small" />;
  }
};

const formatDueTime = (dueAt: string | null): string => {
  if (!dueAt) return "";
  try {
    const d = new Date(dueAt);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

interface HelperRow {
  id: string;
  name: string;
}

interface HelperGroup {
  helperId: string;
  helperName: string;
  cadenceGroups: Array<{
    cadence: string;
    chores: ChoreRow[];
  }>;
  totalMinutes: number;
  completedCount: number;
  totalCount: number;
}

const CADENCE_ORDER = ["daily", "every_2_days", "every_3_days", "every_4_days", "every_5_days", "weekly", "biweekly", "monthly"];

export function HelperDailyView({ date }: HelperDailyViewProps) {
  const { householdId, accessToken } = useAuth();
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chores, setChores] = useState<ChoreRow[]>([]);
  const [helpers, setHelpers] = useState<HelperRow[]>([]);
  const [busyChoreId, setBusyChoreId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    setError(null);

    // Fetch ALL non-deleted chores for the household. We filter client-side
    // to show chores that are either:
    //   (a) due today (exact date match), OR
    //   (b) have a recurring cadence that falls on today (for chores without
    //       scheduler-created per-day instances).
    const [choresRes, helpersRes] = await Promise.all([
      supabase
        .from("chores")
        .select("id,title,description,priority,status,helper_id,due_at,completed_at,metadata")
        .eq("household_id", householdId)
        .is("deleted_at", null)
        .order("due_at", { ascending: true }),
      supabase
        .from("helpers")
        .select("id,name")
        .eq("household_id", householdId),
    ]);

    setLoading(false);

    if (choresRes.error) {
      setError(choresRes.error.message);
      return;
    }

    // Filter chores to those that should appear on the selected date.
    const selectedDate = new Date(`${date}T00:00:00Z`);
    const dateStr = date; // YYYY-MM-DD
    const allChores = (choresRes.data ?? []) as ChoreRow[];

    const todaysChores = allChores.filter((c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const cadence = typeof meta.cadence === "string" ? meta.cadence : null;

      // (a) Exact date match: due_at falls on the selected date.
      if (c.due_at && c.due_at.slice(0, 10) === dateStr) return true;

      // (b) Recurring cadence match: the chore's cadence falls on this date.
      // This handles chores created without per-day scheduler instances.
      if (cadence && c.status !== "completed" && c.status !== "done") {
        const choreKey = typeof meta.template_task_key === "string"
          ? meta.template_task_key
          : c.id;
        try {
          if (templateOccursOnDate(cadence as Cadence, selectedDate, choreKey)) return true;
        } catch {
          // If cadence isn't a valid Cadence value, skip.
        }
      }

      return false;
    });

    setChores(todaysChores);
    setHelpers((helpersRes.data ?? []) as HelperRow[]);
  }, [householdId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  // Group chores by helper → cadence.
  const helperGroups = useMemo((): HelperGroup[] => {
    const helpersById = new Map(helpers.map((h) => [h.id, h]));

    const byHelper = new Map<string, ChoreRow[]>();
    const unassigned: ChoreRow[] = [];

    for (const chore of chores) {
      if (chore.helper_id) {
        const existing = byHelper.get(chore.helper_id);
        if (existing) existing.push(chore);
        else byHelper.set(chore.helper_id, [chore]);
      } else {
        unassigned.push(chore);
      }
    }

    const groups: HelperGroup[] = [];

    for (const [helperId, helperChores] of byHelper) {
      const helper = helpersById.get(helperId);
      const byCadence = new Map<string, ChoreRow[]>();

      for (const chore of helperChores) {
        const meta = (chore.metadata ?? {}) as Record<string, unknown>;
        const cadence = typeof meta.cadence === "string" ? meta.cadence : "other";
        const existing = byCadence.get(cadence);
        if (existing) existing.push(chore);
        else byCadence.set(cadence, [chore]);
      }

      const cadenceGroups = Array.from(byCadence.entries())
        .sort((a, b) => CADENCE_ORDER.indexOf(a[0]) - CADENCE_ORDER.indexOf(b[0]))
        .map(([cadence, cChores]) => ({ cadence, chores: cChores }));

      const totalMinutes = helperChores.reduce((sum, c) => {
        const meta = (c.metadata ?? {}) as Record<string, unknown>;
        return sum + (typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : 0);
      }, 0);

      const completedCount = helperChores.filter((c) => c.status === "completed" || c.status === "done").length;

      groups.push({
        helperId,
        helperName: helper?.name ?? "Unknown",
        cadenceGroups,
        totalMinutes,
        completedCount,
        totalCount: helperChores.length,
      });
    }

    // Add unassigned group if any.
    if (unassigned.length > 0) {
      groups.push({
        helperId: "__unassigned__",
        helperName: t("chores.unassigned"),
        cadenceGroups: [{ cadence: "other", chores: unassigned }],
        totalMinutes: 0,
        completedCount: unassigned.filter((c) => c.status === "completed" || c.status === "done").length,
        totalCount: unassigned.length,
      });
    }

    return groups;
  }, [chores, helpers, t]);

  const toggleComplete = useCallback(
    async (chore: ChoreRow) => {
      if (!householdId || !accessToken) return;
      setBusyChoreId(chore.id);

      const isDone = chore.status === "completed" || chore.status === "done";
      const newStatus = isDone ? "pending" : "completed";

      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `quick_complete_${chore.id}_${Date.now()}`,
          tool: "db.update",
          args: {
            table: "chores",
            id: chore.id,
            patch: {
              status: newStatus,
              completed_at: newStatus === "completed" ? new Date().toISOString() : null,
            },
          },
          reason: newStatus === "completed"
            ? `Quick-complete: "${chore.title}"`
            : `Undo completion: "${chore.title}"`,
        },
      });

      setBusyChoreId(null);

      if (res.ok) {
        // Update local state immediately.
        setChores((prev) =>
          prev.map((c) =>
            c.id === chore.id
              ? { ...c, status: newStatus, completed_at: newStatus === "completed" ? new Date().toISOString() : null }
              : c,
          ),
        );
      }
    },
    [householdId, accessToken],
  );

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" py={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  if (chores.length === 0) {
    return (
      <Card variant="outlined">
        <CardContent sx={{ textAlign: "center", py: 4 }}>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            {t("chores.no_chores_due_on_date")}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t("helper_daily.empty_hint")}
          </Typography>
          <Button
            variant="outlined"
            onClick={() => void load()}
          >
            {t("common.refresh")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Stack spacing={3}>
      {helperGroups.map((group) => {
        const progressPct = group.totalCount > 0 ? Math.round((group.completedCount / group.totalCount) * 100) : 0;

        return (
          <Box key={group.helperId}>
            {/* Helper section header (no Card — chores below are the cards). */}
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ mb: 1.5, px: 0.5 }}
            >
              <Box>
                <Typography variant="h6" fontWeight={700}>
                  {group.helperName}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {group.completedCount}/{group.totalCount} done
                  {group.totalMinutes > 0 && ` · ${group.totalMinutes} min`}
                </Typography>
              </Box>
              <Chip
                label={`${progressPct}%`}
                size="small"
                color={progressPct === 100 ? "success" : progressPct > 50 ? "primary" : "default"}
              />
            </Stack>

            {/* Tasks grouped by cadence — each chore is its own outlined Card,
                matching the Task view's per-chore styling. */}
            {group.cadenceGroups.map(({ cadence, chores: cadChores }) => (
              <Box key={cadence} mb={2}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    display: "block",
                    mb: 0.75,
                    px: 0.5,
                  }}
                >
                  {cadenceLabel(cadence as Cadence)}
                </Typography>
                <Stack spacing={1}>
                  {cadChores.map((chore) => {
                    const isDone = chore.status === "completed" || chore.status === "done";
                    const isBusy = busyChoreId === chore.id;
                    const meta = (chore.metadata ?? {}) as Record<string, unknown>;
                    const space = typeof meta.space === "string" ? meta.space : null;
                    const minutes = typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : null;
                    const priority = typeof chore.priority === "number" ? chore.priority : 1;
                    const dueLabel = formatDueTime(chore.due_at);

                    return (
                      <Card
                        key={chore.id}
                        variant="outlined"
                        sx={{ borderRadius: 2, opacity: isDone ? 0.65 : 1 }}
                      >
                        <Box
                          sx={{
                            display: "grid",
                            gridTemplateColumns: {
                              xs: "auto 1fr",
                              md: "auto minmax(260px, 2fr) minmax(140px, 1fr) minmax(120px, 0.8fr) auto",
                            },
                            gap: 1,
                            alignItems: "center",
                            px: 1.5,
                            py: 1,
                          }}
                        >
                          <Box sx={{ display: "flex", alignItems: "flex-start", pt: 0.25 }}>
                            <Checkbox
                              size="small"
                              checked={isDone}
                              disabled={isBusy}
                              onChange={() => void toggleComplete(chore)}
                              inputProps={{ "aria-label": "Toggle completion" }}
                            />
                          </Box>

                          <Box sx={{ minWidth: 0 }}>
                            <Box display="flex" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
                              {getStatusIcon(chore.status)}
                              <Typography
                                variant="subtitle1"
                                fontWeight={700}
                                noWrap
                                sx={{
                                  minWidth: 0,
                                  textDecoration: isDone ? "line-through" : "none",
                                  color: isDone ? "text.disabled" : "text.primary",
                                }}
                              >
                                {chore.title}
                              </Typography>
                              <Chip
                                size="small"
                                label={`P${priority}`}
                                color={priority >= 3 ? "error" : priority === 2 ? "warning" : "info"}
                                sx={{ ml: "auto", display: { xs: "none", sm: "inline-flex" } }}
                              />
                            </Box>
                            {chore.description ? (
                              <Typography variant="body2" color="textSecondary" noWrap>
                                {chore.description}
                              </Typography>
                            ) : null}
                          </Box>

                          <Box sx={{ display: { xs: "flex", md: "block" }, gap: 1, flexWrap: "wrap" }}>
                            <Typography variant="caption" color="textSecondary">
                              {t("chores.space")}
                            </Typography>
                            <Typography variant="body2" fontWeight={600} sx={{ ml: { xs: 0.5, md: 0 } }}>
                              {space || t("chores.none")}
                            </Typography>
                          </Box>

                          <Box sx={{ display: { xs: "flex", md: "block" }, gap: 1, flexWrap: "wrap" }}>
                            <Typography variant="caption" color="textSecondary">
                              {t("chores.due")}
                            </Typography>
                            <Typography variant="body2" fontWeight={600} sx={{ ml: { xs: 0.5, md: 0 } }}>
                              {dueLabel || t("chores.none")}
                            </Typography>
                          </Box>

                          <Box sx={{ display: "flex", justifyContent: { xs: "flex-start", md: "flex-end" }, gap: 0.5, alignItems: "center" }}>
                            {minutes ? (
                              <Typography variant="caption" color="text.secondary">
                                ~{minutes}m
                              </Typography>
                            ) : null}
                            {isBusy && <CircularProgress size={14} />}
                          </Box>

                          <Box sx={{ display: { xs: "flex", sm: "none" }, gap: 1, gridColumn: "1 / -1" }}>
                            <Chip
                              size="small"
                              label={`P${priority}`}
                              color={priority >= 3 ? "error" : priority === 2 ? "warning" : "info"}
                            />
                          </Box>
                        </Box>
                      </Card>
                    );
                  })}
                </Stack>
              </Box>
            ))}
          </Box>
        );
      })}
    </Stack>
  );
}
