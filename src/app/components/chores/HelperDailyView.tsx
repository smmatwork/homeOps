/**
 * Helper Daily View — shows each helper's tasks for a given day,
 * grouped by cadence, with one-tap completion checkboxes.
 *
 * Uses the shared ChoreCard component for visual consistency with the
 * Task view.
 */

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { ExpandMore, ExpandLess } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import { cadenceLabel, type Cadence } from "../../services/choreRecommendationEngine";
import { templateOccursOnDate } from "../../services/choreScheduler";
import { ChoreCard, type ChoreRow } from "./ChoreCard";
import { EditChoreDialog } from "./EditChoreDialog";

interface HelperDailyViewProps {
  date: string;
}

interface HelperRow {
  id: string;
  name: string;
}

interface HelperGroup {
  helperId: string;
  helperName: string;
  cadenceGroups: Array<{ cadence: string; chores: ChoreRow[] }>;
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
    if (!householdId) { setLoading(false); return; }
    setLoading(true);
    setError(null);

    const [choresRes, helpersRes] = await Promise.all([
      supabase
        .from("chores")
        .select("id,title,description,priority,status,helper_id,due_at,completed_at,metadata,deleted_at,created_at")
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

    const selectedDate = new Date(`${date}T00:00:00Z`);
    const dateStr = date;
    const allChores = (choresRes.data ?? []) as ChoreRow[];

    const todaysChores = allChores.filter((c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const cadence = typeof meta.cadence === "string" ? meta.cadence : null;

      if (c.due_at && c.due_at.slice(0, 10) === dateStr) return true;

      if (cadence && c.status !== "completed" && c.status !== "done") {
        const choreKey = typeof meta.template_task_key === "string"
          ? meta.template_task_key
          : c.id;
        try {
          if (templateOccursOnDate(cadence as Cadence, selectedDate, choreKey)) return true;
        } catch { /* skip invalid cadence */ }
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

  // ── Edit / Delete ─────────────────────────────────────────────
  const [editChore, setEditChore] = useState<ChoreRow | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const handleEditSave = useCallback(async (data: {
    choreId: string; title: string; description: string; status: string;
    priority: number; dueAt: string; helperId: string; space: string; cadence: string;
  }) => {
    if (!householdId || !accessToken) return;
    setEditBusy(true);
    const res = await executeToolCall({
      accessToken, householdId, scope: "household",
      toolCall: {
        id: `edit_${data.choreId}_${Date.now()}`,
        tool: "db.update",
        args: {
          table: "chores", id: data.choreId,
          patch: {
            title: data.title, description: data.description || null,
            status: data.status, priority: data.priority,
            due_at: data.dueAt ? new Date(data.dueAt).toISOString() : null,
            helper_id: data.helperId || null,
            metadata: { space: data.space || null, cadence: data.cadence || null },
          },
        },
        reason: "Edit chore from helper view",
      },
    });
    setEditBusy(false);
    if (res.ok) {
      setEditChore(null);
      void load(); // refresh
    }
  }, [householdId, accessToken, load]);

  const handleDelete = useCallback(async (chore: ChoreRow) => {
    if (!householdId || !accessToken) return;
    await executeToolCall({
      accessToken, householdId, scope: "household",
      toolCall: {
        id: `delete_${chore.id}_${Date.now()}`,
        tool: "db.delete",
        args: { table: "chores", id: chore.id },
        reason: `Delete chore: ${chore.title}`,
      },
    });
    void load();
  }, [householdId, accessToken, load]);

  // All hooks must be before early returns
  const [collapsedHelpers, setCollapsedHelpers] = useState<Set<string>>(new Set());

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
          <Button variant="outlined" onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const toggleHelper = (id: string) => {
    setCollapsedHelpers((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <Stack spacing={3}>
      {helperGroups.map((group) => {
        const progressPct = group.totalCount > 0 ? Math.round((group.completedCount / group.totalCount) * 100) : 0;
        const isCollapsed = collapsedHelpers.has(group.helperId);

        return (
          <Box key={group.helperId}>
            {/* Collapsible helper group header */}
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ mb: isCollapsed ? 0 : 1.5, px: 0.5, cursor: "pointer", "&:hover": { bgcolor: "action.hover" }, borderRadius: 1, py: 0.5 }}
              onClick={() => toggleHelper(group.helperId)}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                {isCollapsed ? <ExpandMore fontSize="small" color="action" /> : <ExpandLess fontSize="small" color="action" />}
                <Typography variant="subtitle1" fontWeight={700}>
                  {group.helperName}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {group.completedCount}/{group.totalCount}
                  {group.totalMinutes > 0 && ` · ${group.totalMinutes} min`}
                </Typography>
              </Stack>
              <Chip
                label={`${progressPct}%`}
                size="small"
                color={progressPct === 100 ? "success" : progressPct > 50 ? "primary" : "default"}
              />
            </Stack>

            {/* Tasks grouped by cadence — collapsible */}
            {!isCollapsed && group.cadenceGroups.map(({ cadence, chores: cadChores }) => (
              <Box key={cadence} mb={2}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, display: "block", mb: 0.75, px: 0.5 }}
                >
                  {cadenceLabel(cadence as Cadence)}
                </Typography>
                <Stack spacing={1}>
                  {cadChores.map((chore) => (
                    <ChoreCard
                      key={chore.id}
                      chore={chore}
                      helperName={group.helperName}
                      onToggleComplete={() => void toggleComplete(chore)}
                      completeBusy={busyChoreId === chore.id}
                      onEdit={() => setEditChore(chore)}
                      onDelete={() => void handleDelete(chore)}
                      showEstimate
                      showTimeOnly
                    />
                  ))}
                </Stack>
              </Box>
            ))}
          </Box>
        );
      })}

      <EditChoreDialog
        open={!!editChore}
        chore={editChore}
        onClose={() => setEditChore(null)}
        helpers={helpers.map((h) => ({ id: h.id, name: h.name }))}
        busy={editBusy}
        onSave={handleEditSave}
      />
    </Stack>
  );
}
