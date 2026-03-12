import { useState } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router";
import {
  Box,
  Button,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
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
  CheckBox,
  BarChart,
  HeadsetMic,
  Menu,
  Logout,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";

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
  const { signOut } = useAuth();
  const [role, setRole] = useState<Role>("household");
  const [mobileOpen, setMobileOpen] = useState(false);

  const onLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
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
    </Box>
  );
}
