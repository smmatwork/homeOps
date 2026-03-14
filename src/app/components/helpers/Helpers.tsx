import { useEffect, useMemo, useState } from "react";
import {
  Box, Button, Card, CardContent, CardHeader, Chip,
  Avatar, Typography, Stack, Tabs, Tab, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  CircularProgress,
  Snackbar,
  Alert,
} from "@mui/material";
import { Phone, Schedule, Add, MoreVert } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";

type HelperRow = {
  id: string;
  household_id: string;
  name: string;
  type: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
};

type TimeOffRow = {
  id: string;
  household_id: string;
  member_kind: string;
  helper_id: string | null;
  start_at: string;
  end_at: string;
  reason: string | null;
  created_at: string;
};

const CATEGORIES = ["All", "Cleaning", "Maintenance", "Outdoor", "Childcare", "Technology"];

const initials = (name: string) =>
  name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();

function normalizeDatetimeLocal(raw: string): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function Helpers() {
  const [category, setCategory] = useState("All");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { accessToken, householdId } = useAuth();
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [helpers, setHelpers] = useState<HelperRow[]>([]);

  const [snackOpen, setSnackOpen] = useState(false);
  const [snackSeverity, setSnackSeverity] = useState<"success" | "error" | "info">("success");
  const [snackMessage, setSnackMessage] = useState<string>("");

  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const [timeOffOpen, setTimeOffOpen] = useState(false);
  const [timeOffHelper, setTimeOffHelper] = useState<HelperRow | null>(null);
  const [timeOffStart, setTimeOffStart] = useState("");
  const [timeOffEnd, setTimeOffEnd] = useState("");
  const [timeOffReason, setTimeOffReason] = useState("");
  const [timeOffBusy, setTimeOffBusy] = useState(false);
  const [timeOffRows, setTimeOffRows] = useState<TimeOffRow[]>([]);

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
        .from("helpers")
        .select("id,household_id,name,type,phone,notes,created_at")
        .eq("household_id", householdId.trim())
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setBusy(false);
      if (error) {
        setLoadError(error.message);
        setHelpers([]);
        return;
      }
      setHelpers((data ?? []) as HelperRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  const filtered = useMemo(() => {
    if (category === "All") return helpers;
    const needle = category.toLowerCase();
    return helpers.filter((h) => (h.type ?? "").toLowerCase().includes(needle));
  }, [category, helpers]);

  const createHelper = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", "Missing session token or household id.");
      return;
    }
    if (!newName.trim()) {
      showSnack("error", "Name is required.");
      return;
    }

    setBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helpers_create_${Date.now()}`,
        tool: "db.insert",
        args: {
          table: "helpers",
          record: {
            name: newName.trim(),
            type: newType.trim() || null,
            phone: newPhone.trim() || null,
            notes: newNotes.trim() || null,
          },
        },
        reason: "Create helper",
      },
    });
    setBusy(false);
    if (!res.ok) {
      showSnack("error", "error" in res ? res.error : "Create failed");
      return;
    }
    setDialogOpen(false);
    setNewName("");
    setNewType("");
    setNewPhone("");
    setNewNotes("");

    const { data, error } = await supabase
      .from("helpers")
      .select("id,household_id,name,type,phone,notes,created_at")
      .eq("household_id", hid)
      .order("created_at", { ascending: false });
    if (error) {
      showSnack("error", error.message);
      return;
    }
    setHelpers((data ?? []) as HelperRow[]);
    showSnack("success", "Helper created.");
  };

  const openTimeOff = async (helper: HelperRow) => {
    const hid = householdId.trim();
    if (!hid) return;
    setTimeOffHelper(helper);
    setTimeOffOpen(true);
    setTimeOffStart("");
    setTimeOffEnd("");
    setTimeOffReason("");
    setTimeOffRows([]);
    setTimeOffBusy(true);
    const { data, error } = await supabase
      .from("member_time_off")
      .select("id,household_id,member_kind,helper_id,start_at,end_at,reason,created_at")
      .eq("household_id", hid)
      .eq("member_kind", "helper")
      .eq("helper_id", helper.id)
      .order("start_at", { ascending: false })
      .limit(20);
    setTimeOffBusy(false);
    if (error) {
      showSnack("error", error.message);
      return;
    }
    setTimeOffRows((data ?? []) as TimeOffRow[]);
  };

  const createTimeOff = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const helper = timeOffHelper;
    if (!token || !hid || !helper) return;

    const startIso = normalizeDatetimeLocal(timeOffStart);
    const endIso = normalizeDatetimeLocal(timeOffEnd);
    if (!startIso || !endIso) {
      showSnack("error", "Start and end are required.");
      return;
    }

    setTimeOffBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `time_off_create_${helper.id}_${Date.now()}`,
        tool: "db.insert",
        args: {
          table: "member_time_off",
          record: {
            member_kind: "helper",
            helper_id: helper.id,
            start_at: startIso,
            end_at: endIso,
            reason: timeOffReason.trim() || null,
          },
        },
        reason: "Add helper time off",
      },
    });
    setTimeOffBusy(false);
    if (!res.ok) {
      showSnack("error", "error" in res ? res.error : "Create failed");
      return;
    }

    await openTimeOff(helper);
    showSnack("success", "Time off added.");
  };

  return (
    <Box sx={{ overflowY: "auto", height: "100%" }}>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Helpers &amp; Services</Typography>
          <Typography variant="body2" color="text.secondary">Manage household service providers</Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setDialogOpen(true)} sx={{ textTransform: "none" }}>
          Add Helper
        </Button>
      </Stack>

      {/* Category tabs */}
      <Tabs
        value={category}
        onChange={(_, v) => setCategory(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 3, borderBottom: "1px solid", borderColor: "divider" }}
      >
        {CATEGORIES.map((c) => (
          <Tab key={c} label={c} value={c} sx={{ textTransform: "none", minWidth: "unset" }} />
        ))}
      </Tabs>

      {/* Grid */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(280px, 1fr))" gap={2}>
        {busy && helpers.length === 0 ? (
          <Box display="flex" justifyContent="center" alignItems="center" py={6} gridColumn="1 / -1">
            <CircularProgress size={24} />
          </Box>
        ) : null}
        {loadError ? (
          <Box gridColumn="1 / -1">
            <Typography color="error">{loadError}</Typography>
          </Box>
        ) : null}
        {filtered.map((helper) => (
          <Card key={helper.id} variant="outlined">
            <CardHeader
              avatar={
                <Avatar sx={{ bgcolor: "primary.main", width: 44, height: 44 }}>
                  {initials(helper.name)}
                </Avatar>
              }
              title={<Typography variant="subtitle1" fontWeight={600}>{helper.name}</Typography>}
              subheader={helper.type ?? ""}
              action={<Box sx={{ cursor: "pointer", p: 1 }}><MoreVert fontSize="small" color="action" /></Box>}
              sx={{ pb: 1 }}
            />
            <Divider />
            <CardContent sx={{ pt: 1.5 }}>
              <Stack spacing={0.75} mb={1.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Phone fontSize="small" color="action" />
                  <Typography variant="body2" color="text.secondary">{helper.phone ?? ""}</Typography>
                </Stack>
                {helper.notes ? (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Schedule fontSize="small" color="action" />
                    <Typography variant="body2" color="text.secondary">{helper.notes}</Typography>
                  </Stack>
                ) : null}
              </Stack>

              <Stack direction="row" spacing={1} mb={2}>
                <Chip label={helper.type ?? "Helper"} size="small" variant="outlined" />
              </Stack>

              <Stack direction="row" spacing={1}>
                <Button variant="outlined" size="small" startIcon={<Phone fontSize="small" />} fullWidth sx={{ textTransform: "none" }}>
                  Call
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  fullWidth
                  sx={{ textTransform: "none" }}
                  onClick={() => void openTimeOff(helper)}
                >
                  Time off
                </Button>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Box>

      {/* Add Helper Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add New Helper</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="Name / Business Name" fullWidth size="small" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <TextField label="Role / Service Type" fullWidth size="small" value={newType} onChange={(e) => setNewType(e.target.value)} />
            <TextField label="Phone" fullWidth size="small" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            <TextField label="Notes" fullWidth size="small" multiline rows={2} value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={busy} onClick={() => void createHelper()}>Add Helper</Button>
        </DialogActions>
      </Dialog>

      {/* Time Off Dialog */}
      <Dialog open={timeOffOpen} onClose={() => setTimeOffOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Helper time off</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="subtitle2">{timeOffHelper?.name ?? ""}</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField
                label="Start"
                type="datetime-local"
                fullWidth
                size="small"
                value={timeOffStart}
                onChange={(e) => setTimeOffStart(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="End"
                type="datetime-local"
                fullWidth
                size="small"
                value={timeOffEnd}
                onChange={(e) => setTimeOffEnd(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Stack>
            <TextField
              label="Reason"
              fullWidth
              size="small"
              value={timeOffReason}
              onChange={(e) => setTimeOffReason(e.target.value)}
            />

            <Button variant="contained" disabled={timeOffBusy} onClick={() => void createTimeOff()} sx={{ alignSelf: "flex-start" }}>
              Add time off
            </Button>

            <Divider />
            <Typography variant="subtitle2">Recent time off</Typography>
            {timeOffBusy && timeOffRows.length === 0 ? (
              <Box display="flex" justifyContent="center" py={2}>
                <CircularProgress size={20} />
              </Box>
            ) : null}
            {timeOffRows.map((r) => (
              <Box key={r.id}>
                <Typography variant="body2">
                  {new Date(r.start_at).toLocaleString()} → {new Date(r.end_at).toLocaleString()}
                </Typography>
                {r.reason ? <Typography variant="caption" color="text.secondary">{r.reason}</Typography> : null}
              </Box>
            ))}
            {!timeOffBusy && timeOffRows.length === 0 ? (
              <Typography variant="body2" color="text.secondary">No time off recorded.</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTimeOffOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snackOpen} autoHideDuration={3000} onClose={() => setSnackOpen(false)}>
        <Alert severity={snackSeverity} onClose={() => setSnackOpen(false)}>
          {snackMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
}
