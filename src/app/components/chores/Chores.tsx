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
  Snackbar,
  Tab,
  Tabs,
  TextField,
  Typography,
  Chip,
  IconButton,
  Alert,
} from "@mui/material";
import {
  Add,
  Edit,
  Delete,
  CheckCircle,
  AccessTime,
  ErrorOutline,
  ReportProblem,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { agentCreate } from "../../services/agentApi";
import { executeToolCall } from "../../services/agentApi";

type ChoreRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  completed_at: string | null;
  helper_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function nextLocalMorningIso(now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

export function Chores() {
  const [view, setView] = useState<"all" | "pending" | "in-progress" | "completed">("all");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { accessToken, householdId, user } = useAuth();

  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chores, setChores] = useState<ChoreRow[]>([]);

  const [snackOpen, setSnackOpen] = useState(false);
  const [snackSeverity, setSnackSeverity] = useState<"success" | "error" | "info">("success");
  const [snackMessage, setSnackMessage] = useState<string>("");

  const showSnack = (severity: "success" | "error" | "info", message: string) => {
    setSnackSeverity(severity);
    setSnackMessage(message);
    setSnackOpen(true);
  };

  useEffect(() => {
    if (!householdId.trim()) return;

    let cancelled = false;
    (async () => {
      setBusy(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from("chores")
        .select("id,title,description,status,priority,due_at,completed_at,helper_id,metadata,created_at")
        .eq("household_id", householdId.trim())
        .order("created_at", { ascending: false });

      if (cancelled) return;
      setBusy(false);
      if (error) {
        setLoadError(error.message);
        return;
      }
      setChores((data ?? []) as ChoreRow[]);
    })();

    return () => {
      cancelled = true;
    };
  }, [householdId]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle color="success" />;
      case "in-progress":
        return <AccessTime color="warning" />;
      default:
        return <ErrorOutline color="action" />;
    }
  };

  const filteredChores = useMemo(
    () => (view === "all" ? chores : chores.filter((chore) => chore.status === view)),
    [chores, view],
  );

  const reportNotDone = async (chore: ChoreRow) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", "Missing session token or household id.");
      return;
    }

    setBusy(true);
    try {
      const { data: existing, error: existingError } = await supabase
        .from("chores")
        .select("id,status")
        .eq("household_id", hid)
        .neq("status", "completed")
        .filter("metadata->>makeup_for_chore_id", "eq", chore.id)
        .limit(1);

      if (existingError) {
        showSnack("error", existingError.message);
        return;
      }
      if (existing && existing.length > 0) {
        showSnack("info", "A make-up task already exists for this chore.");
        return;
      }

      const createdAt = new Date().toISOString();
      const makeupDueAt = nextLocalMorningIso(new Date());
      const makeupTitle = chore.title;
      const basePriority = typeof chore.priority === "number" && Number.isFinite(chore.priority) ? chore.priority : 1;
      const bumpedPriority = Math.min(3, Math.max(1, basePriority + 1));

      let helperIdForMakeup: string | null = chore.helper_id ?? null;
      if (helperIdForMakeup) {
        const nowIso = new Date().toISOString();
        const { data: leaveRows, error: leaveErr } = await supabase
          .from("member_time_off")
          .select("id,start_at,end_at")
          .eq("household_id", hid)
          .eq("member_kind", "helper")
          .eq("helper_id", helperIdForMakeup)
          .lte("start_at", nowIso)
          .gt("end_at", nowIso)
          .limit(1);
        if (leaveErr) {
          showSnack("error", leaveErr.message);
          return;
        }
        if (leaveRows && leaveRows.length > 0) {
          helperIdForMakeup = null;
        }
      }

      const makeupMetadata: Record<string, unknown> = {
        source: "report_not_done",
        makeup_for_chore_id: chore.id,
        reported_at: createdAt,
        reported_by_user_id: user?.id ?? null,
        helper_unassigned_reason: helperIdForMakeup ? null : chore.helper_id ? "helper_on_leave" : null,
      };

      const res = await agentCreate({
        accessToken: token,
        table: "chores",
        record: {
          household_id: hid,
          title: makeupTitle,
          description: chore.description ?? null,
          priority: bumpedPriority,
          status: "pending",
          due_at: makeupDueAt,
          helper_id: helperIdForMakeup,
          metadata: makeupMetadata,
        },
        reason: "User reported chore not done; created make-up task.",
      });

      if (!res.ok) {
        showSnack("error", "error" in res ? res.error : "Create failed");
        return;
      }

      const originalMeta: Record<string, unknown> =
        chore.metadata && typeof chore.metadata === "object" && !Array.isArray(chore.metadata)
          ? (chore.metadata as Record<string, unknown>)
          : {};
      const disputesRaw = (originalMeta as any).disputes;
      const disputes = Array.isArray(disputesRaw) ? disputesRaw.slice(0) : [];
      disputes.push({ at: createdAt, by_user_id: user?.id ?? null, type: "not_done" });

      const updatedMeta = { ...originalMeta, disputes };

      const upd = await executeToolCall({
        accessToken: token,
        householdId: hid,
        scope: "household",
        toolCall: {
          id: `report_not_done_patch_${chore.id}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: chore.id, patch: { metadata: updatedMeta } },
          reason: "User reported chore not done; attach dispute metadata.",
        },
      });
      if (!upd.ok) {
        showSnack("error", "error" in upd ? upd.error : "Update failed");
        return;
      }

      const { data: refreshed, error: refreshError } = await supabase
        .from("chores")
        .select("id,title,description,status,priority,due_at,completed_at,helper_id,metadata,created_at")
        .eq("household_id", hid)
        .order("created_at", { ascending: false });
      if (refreshError) {
        showSnack("error", refreshError.message);
        return;
      }
      setChores((refreshed ?? []) as ChoreRow[]);
      showSnack("success", "Reported. Make-up task created.");
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box p={4}>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            Chores
          </Typography>
          <Typography color="textSecondary">Manage household tasks and assignments</Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<Add />}
          onClick={() => setDialogOpen(true)}
        >
          Add Chore
        </Button>
      </Box>

      {/* Tabs */}
      <Tabs value={view} onChange={(e, newValue) => setView(newValue)} variant="scrollable">
        <Tab label={`All (${chores.length})`} value="all" />
        <Tab label={`Pending (${chores.filter((c) => c.status === "pending").length})`} value="pending" />
        <Tab label={`In Progress (${chores.filter((c) => c.status === "in-progress").length})`} value="in-progress" />
        <Tab label={`Completed (${chores.filter((c) => c.status === "completed").length})`} value="completed" />
      </Tabs>

      {/* Chores List */}
      <Box mt={4} display="grid" gridTemplateColumns="repeat(auto-fill, minmax(300px, 1fr))" gap={2}>
        {busy && chores.length === 0 ? (
          <Box display="flex" justifyContent="center" alignItems="center" py={6} gridColumn="1 / -1">
            <CircularProgress size={24} />
          </Box>
        ) : null}
        {loadError ? (
          <Box gridColumn="1 / -1">
            <Typography color="error">{loadError}</Typography>
          </Box>
        ) : null}
        {filteredChores.map((chore) => (
          <Card key={chore.id}>
            <CardHeader
              title={
                <Box display="flex" alignItems="center" gap={1}>
                  {getStatusIcon(chore.status)}
                  <Typography variant="h6">{chore.title}</Typography>
                </Box>
              }
              subheader={chore.description}
              action={
                <Box>
                  <IconButton
                    onClick={() => void reportNotDone(chore)}
                    disabled={busy}
                    aria-label="Report not done"
                  >
                    <ReportProblem />
                  </IconButton>
                  <IconButton>
                    <Edit />
                  </IconButton>
                  <IconButton color="error">
                    <Delete />
                  </IconButton>
                </Box>
              }
            />
            <CardContent>
              <Box display="flex" flexWrap="wrap" gap={1} mb={2}>
                <Chip label={chore.status} color={chore.status === "completed" ? "success" : "default"} />
                <Chip
                  label={`priority ${typeof chore.priority === "number" ? chore.priority : 1}`}
                  color={(chore.priority ?? 1) >= 3 ? "error" : (chore.priority ?? 1) === 2 ? "warning" : "info"}
                />
              </Box>
              {chore.due_at ? (
                <Typography variant="body2" color="textSecondary">
                  Due: <strong>{new Date(chore.due_at).toLocaleString()}</strong>
                </Typography>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </Box>

      {filteredChores.length === 0 && (
        <Box textAlign="center" py={4}>
          <Typography variant="h6">No chores found</Typography>
          <Typography color="textSecondary">You're all caught up!</Typography>
        </Box>
      )}

      {/* Add Chore Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Create New Chore</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2}>
            <TextField label="Chore Title" fullWidth />
            <TextField label="Description" fullWidth multiline rows={3} />
            <FormControl fullWidth>
              <InputLabel>Assign To</InputLabel>
              <Select>
                <MenuItem value="john">John</MenuItem>
                <MenuItem value="sarah">Sarah</MenuItem>
                <MenuItem value="mike">Mike</MenuItem>
                <MenuItem value="emma">Emma</MenuItem>
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel>Priority</InputLabel>
              <Select>
                <MenuItem value="high">High</MenuItem>
                <MenuItem value="medium">Medium</MenuItem>
                <MenuItem value="low">Low</MenuItem>
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel>Category</InputLabel>
              <Select>
                <MenuItem value="daily">Daily</MenuItem>
                <MenuItem value="weekly">Weekly</MenuItem>
                <MenuItem value="monthly">Monthly</MenuItem>
              </Select>
            </FormControl>
            <TextField label="Due Date" type="datetime-local" fullWidth />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained">Create Chore</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snackOpen} autoHideDuration={3000} onClose={() => setSnackOpen(false)}>
        <Alert onClose={() => setSnackOpen(false)} severity={snackSeverity} variant="filled" sx={{ width: "100%" }}>
          {snackMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
}
