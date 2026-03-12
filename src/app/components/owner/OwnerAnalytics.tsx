import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import {
  BarChart,
  TrendingUp,
  ShowChart,
  Download,
  People,
} from "@mui/icons-material";

export function OwnerAnalytics() {
  const usageStats = [
    { label: "Total Households", value: "1,247", change: "+12.5%", trend: "up" },
    { label: "Active Users", value: "4,891", change: "+8.3%", trend: "up" },
    { label: "Daily Active Users", value: "892", change: "-2.1%", trend: "down" },
    { label: "Total Tasks Created", value: "28,453", change: "+15.7%", trend: "up" },
  ];

  const topFeatures = [
    { name: "Chores Management", usage: 95, users: 4650 },
    { name: "Recipes", usage: 78, users: 3815 },
    { name: "Alerts", usage: 85, users: 4157 },
    { name: "Chat Assistant", usage: 62, users: 3032 },
    { name: "Helpers Management", usage: 71, users: 3472 },
    { name: "Task Status", usage: 88, users: 4304 },
  ];

  const recentActivity = [
    { household: "Smith Family", action: "Created 3 new chores", time: "2 minutes ago" },
    { household: "Johnson Home", action: "Added 2 recipes", time: "15 minutes ago" },
    { household: "Williams Residence", action: "Scheduled helper appointment", time: "1 hour ago" },
    { household: "Brown Family", action: "Completed 5 tasks", time: "2 hours ago" },
    { household: "Davis Household", action: "New user signed up", time: "3 hours ago" },
  ];

  return (
    <Box p={4}>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            Analytics & Usage
          </Typography>
          <Typography color="textSecondary">
            Monitor app performance and user engagement
          </Typography>
        </Box>
        <Box display="flex" gap={2}>
          <FormControl size="small">
            <InputLabel>Time Range</InputLabel>
            <Select defaultValue="7days">
              <MenuItem value="24hours">Last 24 Hours</MenuItem>
              <MenuItem value="7days">Last 7 Days</MenuItem>
              <MenuItem value="30days">Last 30 Days</MenuItem>
              <MenuItem value="90days">Last 90 Days</MenuItem>
            </Select>
          </FormControl>
          <Button variant="outlined" startIcon={<Download />}>
            Export
          </Button>
        </Box>
      </Box>

      {/* Key Metrics */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(250px, 1fr))" gap={2} mb={4}>
        {usageStats.map((stat) => (
          <Card key={stat.label}>
            <CardContent>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                <Typography variant="body2" color="textSecondary">
                  {stat.label}
                </Typography>
                <TrendingUp color={stat.trend === "up" ? "success" : "error"} />
              </Box>
              <Typography variant="h5" fontWeight="bold">
                {stat.value}
              </Typography>
              <Typography
                variant="body2"
                color={stat.trend === "up" ? "success.main" : "error.main"}
              >
                {stat.change} from last period
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))" gap={4}>
        {/* Feature Usage */}
        <Card>
          <CardHeader
            title="Feature Usage"
            subheader="Most popular features by adoption rate"
          />
          <Divider />
          <CardContent>
            {topFeatures.map((feature) => (
              <Box key={feature.name} mb={2}>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="body2" fontWeight="bold">
                    {feature.name}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    {feature.users.toLocaleString()} users
                  </Typography>
                </Box>
                <Box
                  sx={{
                    height: 8,
                    backgroundColor: "grey.300",
                    borderRadius: 4,
                    overflow: "hidden",
                    mt: 1,
                  }}
                >
                  <Box
                    sx={{
                      width: `${feature.usage}%`,
                      height: "100%",
                      backgroundColor: "primary.main",
                    }}
                  />
                </Box>
                <Typography variant="caption" color="textSecondary">
                  {feature.usage}% adoption rate
                </Typography>
              </Box>
            ))}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader
            title="Recent Activity"
            subheader="Live updates from households"
          />
          <Divider />
          <CardContent>
            {recentActivity.map((activity, idx) => (
              <Box key={idx} mb={2}>
                <Typography variant="body2" fontWeight="bold">
                  {activity.household}
                </Typography>
                <Typography variant="body2" color="textSecondary">
                  {activity.action}
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  {activity.time}
                </Typography>
              </Box>
            ))}
          </CardContent>
        </Card>
      </Box>

      {/* User Growth Chart Placeholder */}
      <Card>
        <CardHeader
          title="User Growth Over Time"
          subheader="New user registrations and household growth"
        />
        <Divider />
        <CardContent>
          <Box
            height={200}
            display="flex"
            alignItems="center"
            justifyContent="center"
            sx={{
              backgroundColor: "grey.100",
              borderRadius: 2,
            }}
          >
            <Box textAlign="center">
              <BarChart color="disabled" fontSize="large" />
              <Typography variant="body2" color="textSecondary">
                Chart visualization would appear here
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
