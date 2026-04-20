import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { useI18n } from "../../i18n";

type HouseholdEventRow = {
  id: string;
  household_id: string;
  type: string;
  start_at: string;
  end_at: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
};

type CleaningFeedbackRow = {
  id: string;
  household_id: string;
  rating: number;
  notes: string | null;
  areas: unknown;
  created_by: string;
  created_at: string;
};

function localDateTimeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(d);
}

function eventTitle(row: HouseholdEventRow): string {
  const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
  const title = typeof (meta as any).title === "string" ? String((meta as any).title).trim() : "";
  if (title) return title;
  if (row.type === "visitors") return "Visitors";
  return row.type;
}

export function Signals() {
  const { householdId } = useAuth();
  const { t } = useI18n();

  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [events, setEvents] = useState<HouseholdEventRow[]>([]);
  const [feedback, setFeedback] = useState<CleaningFeedbackRow[]>([]);

  const hid = householdId.trim();

  const upcomingEvents = useMemo(() => {
    const now = Date.now();
    return events
      .filter((e) => {
        const ts = new Date(e.start_at).getTime();
        return Number.isFinite(ts) && ts >= now - 60 * 60 * 1000;
      })
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  }, [events]);

  useEffect(() => {
    const load = async () => {
      if (!hid) return;
      setBusy(true);
      setLoadError(null);

      const nowIso = new Date().toISOString();

      const [eventsRes, feedbackRes] = await Promise.all([
        supabase
          .from("household_events")
          .select("id,household_id,type,start_at,end_at,metadata,created_by,created_at")
          .eq("household_id", hid)
          .gte("start_at", nowIso)
          .order("start_at", { ascending: true })
          .limit(50),
        supabase
          .from("cleaning_feedback")
          .select("id,household_id,rating,notes,areas,created_by,created_at")
          .eq("household_id", hid)
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

      if (eventsRes.error) {
        setLoadError(eventsRes.error.message);
        setBusy(false);
        return;
      }
      if (feedbackRes.error) {
        setLoadError(feedbackRes.error.message);
        setBusy(false);
        return;
      }

      setEvents((eventsRes.data ?? []) as HouseholdEventRow[]);
      setFeedback((feedbackRes.data ?? []) as CleaningFeedbackRow[]);
      setBusy(false);
    };

    void load();
  }, [hid]);

  return (
    <Box p={2}>
      <Box mb={2}>
        <Typography variant="h5">{t("signals.title")}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t("signals.subtitle")}
        </Typography>
      </Box>

      {loadError ? (
        <Alert severity="error">{loadError}</Alert>
      ) : null}

      {busy ? (
        <Box display="flex" justifyContent="center" py={3}>
          <CircularProgress size={26} />
        </Box>
      ) : null}

      <Stack spacing={2}>
        <Card variant="outlined">
          <CardHeader title={t("signals.upcoming_events")} />
          <CardContent>
            {upcomingEvents.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("signals.no_upcoming_events")}
              </Typography>
            ) : (
              <Stack spacing={1.5}>
                {upcomingEvents.map((e) => (
                  <Box key={e.id}>
                    <Box display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                      <Box>
                        <Typography variant="subtitle1">{eventTitle(e)}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {localDateTimeLabel(e.start_at)}
                          {e.end_at ? ` → ${localDateTimeLabel(e.end_at)}` : ""}
                        </Typography>
                      </Box>
                      <Chip label={e.type} size="small" />
                    </Box>
                    <Divider sx={{ mt: 1.25 }} />
                  </Box>
                ))}
              </Stack>
            )}
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardHeader title={t("signals.cleaning_feedback")} />
          <CardContent>
            {feedback.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("signals.no_cleaning_feedback")}
              </Typography>
            ) : (
              <Stack spacing={1.5}>
                {feedback.map((f) => (
                  <Box key={f.id}>
                    <Box display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                      <Box>
                        <Typography variant="subtitle1">{t("signals.rating")} {f.rating}/5</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {localDateTimeLabel(f.created_at)}
                        </Typography>
                        {f.notes ? (
                          <Typography variant="body2" sx={{ mt: 0.5 }}>
                            {f.notes}
                          </Typography>
                        ) : null}
                      </Box>
                    </Box>
                    <Divider sx={{ mt: 1.25 }} />
                  </Box>
                ))}
              </Stack>
            )}
          </CardContent>
        </Card>
      </Stack>
    </Box>
  );
}
