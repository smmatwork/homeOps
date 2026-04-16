/**
 * Assignment panel — reads helpers + unassigned chores from DB,
 * auto-generates assignments, and shows an editable preview
 * where the user can reassign chores between helpers.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Alert,
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
import { CheckCircle } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
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

interface HelperInfo {
  id: string;
  name: string;
  type: string;
}

export function AssignmentPanel({ onDismiss, onComplete }: AssignmentPanelProps) {
  const { householdId, accessToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [helpers, setHelpers] = useState<HelperInfo[]>([]);
  const [plan, setPlan] = useState<AssignmentPlan | null>(null);

  // Editable assignment map: choreId → helperId
  const [assignments, setAssignments] = useState<Record<string, string | null>>({});

  const [applying, setApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState(0);
  const [applyTotal, setApplyTotal] = useState(0);
  const [done, setDone] = useState(false);

  const loadAndPlan = useCallback(async () => {
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

    if (helpersRes.error || choresRes.error) {
      setError(helpersRes.error?.message ?? choresRes.error?.message ?? "Failed to load data");
      setLoading(false);
      return;
    }

    const helperList: HelperInfo[] = (helpersRes.data ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id),
      name: String(r.name),
      type: String(r.type ?? "General"),
    }));

    const assignableHelpers: AssignableHelper[] = (helpersRes.data ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id),
      name: String(r.name),
      type: String(r.type ?? "") || null,
      dailyCapacityMinutes: Number(r.daily_capacity_minutes ?? 120),
      roleTags: inferRoleTags(String(r.type ?? "") || null),
    }));

    const choreList: AssignableChore[] = (choresRes.data ?? []).map((r: Record<string, unknown>) => {
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

    const result = buildAssignmentPlan(choreList, assignableHelpers);

    // Build editable assignment map from the plan
    const map: Record<string, string | null> = {};
    for (const a of result.assignments) {
      map[a.choreId] = a.helperId;
    }

    setHelpers(helperList);
    setPlan(result);
    setAssignments(map);
    setLoading(false);
  }, [householdId]);

  useEffect(() => { void loadAndPlan(); }, [loadAndPlan]);

  const reassignChore = (choreId: string, helperId: string | null) => {
    setAssignments((prev) => ({ ...prev, [choreId]: helperId || null }));
  };

  // Compute stats from current (possibly edited) assignments
  const statsByHelper = (helpers: HelperInfo[], plan: AssignmentPlan) => {
    const counts: Record<string, number> = {};
    for (const [, hid] of Object.entries(assignments)) {
      if (hid) counts[hid] = (counts[hid] ?? 0) + 1;
    }
    const unassignedCount = Object.values(assignments).filter((v) => !v).length;
    return { counts, unassignedCount };
  };

  const applyAssignments = async () => {
    if (!householdId || !accessToken) return;
    const toAssign = Object.entries(assignments).filter(([, hid]) => hid);
    setApplying(true);
    setApplyTotal(toAssign.length);
    setApplyProgress(0);
    setError(null);

    for (let i = 0; i < toAssign.length; i++) {
      const [choreId, helperId] = toAssign[i];
      const chore = plan?.assignments.find((a) => a.choreId === choreId);
      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `assign_${choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: choreId, patch: { helper_id: helperId } },
          reason: `Assign "${chore?.choreTitle ?? choreId}" to helper`,
        },
      });
      if (!res.ok) {
        setError(`Failed: ${"error" in res ? res.error : "unknown"}`);
        setApplying(false);
        return;
      }
      setApplyProgress(i + 1);
    }

    setApplying(false);
    setDone(true);
    onComplete(toAssign.length);
  };

  if (loading) {
    return (
      <Paper variant="outlined" sx={{ p: 3, borderRadius: 2, maxWidth: 580, mx: "auto" }}>
        <Box display="flex" justifyContent="center" py={2}><CircularProgress size={24} /></Box>
      </Paper>
    );
  }

  if (done) {
    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 580, mx: "auto", bgcolor: "success.50", borderColor: "success.200" }}>
        <Stack spacing={1} alignItems="center" py={1}>
          <CheckCircle color="success" sx={{ fontSize: 36 }} />
          <Typography variant="subtitle1" fontWeight={700}>{applyProgress} chore{applyProgress === 1 ? "" : "s"} assigned!</Typography>
          <Button size="small" variant="contained" onClick={onDismiss}>Done</Button>
        </Stack>
      </Paper>
    );
  }

  if (applying) {
    return (
      <Paper variant="outlined" sx={{ p: 3, borderRadius: 2, maxWidth: 580, mx: "auto" }}>
        <Stack spacing={2} alignItems="center">
          <CircularProgress size={28} />
          <Typography variant="body2">Assigning... {applyProgress}/{applyTotal}</Typography>
          <LinearProgress variant="determinate" value={applyTotal > 0 ? (applyProgress / applyTotal) * 100 : 0} sx={{ width: "100%", height: 5, borderRadius: 1 }} />
        </Stack>
      </Paper>
    );
  }

  if (!plan) return null;

  const stats = statsByHelper(helpers, plan);
  const assignedCount = Object.values(assignments).filter(Boolean).length;

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 580, mx: "auto" }}>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="subtitle1" fontWeight={700}>
            Assign chores to helpers
          </Typography>
          <Stack direction="row" spacing={0.5}>
            {helpers.map((h) => (
              <Chip key={h.id} size="small" label={`${h.name}: ${stats.counts[h.id] ?? 0}`} variant="outlined" />
            ))}
            {stats.unassignedCount > 0 && (
              <Chip size="small" label={`Unassigned: ${stats.unassignedCount}`} color="warning" variant="outlined" />
            )}
          </Stack>
        </Stack>

        {/* Chore list with per-chore helper dropdown */}
        <Box sx={{ maxHeight: 400, overflowY: "auto" }}>
          <Stack spacing={0.75}>
            {plan.assignments.map((a) => (
              <Stack
                key={a.choreId}
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ py: 0.5, px: 1, borderRadius: 1, bgcolor: assignments[a.choreId] ? "transparent" : "warning.50" }}
              >
                <Box flex={1} minWidth={0}>
                  <Typography variant="body2" noWrap fontWeight={500}>{a.choreTitle}</Typography>
                  <Stack direction="row" spacing={0.5}>
                    {a.space && <Chip size="small" label={a.space} variant="outlined" sx={{ fontSize: 10, height: 18 }} />}
                    <Chip size="small" label={a.cadence} variant="outlined" sx={{ fontSize: 10, height: 18 }} />
                  </Stack>
                </Box>
                <TextField
                  select
                  size="small"
                  value={assignments[a.choreId] ?? ""}
                  onChange={(e) => reassignChore(a.choreId, e.target.value || null)}
                  sx={{ minWidth: 130 }}
                  SelectProps={{ sx: { fontSize: 13 } }}
                >
                  <MenuItem value="" sx={{ fontSize: 13, color: "text.secondary" }}><em>Unassigned</em></MenuItem>
                  {helpers.map((h) => (
                    <MenuItem key={h.id} value={h.id} sx={{ fontSize: 13 }}>
                      {h.name} ({h.type})
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            ))}
          </Stack>
        </Box>

        {/* Actions */}
        <Stack direction="row" spacing={1}>
          <Button
            variant="contained"
            size="small"
            disabled={assignedCount === 0}
            onClick={() => void applyAssignments()}
          >
            Apply ({assignedCount})
          </Button>
          <Button variant="text" size="small" onClick={onDismiss} sx={{ color: "text.secondary" }}>
            Not now
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
