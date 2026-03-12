import { Link } from "react-router";
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Divider,
  LinearProgress,
  Typography,
} from "@mui/material";
import {
  Assignment,
  MenuBook,
  Group,
  Notifications,
  TrendingUp,
  CheckCircle,
  Warning,
  CalendarToday,
} from "@mui/icons-material";

export function Dashboard() {
  const stats = [
    { name: "Active Chores",       value: "12", icon: Assignment,    color: "primary" as const },
    { name: "Saved Recipes",       value: "48", icon: MenuBook,      color: "success" as const },
    { name: "Household Members",   value: "5",  icon: Group,         color: "secondary" as const },
    { name: "Active Alerts",       value: "3",  icon: Notifications, color: "error" as const },
  ];

  const upcomingChores = [
    { id: 1, name: "Take out trash",     assignee: "John",  due: "Today, 6:00 PM",       status: "pending" },
    { id: 2, name: "Grocery shopping",   assignee: "Sarah", due: "Tomorrow, 10:00 AM",   status: "in-progress" },
    { id: 3, name: "Clean bathrooms",    assignee: "Mike",  due: "Mar 3, 2:00 PM",       status: "pending" },
  ];

  const recentAlerts = [
    { id: 1, message: "Low on milk — add to shopping list",     type: "info",    time: "2 hours ago" },
    { id: 2, message: "Water bill payment due in 3 days",       type: "warning", time: "5 hours ago" },
    { id: 3, message: "HVAC maintenance scheduled for Mar 5",   type: "info",    time: "1 day ago" },
  ];

  return (
    <Box sx={{ overflowY: "auto", height: "100%" }}>
      <Box mb={3}>
        <Typography variant="h5" fontWeight={700}>Dashboard</Typography>
        <Typography variant="body2" color="text.secondary">
          Welcome back! Here's what's happening in your home.
        </Typography>
      </Box>

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
            title="Upcoming Chores"
            subheader="Tasks this week"
            action={<Button component={Link} to="/chores" size="small">View All</Button>}
          />
          <Divider />
          <CardContent>
            {upcomingChores.map((chore) => (
              <Box key={chore.id} display="flex" alignItems="center" gap={1.5} mb={1.5}>
                {chore.status === "in-progress" ? <TrendingUp color="warning" /> : <CheckCircle color="action" />}
                <Box>
                  <Typography variant="body2" fontWeight={600}>{chore.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {chore.assignee} · {chore.due}
                  </Typography>
                </Box>
              </Box>
            ))}
          </CardContent>
        </Card>

        {/* Recent Alerts */}
        <Card variant="outlined">
          <CardHeader
            title="Recent Alerts"
            subheader="Notifications and reminders"
            action={<Button component={Link} to="/alerts" size="small">View All</Button>}
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
        <CardHeader title="March Progress" subheader="Task completion this month" />
        <Divider />
        <CardContent>
          <LinearProgress variant="determinate" value={71} sx={{ height: 8, borderRadius: 4, mb: 1 }} />
          <Typography variant="caption" color="text.secondary">32 / 45 tasks (71%)</Typography>
          <Box display="grid" gridTemplateColumns="repeat(3,1fr)" gap={2} mt={2} textAlign="center">
            {[["32","Completed","success.main"], ["8","In Progress","warning.main"], ["5","Overdue","error.main"]].map(
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
        <CardHeader title="Quick Actions" />
        <Divider />
        <CardContent>
          <Box display="flex" gap={1.5} flexWrap="wrap">
            {[
              { to: "/chores",  icon: Assignment,    label: "Add Chore" },
              { to: "/recipes", icon: MenuBook,       label: "Add Recipe" },
              { to: "/chat",    icon: CalendarToday,  label: "Chat Assistant" },
              { to: "/status",  icon: CheckCircle,    label: "View Status" },
            ].map(({ to, icon: Icon, label }) => (
              <Button key={to} variant="outlined" component={Link} to={to} startIcon={<Icon />} sx={{ textTransform: "none" }}>
                {label}
              </Button>
            ))}
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
