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

type AlertRow = {
  id: string;
  title: string;
  body: string | null;
  severity: number;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

export function Alerts() {
  const [filter, setFilter] = useState<"all" | "critical" | "warning" | "info">("all");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { householdId } = useAuth();
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
        .select("id,title,body,severity,status,created_at,metadata")
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
  const unreadCount = 0;

  return (
    <Box p={4}>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            Alerts & Notifications
          </Typography>
          <Typography color="textSecondary">
            Stay informed about household activities and reminders
          </Typography>
          {unreadCount > 0 && (
            <Badge badgeContent={unreadCount} color="error" sx={{ mt: 1 }}>
              Unread
            </Badge>
          )}
        </Box>
        <Box display="flex" gap={2}>
          <Button variant="outlined" startIcon={<CheckCircle />}>
            Mark All Read
          </Button>
          <Button variant="contained" startIcon={<AddAlert />} onClick={() => setDialogOpen(true)}>
            Create Alert
          </Button>
        </Box>
      </Box>

      {/* Filter Tabs */}
      <Tabs value={filter} onChange={(e, newValue) => setFilter(newValue)} variant="scrollable">
        <Tab label={`All (${alerts.length})`} value="all" />
        <Tab label={`Critical (${alerts.filter((a) => alertType(a) === "critical").length})`} value="critical" />
        <Tab label={`Warning (${alerts.filter((a) => alertType(a) === "warning").length})`} value="warning" />
        <Tab label={`Info (${alerts.filter((a) => alertType(a) === "info").length})`} value="info" />
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
        {filteredAlerts.map((alert) => (
          <Card key={alert.id} variant="outlined">
            <CardContent>
              <Box display="flex" alignItems="center" gap={2}>
                {getAlertIcon(alertType(alert))}
                <Box flex={1}>
                  <Typography variant="h6">{alert.title}</Typography>
                  <Typography variant="body2" color="textSecondary">
                    {alert.body ?? ""}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    {new Date(alert.created_at).toLocaleString()}
                  </Typography>
                </Box>
                <IconButton>
                  <MoreVert />
                </IconButton>
              </Box>
            </CardContent>
          </Card>
        ))}
      </Box>

      {filteredAlerts.length === 0 && (
        <Box textAlign="center" py={4}>
          <NotificationsActive fontSize="large" color="disabled" />
          <Typography variant="h6">No alerts</Typography>
          <Typography color="textSecondary">You're all caught up!</Typography>
        </Box>
      )}

      {/* Create Alert Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Create Custom Alert</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2}>
            <TextField label="Alert Title" fullWidth />
            <TextField label="Message" fullWidth multiline rows={3} />
            <FormControl fullWidth>
              <InputLabel>Priority</InputLabel>
              <Select>
                <MenuItem value="critical">Critical</MenuItem>
                <MenuItem value="warning">Warning</MenuItem>
                <MenuItem value="info">Info</MenuItem>
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel>Category</InputLabel>
              <Select>
                <MenuItem value="maintenance">Maintenance</MenuItem>
                <MenuItem value="bills">Bills</MenuItem>
                <MenuItem value="inventory">Inventory</MenuItem>
                <MenuItem value="safety">Safety</MenuItem>
                <MenuItem value="reminders">Reminders</MenuItem>
              </Select>
            </FormControl>
            <TextField label="Alert Date & Time" type="datetime-local" fullWidth />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained">Create Alert</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
