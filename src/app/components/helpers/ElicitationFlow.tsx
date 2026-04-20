import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { AutoAwesome, Lightbulb } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useHelpersStore } from "../../stores/helpersStore";
import {
  ELICITATION_QUESTIONS,
  answerElicitationQuestion,
  getNextElicitationQuestion,
  startPatternElicitation,
  type ElicitationTemplateId,
  type NextQuestionResult,
} from "../../services/elicitationApi";

interface ElicitationFlowProps {
  /** If true, the dialog auto-opens when pending questions exist. */
  autoOpen?: boolean;
  /** If set, the dialog asks ONLY this question (JIT mode). After it's
   *  answered, the dialog closes rather than walking the whole catalog. */
  scopedTemplateId?: ElicitationTemplateId | null;
  /** Whether to render the persistent banner. Callers that own their own
   *  trigger surface (e.g., AssignmentPanel) can set `hideBanner` to true. */
  hideBanner?: boolean;
  onAllAnswered?: () => void;
  /** Fires when the user dismisses the dialog without completing (Later /
   *  Close). Callers should clear any state that would re-open the dialog. */
  onClose?: () => void;
}

/**
 * Renders a dismissable banner on the Helpers page when pattern-elicitation
 * is incomplete for the household. Clicking it opens a dialog that walks the
 * owner through one question at a time. Every answer writes immediately, so
 * the session is resumable — close the dialog and come back later.
 *
 * Triggers honored:
 *   • Post-onboarding: call `triggerStart()` from the helper-onboarding
 *     completion handler to seed + auto-open.
 *   • Persistent: banner stays visible until all questions are answered
 *     (or skipped).
 */
