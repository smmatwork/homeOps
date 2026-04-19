/**
 * Workload Optimizer — helps the owner close the gap between total chore
 * load and total helper capacity. Flow:
 *
 * Step 1: Gap overview (how much over capacity)
 * Step 2: Cadence reduction suggestions (biggest lever)
 * Step 3: Low-priority chores to skip/remove
 * Step 4: After adjustments, offer redistribution
 */

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { ArrowForward, CheckCircle, TrendingDown } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import {
  buildAssignmentPlan,
  inferRoleTags,
  type AssignableChore,
  type AssignableHelper,
} from "../../services/choreAssigner";

interface WorkloadOptimizerProps {
  onDone?: () => void;
}

interface ChoreEntry {
  id: string;
  title: string;
  space: string;
  cadence: string;
  estimatedMinutes: number;
  priority: number;
  helperId: string | null;
  helperName: string;
  dailyLoad: number; // effective daily minutes
}

interface HelperEntry {
  id: string;
  name: string;
  type: string;
  capacityMinutes: number;
}

type Step = "loading" | "gap" | "cadence" | "skip" | "redistribute" | "applying" | "done";

const CADENCE_OPTIONS = [
  { value: "daily", label: "Daily", factor: 1 },
  { value: "alternate_days", label: "Alternate days", factor: 0.5 },
  { value: "every_3_days", label: "Every 3 days", factor: 1 / 3 },
  { value: "weekly", label: "Weekly", factor: 1 / 6 },
  { value: "biweekly", label: "Biweekly", factor: 1 / 12 },
  { value: "monthly", label: "Monthly", factor: 1 / 26 },
];

function cadenceLoadFactor(cadence: string): number {
  if (cadence === "daily") return 1.0;
  if (cadence === "alternate_days") return 0.5;
  if (cadence.startsWith("weekly")) return 1.0 / 6;
  if (cadence.startsWith("biweekly")) return 1.0 / 12;
  if (cadence.startsWith("monthly")) return 1.0 / 26;
  if (/every_(\d+)_days/.test(cadence)) {
    const n = parseInt(cadence.match(/every_(\d+)_days/)?.[1] ?? "3", 10);
    return 1.0 / n;
  }
  return 1.0 / 6;
}

function suggestCadence(current: string): string | null {
  // Suggest a less frequent cadence
  if (current === "daily") return "alternate_days";
  if (current === "alternate_days") return "weekly";
  if (current.startsWith("weekly")) return "biweekly";
  if (current.startsWith("biweekly")) return "monthly";
  return null;
}

function cadenceLabel(cadence: string): string {
  const base = CADENCE_OPTIONS.find((o) => o.value === cadence);
  if (base) return base.label;
  if (cadence.startsWith("weekly_")) return `Weekly — ${cadence.slice(7).charAt(0).toUpperCase()}${cadence.slice(8)}`;
  if (cadence.startsWith("biweekly_")) return `Biweekly — ${cadence.slice(9).charAt(0).toUpperCase()}${cadence.slice(10)}`;
  if (cadence.startsWith("monthly_")) return `Monthly`;
  return cadence.replace(/_/g, " ");
}

