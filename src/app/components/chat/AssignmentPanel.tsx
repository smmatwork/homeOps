/**
 * Assignment panel — reads helpers + unassigned chores from DB,
 * lets user review/edit helper roles and schedules, then shows
 * a one-click assignment preview based on the auto-assignment engine.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Assignment, CheckCircle } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import {
  buildAssignmentPlan,
  inferRoleTags,
  type AssignableChore,
  type AssignableHelper,
  type AssignmentPlan,
} from "../../services/choreAssigner";

interface AssignmentPanelProps {
  onDismiss: () => void;
  onComplete: (count: number) => void;
}

const HELPER_ROLES = ["Maid", "Cook", "Driver", "Gardener", "Nanny", "Watchman", "Cleaner", "Washer"];

type Step = "review_helpers" | "preview_assignments" | "applying" | "done";

export function AssignmentPanel({ onDismiss, onComplete }: AssignmentPanelProps) {
  const { householdId, accessToken } = useAuth();
  const { t } = useI18n();
  const [step, setStep] = useState<Step>("review_helpers");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Helper data (editable)
  const [helpers, setHelpers] = useState<Array<{
    id: string;
    name: string;
    type: string;
    dailyCapacityMinutes: number;
    hasSchedule: boolean;
    scheduleSummary: string;
  }>>([]);

  // Chores data
  const [chores, setChores] = useState<AssignableChore[]>([]);

  // Assignment plan
  const [plan, setPlan] = useState<AssignmentPlan | null>(null);

  // Applying state
  const [applyProgress, setApplyProgress] = useState(0);
  const [applyTotal, setApplyTotal] = useState(0);

  // Load helpers and chores from DB
  const loadData = useCallback(async () => {
    if (!householdId) { setLoading(false); return; }
    setLoading(true);
    setError(null);

    const [helpersRes, choresRes] = await Promise.all([
      supabase.from("helpers").select("id,name,type,daily_capacity_minutes,metadata").eq("household_id", householdId),
      supabase.from("chores").select("id,title,metadata,helper_id,status")
        .eq("household_id", householdId)
        .is("helper_id", null)
        .is("deleted_at", null)
        .neq("status", "completed"),
    ]);

    setLoading(false);

    if (helpersRes.error) { setError(helpersRes.error.message); return; }
    if (choresRes.error) { setError(choresRes.error.message); return; }

    const h = (helpersRes.data ?? []).map((r: Record<string, unknown>) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const schedule = meta.schedule as Record<string, unknown> | undefined;
      const days = schedule?.days as Record<string, boolean> | undefined;
      const hasSched = days ? Object.values(days).some(Boolean) : false;
      const start = typeof schedule?.start === "string" ? schedule.start : "";
      const end = typeof schedule?.end === "string" ? schedule.end : "";
      const dayNames = days ? Object.entries(days).filter(([, v]) => v).map(([k]) => k.slice(0, 3)).join(", ") : "";

      return {
        id: String(r.id),
        name: String(r.name),
        type: String(r.type ?? ""),
        dailyCapacityMinutes: Number(r.daily_capacity_minutes ?? 120),
        hasSchedule: hasSched,
        scheduleSummary: hasSched ? `${dayNames} ${start}-${end}` : "",
      };
    });

    const c: AssignableChore[] = (choresRes.data ?? []).map((r: Record<string, unknown>) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id),
        title: String(r.title ?? ""),
        space: typeof meta.space === "string" ? meta.space : "",
        cadence: typeof meta.cadence === "string" ? meta.cadence : "weekly",
        estimatedMinutes: typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : 0,
        currentHelperId: null,
      };
    });

    setHelpers(h);
    setChores(c);
  }, [householdId]);

  useEffect(() => { void loadData(); }, [loadData]);

  const updateHelperType = (id: string, type: string) => {
    setHelpers((prev) => prev.map((h) => h.id === id ? { ...h, type } : h));
  };

  const updateHelperCapacity = (id: string, minutes: number) => {
    setHelpers((prev) => prev.map((h) => h.id === id ? { ...h, dailyCapacityMinutes: minutes } : h));
  };

  const generatePlan = () => {
    const assignableHelpers: AssignableHelper[] = helpers.map((h) => ({
      id: h.id,
      name: h.name,
      type: h.type || null,
      dailyCapacityMinutes: h.dailyCapacityMinutes,
      roleTags: inferRoleTags(h.type || null),
    }));
    const result = buildAssignmentPlan(chores, assignableHelpers);
    setPlan(result);
    setStep("preview_assignments");
  };

  const applyAssignments = async () => {
    if (!plan || !householdId || !accessToken) return;
    const assigned = plan.assignments.filter((a) => a.helperId);
    setStep("applying");
    setApplyTotal(assigned.length);
    setApplyProgress(0);
    setError(null);

    for (let i = 0; i < assigned.length; i++) {
      const a = assigned[i];
      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `assign_${a.choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: a.choreId, patch: { helper_id: a.helperId } },
          reason: `Assign "${a.choreTitle}" to ${a.helperName}`,
        },
      });
      if (!res.ok) {
        setError(`Failed to assign "${a.choreTitle}": ${"error" in res ? res.error : "unknown"}`);
        setStep("preview_assignments");
        return;
      }
      setApplyProgress(i + 1);
    }

    setStep("done");
    onComplete(assigned.length);
  };

  if (loading) {
    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 560, mx: "auto" }}>
        <Box display="flex" justifyContent="center" py={3}><CircularProgress size={24} /></Box>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 560, mx: "auto" }}>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {/* Step 1: Review helper roles and capacity */}
      {step === "review_helpers" && (
        <Stack spacing={2}>
          <Typography variant="subtitle1" fontWeight={700}>
            Review helper roles
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Confirm each helper's role and daily capacity. This determines which chores get assigned to whom.
          </Typography>

          {helpers.map((h) => (
            <Card key={h.id} variant="outlined">
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack spacing={1}>
                  <Typography variant="subtitle2" fontWeight={700}>{h.name}</Typography>
                  <Stack direction="row" spacing={1.5}>
                    <Autocomplete
                      freeSolo
                      options={HELPER_ROLES}
                      value={h.type}
                      onInputChange={(_, v) => updateHelperType(h.id, v)}
                      sx={{ flex: 1 }}
                      renderInput={(params) => <TextField {...params} size="small" label="Role" />}
                    />
                    <TextField
                      size="small"
                      type="number"
                      label="Daily capacity (min)"
                      value={h.dailyCapacityMinutes}
                      onChange={(e) => updateHelperCapacity(h.id, Number(e.target.value) || 120)}
                      sx={{ width: 160 }}
                      inputProps={{ min: 30, max: 600 }}
                    />
                  </Stack>
                  {h.hasSchedule ? (
                    <Typography variant="caption" color="success.main">Schedule: {h.scheduleSummary}</Typography>
                  ) : (
                    <Typography variant="caption" color="warning.main">No schedule set — you can configure this later in Helpers</Typography>
                  )}
                </Stack>
              </CardContent>
            </Card>
          ))}

          <Typography variant="body2" color="text.secondary">
            {chores.length} unassigned chore{chores.length === 1 ? "" : "s"} to distribute
          </Typography>

          <Stack direction="row" spacing={1}>
            <Button variant="contained" size="small" onClick={generatePlan} disabled={helpers.length === 0}>
              Generate assignments
            </Button>
            <Button variant="text" size="small" onClick={onDismiss} sx={{ color: "text.secondary" }}>
              Not now
            </Button>
          </Stack>
        </Stack>
      )}

      {/* Step 2: Preview assignments */}
      {step === "preview_assignments" && plan && (
        <Stack spacing={2}>
          <Typography variant="subtitle1" fontWeight={700}>
            Assignment preview
          </Typography>

          {plan.byHelper.map(({ helper, chores: hChores, totalMinutes, capacityUsedPct }) => (
            <Card key={helper.id} variant="outlined">
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="subtitle2" fontWeight={700}>
                      {helper.name} ({helper.type || "General"})
                    </Typography>
                    <Chip
                      size="small"
                      label={`${capacityUsedPct}% capacity`}
                      color={capacityUsedPct > 100 ? "error" : capacityUsedPct > 80 ? "warning" : "success"}
                    />
                  </Stack>
                  <LinearProgress
                    variant="determinate"
                    value={Math.min(100, capacityUsedPct)}
                    color={capacityUsedPct > 100 ? "error" : capacityUsedPct > 80 ? "warning" : "primary"}
                    sx={{ height: 4, borderRadius: 1 }}
                  />
                  <Stack spacing={0.25}>
                    {hChores.map((c) => (
                      <Stack key={c.choreId} direction="row" spacing={1} alignItems="center">
                        <Typography variant="caption" sx={{ flex: 1 }}>{c.choreTitle}</Typography>
                        <Chip size="small" label={c.cadence} variant="outlined" sx={{ fontSize: 10 }} />
                        <Typography variant="caption" color="text.secondary">~{c.estimatedMinutes}m</Typography>
                      </Stack>
                    ))}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {totalMinutes} min total · {hChores.length} chore{hChores.length === 1 ? "" : "s"}
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          ))}

          {plan.unassigned.length > 0 && (
            <Card variant="outlined" sx={{ borderColor: "warning.main" }}>
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Typography variant="subtitle2" fontWeight={700} color="warning.main">
                  Unassigned ({plan.unassigned.length})
                </Typography>
                <Stack spacing={0.25} mt={0.5}>
                  {plan.unassigned.map((c) => (
                    <Typography key={c.choreId} variant="caption" color="text.secondary">
                      {c.choreTitle} — {c.reason}
                    </Typography>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          )}

          <Stack direction="row" spacing={1}>
            <Button variant="contained" size="small" startIcon={<Assignment />} onClick={() => void applyAssignments()}>
              Apply assignments ({plan.assignments.filter((a) => a.helperId).length})
            </Button>
            <Button variant="outlined" size="small" onClick={() => setStep("review_helpers")}>
              Back to edit
            </Button>
            <Button variant="text" size="small" onClick={onDismiss} sx={{ color: "text.secondary" }}>
              Not now
            </Button>
          </Stack>
        </Stack>
      )}

      {/* Step 3: Applying */}
      {step === "applying" && (
        <Stack spacing={2} alignItems="center" py={2}>
          <CircularProgress size={32} />
          <Typography variant="body2">
            Assigning chores... {applyProgress}/{applyTotal}
          </Typography>
          <LinearProgress variant="determinate" value={applyTotal > 0 ? (applyProgress / applyTotal) * 100 : 0} sx={{ width: "100%", height: 6, borderRadius: 1 }} />
        </Stack>
      )}

      {/* Step 4: Done */}
      {step === "done" && (
        <Stack spacing={2} alignItems="center" py={2}>
          <CheckCircle color="success" sx={{ fontSize: 40 }} />
          <Typography variant="subtitle1" fontWeight={700}>
            Assignments complete!
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {applyProgress} chore{applyProgress === 1 ? "" : "s"} assigned to helpers.
          </Typography>
          <Button variant="contained" size="small" onClick={onDismiss}>
            Done
          </Button>
        </Stack>
      )}
    </Paper>
  );
}
