import { useState } from "react";
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
  Tab,
  Tabs,
  Typography,
  Chip,
  LinearProgress,
} from "@mui/material";
import {
  CheckCircle,
  AccessTime,
  ErrorOutline,
  TrendingUp,
  CalendarToday,
  Download,
} from "@mui/icons-material";
import { useI18n } from "../../i18n";

export function TaskStatus() {
  const { t } = useI18n();
  const [statusFilter, setStatusFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState("all");

  const tasks = [
    {
      id: 1,
      title: "Take out trash",
      type: "Chore",
      assignee: "John",
      dueDate: "Mar 1, 2026",
      status: "completed",
      completedDate: "Mar 1, 2026 5:45 PM",
      priority: "high",
      notes: "Completed on time",
    },
    {
      id: 2,
      title: "Grocery shopping",
      type: "Chore",
      assignee: "Sarah",
      dueDate: "Mar 2, 2026",
      status: "in-progress",
      startedDate: "Mar 1, 2026 2:00 PM",
      priority: "medium",
      notes: "Currently at the store",
    },
    {
      id: 3,
      title: "Clean bathrooms",
      type: "Chore",
      assignee: "Mike",
      dueDate: "Mar 3, 2026",
      status: "pending",
      priority: "medium",
      notes: "Waiting to start",
    },
    {
      id: 4,
      title: "Water bill payment",
      type: "Bill",
      assignee: "Sarah",
      dueDate: "Mar 4, 2026",
      status: "pending",
      priority: "high",
      notes: "Amount: $87.50",
    },
    {
      id: 5,
      title: "HVAC maintenance",
      type: "Maintenance",
      assignee: "Scheduled Service",
      dueDate: "Mar 5, 2026",
      status: "scheduled",
      priority: "high",
      notes: "Technician confirmed",
    },
  ];

  const stats = {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    inProgress: tasks.filter((t) => t.status === "in-progress").length,
    pending: tasks.filter((t) => t.status === "pending").length,
    overdue: tasks.filter((t) => t.status === "overdue").length,
  };

  const completionRate = Math.round((stats.completed / stats.total) * 100);

  const filteredTasks = tasks.filter((task) => {
    const matchesStatus = statusFilter === "all" || task.status === statusFilter;
    return matchesStatus;
  });

  const getStatusChipColor = (status: string) => {
    switch (status) {
      case "completed":
        return "success";
      case "in-progress":
        return "warning";
      case "scheduled":
        return "info";
      case "overdue":
        return "error";
      default:
        return "default";
    }
  };

  return (
    <Box p={4}>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            {t("task_status.title")}
          </Typography>
          <Typography color="textSecondary">
            {t("task_status.subtitle")}
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<Download />}>
          {t("task_status.export")}
        </Button>
      </Box>

      {/* Stats Overview */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))" gap={2} mb={4}>
        <Card>
          <CardContent>
            <Typography variant="h5" fontWeight="bold">
              {stats.total}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              {t("task_status.total_tasks")}
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h5" color="success.main" fontWeight="bold">
              {stats.completed}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              {t("task_status.completed")}
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h5" color="warning.main" fontWeight="bold">
              {stats.inProgress}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              {t("task_status.in_progress")}
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h5" color="textSecondary" fontWeight="bold">
              {stats.pending}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              {t("task_status.pending")}
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h5" color="error.main" fontWeight="bold">
              {stats.overdue}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              {t("task_status.overdue")}
            </Typography>
          </CardContent>
        </Card>
      </Box>

      {/* Completion Rate */}
      <Card>
        <CardHeader
          title={t("task_status.overall_completion")}
          subheader={t("task_status.progress_subtitle")}
        />
        <Divider />
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="body2" color="textSecondary">
              {t("task_status.completion_progress")}
            </Typography>
            <Typography variant="h5" fontWeight="bold">
              {completionRate}%
            </Typography>
          </Box>
          <LinearProgress variant="determinate" value={completionRate} />
        </CardContent>
      </Card>

      {/* Filters */}
      <Box display="flex" gap={2} alignItems="center" my={4}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>{t("task_status.status")}</InputLabel>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <MenuItem value="all">{t("task_status.all")}</MenuItem>
            <MenuItem value="completed">{t("task_status.completed")}</MenuItem>
            <MenuItem value="in-progress">{t("task_status.in_progress")}</MenuItem>
            <MenuItem value="pending">{t("task_status.pending")}</MenuItem>
            <MenuItem value="overdue">{t("task_status.overdue")}</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>{t("task_status.time_period")}</InputLabel>
          <Select value={timeFilter} onChange={(e) => setTimeFilter(e.target.value)}>
            <MenuItem value="all">{t("task_status.all_time")}</MenuItem>
            <MenuItem value="today">{t("task_status.today")}</MenuItem>
            <MenuItem value="week">{t("task_status.this_week")}</MenuItem>
            <MenuItem value="month">{t("task_status.this_month")}</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {/* Tasks List */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(300px, 1fr))" gap={2}>
        {filteredTasks.map((task) => (
          <Card key={task.id} variant="outlined">
            <CardContent>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                <Typography variant="h6" fontWeight="bold">
                  {task.title}
                </Typography>
                <Chip
                  label={task.status}
                  color={getStatusChipColor(task.status)}
                  size="small"
                />
              </Box>
              <Typography variant="body2" color="textSecondary">
                {t("task_status.assigned_to")}: {task.assignee}
              </Typography>
              <Typography variant="body2" color="textSecondary">
                {t("task_status.due_date")}: {task.dueDate}
              </Typography>
              {task.notes && (
                <Typography variant="body2" color="textSecondary" mt={1}>
                  {t("task_status.notes")}: {task.notes}
                </Typography>
              )}
            </CardContent>
          </Card>
        ))}
      </Box>

      {filteredTasks.length === 0 && (
        <Box textAlign="center" py={4}>
          <Typography variant="h6">No tasks found</Typography>
          <Typography color="textSecondary">
            Try adjusting your filters
          </Typography>
        </Box>
      )}
    </Box>
  );
}