export function WorkloadOptimizer({ onDone }: WorkloadOptimizerProps) {
  const { householdId, accessToken } = useAuth();
  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);

  const [chores, setChores] = useState<ChoreEntry[]>([]);
  const [helpers, setHelpers] = useState<HelperEntry[]>([]);
  const [totalCapacity, setTotalCapacity] = useState(0);

  // Cadence changes: choreId → new cadence
  const [cadenceChanges, setCadenceChanges] = useState<Record<string, string>>({});
  // Chores to skip/remove
  const [skipSet, setSkipSet] = useState<Set<string>>(new Set());

  const [applyProgress, setApplyProgress] = useState(0);
  const [applyTotal, setApplyTotal] = useState(0);

  // ── Load data ───────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!householdId) return;

    const [helpersRes, choresRes] = await Promise.all([
      supabase.from("helpers").select("id,name,type,daily_capacity_minutes,metadata").eq("household_id", householdId),
      supabase.from("chores").select("id,title,helper_id,metadata,priority,status")
        .eq("household_id", householdId).is("deleted_at", null).neq("status", "completed"),
    ]);

    if (helpersRes.error || choresRes.error) {
      setError(helpersRes.error?.message ?? choresRes.error?.message ?? "Load failed");
      setStep("gap");
      return;
    }

    const helperNameMap = new Map<string, string>();
    const hs: HelperEntry[] = ((helpersRes.data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const schedule = (meta.schedule ?? {}) as Record<string, unknown>;
      const startTime = typeof schedule.start === "string" ? schedule.start : "";
      const endTime = typeof schedule.end === "string" ? schedule.end : "";
      let cap = Number(r.daily_capacity_minutes ?? 120);
      if (startTime && endTime) {
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        const mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins > 0) cap = mins;
      }
      helperNameMap.set(String(r.id), String(r.name));
      return { id: String(r.id), name: String(r.name), type: String(r.type ?? "General"), capacityMinutes: cap };
    });

    const cs: ChoreEntry[] = ((choresRes.data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const cadence = typeof meta.cadence === "string" ? meta.cadence : "weekly";
      const mins = typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : 15;
      const hid = r.helper_id ? String(r.helper_id) : null;
      return {
        id: String(r.id),
        title: String(r.title ?? ""),
        space: typeof meta.space === "string" ? meta.space : "",
        cadence,
        estimatedMinutes: mins,
        priority: Number(r.priority ?? 1),
        helperId: hid,
        helperName: hid ? (helperNameMap.get(hid) ?? "Unknown") : "Unassigned",
        dailyLoad: mins * cadenceLoadFactor(cadence),
      };
    });

    setHelpers(hs);
    setChores(cs);
    setTotalCapacity(hs.reduce((sum, h) => sum + h.capacityMinutes, 0));
    setStep("gap");
  }, [householdId]);

  useEffect(() => { void load(); }, [load]);

  // ── Computed values ─────────────────────────────────────────────

  const currentTotalLoad = chores.reduce((sum, c) => sum + c.dailyLoad, 0);

  // Projected load after cadence changes and skips
  const projectedLoad = chores.reduce((sum, c) => {
    if (skipSet.has(c.id)) return sum;
    const newCadence = cadenceChanges[c.id];
    if (newCadence) return sum + c.estimatedMinutes * cadenceLoadFactor(newCadence);
    return sum + c.dailyLoad;
  }, 0);

  const gap = currentTotalLoad - totalCapacity;
  const projectedGap = projectedLoad - totalCapacity;
  const savedMinutes = currentTotalLoad - projectedLoad;

  // Cadence suggestions: daily/alternate chores sorted by highest daily load
  const cadenceSuggestions = chores
    .filter((c) => ["daily", "alternate_days"].includes(c.cadence) || c.cadence.startsWith("weekly"))
    .filter((c) => suggestCadence(c.cadence) !== null)
    .sort((a, b) => b.dailyLoad - a.dailyLoad);

  // Skip candidates: low priority, non-daily chores
  const skipCandidates = chores
    .filter((c) => c.priority <= 1 && !skipSet.has(c.id))
    .sort((a, b) => a.dailyLoad - b.dailyLoad);

  // ── Apply changes ───────────────────────────────────────────────

  const applyChanges = async () => {
    if (!householdId || !accessToken) return;

    const cadenceUpdates = Object.entries(cadenceChanges);
    const skips = [...skipSet];
    const total = cadenceUpdates.length + skips.length;
    if (total === 0) return;

    setStep("applying");
    setApplyTotal(total);
    setApplyProgress(0);
    setError(null);

    let i = 0;

    // Apply cadence changes
    for (const [choreId, newCadence] of cadenceUpdates) {
      const chore = chores.find((c) => c.id === choreId);
      const res = await executeToolCall({
        accessToken, householdId, scope: "household",
        toolCall: {
          id: `optimize_cadence_${choreId}_${Date.now()}`,
          tool: "db.update",
          args: {
            table: "chores",
            id: choreId,
            patch: { metadata: { ...(chore ? { space: chore.space, estimated_minutes: chore.estimatedMinutes } : {}), cadence: newCadence } },
          },
          reason: `Optimize: change "${chore?.title}" from ${chore?.cadence} to ${newCadence}`,
        },
      });
      if (!res.ok) {
        setError(`Failed on "${chore?.title}": ${"error" in res ? res.error : "unknown"}`);
        setStep("cadence");
        return;
      }
      i += 1;
      setApplyProgress(i);
    }

    // Apply skips (soft-delete)
    for (const choreId of skips) {
      const chore = chores.find((c) => c.id === choreId);
      const res = await executeToolCall({
        accessToken, householdId, scope: "household",
        toolCall: {
          id: `optimize_skip_${choreId}_${Date.now()}`,
          tool: "db.delete",
          args: { table: "chores", id: choreId },
          reason: `Optimize: remove low-priority "${chore?.title}"`,
        },
      });
      if (!res.ok) {
        setError(`Failed on "${chore?.title}": ${"error" in res ? res.error : "unknown"}`);
        setStep("skip");
        return;
      }
      i += 1;
      setApplyProgress(i);
    }

    setStep("done");
  };

  // ── Redistribute after optimization ─────────────────────────────

  const applyRedistribution = async () => {
    if (!householdId || !accessToken) return;

    // Build remaining chores after skips
    const remaining: AssignableChore[] = chores
      .filter((c) => !skipSet.has(c.id))
      .map((c) => ({
        id: c.id,
        title: c.title,
        space: c.space,
        cadence: cadenceChanges[c.id] ?? c.cadence,
        estimatedMinutes: c.estimatedMinutes,
        currentHelperId: c.helperId,
      }));

    const assignableHelpers: AssignableHelper[] = helpers.map((h) => ({
      id: h.id, name: h.name, type: h.type,
      dailyCapacityMinutes: h.capacityMinutes,
      roleTags: inferRoleTags(h.type),
      kind: "helper" as const,
    }));

    const plan = buildAssignmentPlan(remaining, assignableHelpers);

    // Apply reassignments
    const toApply = plan.assignments.filter((a) => {
      const chore = remaining.find((c) => c.id === a.choreId);
      return a.helperId && a.helperId !== chore?.currentHelperId;
    });

    setStep("applying");
    setApplyTotal(toApply.length);
    setApplyProgress(0);

    for (let i = 0; i < toApply.length; i++) {
      const a = toApply[i];
      const res = await executeToolCall({
        accessToken, householdId, scope: "household",
        toolCall: {
          id: `redistribute_${a.choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: a.choreId, patch: { helper_id: a.helperId } },
          reason: `Redistribute: assign "${a.choreTitle}" to ${a.helperName}`,
        },
      });
      if (!res.ok) {
        setError(`Failed: ${"error" in res ? res.error : "unknown"}`);
        setStep("redistribute");
        return;
      }
      setApplyProgress(i + 1);
    }

    setStep("done");
  };

  // ── Render ──────────────────────────────────────────────────────

  if (step === "loading") {
    return <Card variant="outlined"><CardContent><Box display="flex" justifyContent="center" py={3}><CircularProgress size={24} /></Box></CardContent></Card>;
  }

  if (step === "done") {
    return (
      <Card variant="outlined"><CardContent>
        <Stack spacing={2} alignItems="center" py={2}>
          <CheckCircle color="success" sx={{ fontSize: 48 }} />
          <Typography variant="h6" fontWeight={600}>Workload optimized</Typography>
          <Typography variant="body2" color="text.secondary">
            Saved {Math.round(savedMinutes)} min/day effective load.
          </Typography>
          <Button variant="contained" onClick={onDone}>Done</Button>
        </Stack>
      </CardContent></Card>
    );
  }

  if (step === "applying") {
    return (
      <Card variant="outlined"><CardContent>
        <Stack spacing={2} alignItems="center" py={2}>
          <CircularProgress size={28} />
          <Typography variant="body2">Applying... {applyProgress}/{applyTotal}</Typography>
          <LinearProgress variant="determinate" value={applyTotal > 0 ? (applyProgress / applyTotal) * 100 : 0} sx={{ width: "100%", height: 5, borderRadius: 1 }} />
        </Stack>
      </CardContent></Card>
    );
  }

  // ── Step 1: Gap overview ──────────────────────────────────────

  if (step === "gap") {
    const gapPct = totalCapacity > 0 ? Math.round((currentTotalLoad / totalCapacity) * 100) : 0;
    const isOver = currentTotalLoad > totalCapacity;

    return (
      <Card variant="outlined"><CardContent>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" fontWeight={600}>Workload Overview</Typography>
            <Typography variant="body2" color="text.secondary">
              {isOver
                ? `Your home needs ${Math.round(currentTotalLoad)} min/day but helpers have ${totalCapacity} min. That's ${gapPct}% of capacity.`
                : `Workload is within capacity: ${Math.round(currentTotalLoad)}/${totalCapacity} min/day (${gapPct}%).`}
            </Typography>
          </Box>

          {error && <Alert severity="error">{error}</Alert>}

          {/* Per-helper breakdown */}
          {helpers.map((h) => {
            const load = chores.filter((c) => c.helperId === h.id).reduce((s, c) => s + c.dailyLoad, 0);
            const pct = h.capacityMinutes > 0 ? Math.round((load / h.capacityMinutes) * 100) : 0;
            return (
              <Box key={h.id}>
                <Stack direction="row" justifyContent="space-between" mb={0.5}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2" fontWeight={600}>{h.name}</Typography>
                    <Chip size="small" label={h.type} variant="outlined" sx={{ fontSize: 10 }} />
                  </Stack>
                  <Typography variant="caption" color={pct > 100 ? "error.main" : "text.secondary"}>
                    {Math.round(load)}/{h.capacityMinutes} min · {pct}%
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate" value={Math.min(100, pct)}
                  color={pct > 100 ? "error" : pct < 40 ? "warning" : "primary"}
                  sx={{ height: 6, borderRadius: 1 }}
                />
              </Box>
            );
          })}

          {/* Total bar */}
          <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: isOver ? "error.50" : "success.50", border: "1px solid", borderColor: isOver ? "error.200" : "success.200" }}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" fontWeight={600}>Total</Typography>
              <Typography variant="body2" fontWeight={600} color={isOver ? "error.main" : "success.main"}>
                {Math.round(currentTotalLoad)}/{totalCapacity} min · {isOver ? `${Math.round(gap)} min over` : "OK"}
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate" value={Math.min(100, gapPct)}
              color={isOver ? "error" : "success"}
              sx={{ height: 8, borderRadius: 1, mt: 0.5 }}
            />
          </Box>

          <Stack direction="row" spacing={1}>
            {isOver && (
              <Button variant="contained" color="warning" startIcon={<TrendingDown />} onClick={() => setStep("cadence")}>
                Reduce workload
              </Button>
            )}
            {!isOver && (
              <Button variant="contained" onClick={() => setStep("redistribute")}>
                Redistribute evenly
              </Button>
            )}
            {onDone && <Button variant="outlined" onClick={onDone}>Close</Button>}
          </Stack>
        </Stack>
      </CardContent></Card>
    );
  }

  // ── Step 2: Cadence reduction ─────────────────────────────────

  if (step === "cadence") {
    return (
      <Card variant="outlined"><CardContent>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" fontWeight={600}>Reduce Frequency</Typography>
            <Typography variant="body2" color="text.secondary">
              These chores have the highest daily load. Reducing their frequency frees the most time.
              {savedMinutes > 0 && (
                <Chip size="small" label={`${Math.round(savedMinutes)} min/day saved so far`} color="success" sx={{ ml: 1, fontSize: 11 }} />
              )}
            </Typography>
          </Box>

          {error && <Alert severity="error">{error}</Alert>}

          {/* Live projected gap */}
          <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: projectedGap > 0 ? "warning.50" : "success.50", border: "1px solid", borderColor: projectedGap > 0 ? "warning.200" : "success.200" }}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" fontWeight={600}>Projected load</Typography>
              <Typography variant="body2" fontWeight={600} color={projectedGap > 0 ? "warning.main" : "success.main"}>
                {Math.round(projectedLoad)}/{totalCapacity} min
                {projectedGap > 0 ? ` · ${Math.round(projectedGap)} min still over` : " · within capacity"}
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate" value={Math.min(100, totalCapacity > 0 ? (projectedLoad / totalCapacity) * 100 : 0)}
              color={projectedGap > 0 ? "warning" : "success"}
              sx={{ height: 6, borderRadius: 1, mt: 0.5 }}
            />
          </Box>

          {/* Suggestion list */}
          <Box sx={{ maxHeight: 400, overflowY: "auto" }}>
            <Stack spacing={0.75}>
              {cadenceSuggestions.slice(0, 40).map((c) => {
                const suggested = suggestCadence(c.cadence)!;
                const currentOverride = cadenceChanges[c.id];
                const savings = c.dailyLoad - c.estimatedMinutes * cadenceLoadFactor(currentOverride ?? c.cadence);
                return (
                  <Stack key={c.id} direction="row" spacing={1} alignItems="center"
                    sx={{ py: 0.75, px: 1, borderRadius: 1, bgcolor: currentOverride ? "success.50" : "transparent" }}>
                    <Box flex={1} minWidth={0}>
                      <Typography variant="body2" noWrap fontWeight={500} sx={{ fontSize: 13 }}>{c.title}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {c.space ? `${c.space} · ` : ""}{c.helperName} · {Math.round(c.dailyLoad)} min/day
                      </Typography>
                    </Box>
                    <Chip size="small" label={cadenceLabel(c.cadence)} variant="outlined" sx={{ fontSize: 10 }} />
                    <ArrowForward sx={{ fontSize: 14, color: "text.secondary" }} />
                    <TextField
                      select size="small" value={currentOverride ?? suggested}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === c.cadence) {
                          setCadenceChanges((prev) => { const n = { ...prev }; delete n[c.id]; return n; });
                        } else {
                          setCadenceChanges((prev) => ({ ...prev, [c.id]: val }));
                        }
                      }}
                      sx={{ minWidth: 140 }}
                      SelectProps={{ sx: { fontSize: 11 } }}
                    >
                      {CADENCE_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value} sx={{ fontSize: 12 }}>{o.label}</MenuItem>)}
                    </TextField>
                    {currentOverride && savings > 0 && (
                      <Typography variant="caption" color="success.main" sx={{ minWidth: 50, textAlign: "right" }}>
                        -{Math.round(savings)} min
                      </Typography>
                    )}
                  </Stack>
                );
              })}
            </Stack>
          </Box>

          <Stack direction="row" spacing={1}>
            {projectedGap > 0 ? (
              <Button variant="contained" onClick={() => setStep("skip")}>
                Next: remove low-priority
              </Button>
            ) : (
              <Button variant="contained" color="success" onClick={() => setStep("redistribute")}>
                Looks good — redistribute
              </Button>
            )}
            <Button variant="outlined" onClick={() => setStep("gap")}>Back</Button>
            {Object.keys(cadenceChanges).length > 0 && (
              <Button variant="text" color="success" onClick={() => void applyChanges()}>
                Apply {Object.keys(cadenceChanges).length} changes now
              </Button>
            )}
          </Stack>
        </Stack>
      </CardContent></Card>
    );
  }

  // ── Step 3: Skip / remove low-priority ────────────────────────

  if (step === "skip") {
    return (
      <Card variant="outlined"><CardContent>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" fontWeight={600}>Remove Low-Priority Chores</Typography>
            <Typography variant="body2" color="text.secondary">
              These low-priority chores can be deferred or removed to free more capacity.
              {skipSet.size > 0 && (
                <Chip size="small" label={`${skipSet.size} selected for removal`} color="error" sx={{ ml: 1, fontSize: 11 }} />
              )}
            </Typography>
          </Box>

          {/* Live projected gap */}
          <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: projectedGap > 0 ? "warning.50" : "success.50", border: "1px solid", borderColor: projectedGap > 0 ? "warning.200" : "success.200" }}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" fontWeight={600}>Projected load</Typography>
              <Typography variant="body2" fontWeight={600} color={projectedGap > 0 ? "warning.main" : "success.main"}>
                {Math.round(projectedLoad)}/{totalCapacity} min
                {projectedGap > 0 ? ` · ${Math.round(projectedGap)} min still over` : " · within capacity"}
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate" value={Math.min(100, totalCapacity > 0 ? (projectedLoad / totalCapacity) * 100 : 0)}
              color={projectedGap > 0 ? "warning" : "success"}
              sx={{ height: 6, borderRadius: 1, mt: 0.5 }}
            />
          </Box>

          <Box sx={{ maxHeight: 350, overflowY: "auto" }}>
            <Stack spacing={0.5}>
              {skipCandidates.map((c) => (
                <Stack key={c.id} direction="row" spacing={1} alignItems="center"
                  sx={{ py: 0.5, px: 1, borderRadius: 1, bgcolor: skipSet.has(c.id) ? "error.50" : "transparent" }}>
                  <Checkbox
                    size="small" checked={skipSet.has(c.id)}
                    onChange={(e) => {
                      setSkipSet((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(c.id); else next.delete(c.id);
                        return next;
                      });
                    }}
                  />
                  <Box flex={1} minWidth={0}>
                    <Typography variant="body2" noWrap fontWeight={500} sx={{ fontSize: 13 }}>{c.title}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {c.space ? `${c.space} · ` : ""}{cadenceLabel(c.cadence)} · {Math.round(c.dailyLoad)} min/day
                    </Typography>
                  </Box>
                  <Chip size="small" label={`P${c.priority}`} variant="outlined" sx={{ fontSize: 10 }} />
                </Stack>
              ))}
              {skipCandidates.length === 0 && (
                <Typography variant="body2" color="text.secondary" textAlign="center" py={2}>
                  No low-priority chores to remove.
                </Typography>
              )}
            </Stack>
          </Box>

          <Stack direction="row" spacing={1}>
            <Button variant="contained" color={projectedGap > 0 ? "warning" : "success"}
              onClick={() => void applyChanges()}
              disabled={Object.keys(cadenceChanges).length === 0 && skipSet.size === 0}>
              Apply {Object.keys(cadenceChanges).length + skipSet.size} changes
            </Button>
            <Button variant="outlined" onClick={() => setStep("cadence")}>Back</Button>
          </Stack>
        </Stack>
      </CardContent></Card>
    );
  }

  // ── Step 4: Redistribute ──────────────────────────────────────

  if (step === "redistribute") {
    // Show per-helper projected loads and offer to auto-redistribute
    const perHelper = helpers.map((h) => {
      const load = chores
        .filter((c) => c.helperId === h.id && !skipSet.has(c.id))
        .reduce((s, c) => {
          const cad = cadenceChanges[c.id] ?? c.cadence;
          return s + c.estimatedMinutes * cadenceLoadFactor(cad);
        }, 0);
      return { ...h, load: Math.round(load), pct: h.capacityMinutes > 0 ? Math.round((load / h.capacityMinutes) * 100) : 0 };
    });

    const imbalanced = perHelper.some((h) => h.pct > 100) || perHelper.some((h) => h.load === 0 && chores.some((c) => c.helperId !== null));

    return (
      <Card variant="outlined"><CardContent>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" fontWeight={600}>Redistribute Workload</Typography>
            <Typography variant="body2" color="text.secondary">
              {imbalanced
                ? "Some helpers are still over capacity or idle. Auto-redistribute to balance the load."
                : "Workload looks balanced. You can still auto-redistribute for optimal fit."}
            </Typography>
          </Box>

          {perHelper.map((h) => (
            <Box key={h.id}>
              <Stack direction="row" justifyContent="space-between" mb={0.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" fontWeight={600}>{h.name}</Typography>
                  <Chip size="small" label={h.type} variant="outlined" sx={{ fontSize: 10 }} />
                </Stack>
                <Typography variant="caption" color={h.pct > 100 ? "error.main" : h.load === 0 ? "warning.main" : "text.secondary"}>
                  {h.load}/{h.capacityMinutes} min · {h.pct}%
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate" value={Math.min(100, h.pct)}
                color={h.pct > 100 ? "error" : h.pct < 40 ? "warning" : "primary"}
                sx={{ height: 6, borderRadius: 1 }}
              />
            </Box>
          ))}

          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => void applyRedistribution()}>
              Auto-redistribute
            </Button>
            <Button variant="outlined" onClick={() => setStep("cadence")}>Back to frequency</Button>
            {onDone && <Button variant="text" onClick={onDone} sx={{ color: "text.secondary" }}>Skip</Button>}
          </Stack>
        </Stack>
      </CardContent></Card>
    );
  }

  return null;
}
