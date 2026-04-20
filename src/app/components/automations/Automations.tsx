import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Delete, Edit, Pause, PlayArrow, Schedule } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { disableAutomation, listAutomations, runAutomationNow, type AutomationCadence, type AutomationRow, updateAutomation } from "../../services/agentApi";
import { useI18n } from "../../i18n";

const cadenceLabel = (c: string) => {
  if (c === "daily") return "Daily";
  if (c === "weekdays") return "Weekdays";
  if (c === "weekly") return "Weekly";
  if (c === "monthly") return "Monthly";
  if (c === "hourly") return "Hourly";
  if (c === "every_2_hours") return "Every 2 hours";
  if (c === "every_5_minutes") return "Every 5 minutes";
  return c;
};

const formatWhen = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(d);
};

export function Automations() {
  const { accessToken, householdId } = useAuth();
  const { t } = useI18n();

  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<AutomationRow[]>([]);

  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<AutomationRow | null>(null);

  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCadence, setEditCadence] = useState<AutomationCadence>("daily");
  const [editAtTime, setEditAtTime] = useState<string>("");
  const [editDayOfWeek, setEditDayOfWeek] = useState<string>("");
  const [editDayOfMonth, setEditDayOfMonth] = useState<string>("");

  const openEdit = (row: AutomationRow) => {
    setEditRow(row);
    setEditTitle(row.title ?? "");
    setEditDescription(row.description ?? "");
    setEditCadence(row.cadence);
    setEditAtTime(row.at_time ?? "");
    setEditDayOfWeek(typeof row.day_of_week === "number" ? String(row.day_of_week) : "");
    setEditDayOfMonth(typeof row.day_of_month === "number" ? String(row.day_of_month) : "");
    setEditError(null);
    setEditOpen(true);
  };

  const closeEdit = () => {
    setEditOpen(false);
    setEditBusy(false);
    setEditError(null);
    setEditRow(null);
  };

  const reload = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setBusy(true);
    setLoadError(null);
    const res = await listAutomations({ accessToken: token, householdId: hid });
    setBusy(false);

    if (!res.ok) {
      setItems([]);
      setLoadError((res as { ok: false; error: string }).error);
      return;
    }

    setItems(res.automations);
  };

  useEffect(() => {
    void reload();
  }, [accessToken, householdId]);

  const activeCount = useMemo(() => items.filter((a) => a.status === "active").length, [items]);
  const pausedCount = useMemo(() => items.filter((a) => a.status === "paused").length, [items]);
  const disabledCount = useMemo(() => items.filter((a) => a.status === "disabled").length, [items]);

  const sortedItems = useMemo(() => {
    const rank = (s: string) => {
      if (s === "active") return 0;
      if (s === "paused") return 1;
      if (s === "disabled") return 2;
      return 1;
    };

    return [...items].sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
    });
  }, [items]);

  const updateStatus = async (row: AutomationRow, status: "active" | "paused") => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    const prev = items;
    setItems((cur) => cur.map((a) => (a.id === row.id ? { ...a, status } : a)));

    const res = await updateAutomation({ accessToken: token, householdId: hid, id: row.id, patch: { status } });
    if (!res.ok) {
      setItems(prev);
      setLoadError((res as { ok: false; error: string }).error);
      return;
    }

    setItems((cur) => cur.map((a) => (a.id === row.id ? res.automation : a)));
  };

  const runNow = async (row: AutomationRow) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    const prev = items;
    setItems((cur) => cur.map((a) => (a.id === row.id ? { ...a, last_run_at: new Date().toISOString() } : a)));

    const res = await runAutomationNow({ accessToken: token, householdId: hid, id: row.id });
    if (!res.ok) {
      setItems(prev);
      setLoadError((res as { ok: false; error: string }).error);
      return;
    }

    setItems((cur) => cur.map((a) => (a.id === row.id ? res.automation : a)));
  };

  const disable = async (row: AutomationRow) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    const prev = items;
    setItems((cur) => cur.map((a) => (a.id === row.id ? { ...a, status: "disabled" } : a)));

    const res = await disableAutomation({ accessToken: token, householdId: hid, id: row.id });
    if (!res.ok) {
      setItems(prev);
      setLoadError((res as { ok: false; error: string }).error);
      return;
    }

    setItems((cur) => cur.map((a) => (a.id === row.id ? res.automation : a)));
  };

  const saveEdit = async () => {
    if (!editRow) return;

    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    const title = editTitle.trim();
    if (!title) {
      setEditError(t("automations.title_required"));
      return;
    }

    const atTime = editAtTime.trim() ? editAtTime.trim() : null;
    const dayOfWeek = editDayOfWeek.trim() ? Number(editDayOfWeek.trim()) : null;
    const dayOfMonth = editDayOfMonth.trim() ? Number(editDayOfMonth.trim()) : null;

    if (editCadence === "weekly" && dayOfWeek === null) {
      setEditError(t("automations.weekly_requires_dow"));
      return;
    }

    if (editCadence === "monthly" && dayOfMonth === null) {
      setEditError(t("automations.monthly_requires_dom"));
      return;
    }

    setEditBusy(true);
    setEditError(null);

    const patch: Record<string, unknown> = {
      title,
      description: editDescription.trim() || null,
      cadence: editCadence,
      at_time: atTime,
      day_of_week: editCadence === "weekly" ? dayOfWeek : null,
      day_of_month: editCadence === "monthly" ? dayOfMonth : null,
    };

    const res = await updateAutomation({
      accessToken: token,
      householdId: hid,
      id: editRow.id,
      patch,
    });

    setEditBusy(false);

    if (!res.ok) {
      setEditError((res as { ok: false; error: string }).error);
      return;
    }

    setItems((cur) => cur.map((a) => (a.id === editRow.id ? res.automation : a)));
    closeEdit();
  };

  const statusChip = (status: string) => {
    if (status === "active") return <Chip label={t("automations.status_active")} color="success" size="small" variant="outlined" />;
    if (status === "paused") return <Chip label={t("automations.status_paused")} color="warning" size="small" variant="outlined" />;
    if (status === "disabled") return <Chip label={t("automations.status_disabled")} color="default" size="small" variant="outlined" />;
    return <Chip label={status} size="small" variant="outlined" />;
  };

  return (
    <Box p={4}>
      <Box display="flex" justifyContent="space-between" alignItems="flex-end" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight={700}>
            {t("automations.title")}
          </Typography>
          <Typography color="text.secondary">{t("automations.subtitle")}</Typography>
          <Typography variant="caption" color="text.secondary">
            {t("automations.summary").replace("{active}", String(activeCount)).replace("{paused}", String(pausedCount)).replace("{disabled}", String(disabledCount))}
          </Typography>
        </Box>
        <Button variant="outlined" onClick={() => void reload()} disabled={busy} sx={{ textTransform: "none" }}>
          {t("common.refresh")}
        </Button>
      </Box>

      {loadError ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      ) : null}

      {busy && items.length === 0 ? (
        <Box display="flex" justifyContent="center" alignItems="center" py={6}>
          <CircularProgress size={24} />
        </Box>
      ) : null}

      {!busy && items.length === 0 ? (
        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Schedule color="disabled" />
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  {t("automations.none_title")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("automations.none_body")}
                </Typography>
              </Box>
            </Stack>
          </CardContent>
        </Card>
      ) : null}

      <Stack spacing={2}>
        {sortedItems.map((a) => (
          <Card key={a.id} variant="outlined">
            <CardHeader
              title={
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="subtitle1" fontWeight={700} sx={{ mr: 1 }}>
                    {a.title}
                  </Typography>
                  {statusChip(a.status)}
                </Stack>
              }
              subheader={
                <Typography variant="body2" color="text.secondary">
                  {a.description ?? ""}
                </Typography>
              }
              action={
                <Stack direction="row" spacing={1} alignItems="center" sx={{ pt: 0.5 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<PlayArrow fontSize="small" />}
                    onClick={() => void runNow(a)}
                    disabled={a.status === "disabled"}
                    sx={{ textTransform: "none" }}
                  >
                    {t("automations.run_now")}
                  </Button>
                  {a.status === "active" ? (
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<Pause fontSize="small" />}
                      onClick={() => void updateStatus(a, "paused")}
                      sx={{ textTransform: "none" }}
                    >
                      {t("automations.pause")}
                    </Button>
                  ) : null}
                  {a.status === "paused" ? (
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<PlayArrow fontSize="small" />}
                      onClick={() => void updateStatus(a, "active")}
                      sx={{ textTransform: "none" }}
                    >
                      {t("automations.resume")}
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<Edit fontSize="small" />}
                    onClick={() => openEdit(a)}
                    disabled={a.status === "disabled"}
                    sx={{ textTransform: "none" }}
                  >
                    {t("common.edit")}
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    startIcon={<Delete fontSize="small" />}
                    onClick={() => void disable(a)}
                    disabled={a.status === "disabled"}
                    sx={{ textTransform: "none" }}
                  >
                    {t("automations.disable")}
                  </Button>
                </Stack>
              }
            />
            <Divider />
            <CardContent>
              <Stack spacing={1}>
                <Typography variant="body2">
                  <strong>{t("automations.cadence")}:</strong> {cadenceLabel(a.cadence)}
                </Typography>
                <Typography variant="body2">
                  <strong>{t("automations.next_run") }:</strong> {formatWhen(a.next_run_at)}
                </Typography>
                <Typography variant="body2">
                  <strong>{t("automations.last_run") }:</strong> {formatWhen(a.last_run_at)}
                </Typography>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>

      <Dialog open={editOpen} onClose={closeEdit} fullWidth maxWidth="sm">
        <DialogTitle>{t("automations.edit")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            {editError ? <Alert severity="error">{editError}</Alert> : null}
            <TextField label={t("automations.field_title")} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} fullWidth />
            <TextField
              label={t("automations.field_description")}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              fullWidth
              multiline
              minRows={2}
            />

            <FormControl fullWidth>
              <InputLabel>{t("automations.field_cadence")}</InputLabel>
              <Select
                value={editCadence}
                label={t("automations.field_cadence")}
                onChange={(e) => setEditCadence((e.target.value as AutomationCadence) || "daily")}
              >
                <MenuItem value="daily">{t("automations.cadence_daily")}</MenuItem>
                <MenuItem value="weekdays">{t("automations.cadence_weekdays")}</MenuItem>
                <MenuItem value="weekly">{t("automations.cadence_weekly")}</MenuItem>
                <MenuItem value="monthly">{t("automations.cadence_monthly")}</MenuItem>
                <MenuItem value="hourly">{t("automations.cadence_hourly")}</MenuItem>
                <MenuItem value="every_2_hours">{t("automations.cadence_every_2_hours")}</MenuItem>
                <MenuItem value="every_5_minutes">{t("automations.cadence_every_5_minutes")}</MenuItem>
              </Select>
            </FormControl>

            <TextField
              label={t("automations.field_at_time")}
              value={editAtTime}
              onChange={(e) => setEditAtTime(e.target.value)}
              fullWidth
              placeholder="HH:MM:SS"
            />

            <TextField
              label={t("automations.field_day_of_week")}
              value={editDayOfWeek}
              onChange={(e) => setEditDayOfWeek(e.target.value)}
              fullWidth
              disabled={editCadence !== "weekly"}
              placeholder="0 (Sun) ... 6 (Sat)"
            />

            <TextField
              label={t("automations.field_day_of_month")}
              value={editDayOfMonth}
              onChange={(e) => setEditDayOfMonth(e.target.value)}
              fullWidth
              disabled={editCadence !== "monthly"}
              placeholder="1 ... 31"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeEdit} disabled={editBusy} sx={{ textTransform: "none" }}>
            {t("common.cancel")}
          </Button>
          <Button variant="contained" onClick={() => void saveEdit()} disabled={editBusy} sx={{ textTransform: "none" }}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
