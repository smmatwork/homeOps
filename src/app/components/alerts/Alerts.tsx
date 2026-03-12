import { useState } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
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

export function Alerts() {
  const [filter, setFilter] = useState<"all" | "critical" | "warning" | "info">("all");
  const [dialogOpen, setDialogOpen] = useState(false);

  const alerts = [
    // ...existing alerts array...
  ];

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

  const filteredAlerts = filter === "all" ? alerts : alerts.filter((alert) => alert.type === filter);
  const unreadCount = alerts.filter((a) => !a.isRead).length;

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
        <Tab label={`Critical (${alerts.filter((a) => a.type === "critical").length})`} value="critical" />
        <Tab label={`Warning (${alerts.filter((a) => a.type === "warning").length})`} value="warning" />
        <Tab label={`Info (${alerts.filter((a) => a.type === "info").length})`} value="info" />
      </Tabs>

      {/* Alerts List */}
      <Box mt={4} display="flex" flexDirection="column" gap={2}>
        {filteredAlerts.map((alert) => (
          <Card key={alert.id} variant="outlined">
            <CardContent>
              <Box display="flex" alignItems="center" gap={2}>
                {getAlertIcon(alert.type)}
                <Box flex={1}>
                  <Typography variant="h6">{alert.title}</Typography>
                  <Typography variant="body2" color="textSecondary">
                    {alert.message}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    {alert.timestamp}
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
