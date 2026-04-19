/**
 * Helper Capacity Utilization card — shows how much of each helper's
 * daily capacity is used by assigned chores, with alerts for
 * over-capacity and under-utilization.
 */

import { useEffect, useState, useCallback } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { Balance } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { WorkloadOptimizer } from "./WorkloadOptimizer";

interface HelperCapacity {
  id: string;
  name: string;
  type: string;
  capacityMinutes: number;
  workDays: string[];
  startTime: string;
  endTime: string;
  assignedChores: number;
  dailyLoadMinutes: number;
  unassignedHighPriority: number;
  utilizationPct: number;
  status: "healthy" | "over" | "under" | "idle" | "on_leave";
  /** Upcoming leave periods */
  upcomingLeave: Array<{ startAt: string; endAt: string; reason: string | null }>;
  /** Number of assigned chores affected by upcoming leave */
  choresDuringLeave: number;
}

interface CapacitySummary {
  helpers: HelperCapacity[];
  totalUnassigned: number;
  totalUnassignedHighPriority: number;
  alerts: string[];
}

/** Compute effective daily load from a cadence */
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

export function HelperCapacityCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const { householdId } = useAuth();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<CapacitySummary | null>(null);
  const [showRebalance, setShowRebalance] = useState(false);
  const [optimizerHelperFilter, setOptimizerHelperFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!householdId) { setLoading(false); return; }
    setLoading(true);

    const nowIso = new Date().toISOString();
    const futureIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // next 30 days

    const [helpersRes, choresRes, leaveRes] = await Promise.all([
      supabase.from("helpers").select("id,name,type,daily_capacity_minutes,metadata").eq("household_id", householdId),
      supabase.from("chores").select("id,helper_id,priority,metadata").eq("household_id", householdId).is("deleted_at", null).neq("status", "completed"),
      supabase.from("member_time_off").select("helper_id,start_at,end_at,reason")
        .eq("household_id", householdId)
        .eq("member_kind", "helper")
        .gte("end_at", nowIso)
        .lte("start_at", futureIso),
    ]);

    setLoading(false);
    if (helpersRes.error || choresRes.error) return;

    const chores = (choresRes.data ?? []) as Array<Record<string, unknown>>;
    const leaveData = (leaveRes.data ?? []) as Array<Record<string, unknown>>;
    const alerts: string[] = [];

    // Compute per-helper capacity
    const helperCapacities: HelperCapacity[] = ((helpersRes.data ?? []) as Array<Record<string, unknown>>).map((r) => {
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

      const helperId = String(r.id);
      const assigned = chores.filter((c) => String(c.helper_id) === helperId);
      const dailyLoad = assigned.reduce((sum, c) => {
        const cmeta = (c.metadata ?? {}) as Record<string, unknown>;
        const cadence = typeof cmeta.cadence === "string" ? cmeta.cadence : "weekly";
        const mins = typeof cmeta.estimated_minutes === "number" ? cmeta.estimated_minutes : 15;
        return sum + mins * cadenceLoadFactor(cadence);
      }, 0);

      const utilizationPct = capacityMinutes > 0 ? Math.round((dailyLoad / capacityMinutes) * 100) : 0;

      // Check for upcoming leave
      const upcomingLeave = leaveData
        .filter((l) => String(l.helper_id) === helperId)
        .map((l) => ({
          startAt: String(l.start_at),
          endAt: String(l.end_at),
          reason: l.reason ? String(l.reason) : null,
        }));

      // Is currently on leave?
      const now = new Date();
      const isCurrentlyOnLeave = upcomingLeave.some((l) => {
        const start = new Date(l.startAt);
        const end = new Date(l.endAt);
        return now >= start && now < end;
      });

      let status: HelperCapacity["status"] = "healthy";
      if (isCurrentlyOnLeave) status = "on_leave";
      else if (assigned.length === 0) status = "idle";
      else if (utilizationPct > 100) status = "over";
      else if (utilizationPct < 40) status = "under";

      return {
        id: helperId,
        name: String(r.name),
        type: String(r.type ?? "General"),
        capacityMinutes,
        workDays,
        startTime,
        endTime,
        assignedChores: assigned.length,
        dailyLoadMinutes: Math.round(dailyLoad),
        unassignedHighPriority: 0,
        utilizationPct,
        status,
        upcomingLeave,
        choresDuringLeave: isCurrentlyOnLeave ? assigned.length : 0,
      };
    });

    // Count unassigned chores
    const unassigned = chores.filter((c) => !c.helper_id);
    const unassignedHigh = unassigned.filter((c) => Number(c.priority) >= 3).length;

    // Generate alerts
    for (const h of helperCapacities) {
      if (h.status === "on_leave") {
        alerts.push(`🔴 ${h.name} (${h.type}) is currently on leave — ${h.assignedChores} chore${h.assignedChores === 1 ? "" : "s"} need temporary coverage.`);
      } else if (h.status === "over") {
        alerts.push(`${h.name} (${h.type}) is over capacity at ${h.utilizationPct}% — ${h.dailyLoadMinutes} min assigned vs ${h.capacityMinutes} min available.`);
      } else if (h.status === "idle") {
        alerts.push(`${h.name} (${h.type}) has no chores assigned — consider assigning tasks or adjusting their schedule.`);
      } else if (h.status === "under" && h.assignedChores > 0) {
        alerts.push(`${h.name} (${h.type}) is at ${h.utilizationPct}% utilization — has spare capacity of ${h.capacityMinutes - h.dailyLoadMinutes} min/day.`);
      }

      // Upcoming leave warning
      for (const leave of h.upcomingLeave) {
        const start = new Date(leave.startAt);
        const end = new Date(leave.endAt);
        const now = new Date();
        if (start > now) {
          const daysUntil = Math.ceil((start.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
          const leaveDays = Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
          if (daysUntil <= 7 && h.assignedChores > 0) {
            alerts.push(
              `⚠️ ${h.name} goes on leave in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${leaveDays} day${leaveDays === 1 ? "" : "s"})` +
              ` — ${h.assignedChores} chore${h.assignedChores === 1 ? "" : "s"} will need coverage.` +
              (leave.reason ? ` Reason: ${leave.reason}` : ""),
            );
          }
        }
      }
    }
    if (unassigned.length > 5) {
      alerts.push(`${unassigned.length} chores are unassigned (${unassignedHigh} high-priority). Assign them from the Chores page.`);
    }

    setSummary({
      helpers: helperCapacities,
      totalUnassigned: unassigned.length,
      totalUnassignedHighPriority: unassignedHigh,
      alerts,
    });
  }, [householdId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  if (loading) {
    return <Card variant="outlined"><CardContent><Box display="flex" justifyContent="center" py={2}><CircularProgress size={20} /></Box></CardContent></Card>;
  }

  if (!summary || summary.helpers.length === 0) return null;

  if (showRebalance) {
    return (
      <WorkloadOptimizer
        initialHelperFilter={optimizerHelperFilter}
        onDone={() => {
          setShowRebalance(false);
          setOptimizerHelperFilter(null);
          void load();
        }}
      />
    );
  }

  const hasOverloaded = summary.helpers.some((h) => h.status === "over");

  const statusColor = (s: HelperCapacity["status"]) => {
    switch (s) {
      case "over": return "error";
      case "on_leave": return "error";
      case "under": return "warning";
      case "idle": return "default";
      default: return "success";
    }
  };

  const statusLabel = (s: HelperCapacity["status"]) => {
    switch (s) {
      case "over": return "Over capacity";
      case "on_leave": return "On leave";
      case "under": return "Under-utilized";
      case "idle": return "No tasks";
      default: return "Healthy";
    }
  };

  return (
    <Card variant="outlined">
      <CardHeader
        title={<Typography variant="h6" fontWeight={600}>Helper Capacity</Typography>}
        subheader="Daily workload vs available hours per helper"
        action={
          <Button
            variant="contained"
            color={hasOverloaded ? "warning" : "primary"}
            startIcon={<Balance />}
            onClick={() => setShowRebalance(true)}
            size="small"
          >
            {hasOverloaded ? "Optimize workload" : "Optimize & redistribute"}
          </Button>
        }
      />
      <CardContent>
        <Stack spacing={2}>
          {/* Alerts */}
          {summary.alerts.map((alert, i) => (
            <Alert key={i} severity={alert.includes("over capacity") ? "error" : alert.includes("unassigned") ? "warning" : "info"} sx={{ py: 0.5 }}>
              <Typography variant="body2">{alert}</Typography>
            </Alert>
          ))}

          {/* Per-helper bars — click to optimize that helper */}
          {summary.helpers.map((h) => (
            <Box
              key={h.id}
              onClick={() => { setOptimizerHelperFilter(h.id); setShowRebalance(true); }}
              sx={{ cursor: "pointer", p: 1, mx: -1, borderRadius: 1, "&:hover": { bgcolor: "action.hover" } }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={0.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" fontWeight={600}>{h.name}</Typography>
                  <Chip size="small" label={h.type} variant="outlined" sx={{ fontSize: 10 }} />
                  <Chip size="small" label={statusLabel(h.status)} color={statusColor(h.status)} sx={{ fontSize: 10 }} />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {h.dailyLoadMinutes}/{h.capacityMinutes} min · {h.assignedChores} chores · {h.utilizationPct}%
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={Math.min(100, h.utilizationPct)}
                color={h.status === "over" ? "error" : h.status === "under" ? "warning" : "primary"}
                sx={{ height: 6, borderRadius: 1 }}
              />
              {h.workDays.length > 0 && (
                <Typography variant="caption" color="text.secondary" mt={0.25} display="block">
                  {h.workDays.map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(", ")}
                  {h.startTime && h.endTime ? ` · ${h.startTime}–${h.endTime}` : ""}
                </Typography>
              )}
              {h.upcomingLeave.length > 0 && h.upcomingLeave.map((leave, i) => {
                const start = new Date(leave.startAt);
                const end = new Date(leave.endAt);
                const now = new Date();
                const isCurrent = now >= start && now < end;
                return (
                  <Typography key={i} variant="caption" color={isCurrent ? "error.main" : "warning.main"} display="block" mt={0.25}>
                    {isCurrent ? "On leave" : "Upcoming leave"}: {start.toLocaleDateString()} — {end.toLocaleDateString()}
                    {leave.reason ? ` (${leave.reason})` : ""}
                  </Typography>
                );
              })}
            </Box>
          ))}

          {/* Unassigned summary */}
          {summary.totalUnassigned > 0 && (
            <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: "warning.50", border: "1px solid", borderColor: "warning.200" }}>
              <Typography variant="body2" fontWeight={600}>
                {summary.totalUnassigned} unassigned chore{summary.totalUnassigned === 1 ? "" : "s"}
                {summary.totalUnassignedHighPriority > 0 && (
                  <Chip size="small" label={`${summary.totalUnassignedHighPriority} high priority`} color="error" sx={{ ml: 1, fontSize: 10 }} />
                )}
              </Typography>
            </Box>
          )}

          {/* Rebalance button */}
        </Stack>
      </CardContent>
    </Card>
  );
}
