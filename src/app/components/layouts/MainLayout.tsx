import { useCallback, useEffect, useState } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Rating,
  Select,
  Stack,
  TextField,
  Toolbar,
  Typography,
  AppBar,
} from "@mui/material";
import {
  Home,
  Assignment,
  MenuBook,
  People,
  NotificationsNone,
  Settings,
  Chat,
  BuildCircle,
  CheckBox,
  BarChart,
  HeadsetMic,
  Menu,
  Logout,
  Person,
  Feedback as FeedbackIcon,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";

type EscalationChoreRow = {
  id: string;
  household_id: string;
  title: string;
  status: string;
  due_at: string | null;
  metadata: Record<string, unknown> | null;
};

const NAV_ITEMS = [
  { name: "Dashboard",      path: "/",          icon: Home,            roles: ["household", "admin", "owner", "support"] },
  { name: "Chores",         path: "/chores",    icon: Assignment,      roles: ["household", "admin"] },
  { name: "Recipes",        path: "/recipes",   icon: MenuBook,        roles: ["household", "admin"] },
  { name: "Helpers",        path: "/helpers",   icon: People,          roles: ["household", "admin"] },
  { name: "Alerts",         path: "/alerts",    icon: NotificationsNone, roles: ["household", "admin", "support"] },
  { name: "Chat Assistant", path: "/chat",      icon: Chat,            roles: ["household", "admin"] },
  { name: "Task Status",    path: "/status",    icon: CheckBox,        roles: ["household", "admin", "support"] },
  { name: "Admin Config",   path: "/admin",     icon: Settings,        roles: ["admin"] },
  { name: "Analytics",      path: "/analytics", icon: BarChart,        roles: ["owner"] },
  { name: "Support Panel",  path: "/support",   icon: HeadsetMic,      roles: ["support"] },
];

type Role = "household" | "admin" | "owner" | "support";

export function MainLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut, user, householdId, accessToken } = useAuth();
  const [role, setRole] = useState<Role>("household");
  const [mobileOpen, setMobileOpen] = useState(false);

  const [profileOpen, setProfileOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileFullName, setProfileFullName] = useState("");

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackSuccess, setFeedbackSuccess] = useState<string | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<number | null>(5);
  const [feedbackMessage, setFeedbackMessage] = useState("");

  const onLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  const computeGraceHours = useCallback((cadence: string): number => {
    if (cadence === "daily") return 24;
    if (cadence === "weekly") return 72;
    if (cadence === "biweekly") return 96;
    if (cadence === "monthly") return 168;
    return 72;
  }, []);

  const runMaintenanceEscalation = useCallback(async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!hid || !token) return;

    const dbInsert = async (table: string, record: Record<string, unknown>, reason: string) => {
      return executeToolCall({
        accessToken: token,
        householdId: hid,
        scope: "household",
        toolCall: {
          id: `maint_ins_${table}_${Date.now()}`,
          tool: "db.insert",
          args: { table, record },
          reason,
        },
      });
    };

    const dbUpdate = async (table: string, id: string, patch: Record<string, unknown>, reason: string) => {
      return executeToolCall({
        accessToken: token,
        householdId: hid,
        scope: "household",
        toolCall: {
          id: `maint_upd_${table}_${Date.now()}`,
          tool: "db.update",
          args: { table, id, patch },
          reason,
        },
      });
    };

    const { data: chores, error: choresError } = await supabase
      .from("chores")
      .select("id,household_id,title,status,due_at,metadata")
      .eq("household_id", hid)
      .neq("status", "completed")
      .not("due_at", "is", null)
      .filter("metadata->>maintenance", "eq", "true")
      .limit(50);

    if (choresError) return;
    const rows = (chores ?? []) as EscalationChoreRow[];
    if (rows.length === 0) return;

    const nowMs = Date.now();
    for (const c of rows) {
      if (!c.due_at) continue;

      const meta = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? c.metadata : {};
      const escalation = (meta as any).escalation && typeof (meta as any).escalation === "object" ? (meta as any).escalation : {};
      const escalatedAt = typeof escalation.escalated_at === "string" ? String(escalation.escalated_at).trim() : "";
      if (escalatedAt) continue;

      const cadence = typeof (meta as any).cadence === "string" ? String((meta as any).cadence).trim() : "";
      const graceHours = typeof escalation.grace_hours === "number" ? escalation.grace_hours : computeGraceHours(cadence);
      const dueMs = new Date(c.due_at).getTime();
      if (!Number.isFinite(dueMs)) continue;

      const overdueByHours = (nowMs - dueMs) / (1000 * 60 * 60);
      if (overdueByHours <= graceHours) continue;

      const scheduleLabel = typeof (meta as any).schedule_label === "string" ? String((meta as any).schedule_label).trim() : "";
      const equipmentType = typeof (meta as any).equipment_type === "string" ? String((meta as any).equipment_type).trim() : "";
      const equipmentLabel = typeof (meta as any).equipment_label === "string" ? String((meta as any).equipment_label).trim() : "";
      const equipmentSuffix = `${equipmentType ? `${equipmentType} ` : ""}${equipmentLabel}`.trim();

      const title = `Maintenance overdue: ${c.title}${equipmentSuffix ? ` (${equipmentSuffix})` : ""}`;
      const body = `${scheduleLabel ? `Due: ${scheduleLabel}. ` : ""}Overdue by ~${Math.max(1, Math.floor(overdueByHours / 24))} day(s).`;
      const severity = overdueByHours > graceHours + 72 ? 3 : 2;

      const { data: existingAlerts, error: alertLookupError } = await supabase
        .from("alerts")
        .select("id,status")
        .eq("household_id", hid)
        .eq("status", "open")
        .filter("metadata->>maintenance_chore_id", "eq", c.id)
        .limit(1);

      if (alertLookupError) continue;

      const existingAlertId = existingAlerts?.[0]?.id ? String(existingAlerts[0].id) : "";

      const alertPayload = {
        household_id: hid,
        title,
        body,
        severity,
        status: "open",
        scheduled_at: null,
        resolved_at: null,
        metadata: {
          source: "maintenance_escalation",
          maintenance_chore_id: c.id,
        },
      };

      if (existingAlertId) {
        const updRes = await dbUpdate("alerts", existingAlertId, alertPayload as unknown as Record<string, unknown>, "Update maintenance escalation alert");
        if (!updRes.ok) continue;
      } else {
        const insRes = await dbInsert("alerts", alertPayload as unknown as Record<string, unknown>, "Create maintenance escalation alert");
        if (!insRes.ok) continue;
      }

      const updatedMeta = {
        ...meta,
        escalation: {
          ...escalation,
          grace_hours: graceHours,
          escalated_at: new Date().toISOString(),
          alert_id: existingAlertId || null,
        },
      };

      const updChoreRes = await dbUpdate(
        "chores",
        c.id,
        { metadata: updatedMeta } as Record<string, unknown>,
        "Mark maintenance chore escalated",
      );
      if (!updChoreRes.ok) continue;
    }
  }, [computeGraceHours, householdId, accessToken]);

  useEffect(() => {
    if (!user?.id) return;
    if (!householdId.trim()) return;

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        await runMaintenanceEscalation();
      } catch {
        // ignore
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [user?.id, householdId, runMaintenanceEscalation]);

  const openAgentSetup = () => {
    if (!location.pathname.startsWith("/chat")) {
      navigate("/chat");
    }
    try {
      window.dispatchEvent(new Event("homeops:open-agent-setup"));
    } catch {
      // ignore
    }
  };

  const openProfile = async () => {
    setProfileError(null);
    setProfileOpen(true);
    if (!user?.id) return;
    setProfileBusy(true);
    const { data, error } = await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
    setProfileBusy(false);
    if (error) {
      setProfileError("We couldn't load your profile right now.");
      return;
    }
    const fromDb = data?.full_name ? String(data.full_name) : "";
    const fromMeta = typeof (user.user_metadata as any)?.full_name === "string" ? String((user.user_metadata as any).full_name) : "";
    setProfileFullName(fromDb || fromMeta || "");
  };

  const saveProfile = async () => {
    if (!user?.id) return;
    setProfileError(null);
    setProfileBusy(true);
    const next = profileFullName.trim();
    const { error } = await supabase.from("profiles").update({ full_name: next || null }).eq("id", user.id);
    setProfileBusy(false);
    if (error) {
      setProfileError("We couldn't save your profile. Please try again.");
      return;
    }
    setProfileOpen(false);
  };

  const submitFeedback = async () => {
    if (!user?.id) {
      setFeedbackError("Please log in to send feedback.");
      return;
    }
    const rating = typeof feedbackRating === "number" ? Math.floor(feedbackRating) : null;
    if (!rating || rating < 1 || rating > 5) {
      setFeedbackError("Please select a rating (1 to 5).");
      return;
    }
    setFeedbackError(null);
    setFeedbackSuccess(null);
    setFeedbackBusy(true);
    const { error } = await supabase.from("app_feedback").insert({
      user_id: user.id,
      household_id: householdId.trim() || null,
      rating,
      message: feedbackMessage.trim() || null,
      page: typeof window !== "undefined" ? window.location.pathname : null,
      metadata: { source: "drawer" },
    });
    setFeedbackBusy(false);
    if (error) {
      setFeedbackError("We couldn't send your feedback right now. Please try again.");
      return;
    }
    setFeedbackSuccess("Thanks — your feedback was sent.");
    setFeedbackMessage("");
    setFeedbackRating(5);
  };

  const navItems = NAV_ITEMS.filter((item) => item.roles.includes(role));

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <List dense>
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive =
          item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path);
        return (
          <ListItem key={item.path} disablePadding>
            <ListItemButton
              component={Link}
              to={item.path}
              onClick={onNavigate}
              selected={isActive}
              sx={{
                borderRadius: 1,
                mx: 0.5,
                "&.Mui-selected": {
                  bgcolor: "action.selected",
                  "& .MuiListItemIcon-root": { color: "primary.main" },
                  "& .MuiListItemText-primary": { fontWeight: 600 },
                },
              }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>
                <Icon fontSize="small" color={isActive ? "primary" : "inherit"} />
              </ListItemIcon>
              <ListItemText primary={item.name} />
            </ListItemButton>
          </ListItem>
        );
      })}
    </List>
  );

  const drawerContent = (
    <>
      <Toolbar sx={{ px: 2 }}>
        <Box>
          <Typography variant="h6" fontWeight={700}>
            HomeOps
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Household Manager
          </Typography>
        </Box>
      </Toolbar>
      <Box sx={{ flex: 1, overflowY: "auto" }}>
        <NavLinks />
      </Box>
      <Box sx={{ p: 2, borderTop: "1px solid", borderColor: "divider" }}>
        <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
          Role (Demo)
        </Typography>
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          fullWidth
          size="small"
        >
          <MenuItem value="household">Household User</MenuItem>
          <MenuItem value="admin">Admin</MenuItem>
          <MenuItem value="owner">Owner / Dev</MenuItem>
          <MenuItem value="support">Support Staff</MenuItem>
        </Select>

        <Stack spacing={1} sx={{ mt: 1.5 }}>
          <Button
            variant="outlined"
            fullWidth
            startIcon={<BuildCircle fontSize="small" />}
            onClick={openAgentSetup}
            sx={{ textTransform: "none" }}
          >
            Agent Setup
          </Button>
          <Button
            variant="outlined"
            fullWidth
            startIcon={<Person fontSize="small" />}
            onClick={openProfile}
            sx={{ textTransform: "none" }}
          >
            Profile
          </Button>
          <Button
            variant="outlined"
            fullWidth
            startIcon={<FeedbackIcon fontSize="small" />}
            onClick={() => {
              setFeedbackOpen(true);
              setFeedbackError(null);
              setFeedbackSuccess(null);
            }}
            sx={{ textTransform: "none" }}
          >
            Send feedback
          </Button>
        </Stack>

        <Button
          variant="outlined"
          fullWidth
          startIcon={<Logout fontSize="small" />}
          onClick={onLogout}
          sx={{ mt: 1.5, textTransform: "none" }}
        >
          Logout
        </Button>
      </Box>
    </>
  );

  return (
    <Box display="flex" height="100vh" overflow="hidden">
      {/* Desktop permanent drawer */}
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: "none", md: "flex" },
          width: 240,
          flexShrink: 0,
          "& .MuiDrawer-paper": {
            width: 240,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
          },
        }}
      >
        {drawerContent}
      </Drawer>

      {/* Mobile AppBar + temporary drawer */}
      <AppBar position="fixed" sx={{ display: { md: "none" } }}>
        <Toolbar>
          <IconButton color="inherit" edge="start" onClick={() => setMobileOpen(true)} sx={{ mr: 1 }}>
            <Menu />
          </IconButton>
          <Typography variant="h6" fontWeight={700} sx={{ flexGrow: 1 }}>
            HomeOps
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: "flex", md: "none" },
          "& .MuiDrawer-paper": {
            width: 240,
            display: "flex",
            flexDirection: "column",
          },
        }}
      >
        {drawerContent}
      </Drawer>

      {/* Main content */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          p: 3,
          mt: { xs: 8, md: 0 },
        }}
      >
        <Outlet />
      </Box>

      <Dialog open={profileOpen} onClose={() => setProfileOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Profile</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={1}>
            {profileError ? <Typography color="error">{profileError}</Typography> : null}
            <TextField
              label="Your name"
              value={profileFullName}
              onChange={(e) => setProfileFullName(e.target.value)}
              fullWidth
              size="small"
              disabled={profileBusy}
            />
            <TextField label="Email" value={user?.email ? String(user.email) : ""} fullWidth size="small" disabled />
            <TextField label="Home ID" value={householdId.trim()} fullWidth size="small" disabled />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={() => setProfileOpen(false)} disabled={profileBusy}>
            Close
          </Button>
          <Button variant="contained" onClick={saveProfile} disabled={profileBusy}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Feedback</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={1}>
            {feedbackError ? <Typography color="error">{feedbackError}</Typography> : null}
            {feedbackSuccess ? <Typography color="success.main">{feedbackSuccess}</Typography> : null}
            <Box>
              <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                Rating
              </Typography>
              <Rating value={feedbackRating} onChange={(_, v) => setFeedbackRating(v)} />
            </Box>
            <TextField
              label="What can we improve? (optional)"
              value={feedbackMessage}
              onChange={(e) => setFeedbackMessage(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={3}
              disabled={feedbackBusy}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={() => setFeedbackOpen(false)} disabled={feedbackBusy}>
            Close
          </Button>
          <Button variant="contained" onClick={submitFeedback} disabled={feedbackBusy}>
            Send
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
