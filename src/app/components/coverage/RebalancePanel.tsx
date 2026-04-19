/**
 * Rebalance Panel — computes an optimal redistribution of chores across
 * all helpers, shows a before/after preview, and applies on approval.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { ArrowForward, CheckCircle } from "@mui/icons-material";
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

interface RebalancePanelProps {
  onDone?: () => void;
}

interface HelperSummary {
  id: string;
  name: string;
  type: string;
  capacityMinutes: number;
  beforeLoad: number;
  beforeCount: number;
  afterLoad: number;
  afterCount: number;
}

interface Reassignment {
  choreId: string;
  choreTitle: string;
  space: string;
  fromId: string | null;
  fromName: string;
  toId: string | null;
  toName: string;
}

function cadenceLoadFactor(cadence: string): number {
  if (cadence === "daily" || cadence === "alternate_days") return 1.0;
  if (cadence.startsWith("weekly")) return 1.0 / 6;
  if (cadence.startsWith("biweekly")) return 1.0 / 12;
  if (cadence.startsWith("monthly")) return 1.0 / 26;
  if (/every_\d_days/.test(cadence)) {
    const n = parseInt(cadence.split("_")[1], 10) || 3;
    return 1.0 / n;
  }
  return 1.0 / 6;
}

export function RebalancePanel({ onDone }: RebalancePanelProps) {
  const { householdId, accessToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<AssignmentPlan | null>(null);
  const [helperSummaries, setHelperSummaries] = useState<HelperSummary[]>([]);
  const [reassignments, setReassignments] = useState<Reassignment[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState(0);
  const [done, setDone] = useState(false);

  const compute = useCallback(async () => {
    if (!householdId) { setLoading(false); return; }
    setLoading(true);
    setError(null);

    const [helpersRes, choresRes, membersRes] = await Promise.all([
      supabase.from("helpers").select("id,name,type,daily_capacity_minutes,metadata").eq("household_id", householdId),
      supabase.from("chores").select("id,title,helper_id,assignee_person_id,metadata,priority,status")
        .eq("household_id", householdId).is("deleted_at", null).neq("status", "completed"),
      supabase.from("household_people").select("id,display_name,person_type").eq("household_id", householdId),
    ]);

    setLoading(false);
    if (helpersRes.error || choresRes.error) {
      setError(helpersRes.error?.message ?? choresRes.error?.message ?? "Load failed");
      return;
    }

    const rawHelpers = (helpersRes.data ?? []) as Array<Record<string, unknown>>;
    const rawChores = (choresRes.data ?? []) as Array<Record<string, unknown>>;
    const rawMembers = ((membersRes.data ?? []) as Array<Record<string, unknown>>)
      .filter((m) => String(m.person_type) === "adult");

    // Build helper name map for "before" display
    const helperNameMap = new Map<string, string>();
    const helpers: AssignableHelper[] = rawHelpers.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const schedule = (meta.schedule ?? {}) as Record<string, unknown>;
      const days = (schedule.days ?? {}) as Record<string, boolean>;
      const workDays = Object.entries(days).filter(([, v]) => v).map(([k]) => k);
      const startTime = typeof schedule.start === "string" ? schedule.start : "";
      const endTime = typeof schedule.end === "string" ? schedule.end : "";

      let capacityMinutes = Number(r.daily_capacity_minutes ?? 120);
      if (startTime && endTime) {
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        const scheduleMins = (eh * 60 + em) - (sh * 60 + sm);
        if (scheduleMins > 0) capacityMinutes = scheduleMins;
      }

      helperNameMap.set(String(r.id), String(r.name));
      return {
        id: String(r.id),
        name: String(r.name),
        type: String(r.type ?? "General"),
        dailyCapacityMinutes: capacityMinutes,
        roleTags: inferRoleTags(String(r.type ?? "")),
        kind: "helper" as const,
        workDays,
      };
    });

    // Add household members
    for (const m of rawMembers) {
      const memberId = `member_${m.id}`;
      helperNameMap.set(memberId, `${String(m.display_name)} (Self)`);
      helpers.push({
        id: memberId,
        name: `${String(m.display_name)} (Self)`,
        type: "Household member",
        dailyCapacityMinutes: 60,
        roleTags: ["general"],
        kind: "member",
        workDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      });
    }

    // Build chore list (include ALL chores — assigned and unassigned)
    const chores: AssignableChore[] = rawChores.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id),
        title: String(r.title ?? ""),
        space: typeof meta.space === "string" ? meta.space : "",
        cadence: typeof meta.cadence === "string" ? meta.cadence : "weekly",
        estimatedMinutes: typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : 15,
        currentHelperId: r.helper_id ? String(r.helper_id) : null,
      };
    });

    // Compute "before" loads
    const beforeLoad = new Map<string, { load: number; count: number }>();
    for (const h of helpers) beforeLoad.set(h.id, { load: 0, count: 0 });
    for (const c of chores) {
      if (!c.currentHelperId) continue;
      const entry = beforeLoad.get(c.currentHelperId);
      if (entry) {
        entry.load += c.estimatedMinutes * cadenceLoadFactor(c.cadence);
        entry.count += 1;
      }
    }

    // Run the assignment engine on ALL chores (ignoring current assignments)
    const result = buildAssignmentPlan(chores, helpers);
    setPlan(result);

    // Compute "after" loads and find reassignments
    const afterLoad = new Map<string, { load: number; count: number }>();
    for (const h of helpers) afterLoad.set(h.id, { load: 0, count: 0 });

    const changes: Reassignment[] = [];
    for (const a of result.assignments) {
      const newId = a.assigneePersonId ? `member_${a.assigneePersonId}` : a.helperId;
      if (newId) {
        const entry = afterLoad.get(newId);
        if (entry) {
          entry.load += a.estimatedMinutes * cadenceLoadFactor(a.cadence);
          entry.count += 1;
        }
      }

      const chore = chores.find((c) => c.id === a.choreId);
      const oldId = chore?.currentHelperId ?? null;
      if (oldId !== (a.helperId ?? null) || (a.assigneePersonId && oldId !== `member_${a.assigneePersonId}`)) {
        changes.push({
          choreId: a.choreId,
          choreTitle: a.choreTitle,
          space: a.space,
          fromId: oldId,
          fromName: oldId ? (helperNameMap.get(oldId) ?? "Unknown") : "Unassigned",
          toId: newId,
          toName: newId ? (helperNameMap.get(newId) ?? a.helperName ?? "Unknown") : "Unassigned",
        });
      }
    }

    // Build summaries
    const summaries: HelperSummary[] = helpers.map((h) => ({
      id: h.id,
      name: h.name,
      type: h.type ?? "General",
      capacityMinutes: h.dailyCapacityMinutes,
      beforeLoad: Math.round(beforeLoad.get(h.id)?.load ?? 0),
      beforeCount: beforeLoad.get(h.id)?.count ?? 0,
      afterLoad: Math.round(afterLoad.get(h.id)?.load ?? 0),
      afterCount: afterLoad.get(h.id)?.count ?? 0,
    }));

    setHelperSummaries(summaries);
    setReassignments(changes);
  }, [householdId]);

  useEffect(() => { void compute(); }, [compute]);

  const applyRebalance = async () => {
    if (!householdId || !accessToken || !plan) return;
    setApplying(true);
    setApplyProgress(0);
    setError(null);

    const toApply = reassignments.filter((r) => r.toId);
    for (let i = 0; i < toApply.length; i++) {
      const r = toApply[i];
      const isPerson = r.toId?.startsWith("member_") ?? false;
      const realId = isPerson ? r.toId!.replace("member_", "") : r.toId;

      const patch: Record<string, unknown> = {};
      if (isPerson) {
        patch.assignee_person_id = realId;
        patch.helper_id = null;
      } else {
        patch.helper_id = realId;
        patch.assignee_person_id = null;
      }

      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `rebalance_${r.choreId}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: r.choreId, patch },
          reason: `Rebalance: move "${r.choreTitle}" from ${r.fromName} to ${r.toName}`,
        },
      });

      if (!res.ok) {
        setError(`Failed on "${r.choreTitle}": ${"error" in res ? res.error : "unknown"}`);
        setApplying(false);
        return;
      }
      setApplyProgress(i + 1);
    }

    setApplying(false);
    setDone(true);
  };

  if (loading) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Box display="flex" justifyContent="center" py={3}><CircularProgress size={24} /></Box>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2} alignItems="center" py={2}>
            <CheckCircle color="success" sx={{ fontSize: 48 }} />
            <Typography variant="h6" fontWeight={600}>
              Rebalance complete — {reassignments.length} chore{reassignments.length === 1 ? "" : "s"} reassigned
            </Typography>
            <Button variant="contained" onClick={onDone}>Done</Button>
          </Stack>
        </CardContent>
      </Card>
    );
  }

  if (applying) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2} alignItems="center" py={2}>
            <CircularProgress size={28} />
            <Typography variant="body2">
              Applying... {applyProgress}/{reassignments.filter((r) => r.toId).length}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={reassignments.length > 0 ? (applyProgress / reassignments.filter((r) => r.toId).length) * 100 : 0}
              sx={{ width: "100%", height: 5, borderRadius: 1 }}
            />
          </Stack>
        </CardContent>
      </Card>
    );
  }

  const hasOverloaded = helperSummaries.some((h) => h.beforeLoad > h.capacityMinutes);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" fontWeight={600}>Rebalance Preview</Typography>
            <Typography variant="body2" color="text.secondary">
              {reassignments.length} chore{reassignments.length === 1 ? "" : "s"} would be reassigned.
              Review the changes below and approve to apply.
            </Typography>
          </Box>

          {error && <Alert severity="error">{error}</Alert>}

          {/* Before / After comparison per helper */}
          <Box>
            <Typography variant="subtitle2" fontWeight={600} mb={1}>Helper load comparison</Typography>
            <Stack spacing={1.5}>
              {helperSummaries.map((h) => {
                const beforePct = h.capacityMinutes > 0 ? Math.round((h.beforeLoad / h.capacityMinutes) * 100) : 0;
                const afterPct = h.capacityMinutes > 0 ? Math.round((h.afterLoad / h.capacityMinutes) * 100) : 0;
                const improved = afterPct < beforePct;
                const worsened = afterPct > beforePct && afterPct > 100;
                return (
                  <Box key={h.id} sx={{ p: 1.5, borderRadius: 1, border: "1px solid", borderColor: "divider" }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={0.5}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="body2" fontWeight={600}>{h.name}</Typography>
                        <Chip size="small" label={h.type} variant="outlined" sx={{ fontSize: 10 }} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {h.capacityMinutes} min capacity
                      </Typography>
                    </Stack>

                    {/* Before bar */}
                    <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
                      <Typography variant="caption" sx={{ minWidth: 45 }} color="text.secondary">Before</Typography>
                      <LinearProgress
                        variant="determinate"
                        value={Math.min(100, beforePct)}
                        color={beforePct > 100 ? "error" : beforePct < 40 ? "warning" : "primary"}
                        sx={{ flex: 1, height: 6, borderRadius: 1 }}
                      />
                      <Typography variant="caption" sx={{ minWidth: 85, textAlign: "right" }}
                        color={beforePct > 100 ? "error.main" : "text.secondary"}>
                        {h.beforeLoad} min · {beforePct}%
                      </Typography>
                    </Stack>

                    {/* After bar */}
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption" sx={{ minWidth: 45 }} color="text.secondary">After</Typography>
                      <LinearProgress
                        variant="determinate"
                        value={Math.min(100, afterPct)}
                        color={afterPct > 100 ? "error" : afterPct < 40 ? "warning" : "success"}
                        sx={{ flex: 1, height: 6, borderRadius: 1 }}
                      />
                      <Typography variant="caption" sx={{ minWidth: 85, textAlign: "right" }}
                        color={improved ? "success.main" : worsened ? "error.main" : "text.secondary"}>
                        {h.afterLoad} min · {afterPct}%
                        {improved ? " ↓" : ""}
                      </Typography>
                    </Stack>

                    <Typography variant="caption" color="text.secondary" mt={0.5} display="block">
                      {h.beforeCount} → {h.afterCount} chores
                    </Typography>
                  </Box>
                );
              })}
            </Stack>
          </Box>

          {/* Reassignment list */}
          {reassignments.length > 0 && (
            <Box>
              <Typography variant="subtitle2" fontWeight={600} mb={1}>
                Reassignments ({reassignments.length})
              </Typography>
              <Box sx={{ maxHeight: 300, overflowY: "auto" }}>
                <Stack spacing={0.5}>
                  {reassignments.map((r) => (
                    <Stack
                      key={r.choreId}
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      sx={{ py: 0.5, px: 1, borderRadius: 1, bgcolor: "action.hover" }}
                    >
                      <Box flex={1} minWidth={0}>
                        <Typography variant="body2" noWrap fontWeight={500} sx={{ fontSize: 13 }}>
                          {r.choreTitle}
                        </Typography>
                        {r.space && (
                          <Typography variant="caption" color="text.secondary">{r.space}</Typography>
                        )}
                      </Box>
                      <Chip size="small" label={r.fromName} color="default" variant="outlined" sx={{ fontSize: 11 }} />
                      <ArrowForward sx={{ fontSize: 14, color: "text.secondary" }} />
                      <Chip size="small" label={r.toName} color="primary" variant="outlined" sx={{ fontSize: 11 }} />
                    </Stack>
                  ))}
                </Stack>
              </Box>
            </Box>
          )}

          {reassignments.length === 0 && (
            <Alert severity="success">
              Schedule is already balanced — no reassignments needed.
            </Alert>
          )}

          {/* Actions */}
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              color={hasOverloaded ? "warning" : "primary"}
              disabled={reassignments.length === 0}
              onClick={() => void applyRebalance()}
            >
              Apply {reassignments.length} reassignment{reassignments.length === 1 ? "" : "s"}
            </Button>
            {onDone && (
              <Button variant="outlined" onClick={onDone}>Cancel</Button>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
