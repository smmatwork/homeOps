import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
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
  Tab,
  Tabs,
  TextField,
  Typography,
  Badge,
  IconButton,
} from "@mui/material";
import {
  NotificationsActive,
  ErrorOutline,
  WarningAmber,
  InfoOutlined,
  CheckCircle,
  Delete,
  AddAlert,
  MoreVert,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { useI18n } from "../../i18n";

type AlertRow = {
  id: string;
  household_id: string;
  title: string;
  body: string | null;
  severity: number;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
  justification: string | null;
  category: string | null;
  read_at: string | null;
  dismissed_at: string | null;
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

export function Alerts() {
  const [filter, setFilter] = useState<"all" | "critical" | "warning" | "info">("all");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { householdId } = useAuth();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);

  useEffect(() => {
    if (!householdId.trim()) return;

    let cancelled = false;
    (async () => {
      setBusy(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from("alerts")
        .select("id,title,body,severity,status,created_at,metadata,justification,category,read_at,dismissed_at")
        .eq("household_id", householdId.trim())
        .order("created_at", { ascending: false })
        .limit(50);

      if (cancelled) return;
      setBusy(false);
      if (error) {
        setLoadError(error.message);
        setAlerts([]);
        return;
      }
      setAlerts((data ?? []) as AlertRow[]);
    })();

    return () => {
      cancelled = true;
    };
  }, [householdId]);

  const alertType = (a: AlertRow): "critical" | "warning" | "info" => {
    const sev = typeof a.severity === "number" && Number.isFinite(a.severity) ? a.severity : 1;
    if (sev >= 3) return "critical";
    if (sev === 2) return "warning";
    return "info";
  };

  const getAlertIcon = (type: string) => {
    switch (type) {
      case "critical":
        return <ErrorOutline color="error" />;
      case "warning":
        return <WarningAmber color="warning" />;
      case "info":
        return <InfoOutlined color="info" />;
      default:
        return <NotificationsActive />;
    }
  };

  const filteredAlerts = useMemo(
    () => (filter === "all" ? alerts : alerts.filter((a) => alertType(a) === filter)),
    [alerts, filter],
  );
  const unreadCount = alerts.filter((a) => !a.read_at && !a.dismissed_at).length;

  const markAsRead = async (alertId: string) => {
    await supabase.from("alerts").update({ read_at: new Date().toISOString() }).eq("id", alertId);
    setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, read_at: new Date().toISOString() } : a));
  };

  const dismissAlert = async (alertId: string) => {
    await supabase.from("alerts").update({ dismissed_at: new Date().toISOString() }).eq("id", alertId);
    setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, dismissed_at: new Date().toISOString() } : a));
  };

  const markAllRead = async () => {
    const unreadIds = alerts.filter((a) => !a.read_at).map((a) => a.id);
    if (unreadIds.length === 0) return;
    await supabase.from("alerts").update({ read_at: new Date().toISOString() }).in("id", unreadIds);
    setAlerts((prev) => prev.map((a) => ({ ...a, read_at: a.read_at ?? new Date().toISOString() })));
  };

  return (
    <Box p={4}>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            {t("alerts.title")}
          </Typography>
          <Typography color="textSecondary">
            {t("alerts.subtitle")}
          </Typography>
          {unreadCount > 0 && (
            <Badge badgeContent={unreadCount} color="error" sx={{ mt: 1 }}>
              {t("alerts.unread")}
            </Badge>
          )}
        </Box>
        <Box display="flex" gap={2}>
          <Button variant="outlined" startIcon={<CheckCircle />} onClick={() => void markAllRead()} disabled={unreadCount === 0}>
            {t("alerts.mark_all_read")}
          </Button>
          <Button variant="contained" startIcon={<AddAlert />} onClick={() => setDialogOpen(true)}>
            {t("alerts.create")}
          </Button>
        </Box>
      </Box>

      {/* Filter Tabs */}
      <Tabs value={filter} onChange={(e, newValue) => setFilter(newValue)} variant="scrollable">
        <Tab label={`${t("alerts.all")} (${alerts.length})`} value="all" />
        <Tab label={`${t("alerts.critical_tab")} (${alerts.filter((a) => alertType(a) === "critical").length})`} value="critical" />
        <Tab label={`${t("alerts.warning_tab")} (${alerts.filter((a) => alertType(a) === "warning").length})`} value="warning" />
        <Tab label={`${t("alerts.info_tab")} (${alerts.filter((a) => alertType(a) === "info").length})`} value="info" />
      </Tabs>

      {/* Alerts List */}
      <Box mt={4} display="flex" flexDirection="column" gap={2}>
        {busy && alerts.length === 0 ? (
          <Box display="flex" justifyContent="center" alignItems="center" py={6}>
            <CircularProgress size={24} />
          </Box>
        ) : null}
        {loadError ? (
          <Typography color="error">{loadError}</Typography>
        ) : null}
        {filteredAlerts.filter((a) => !a.dismissed_at).map((alert) => (
          <Card key={alert.id} variant="outlined" sx={{ opacity: alert.read_at ? 0.75 : 1 }}>
            <CardContent>
              <Box display="flex" alignItems="flex-start" gap={2}>
                {getAlertIcon(alertType(alert))}
                <Box flex={1}>
                  <Typography variant="h6" fontWeight={alert.read_at ? 400 : 700}>{alert.title}</Typography>
                  <Typography variant="body2" color="textSecondary">
                    {alert.body ?? ""}
                  </Typography>
                  {alert.justification && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5, fontStyle: "italic" }}>
                      Why: {alert.justification}
                    </Typography>
                  )}
                  <Typography variant="caption" color="textSecondary" sx={{ display: "block", mt: 0.5 }}>
                    {localDateTimeLabel(alert.created_at)}
                    {alert.category && ` · ${alert.category}`}
                  </Typography>
                </Box>
                <Box display="flex" gap={0.5}>
                  {!alert.read_at && (
                    <IconButton size="small" title="Mark as read" onClick={() => void markAsRead(alert.id)}>
                      <CheckCircle fontSize="small" />
                    </IconButton>
                  )}
                  <IconButton size="small" title="Dismiss" onClick={() => void dismissAlert(alert.id)}>
                    <Delete fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
            </CardContent>
          </Card>
        ))}
      </Box>

      {filteredAlerts.length === 0 && (
        <Box textAlign="center" py={4}>
          <NotificationsActive fontSize="large" color="disabled" />
          <Typography variant="h6">{t("alerts.no_alerts")}</Typography>
          <Typography color="textSecondary">{t("alerts.caught_up")}</Typography>
        </Box>
      )}

      {/* Create Alert Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>{t("alerts.create_custom")}</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2}>
            <TextField label={t("alerts.alert_title")} fullWidth />
            <TextField label={t("alerts.message")} fullWidth multiline rows={3} />
            <FormControl fullWidth>
              <InputLabel>{t("alerts.priority")}</InputLabel>
              <Select>
                <MenuItem value="critical">{t("alerts.critical")}</MenuItem>
                <MenuItem value="warning">{t("alerts.warning")}</MenuItem>
                <MenuItem value="info">{t("alerts.info")}</MenuItem>
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel>{t("alerts.category")}</InputLabel>
              <Select>
                <MenuItem value="maintenance">{t("alerts.maintenance")}</MenuItem>
                <MenuItem value="bills">{t("alerts.bills")}</MenuItem>
                <MenuItem value="inventory">{t("alerts.inventory")}</MenuItem>
                <MenuItem value="safety">{t("alerts.safety")}</MenuItem>
                <MenuItem value="reminders">{t("alerts.reminders")}</MenuItem>
              </Select>
            </FormControl>
            <TextField label={t("alerts.alert_date_time")} type="datetime-local" fullWidth />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="contained">{t("alerts.create")}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
