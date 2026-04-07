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
import { useI18n } from "../../i18n";

export function OwnerAnalytics() {
  const { t } = useI18n();
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
            {t("analytics.title")}
          </Typography>
          <Typography color="textSecondary">
            {t("analytics.subtitle")}
          </Typography>
        </Box>
        <Box display="flex" gap={2}>
          <FormControl size="small">
            <InputLabel>{t("analytics.time_range")}</InputLabel>
            <Select defaultValue="7days">
              <MenuItem value="24hours">{t("analytics.last_24_hours")}</MenuItem>
              <MenuItem value="7days">{t("analytics.last_7_days")}</MenuItem>
              <MenuItem value="30days">{t("analytics.last_30_days")}</MenuItem>
              <MenuItem value="90days">{t("analytics.last_90_days")}</MenuItem>
            </Select>
          </FormControl>
          <Button variant="outlined" startIcon={<Download />}>
            {t("analytics.export")}
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
                {stat.change} {t("analytics.from_last_period")}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))" gap={4}>
        {/* Feature Usage */}
        <Card>
          <CardHeader
            title={t("analytics.feature_usage")}
            subheader={t("analytics.feature_usage_subtitle")}
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
                    {feature.users.toLocaleString()} {t("analytics.users")}
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
                  {feature.usage}% {t("analytics.adoption_rate")}
                </Typography>
              </Box>
            ))}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader
            title={t("analytics.recent_activity")}
            subheader={t("analytics.recent_activity_subtitle")}
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
          title={t("analytics.user_growth")}
          subheader={t("analytics.user_growth_subtitle")}
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
                {t("analytics.chart_placeholder")}
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
