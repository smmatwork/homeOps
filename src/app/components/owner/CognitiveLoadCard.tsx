/**
 * O1 Cognitive Load Metric card — shows the household's cognitive load
 * reduction ratio from the assignment_decisions table (4-week rolling window).
 */

import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Card,
  CardContent,
  CircularProgress,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { Psychology } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";

interface O1Data {
  total_decisions: number;
  load_reducing_decisions: number;
  ratio: number;
}

export function CognitiveLoadCard() {
  const { householdId } = useAuth();
  const [data, setData] = useState<O1Data | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!householdId) { setLoading(false); return; }
    setLoading(true);
    try {
      const { data: result, error } = await supabase.rpc(
        "get_o1_cognitive_load_ratio",
        { p_household_id: householdId },
      );
      if (!error && result) {
        // RPC returns a single row as array or object
        const row = Array.isArray(result) ? result[0] : result;
        if (row) {
          setData({
            total_decisions: Number(row.total_decisions ?? 0),
            load_reducing_decisions: Number(row.load_reducing_decisions ?? 0),
            ratio: Number(row.ratio ?? 0),
          });
        }
      }
    } catch {
      // Non-critical — card just won't show data
    }
    setLoading(false);
  }, [householdId]);

  useEffect(() => { void fetchData(); }, [fetchData]);

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

  const pct = data ? Math.round(data.ratio * 100) : 0;
  const total = data?.total_decisions ?? 0;
  const loadReducing = data?.load_reducing_decisions ?? 0;

  // Color based on O1 target thresholds
  const color = pct >= 70 ? "success" : pct >= 45 ? "warning" : "error";

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Psychology color="primary" sx={{ fontSize: 20 }} />
            <Typography variant="subtitle2" fontWeight={700}>
              Cognitive Load Reduction
            </Typography>
          </Stack>

          {total === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No assignment decisions recorded yet. As you use the system,
              this metric will show how much cognitive work HomeOps handles for you.
            </Typography>
          ) : (
            <>
              <Stack direction="row" spacing={2} alignItems="baseline">
                <Typography variant="h4" fontWeight={700} color={`${color}.main`}>
                  {pct}%
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  of decisions handled by HomeOps
                </Typography>
              </Stack>

              <LinearProgress
                variant="determinate"
                value={pct}
                color={color as "success" | "warning" | "error"}
                sx={{ height: 8, borderRadius: 1 }}
              />

              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption" color="text.secondary">
                  {loadReducing} load-reducing / {total} total (4-week window)
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Target: 45% (Phase 1)
                </Typography>
              </Stack>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
