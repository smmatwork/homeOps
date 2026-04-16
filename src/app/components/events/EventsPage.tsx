import { useEffect, useState, useCallback } from "react";
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
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Add, Delete, Event as EventIcon } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import {
  HOUSEHOLD_EVENT_TYPES,
  createHouseholdEvent,
  deleteHouseholdEvent,
  fetchHouseholdEvents,
  type HouseholdEvent,
} from "../../services/householdEventsApi";

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString();
}

function eventTypeColor(type: string): "default" | "primary" | "secondary" | "info" | "warning" | "success" | "error" {
  switch (type) {
    case "guest_arrival": return "info";
    case "vacation": return "primary";
    case "occasion": return "secondary";
    case "weather": return "warning";
    case "member_health": return "error";
    case "helper_leave": return "warning";
    default: return "default";
  }
}

export function EventsPage() {
  const { householdId, accessToken } = useAuth();
  const { t } = useI18n();
  const [events, setEvents] = useState<HouseholdEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Form state
  const [type, setType] = useState<string>("guest_arrival");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    setError(null);
    const result = await fetchHouseholdEvents(householdId);
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEvents(result.events);
  }, [householdId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!householdId || !accessToken || !startAt) return;
    setBusy(true);
    setError(null);
    const result = await createHouseholdEvent({
      accessToken,
      householdId,
      type,
      startAt: new Date(startAt).toISOString(),
      endAt: endAt ? new Date(endAt).toISOString() : null,
      metadata: notes ? { notes } : {},
    });
    setBusy(false);
    if (!result.ok) {
      setError("error" in result ? result.error : "Failed to create event");
      return;
    }
    setDialogOpen(false);
    setType("guest_arrival");
    setStartAt("");
    setEndAt("");
    setNotes("");
    await load();
  };

  const handleDelete = async (eventId: string) => {
    if (!householdId || !accessToken) return;
    setError(null);
    const result = await deleteHouseholdEvent({ accessToken, householdId, eventId });
    if (!result.ok) {
      setError("error" in result ? result.error : "Failed to delete event");
      return;
    }
    await load();
  };

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 1200, mx: "auto" }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight={700}>
            {t("events.title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("events.subtitle")}
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<Add />}
          onClick={() => setDialogOpen(true)}
        >
          {t("events.add_event")}
        </Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress />
        </Box>
      ) : events.length === 0 ? (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: "center", py: 6 }}>
            <EventIcon sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
            <Typography color="text.secondary">{t("events.empty")}</Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={2}>
          {events.map((event) => {
            const meta = event.metadata as Record<string, unknown>;
            const notes = typeof meta.notes === "string" ? meta.notes : "";
            return (
              <Card key={event.id} variant="outlined">
                <CardContent>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                    <Stack spacing={1} flex={1}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Chip
                          size="small"
                          label={t(`events.type_${event.type}`)}
                          color={eventTypeColor(event.type)}
                        />
                        <Typography variant="body2" color="text.secondary">
                          {formatDateTime(event.start_at)}
                          {event.end_at && ` → ${formatDateTime(event.end_at)}`}
                        </Typography>
                      </Stack>
                      {notes && (
                        <Typography variant="body2">{notes}</Typography>
                      )}
                    </Stack>
                    <IconButton size="small" onClick={() => void handleDelete(event.id)}>
                      <Delete fontSize="small" />
                    </IconButton>
                  </Stack>
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      )}

      {/* Add event dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("events.add_event")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              select
              label={t("events.type")}
              value={type}
              onChange={(e) => setType(e.target.value)}
              size="small"
              fullWidth
            >
              {HOUSEHOLD_EVENT_TYPES.map((t_key) => (
                <MenuItem key={t_key} value={t_key}>
                  {t(`events.type_${t_key}`)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label={t("events.start_at")}
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              size="small"
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              label={t("events.end_at")}
              type="datetime-local"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
              size="small"
              fullWidth
              InputLabelProps={{ shrink: true }}
              helperText={t("events.end_at_optional")}
            />
            <TextField
              label={t("events.notes")}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              size="small"
              fullWidth
              multiline
              minRows={2}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="contained" onClick={handleCreate} disabled={busy || !startAt}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
