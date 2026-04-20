import { useState, useEffect, useMemo } from "react";
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
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  Add,
  Close,
  Delete,
  Edit,
  SwapHoriz,
  SkipNext,
  PriorityHigh,
  Schedule,
  ReportProblem,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { executeToolCall } from "../../services/agentApi";
import type { ChoreMutation } from "../../services/choreScheduler";
import type { ChoreAdjustment } from "../../services/choreReactor";
import type { SyncResult } from "../../services/choreEngine";

interface SyncResultsDrawerProps {
  open: boolean;
  onClose: () => void;
  result: SyncResult | null;
  onApplied?: () => void;
}

function adjustmentIcon(type: string) {
  switch (type) {
    case "reassign": return <SwapHoriz fontSize="small" />;
    case "skip": return <SkipNext fontSize="small" />;
    case "create": return <Add fontSize="small" />;
    case "reprioritize": return <PriorityHigh fontSize="small" />;
    case "escalate": return <ReportProblem fontSize="small" />;
    default: return <Schedule fontSize="small" />;
  }
}

function adjustmentColor(severity: string): "error" | "warning" | "info" {
  if (severity === "critical") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

import { ALL_CADENCES, cadenceLabel, cadenceIntervalDays } from "../../services/choreRecommendationEngine";

export function SyncResultsDrawer({ open, onClose, result, onApplied }: SyncResultsDrawerProps) {
  const { householdId, accessToken } = useAuth();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // ── Editable local copies of mutations ──────────────────────────────
  // The user can edit titles, cadences, and delete tasks before applying.
  const [editedMutations, setEditedMutations] = useState<ChoreMutation[]>([]);
  const [deletedIndices, setDeletedIndices] = useState<Set<number>>(new Set());
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  // Sync local state when result changes (new sync run).
  useEffect(() => {
    if (result) {
      setEditedMutations([...result.schedulerMutations]);
      setDeletedIndices(new Set());
      setApplied(new Set());
      setEditingIdx(null);
    }
  }, [result]);

  if (!result) return null;

  const visibleMutations = editedMutations.filter((_, i) => !deletedIndices.has(i));

  const totalPending =
    visibleMutations.length +
    result.reactorAdjustments.length -
    applied.size;

  const applyMutation = async (mutation: ChoreMutation, index: number) => {
    if (!householdId || !accessToken) return;
    const key = `sched_${index}`;
    if (applied.has(key)) return;
    setBusy(true);
    setError(null);

    const res = await executeToolCall({
      accessToken,
      householdId,
      scope: "household",
      toolCall: {
        id: `sync_apply_${mutation.templateId}_${Date.now()}`,
        tool: "db.insert",
        args: {
          table: "chores",
          record: {
            title: mutation.title,
            status: "pending",
            priority: mutation.priority,
            due_at: mutation.dueAt,
            helper_id: mutation.helperId,
            template_id: mutation.templateId,
            metadata: mutation.metadata,
          },
        },
        reason: `Sync: schedule "${mutation.title}"`,
      },
    });

    setBusy(false);
    if (res.ok) {
      setApplied((prev) => new Set(prev).add(key));
      onApplied?.();
    } else {
      setError("error" in res ? res.error : "Failed to apply");
    }
  };

  const applyAdjustment = async (adj: ChoreAdjustment, index: number) => {
    if (!householdId || !accessToken) return;
    const key = `adj_${index}`;
    if (applied.has(key)) return;
    setBusy(true);
    setError(null);

    let res: { ok: boolean; error?: string } = { ok: false, error: "Unknown type" };

    if (adj.type === "reassign" && adj.choreId && adj.toHelperId) {
      const r = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `sync_reassign_${adj.choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: adj.choreId, patch: { helper_id: adj.toHelperId } },
          reason: adj.reason,
        },
      });
      res = r.ok ? { ok: true } : { ok: false, error: "error" in r ? r.error : "Failed" };
    } else if (adj.type === "skip" && adj.choreId) {
      const r = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `sync_skip_${adj.choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: adj.choreId, patch: { status: "done", metadata: { skip_reason: adj.skipReason } } },
          reason: adj.reason,
        },
      });
      res = r.ok ? { ok: true } : { ok: false, error: "error" in r ? r.error : "Failed" };
    } else if (adj.type === "create") {
      const r = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `sync_create_${Date.now()}`,
          tool: "db.insert",
          args: {
            table: "chores",
            record: {
              title: adj.createTitle ?? "Chore",
              status: "pending",
              priority: 3,
              due_at: adj.createDueAt,
              metadata: { space: adj.createSpace, cadence: adj.createCadence, source: "reactor" },
            },
          },
          reason: adj.reason,
        },
      });
      res = r.ok ? { ok: true } : { ok: false, error: "error" in r ? r.error : "Failed" };
    } else if (adj.type === "reprioritize" && adj.choreId) {
      const r = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `sync_reprio_${adj.choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: adj.choreId, patch: { priority: adj.newPriority ?? 3 } },
          reason: adj.reason,
        },
      });
      res = r.ok ? { ok: true } : { ok: false, error: "error" in r ? r.error : "Failed" };
    }

    setBusy(false);
    if (res.ok) {
      setApplied((prev) => new Set(prev).add(key));
      onApplied?.();
    } else {
      setError(res.error ?? "Failed to apply");
    }
  };

  const updateMutation = (index: number, patch: Partial<ChoreMutation>) => {
    setEditedMutations((prev) => {
      const updated = prev.map((m, i) => (i === index ? { ...m, ...patch } : m));

      // If cadence changed to a higher frequency, expand to fill remaining horizon days.
      if (patch.cadence && patch.cadence !== prev[index].cadence) {
        const original = prev[index];
        const newCadence = patch.cadence;
        const interval = cadenceIntervalDays(newCadence);
        const oldInterval = cadenceIntervalDays(prev[index].cadence);

        // Only expand if the new cadence is more frequent than the old one.
        if (interval < oldInterval) {
          const baseDate = new Date(original.dueAt);
          const horizon = 7;
          const newMutations: ChoreMutation[] = [];
          for (let d = interval; d < horizon; d += interval) {
            const nextDate = new Date(baseDate);
            nextDate.setUTCDate(baseDate.getUTCDate() + d);
            const dk = nextDate.toISOString().slice(0, 10);
            const alreadyExists = updated.some(
              (m, i) => !deletedIndices.has(i) && m.taskKey === original.taskKey && m.dueAt.slice(0, 10) === dk,
            );
            if (!alreadyExists) {
              newMutations.push({
                ...updated[index],
                cadence: newCadence,
                dueAt: nextDate.toISOString(),
                metadata: { ...updated[index].metadata, cadence: newCadence },
              });
            }
          }
          if (newMutations.length > 0) {
            return [...updated, ...newMutations];
          }
        }
      }

      return updated;
    });
  };

  const deleteMutation = (index: number) => {
    setDeletedIndices((prev) => new Set(prev).add(index));
  };

  /**
   * Apply mutations in parallel batches of BATCH_SIZE for performance.
   * Sequential apply of 114 tasks takes minutes; batched takes seconds.
   */
  const BATCH_SIZE = 10;

  const applyAll = async () => {
    setBusy(true);
    setError(null);

    // Collect all pending work.
    const schedWork: Array<{ mutation: ChoreMutation; index: number }> = [];
    for (let i = 0; i < editedMutations.length; i += 1) {
      if (deletedIndices.has(i)) continue;
      if (applied.has(`sched_${i}`)) continue;
      schedWork.push({ mutation: editedMutations[i], index: i });
    }
    const adjWork: Array<{ adj: ChoreAdjustment; index: number }> = [];
    for (let i = 0; i < result.reactorAdjustments.length; i += 1) {
      if (applied.has(`adj_${i}`)) continue;
      adjWork.push({ adj: result.reactorAdjustments[i], index: i });
    }

    // Process scheduler mutations in parallel batches.
    for (let batch = 0; batch < schedWork.length; batch += BATCH_SIZE) {
      const chunk = schedWork.slice(batch, batch + BATCH_SIZE);
      await Promise.all(
        chunk.map(({ mutation, index }) => applyMutation(mutation, index)),
      );
    }

    // Process adjustments in parallel batches.
    for (let batch = 0; batch < adjWork.length; batch += BATCH_SIZE) {
      const chunk = adjWork.slice(batch, batch + BATCH_SIZE);
      await Promise.all(
        chunk.map(({ adj, index }) => applyAdjustment(adj, index)),
      );
    }

    setBusy(false);
    onApplied?.();
  };

  return (
    <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: { xs: "100%", sm: 480 } } }}>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h6" fontWeight={700}>
              {t("engine.sync_results")}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t("engine.sync_summary")
                .replace("{scheduled}", String(visibleMutations.length))
                .replace("{adjusted}", String(result.reactorAdjustments.length))}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5}>
            {totalPending > 0 && (
              <Button
                variant="contained"
                size="small"
                disabled={busy}
                onClick={() => void applyAll()}
              >
                {t("engine.apply_all").replace("{count}", String(totalPending))}
              </Button>
            )}
            <IconButton size="small" onClick={onClose}>
              <Close fontSize="small" />
            </IconButton>
          </Stack>
        </Stack>
      </Box>

      <Box sx={{ p: 2, overflowY: "auto", flex: 1 }}>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

        {busy && (
          <Box display="flex" justifyContent="center" py={2}>
            <CircularProgress size={20} />
          </Box>
        )}

        {/* Scheduler mutations — grouped by helper → cadence, editable */}
        {editedMutations.length > 0 && (() => {
          // Group by helper name, then by cadence within each helper.
          const byHelper = new Map<string, { indices: number[] }>();
          editedMutations.forEach((m, i) => {
            if (deletedIndices.has(i)) return;
            const helperName = (m.metadata as any)?.helper_name ?? m.space ?? "Unassigned";
            const existing = byHelper.get(helperName);
            if (existing) existing.indices.push(i);
            else byHelper.set(helperName, { indices: [i] });
          });

          if (byHelper.size === 0) return null;

          // Within each helper, group by cadence.
          const cadenceOrder = ["daily", "every_2_days", "every_3_days", "every_4_days", "every_5_days", "weekly", "biweekly", "monthly"];

          return (
            <Box mb={3}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {t("engine.section_scheduled")} ({visibleMutations.length})
              </Typography>
              <Stack spacing={2} mt={1}>
                {Array.from(byHelper.entries()).map(([helperName, { indices }]) => {
                  const allApplied = indices.every((i) => applied.has(`sched_${i}`));
                  const totalMin = indices.reduce((sum, i) => sum + (editedMutations[i].estimatedMinutes ?? 0), 0);

                  // Sub-group by cadence.
                  const byCadence = new Map<string, number[]>();
                  for (const idx of indices) {
                    const cad = editedMutations[idx].cadence;
                    const existing = byCadence.get(cad);
                    if (existing) existing.push(idx);
                    else byCadence.set(cad, [idx]);
                  }
                  const sortedCadences = Array.from(byCadence.entries()).sort(
                    (a, b) => cadenceOrder.indexOf(a[0]) - cadenceOrder.indexOf(b[0]),
                  );

                  return (
                    <Card key={helperName} variant="outlined" sx={{ opacity: allApplied ? 0.5 : 1 }}>
                      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1.5}>
                          <Box>
                            <Typography variant="subtitle1" fontWeight={700}>{helperName}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {indices.length} tasks · {totalMin} min
                            </Typography>
                          </Box>
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={busy || allApplied}
                            onClick={async () => {
                              for (const idx of indices) {
                                if (!applied.has(`sched_${idx}`)) {
                                  await applyMutation(editedMutations[idx], idx);
                                }
                              }
                            }}
                          >
                            {allApplied ? t("engine.applied") : t("engine.apply")}
                          </Button>
                        </Stack>

                        {sortedCadences.map(([cad, cadIndices]) => (
                          <Box key={cad} mb={1}>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, display: "block", mb: 0.5 }}
                            >
                              {cadenceLabel(cad as any)}
                            </Typography>
                            <Stack spacing={0.5}>
                              {cadIndices.map((globalIdx) => {
                                const m = editedMutations[globalIdx];
                                const isApplied = applied.has(`sched_${globalIdx}`);
                                const isEditing = editingIdx === globalIdx;

                                if (isEditing) {
                                  return (
                                    <Box key={globalIdx} sx={{ p: 1, bgcolor: "action.hover", borderRadius: 1 }}>
                                      <Stack spacing={1}>
                                        <TextField
                                          size="small"
                                          fullWidth
                                          label={t("engine.edit_title")}
                                          value={m.title}
                                          onChange={(e) => updateMutation(globalIdx, { title: e.target.value })}
                                        />
                                        <Stack direction="row" spacing={1}>
                                          <Select
                                            size="small"
                                            value={m.cadence}
                                            onChange={(e) => updateMutation(globalIdx, { cadence: e.target.value as any })}
                                            sx={{ minWidth: 120 }}
                                          >
                                            {ALL_CADENCES.map((c) => (
                                              <MenuItem key={c} value={c}>{cadenceLabel(c)}</MenuItem>
                                            ))}
                                          </Select>
                                          <Button size="small" variant="contained" onClick={() => setEditingIdx(null)}>
                                            {t("common.done")}
                                          </Button>
                                        </Stack>
                                      </Stack>
                                    </Box>
                                  );
                                }

                                return (
                                  <Stack key={globalIdx} direction="row" spacing={0.5} alignItems="center" sx={{ opacity: isApplied ? 0.5 : 1 }}>
                                    <Chip size="small" variant="outlined" label={m.space} sx={{ minWidth: 80 }} />
                                    <Typography variant="body2" flex={1} noWrap>{m.title}</Typography>
                                    <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                                      ~{m.estimatedMinutes ?? 0}m
                                    </Typography>
                                    {!isApplied && (
                                      <>
                                        <IconButton size="small" onClick={() => setEditingIdx(globalIdx)} disabled={busy}>
                                          <Edit sx={{ fontSize: 16 }} />
                                        </IconButton>
                                        <IconButton size="small" onClick={() => deleteMutation(globalIdx)} disabled={busy}>
                                          <Delete sx={{ fontSize: 16 }} />
                                        </IconButton>
                                      </>
                                    )}
                                  </Stack>
                                );
                              })}
                            </Stack>
                          </Box>
                        ))}
                      </CardContent>
                    </Card>
                  );
                })}
              </Stack>
            </Box>
          );
        })()}

        {/* Reactor adjustments */}
        {result.reactorAdjustments.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
              {t("engine.section_adjustments")} ({result.reactorAdjustments.length})
            </Typography>
            <Stack spacing={1} mt={1}>
              {result.reactorAdjustments.map((adj, i) => {
                const key = `adj_${i}`;
                const isApplied = applied.has(key);

                // Escalation — special rendering with prominent alert + affected chores list
                if (adj.type === "escalate") {
                  return (
                    <Alert
                      key={key}
                      severity="error"
                      icon={<ReportProblem />}
                      sx={{ alignItems: "flex-start" }}
                    >
                      <Typography variant="body2" fontWeight={600} gutterBottom>
                        {t("engine.escalation_title")}
                      </Typography>
                      <Typography variant="body2" gutterBottom>
                        {adj.reason}
                      </Typography>
                      {adj.affectedChores && adj.affectedChores.length > 0 && (
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap mt={0.5}>
                          {adj.affectedChores.map((title) => (
                            <Chip key={title} size="small" label={title} color="error" variant="outlined" />
                          ))}
                        </Stack>
                      )}
                    </Alert>
                  );
                }

                return (
                  <Card key={key} variant="outlined" sx={{ opacity: isApplied ? 0.5 : 1 }}>
                    <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Box>
                          <Stack direction="row" spacing={0.5} alignItems="center" mb={0.25}>
                            <Chip
                              size="small"
                              color={adjustmentColor(adj.severity)}
                              icon={adjustmentIcon(adj.type)}
                              label={adj.type}
                              sx={{ fontWeight: 600, textTransform: "capitalize" }}
                            />
                          </Stack>
                          <Typography variant="body2">{adj.reason}</Typography>
                        </Box>
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={busy || isApplied}
                          onClick={() => void applyAdjustment(adj, i)}
                        >
                          {isApplied ? t("engine.applied") : t("engine.apply")}
                        </Button>
                      </Stack>
                    </CardContent>
                  </Card>
                );
              })}
            </Stack>
          </Box>
        )}

        {result.schedulerMutations.length === 0 && result.reactorAdjustments.length === 0 && (
          <Box textAlign="center" py={6}>
            <Typography color="text.secondary">{t("engine.nothing_to_sync")}</Typography>
          </Box>
        )}
      </Box>
    </Drawer>
  );
}
