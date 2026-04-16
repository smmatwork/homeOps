import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  Assignment,
  MenuBook,
  Group,
  Notifications,
  TrendingUp,
  CheckCircle,
  Edit,
  Warning,
  CalendarToday,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";

type ChoreRow = {
  id: string;
  household_id: string;
  title: string;
  status: string;
  priority: number;
  due_at: string | null;
  completed_at: string | null;
  helper_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type HelperRow = {
  id: string;
  household_id: string;
  name: string;
  type: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
};

function datetimeLocalFromIso(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function isoFromDatetimeLocal(value: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function Dashboard() {
  const { accessToken, householdId, user } = useAuth();
  const { t } = useI18n();
  const [chores, setChores] = useState<ChoreRow[]>([]);
  const [helpers, setHelpers] = useState<HelperRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [setupState, setSetupState] = useState<{ loaded: boolean; remaining: string[] }>({ loaded: false, remaining: [] });

  const [editOpen, setEditOpen] = useState(false);
  const [editChore, setEditChore] = useState<ChoreRow | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editStatus, setEditStatus] = useState("pending");
  const [editPriority, setEditPriority] = useState("1");
  const [editDueAt, setEditDueAt] = useState("");
  const [editHelperId, setEditHelperId] = useState<string>("");
  const [editSpace, setEditSpace] = useState("");
  const [editSubspace, setEditSubspace] = useState("");
  const [editCadence, setEditCadence] = useState("");

  const stats = [
    { name: "Active Chores",       value: "12", icon: Assignment,    color: "primary" as const },
    { name: "Saved Recipes",       value: "48", icon: MenuBook,      color: "success" as const },
    { name: "Household Members",   value: "5",  icon: Group,         color: "secondary" as const },
    { name: "Active Alerts",       value: "3",  icon: Notifications, color: "error" as const },
  ];

  const recentAlerts = [
    { id: 1, message: "Low on milk — add to shopping list",     type: "info",    time: "2 hours ago" },
    { id: 2, message: "Water bill payment due in 3 days",       type: "warning", time: "5 hours ago" },
    { id: 3, message: "HVAC maintenance scheduled for Mar 5",   type: "info",    time: "1 day ago" },
  ];

  const upcomingChores = useMemo(() => {
    return chores
      .filter((c) => c.status !== "completed")
      .slice(0, 8);
  }, [chores]);

  useEffect(() => {
    if (!householdId.trim()) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      const hid = householdId.trim();

      const choresReq = supabase
        .from("chores")
        .select("id,household_id,title,status,priority,due_at,completed_at,helper_id,metadata,created_at")
        .eq("household_id", hid)
        .is("deleted_at", null)
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(50);

      const helpersReq = supabase
        .from("helpers")
        .select("id,household_id,name,type,phone,notes,created_at")
        .eq("household_id", hid)
        .order("created_at", { ascending: false });

      const [choresRes, helpersRes] = await Promise.all([choresReq, helpersReq]);

      if (cancelled) return;
      setBusy(false);
      if (choresRes.error) {
        setChores([]);
      } else {
        setChores((choresRes.data ?? []) as ChoreRow[]);
      }
      if (helpersRes.error) {
        setHelpers([]);
      } else {
        setHelpers((helpersRes.data ?? []) as HelperRow[]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [householdId]);

  // Detect onboarding setup state for the "Continue Setup" banner
  useEffect(() => {
    const hid = householdId?.trim();
    const uid = user?.id;
    if (!hid || !uid) return;
    let cancelled = false;
    (async () => {
      const { detectOnboardingState, buildOnboardingContext } = await import("../../services/onboardingState");
      const state = await detectOnboardingState(hid, uid);
      if (cancelled) return;
      const remaining: string[] = [];
      if (!state.homeProfileExists) remaining.push(t("dashboard.setup_home_profile"));
      else if (!state.hasFeatures) remaining.push(t("dashboard.setup_features"));
      if (state.choreCount === 0) remaining.push(t("dashboard.setup_chores"));
      if (state.helperCount === 0) remaining.push(t("dashboard.setup_helpers"));
      setSetupState({ loaded: true, remaining });
    })();
    return () => { cancelled = true; };
  }, [householdId, user?.id, t]);

  const helperName = (helperId: string | null): string => {
    if (!helperId) return "Unassigned";
    const h = helpers.find((x) => x.id === helperId);
    return h?.name ? String(h.name) : "Unassigned";
  };

  const dueLabel = (iso: string | null): string => {
    if (!iso) return "No due date";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "No due date";
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

  const openEdit = (chore: ChoreRow) => {
    setEditChore(chore);
    setEditTitle(chore.title ?? "");
    setEditStatus(chore.status ?? "pending");
    setEditPriority(String(typeof chore.priority === "number" && Number.isFinite(chore.priority) ? chore.priority : 1));
    setEditDueAt(datetimeLocalFromIso(chore.due_at));
    setEditHelperId(chore.helper_id ?? "");
    const meta = chore.metadata && typeof chore.metadata === "object" && !Array.isArray(chore.metadata) ? chore.metadata : {};
    setEditSpace(typeof (meta as any).space === "string" ? String((meta as any).space).trim() : "");
    setEditSubspace(typeof (meta as any).subspace === "string" ? String((meta as any).subspace).trim() : "");
    setEditCadence(typeof (meta as any).cadence === "string" ? String((meta as any).cadence).trim() : "");
    setEditOpen(true);
  };

  const saveEdit = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid || !editChore?.id) return;

    const nextPriority = Math.max(1, Math.min(3, Number(editPriority) || 1));
    const nextDueAt = isoFromDatetimeLocal(editDueAt);

    const baseMeta: Record<string, unknown> =
      editChore.metadata && typeof editChore.metadata === "object" && !Array.isArray(editChore.metadata)
        ? (editChore.metadata as Record<string, unknown>)
        : {};
    const nextMeta: Record<string, unknown> = { ...baseMeta };
    if (editSpace.trim()) nextMeta.space = editSpace.trim();
    else delete (nextMeta as any).space;
    if (editSubspace.trim()) nextMeta.subspace = editSubspace.trim();
    else delete (nextMeta as any).subspace;
    if (editCadence.trim()) nextMeta.cadence = editCadence.trim();
    else delete (nextMeta as any).cadence;

    setEditBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `dashboard_chore_update_${editChore.id}_${Date.now()}`,
        tool: "db.update",
        args: {
          table: "chores",
          id: editChore.id,
          patch: {
            title: editTitle.trim() || editChore.title,
            status: editStatus,
            priority: nextPriority,
            due_at: nextDueAt,
            helper_id: editHelperId.trim() || null,
            metadata: nextMeta,
          },
        },
        reason: "Edit chore from Dashboard",
      },
    });
    setEditBusy(false);
    if (!res.ok) return;

    const { data, error } = await supabase
      .from("chores")
      .select("id,household_id,title,status,priority,due_at,completed_at,helper_id,metadata,created_at")
      .eq("household_id", hid)
      .is("deleted_at", null)
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (!error) setChores((data ?? []) as ChoreRow[]);

    setEditOpen(false);
    setEditChore(null);
  };

  return (
    <Box sx={{ overflowY: "auto", height: "100%" }}>
      <Box mb={3}>
        <Typography variant="h5" fontWeight={700}>{t("dashboard.title")}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t("dashboard.subtitle")}
        </Typography>
      </Box>

      {/* Setup progress banner — shown when onboarding steps are incomplete */}
      {setupState.loaded && setupState.remaining.length > 0 && (
        <Card variant="outlined" sx={{ mb: 3, bgcolor: "primary.50", borderColor: "primary.200" }}>
          <CardContent sx={{ py: 2 }}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }} justifyContent="space-between">
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  {t("dashboard.setup_incomplete")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {setupState.remaining.join(" · ")}
                </Typography>
              </Box>
              <Button
                variant="contained"
                size="small"
                href="/chat?onboarding=true"
                sx={{ whiteSpace: "nowrap" }}
              >
                {t("dashboard.continue_setup")}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap={2} mb={3}>
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.name} variant="outlined">
              <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="center">
                  <Box>
                    <Typography variant="caption" color="text.secondary">{stat.name}</Typography>
                    <Typography variant="h5" fontWeight={700}>{stat.value}</Typography>
                  </Box>
                  <Icon color={stat.color} fontSize="large" />
                </Box>
              </CardContent>
            </Card>
          );
        })}
      </Box>

      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" gap={3} mb={3}>
        {/* Upcoming Chores */}
        <Card variant="outlined">
          <CardHeader
            title={t("dashboard.upcoming_chores")}
            subheader={t("dashboard.tasks_this_week")}
            action={<Button component={Link} to="/chores" size="small">{t("dashboard.view_all")}</Button>}
          />
          <Divider />
          <CardContent>
            {busy ? (
              <Typography variant="caption" color="text.secondary">{t("common.loading")}</Typography>
            ) : null}
            {upcomingChores.map((chore) => (
              <Box key={chore.id} display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={1.5}>
                <Box display="flex" alignItems="center" gap={1.5} sx={{ minWidth: 0 }}>
                  {chore.status === "in-progress" ? <TrendingUp color="warning" /> : <CheckCircle color="action" />}
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={600} noWrap title={chore.title}>
                      {chore.title}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {helperName(chore.helper_id)} · {dueLabel(chore.due_at)}
                    </Typography>
                  </Box>
                </Box>
                <IconButton size="small" onClick={() => openEdit(chore)} aria-label="Edit chore">
                  <Edit fontSize="small" />
                </IconButton>
              </Box>
            ))}
            {!busy && upcomingChores.length === 0 ? (
              <Typography variant="body2" color="text.secondary">{t("dashboard.no_upcoming_chores")}</Typography>
            ) : null}
          </CardContent>
        </Card>

        {/* Recent Alerts */}
        <Card variant="outlined">
          <CardHeader
            title={t("dashboard.recent_alerts")}
            subheader={t("dashboard.notifications_and_reminders")}
            action={<Button component={Link} to="/alerts" size="small">{t("dashboard.view_all")}</Button>}
          />
          <Divider />
          <CardContent>
            {recentAlerts.map((alert) => (
              <Box key={alert.id} display="flex" alignItems="center" gap={1.5} mb={1.5}>
                {alert.type === "warning" ? <Warning color="warning" /> : <Notifications color="info" />}
                <Box>
                  <Typography variant="body2">{alert.message}</Typography>
                  <Typography variant="caption" color="text.secondary">{alert.time}</Typography>
                </Box>
              </Box>
            ))}
          </CardContent>
        </Card>
      </Box>

      {/* Completion */}
      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardHeader title={t("dashboard.progress_title")} subheader={t("dashboard.progress_subtitle")} />
        <Divider />
        <CardContent>
          <LinearProgress variant="determinate" value={71} sx={{ height: 8, borderRadius: 4, mb: 1 }} />
          <Typography variant="caption" color="text.secondary">32 / 45 tasks (71%)</Typography>
          <Box display="grid" gridTemplateColumns="repeat(3,1fr)" gap={2} mt={2} textAlign="center">
            {[["32",t("dashboard.completed"),"success.main"], ["8",t("dashboard.in_progress"),"warning.main"], ["5",t("dashboard.overdue"),"error.main"]].map(
              ([v, l, c]) => (
                <Box key={l}>
                  <Typography variant="h5" color={c} fontWeight={700}>{v}</Typography>
                  <Typography variant="caption" color="text.secondary">{l}</Typography>
                </Box>
              )
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Quick actions */}
      <Card variant="outlined">
        <CardHeader title={t("dashboard.quick_actions")} />
        <Divider />
        <CardContent>
          <Box display="flex" gap={1.5} flexWrap="wrap">
            {[
              { to: "/chores",  icon: Assignment,    label: t("dashboard.add_chore") },
              { to: "/recipes", icon: MenuBook,       label: t("dashboard.add_recipe") },
              { to: "/chat",    icon: CalendarToday,  label: t("dashboard.chat_assistant") },
              { to: "/status",  icon: CheckCircle,    label: t("dashboard.view_status") },
            ].map(({ to, icon: Icon, label }) => (
              <Button key={to} variant="outlined" component={Link} to={to} startIcon={<Icon />} sx={{ textTransform: "none" }}>
                {label}
              </Button>
            ))}
          </Box>
        </CardContent>
      </Card>

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit chore</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2} mt={1}>
            <TextField
              label="Title"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              fullWidth
              size="small"
            />
            <Box display="grid" gridTemplateColumns={{ xs: "1fr", sm: "1fr 1fr" }} gap={2}>
              <FormControl fullWidth size="small">
                <InputLabel>Status</InputLabel>
                <Select
                  label="Status"
                  value={editStatus}
                  onChange={(e) => setEditStatus(String(e.target.value))}
                >
                  <MenuItem value="pending">pending</MenuItem>
                  <MenuItem value="in-progress">in-progress</MenuItem>
                  <MenuItem value="completed">completed</MenuItem>
                </Select>
              </FormControl>
              <TextField
                label="Priority (1-3)"
                value={editPriority}
                onChange={(e) => setEditPriority(e.target.value)}
                fullWidth
                size="small"
              />
            </Box>
            <TextField
              label="Due"
              type="datetime-local"
              value={editDueAt}
              onChange={(e) => setEditDueAt(e.target.value)}
              fullWidth
              size="small"
              InputLabelProps={{ shrink: true }}
            />
            <Box display="grid" gridTemplateColumns={{ xs: "1fr", sm: "1fr 1fr" }} gap={2}>
              <TextField
                label="Space"
                value={editSpace}
                onChange={(e) => setEditSpace(e.target.value)}
                fullWidth
                size="small"
              />
              <TextField
                label="Subspace"
                value={editSubspace}
                onChange={(e) => setEditSubspace(e.target.value)}
                fullWidth
                size="small"
              />
            </Box>
            <Box display="grid" gridTemplateColumns={{ xs: "1fr", sm: "1fr 1fr" }} gap={2}>
              <FormControl fullWidth size="small">
                <InputLabel>Cadence</InputLabel>
                <Select
                  label="Cadence"
                  value={editCadence}
                  onChange={(e) => setEditCadence(String(e.target.value))}
                >
                  <MenuItem value="">(none)</MenuItem>
                  <MenuItem value="daily">daily</MenuItem>
                  <MenuItem value="weekly">weekly</MenuItem>
                  <MenuItem value="biweekly">biweekly</MenuItem>
                  <MenuItem value="monthly">monthly</MenuItem>
                </Select>
              </FormControl>
            </Box>
            <FormControl fullWidth size="small">
              <InputLabel>Helper</InputLabel>
              <Select
                label="Helper"
                value={editHelperId}
                onChange={(e) => setEditHelperId(String(e.target.value))}
              >
                <MenuItem value="">Unassigned</MenuItem>
                {helpers.map((h) => (
                  <MenuItem key={h.id} value={h.id}>
                    {h.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={() => setEditOpen(false)} disabled={editBusy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={saveEdit} disabled={editBusy || !editChore}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