export function ElicitationFlow(props: ElicitationFlowProps = {}) {
  const { householdId, user } = useAuth();
  const helpers = useHelpersStore((s) => s.helpers);

  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState<NextQuestionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedHelperId, setSelectedHelperId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ total: number; pending: number; loaded: boolean }>({
    total: 0,
    pending: 0,
    loaded: false,
  });

  /** Seed rows if needed; return the current counts. */
  const seedIfNeeded = useCallback(async () => {
    const hid = householdId?.trim();
    const uid = user?.id;
    if (!hid || !uid) return null;
    const r = await startPatternElicitation({ householdId: hid, actorUserId: uid });
    if (r.ok === false) {
      setError(r.error);
      return null;
    }
    setStatus({ total: r.totalCount, pending: r.pendingCount, loaded: true });
    return r;
  }, [householdId, user?.id]);

  const loadNext = useCallback(async () => {
    const hid = householdId?.trim();
    const uid = user?.id;
    if (!hid || !uid) return;

    // Scoped mode (JIT): bypass the queue and ask only the one template.
    if (props.scopedTemplateId) {
      setQuestion({
        ok: true,
        templateId: props.scopedTemplateId,
        status: "in_progress",
        askedAt: new Date().toISOString(),
        pendingCount: 1,
        answeredCount: 0,
      });
      setSelectedHelperId(null);
      setStatus({ total: 1, pending: 1, loaded: true });
      return;
    }

    const r = await getNextElicitationQuestion({ householdId: hid, actorUserId: uid });
    if (r.ok === false) {
      setError(r.error);
      return;
    }
    setQuestion(r);
    setSelectedHelperId(null);
    setStatus((prev) => ({
      total: prev.total || r.pendingCount + r.answeredCount,
      pending: r.pendingCount,
      loaded: true,
    }));
  }, [householdId, user?.id, props.scopedTemplateId]);

  // Detect existing elicitation state on mount so the banner can decide
  // whether to show. Doesn't seed — only seeds when the user clicks Start
  // or when the onboarding trigger calls triggerStart().
  useEffect(() => {
    if (props.scopedTemplateId) return; // scoped mode bypasses the queue
    const hid = householdId?.trim();
    const uid = user?.id;
    if (!hid || !uid) return;
    let cancelled = false;
    (async () => {
      const r = await getNextElicitationQuestion({ householdId: hid, actorUserId: uid });
      if (cancelled) return;
      if (r.ok === true) {
        setStatus({
          total: r.pendingCount + r.answeredCount,
          pending: r.pendingCount,
          loaded: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId, user?.id, props.scopedTemplateId]);

  // Auto-open once on mount if the caller asked for it and there's work to do.
  // Scoped mode always opens (that's the point — answer one question and close).
  useEffect(() => {
    if (!props.autoOpen) return;
    if (props.scopedTemplateId) {
      void openFlow();
      return;
    }
    if (!status.loaded) return;
    if (status.pending > 0 || status.total === 0) {
      void openFlow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.autoOpen, status.loaded, props.scopedTemplateId]);

  const openFlow = useCallback(async () => {
    setOpen(true);
    setError(null);
    setBusy(true);
    // Scoped mode doesn't need seeding — we're asking one specific question,
    // and answering it directly upserts the state row.
    if (!props.scopedTemplateId) {
      await seedIfNeeded();
    }
    await loadNext();
    setBusy(false);
  }, [seedIfNeeded, loadNext, props.scopedTemplateId]);

  const closeFlow = useCallback(() => {
    setOpen(false);
    setQuestion(null);
    setSelectedHelperId(null);
    if (props.onClose) props.onClose();
  }, [props]);

  const handleAnswer = useCallback(async (opts: { skip: boolean }) => {
    const hid = householdId?.trim();
    const uid = user?.id;
    const tid = question?.ok === true ? question.templateId : null;
    if (!hid || !uid || !tid) return;
    setBusy(true);
    setError(null);
    const r = await answerElicitationQuestion({
      householdId: hid,
      actorUserId: uid,
      templateId: tid,
      helperId: opts.skip ? null : selectedHelperId,
      skip: opts.skip,
    });
    if (r.ok === false) {
      setBusy(false);
      setError(r.error);
      return;
    }
    // Scoped (JIT) mode: one question, then close. Notify parent so it can
    // clear its own scopedTemplateId state.
    if (props.scopedTemplateId) {
      setBusy(false);
      setOpen(false);
      if (props.onAllAnswered) props.onAllAnswered();
      return;
    }
    await loadNext();
    setBusy(false);
  }, [householdId, user?.id, question, selectedHelperId, loadNext, props.scopedTemplateId, props.onAllAnswered]);

  // Finish detection: question returned but templateId is null → all done
  const allDone =
    question?.ok === true && question.templateId === null && status.pending === 0;

  useEffect(() => {
    if (open && allDone && props.onAllAnswered) {
      props.onAllAnswered();
    }
  }, [open, allDone, props]);

  const currentTid = question?.ok === true ? question.templateId : null;
  const currentMeta = currentTid ? ELICITATION_QUESTIONS[currentTid] : null;
  const progressPct =
    status.total > 0
      ? Math.round(((status.total - status.pending) / status.total) * 100)
      : 0;

  // Banner — only renders when there's work to do and the caller hasn't hidden it
  const showBanner = !props.hideBanner && status.loaded && status.pending > 0;

  return (
    <>
      {showBanner && !open && (
        <Card
          variant="outlined"
          sx={{ borderColor: "primary.light", bgcolor: "primary.50", mb: 2 }}
        >
          <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
            <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
              <Lightbulb sx={{ color: "primary.main" }} />
              <Box flex={1} minWidth={200}>
                <Typography variant="subtitle2" fontWeight={700}>
                  Set up assignment patterns
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {status.pending} question{status.pending === 1 ? "" : "s"} left · ~2 min — helps the agent auto-assign chores
                </Typography>
              </Box>
              <Button
                size="small"
                variant="contained"
                startIcon={<AutoAwesome />}
                onClick={() => void openFlow()}
              >
                {status.pending === status.total ? "Start" : "Resume"}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onClose={closeFlow} maxWidth="sm" fullWidth>
        <DialogTitle>
          Assignment preferences
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            {status.total > 0 && (
              <Box>
                <LinearProgress
                  variant="determinate"
                  value={progressPct}
                  sx={{ height: 6, borderRadius: 1 }}
                />
                <Typography variant="caption" color="text.secondary" mt={0.5} display="block">
                  {status.total - status.pending} of {status.total} answered
                </Typography>
              </Box>
            )}

            {error && <Alert severity="error">{error}</Alert>}

            {busy && !currentMeta ? (
              <Box display="flex" justifyContent="center" py={3}>
                <CircularProgress size={24} />
              </Box>
            ) : allDone || !currentMeta ? (
              <Stack spacing={1} alignItems="center" py={2}>
                <AutoAwesome color="success" />
                <Typography variant="body2" fontWeight={600} textAlign="center">
                  All set.
                </Typography>
                <Typography variant="caption" color="text.secondary" textAlign="center">
                  I'll use these preferences when assigning chores. You can update them anytime from this page.
                </Typography>
              </Stack>
            ) : (
              <>
                <Box>
                  <Typography variant="subtitle1" fontWeight={700}>
                    {currentMeta.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {currentMeta.description}
                  </Typography>
                </Box>

                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {helpers.length === 0 ? (
                    <Alert severity="info" sx={{ width: "100%" }}>
                      Add at least one helper first to answer this question.
                    </Alert>
                  ) : (
                    helpers.map((h) => (
                      <Chip
                        key={h.id}
                        label={h.name}
                        color={selectedHelperId === h.id ? "primary" : "default"}
                        variant={selectedHelperId === h.id ? "filled" : "outlined"}
                        onClick={() => setSelectedHelperId(h.id)}
                        disabled={busy}
                      />
                    ))
                  )}
                </Stack>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {allDone || !currentMeta ? (
            <Button onClick={closeFlow} variant="contained">
              Close
            </Button>
          ) : (
            <>
              <Button
                onClick={() => void handleAnswer({ skip: true })}
                disabled={busy}
                color="inherit"
              >
                Skip this one
              </Button>
              <Box flex={1} />
              <Button onClick={closeFlow} disabled={busy}>
                Later
              </Button>
              <Button
                variant="contained"
                onClick={() => void handleAnswer({ skip: false })}
                disabled={busy || !selectedHelperId}
              >
                {busy ? <CircularProgress size={16} /> : "Save & next"}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
