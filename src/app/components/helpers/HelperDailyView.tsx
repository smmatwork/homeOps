/**
 * Helper daily view — shows today's chores for a specific helper,
 * with check-in status and quick completion toggles.
 *
 * This is the helper-facing surface (used by both owners viewing a
 * helper's day and by the helper themselves via the magic-link app).
 */

import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import {
  Today,
  CheckCircle,
  RadioButtonUnchecked,
  Schedule,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";

interface HelperDailyViewProps {
  helperId: string;
  helperName: string;
}

interface DayChore {
  id: string;
  title: string;
  status: string;
  space: string;
  cadence: string;
  estimatedMinutes: number;
}

export function HelperDailyView({ helperId, helperName }: HelperDailyViewProps) {
  const { householdId } = useAuth();
  const [chores, setChores] = useState<DayChore[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTodayChores = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);

    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();

    const { data } = await supabase
      .from("chores")
      .select("id,title,status,metadata")
      .eq("household_id", householdId)
      .eq("helper_id", helperId)
      .is("deleted_at", null)
      .gte("due_at", startOfDay)
      .lt("due_at", endOfDay)
      .order("due_at", { ascending: true });

    const mapped: DayChore[] = (data ?? []).map((c: Record<string, unknown>) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      return {
        id: String(c.id),
        title: String(c.title ?? ""),
        status: String(c.status ?? "pending"),
        space: typeof meta.space === "string" ? meta.space : "",
        cadence: typeof meta.cadence === "string" ? meta.cadence : "",
        estimatedMinutes: typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : 0,
      };
    });
    setChores(mapped);
    setLoading(false);
  }, [householdId, helperId]);

  useEffect(() => { void loadTodayChores(); }, [loadTodayChores]);

  const toggleComplete = async (choreId: string, currentStatus: string) => {
    const newStatus = currentStatus === "completed" ? "pending" : "completed";
    await supabase.from("chores").update({
      status: newStatus,
      completed_at: newStatus === "completed" ? new Date().toISOString() : null,
    }).eq("id", choreId);
    setChores((prev) =>
      prev.map((c) => c.id === choreId ? { ...c, status: newStatus } : c),
    );
  };

  const doneCount = chores.filter((c) => c.status === "completed").length;
  const totalMinutes = chores.reduce((s, c) => s + c.estimatedMinutes, 0);

  if (loading) {
    return <CircularProgress size={16} />;
  }

  if (chores.length === 0) {
    return (
      <Card variant="outlined" sx={{ mt: 1 }}>
        <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
          <Typography variant="body2" color="text.secondary">
            No chores scheduled for {helperName} today.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card variant="outlined" sx={{ mt: 1 }}>
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Stack direction="row" spacing={1} alignItems="center">
              <Today fontSize="small" color="primary" />
              <Typography variant="subtitle2" fontWeight={600}>
                Today's tasks
              </Typography>
            </Stack>
            <Stack direction="row" spacing={0.5}>
              <Chip
                size="small"
                label={`${doneCount}/${chores.length} done`}
                color={doneCount === chores.length ? "success" : "default"}
                variant="outlined"
                sx={{ fontSize: 10 }}
              />
              <Chip
                size="small"
                icon={<Schedule />}
                label={`${totalMinutes}m`}
                variant="outlined"
                sx={{ fontSize: 10 }}
              />
            </Stack>
          </Stack>

          <Stack spacing={0.25}>
            {chores.map((chore) => (
              <Stack
                key={chore.id}
                direction="row"
                spacing={0.5}
                alignItems="center"
                sx={{
                  py: 0.25,
                  px: 0.5,
                  borderRadius: 1,
                  opacity: chore.status === "completed" ? 0.6 : 1,
                }}
              >
                <Checkbox
                  size="small"
                  checked={chore.status === "completed"}
                  onChange={() => void toggleComplete(chore.id, chore.status)}
                  icon={<RadioButtonUnchecked fontSize="small" />}
                  checkedIcon={<CheckCircle fontSize="small" />}
                  sx={{ p: 0.25 }}
                />
                <Typography
                  variant="body2"
                  sx={{
                    flex: 1,
                    fontSize: 12,
                    textDecoration: chore.status === "completed" ? "line-through" : "none",
                  }}
                  noWrap
                >
                  {chore.title}
                </Typography>
                {chore.space && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                    {chore.space}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, minWidth: 25, textAlign: "right" }}>
                  {chore.estimatedMinutes}m
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
