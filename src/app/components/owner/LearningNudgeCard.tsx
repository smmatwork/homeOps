import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { Lightbulb } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import {
  acceptNudge,
  declineNudge,
  fetchPendingNudges,
  NUDGE_AVAILABLE_EVENT,
  type PendingNudge,
} from "../../services/assignmentApi";

function formatPredicate(p: Record<string, unknown>): string {
  const titleHead = typeof p.title_head === "string" ? p.title_head : "";
  const space = typeof p.space === "string" ? p.space : "";
  const cadence = typeof p.cadence === "string" ? p.cadence : "";
  const parts: string[] = [];
  if (titleHead) parts.push(titleHead);
  if (space) parts.push(`in ${space}`);
  if (cadence) parts.push(`(${cadence.replace(/_/g, " ")})`);
  return parts.length > 0 ? parts.join(" ") : "this kind of task";
}

export function LearningNudgeCard() {
  const { householdId, user } = useAuth();
  const [nudges, setNudges] = useState<PendingNudge[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const hid = householdId?.trim();
    const uid = user?.id;
    if (!hid || !uid) return;
    setLoading(true);
    setError(null);
    const r = await fetchPendingNudges({ householdId: hid, actorUserId: uid });
    setLoading(false);
    if (r.ok === false) {
      setError(r.error);
      return;
    }
    setNudges(r.nudges);
  }, [householdId, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handler = () => {
      void load();
    };
    window.addEventListener(NUDGE_AVAILABLE_EVENT, handler);
    return () => window.removeEventListener(NUDGE_AVAILABLE_EVENT, handler);
  }, [load]);

  const handleAccept = async (overrideId: number) => {
    const uid = user?.id;
    if (!uid) return;
    setBusyId(overrideId);
    setError(null);
    const r = await acceptNudge({ overrideId, actorUserId: uid });
    setBusyId(null);
    if (r.ok === false) {
      setError(r.error);
      return;
    }
    setNudges((prev) => prev.filter((n) => n.overrideId !== overrideId));
  };

  const handleDecline = async (overrideId: number) => {
    const uid = user?.id;
    if (!uid) return;
    setBusyId(overrideId);
    setError(null);
    const r = await declineNudge({ overrideId, actorUserId: uid });
    setBusyId(null);
    if (r.ok === false) {
      setError(r.error);
      return;
    }
    setNudges((prev) => prev.filter((n) => n.overrideId !== overrideId));
  };

  if (loading && nudges.length === 0) {
    return null;
  }
  if (!loading && nudges.length === 0 && !error) {
    return null;
  }

  return (
    <Card variant="outlined" sx={{ borderColor: "warning.light", bgcolor: "warning.50" }}>
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="center" mb={1}>
          <Lightbulb sx={{ fontSize: 20, color: "warning.dark" }} />
          <Typography variant="subtitle2" fontWeight={700}>
            I noticed a pattern
          </Typography>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}

        <Stack spacing={2}>
          {nudges.map((n) => {
            const chosen = n.chosenHelperName ?? "someone else";
            const proposed = n.proposedHelperName ?? "the usual helper";
            const predicate = formatPredicate(n.chorePredicate);
            const isBusy = busyId === n.overrideId;
            return (
              <Box key={n.overrideId}>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  You've assigned <b>{predicate}</b> to <b>{chosen}</b> {n.overrideCount} times
                  instead of <b>{proposed}</b>. Should I make <b>{chosen}</b> the default?
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    variant="contained"
                    color="warning"
                    disabled={isBusy}
                    onClick={() => void handleAccept(n.overrideId)}
                  >
                    {isBusy ? <CircularProgress size={14} /> : "Yes, make default"}
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={isBusy}
                    onClick={() => void handleDecline(n.overrideId)}
                  >
                    No, keep asking
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                  Decline to snooze this question for 30 days.
                </Typography>
              </Box>
            );
          })}
        </Stack>
      </CardContent>
    </Card>
  );
}
