/**
 * Weekly Plan Card — generates the upcoming week's chore assignments
 * and allows single-tap "Approve all" confirmation.
 *
 * This is the primary lever for Phase 1 cognitive load reduction:
 * the owner approves once, the system runs the week.
 * Per O1 rule #5, approving N items in one tap = N load-reducing events.
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
  Collapse,
  Divider,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import {
  CalendarMonth,
  CheckCircle,
  ExpandMore,
  ExpandLess,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import {
  scheduleChores,
  type HelperInfo,
  type ExistingChore,
  type TimeOffPeriod,
  type ChoreMutation,
  type ChoreTemplate,
} from "../../services/choreScheduler";

interface WeeklyPlanCardProps {
  onApproved?: (count: number) => void;
}

/** Group mutations by day for display. */
function groupByDay(mutations: ChoreMutation[]): Map<string, ChoreMutation[]> {
  const map = new Map<string, ChoreMutation[]>();
  for (const m of mutations) {
    const day = m.dueAt.split("T")[0];
    const list = map.get(day) ?? [];
    list.push(m);
    map.set(day, list);
  }
  return map;
}

function formatDay(dateStr: string): string {
  const d = new Date(dateStr);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function WeeklyPlanCard({ onApproved }: WeeklyPlanCardProps) {
  const { householdId, accessToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [mutations, setMutations] = useState<ChoreMutation[]>([]);
  const [helperNames, setHelperNames] = useState<Map<string, string>>(new Map());
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  const generatePlan = useCallback(async () => {
    if (!householdId) { setLoading(false); return; }
    setLoading(true);
    setError(null);

    try {
      const [helpersRes, choresRes, templatesRes, timeOffRes] = await Promise.all([
        supabase.from("helpers").select("id,name,daily_capacity_minutes,metadata")
          .eq("household_id", householdId),
        supabase.from("chores").select("id,template_id,title,due_at,status,helper_id,metadata")
          .eq("household_id", householdId).is("deleted_at", null),
        supabase.from("chore_templates").select("*")
          .eq("household_id", householdId).eq("active", true),
        supabase.from("member_time_off").select("helper_id,start_at,end_at")
          .eq("household_id", householdId).eq("member_kind", "helper"),
      ]);

      const helpers: HelperInfo[] = (helpersRes.data ?? []).map((h: Record<string, unknown>) => ({
        id: String(h.id),
        name: String(h.name),
        capacityMinutes: Number(h.daily_capacity_minutes ?? 120),
        averageRating: null,
      }));

      const nameMap = new Map<string, string>();
      for (const h of helpers) nameMap.set(h.id, h.name);
      setHelperNames(nameMap);

      const existing: ExistingChore[] = (choresRes.data ?? []).map((c: Record<string, unknown>) => ({
        id: String(c.id),
        templateId: c.template_id ? String(c.template_id) : null,
        title: String(c.title ?? ""),
        dueAt: c.due_at ? String(c.due_at) : null,
        status: String(c.status ?? "pending"),
        helperId: c.helper_id ? String(c.helper_id) : null,
        metadata: (c.metadata ?? null) as Record<string, unknown> | null,
      }));

      const templates = (templatesRes.data ?? []).map((t: Record<string, unknown>) => ({
        id: String(t.id),
        title: String(t.title ?? ""),
        space: t.space ? String(t.space) : null,
        cadence: String(t.cadence ?? "weekly"),
        priority: Number(t.priority ?? 1),
        estimatedMinutes: t.estimated_minutes ? Number(t.estimated_minutes) : null,
        defaultHelperId: t.default_helper_id ? String(t.default_helper_id) : null,
        metadata: (t.metadata ?? {}) as Record<string, unknown>,
      })) as ChoreTemplate[];

      const timeOff: TimeOffPeriod[] = (timeOffRes.data ?? [])
        .filter((t: Record<string, unknown>) => t.helper_id)
        .map((t: Record<string, unknown>) => ({
          helperId: String(t.helper_id),
          startAt: String(t.start_at),
          endAt: String(t.end_at),
        }));

      if (templates.length === 0) {
        setMutations([]);
        setLoading(false);
        return;
      }

      const result = scheduleChores({
        templates,
        existingChores: existing,
        helpers,
        timeOff,
        horizon: 7,
      });

      setMutations(result.mutations);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }, [householdId]);

  useEffect(() => { void generatePlan(); }, [generatePlan]);

  const approveAll = async () => {
    if (!householdId || !accessToken) return;
    setApplying(true);
    setProgress(0);
    setError(null);

    try {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        const { error: insertError } = await supabase.from("chores").insert({
          household_id: householdId,
          title: m.title,
          status: m.status,
          priority: m.priority,
          due_at: m.dueAt,
          helper_id: m.helperId,
          assignee_person_id: m.assigneePersonId ?? null,
          template_id: m.templateId,
          metadata: m.metadata,
        });
        if (insertError) {
          setError(`Failed at chore ${i + 1}: ${insertError.message}`);
          setApplying(false);
          return;
        }
        setProgress(i + 1);
      }
      setDone(true);
      onApproved?.(mutations.length);
    } catch (e) {
      setError(String(e));
    }
    setApplying(false);
  };

  const toggleDay = (day: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day); else next.add(day);
      return next;
    });
  };

  if (loading) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Box display="flex" justifyContent="center" py={2}>
            <CircularProgress size={20} />
          </Box>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card variant="outlined" sx={{ borderColor: "success.main" }}>
        <CardContent>
          <Stack spacing={1} alignItems="center" py={1}>
            <CheckCircle color="success" sx={{ fontSize: 36 }} />
            <Typography variant="subtitle1" fontWeight={700}>
              Week approved! {mutations.length} chore{mutations.length === 1 ? "" : "s"} scheduled.
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    );
  }

  if (mutations.length === 0) {
    return null; // Nothing to schedule — don't show the card
  }

  const byDay = groupByDay(mutations);
  const days = [...byDay.keys()].sort();

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <CalendarMonth color="primary" sx={{ fontSize: 20 }} />
            <Typography variant="subtitle1" fontWeight={700}>
              Weekly Plan
            </Typography>
            <Chip size="small" label={`${mutations.length} chores`} variant="outlined" />
          </Stack>

          <Typography variant="body2" color="text.secondary">
            Review and approve next week's chore schedule in one tap.
          </Typography>

          {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}

          {applying && (
            <Stack spacing={1}>
              <Typography variant="body2">Scheduling... {progress}/{mutations.length}</Typography>
              <LinearProgress variant="determinate" value={(progress / mutations.length) * 100} />
            </Stack>
          )}

          {!applying && (
            <>
              <Box sx={{ maxHeight: 300, overflowY: "auto" }}>
                {days.map((day) => {
                  const dayMutations = byDay.get(day) ?? [];
                  const expanded = expandedDays.has(day);
                  return (
                    <Box key={day}>
                      <Stack
                        direction="row" spacing={1} alignItems="center"
                        sx={{ cursor: "pointer", py: 0.5 }}
                        onClick={() => toggleDay(day)}
                      >
                        {expanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                        <Typography variant="subtitle2" fontWeight={600}>
                          {formatDay(day)}
                        </Typography>
                        <Chip size="small" label={`${dayMutations.length}`} sx={{ fontSize: 10, height: 18 }} />
                      </Stack>
                      <Collapse in={expanded}>
                        <Stack spacing={0.25} sx={{ pl: 3, pb: 1 }}>
                          {dayMutations.map((m, idx) => (
                            <Stack key={idx} direction="row" spacing={1} alignItems="center">
                              <Typography variant="body2" sx={{ fontSize: 12, flex: 1 }} noWrap>
                                {m.title}
                              </Typography>
                              {m.helperId && (
                                <Chip
                                  size="small"
                                  label={helperNames.get(m.helperId) ?? "—"}
                                  variant="outlined"
                                  sx={{ fontSize: 10, height: 18 }}
                                />
                              )}
                              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 35 }}>
                                {m.estimatedMinutes ?? "—"}m
                              </Typography>
                            </Stack>
                          ))}
                        </Stack>
                      </Collapse>
                      <Divider />
                    </Box>
                  );
                })}
              </Box>

              <Stack direction="row" spacing={1}>
                <Button
                  variant="contained" size="small"
                  onClick={() => void approveAll()}
                  startIcon={<CheckCircle />}
                >
                  Approve all ({mutations.length})
                </Button>
                <Button variant="text" size="small" onClick={() => setMutations([])} sx={{ color: "text.secondary" }}>
                  Not now
                </Button>
              </Stack>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
