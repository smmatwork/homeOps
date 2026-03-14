import { Stack, Card, CardHeader, CardContent, Button, Divider, Typography } from "@mui/material";
import {
  AddTask,
  ShoppingCart,
  Alarm,
  MenuBook,
  BarChart,
  Home,
  FormatListBulleted,
  Groups,
  NotificationsActive,
  Bolt,
  Link as LinkIcon,
} from "@mui/icons-material";
import { useNavigate } from "react-router";

interface QuickAction {
  label: string;
  icon: React.ElementType;
  prompt: string;
}

const QUICK_COMMANDS: QuickAction[] = [
  { label: "Add a chore", icon: AddTask, prompt: "Add a new chore" },
  { label: "Shopping list", icon: ShoppingCart, prompt: "Create a shopping list" },
  { label: "Set a reminder", icon: Alarm, prompt: "Set a reminder" },
  { label: "Find a recipe", icon: MenuBook, prompt: "Find a recipe for dinner" },
  { label: "Task overview", icon: BarChart, prompt: "Give me a task overview for today" },
];

interface QuickActionsPanelProps {
  onQuickAction: (prompt: string) => void;
  alertCount?: number;
  onCreateHomeProfile?: () => void;
  onReviewHomeProfile?: () => void;
  onGenerateCoverage?: () => void;
  onRecommendChores?: () => void;
  homeProfileExists?: boolean;
}

export function QuickActionsPanel({
  onQuickAction,
  alertCount = 3,
  onCreateHomeProfile,
  onReviewHomeProfile,
  onGenerateCoverage,
  onRecommendChores,
  homeProfileExists = false,
}: QuickActionsPanelProps) {
  const navigate = useNavigate();

  return (
    <Stack spacing={2}>
      {/* Quick Commands */}
      <Card variant="outlined">
        <CardHeader
          avatar={<Bolt color="warning" sx={{ fontSize: 20 }} />}
          title={
            <Typography variant="subtitle1" fontWeight={600}>
              Quick Commands
            </Typography>
          }
          subheader={
            <Typography variant="caption" color="text.secondary">
              Tap to try these
            </Typography>
          }
          sx={{ pb: 1, "& .MuiCardHeader-content": { minWidth: 0 } }}
        />
        <CardContent sx={{ pt: 0 }}>
          <Stack spacing={0.75}>
            <Button
              variant="outlined"
              fullWidth
              size="small"
              startIcon={<Home fontSize="small" />}
              disabled={!onReviewHomeProfile}
              onClick={() => onReviewHomeProfile?.()}
              sx={{
                justifyContent: "flex-start",
                textTransform: "none",
                fontSize: "0.82rem",
                borderRadius: "8px",
                color: "text.primary",
                borderColor: "divider",
                "&:hover": {
                  borderColor: "primary.main",
                  bgcolor: "grey.50",
                },
              }}
            >
              Review home profile
            </Button>

            {onGenerateCoverage ? (
              <Button
                variant="outlined"
                fullWidth
                size="small"
                startIcon={<BarChart fontSize="small" />}
                onClick={() => onGenerateCoverage()}
                sx={{
                  justifyContent: "flex-start",
                  textTransform: "none",
                  fontSize: "0.82rem",
                  borderRadius: "8px",
                  color: "text.primary",
                  borderColor: "divider",
                  "&:hover": {
                    borderColor: "primary.main",
                    bgcolor: "grey.50",
                  },
                }}
              >
                Generate coverage
              </Button>
            ) : null}

            {onRecommendChores ? (
              <Button
                variant="outlined"
                fullWidth
                size="small"
                startIcon={<AddTask fontSize="small" />}
                onClick={() => onRecommendChores()}
                sx={{
                  justifyContent: "flex-start",
                  textTransform: "none",
                  fontSize: "0.82rem",
                  borderRadius: "8px",
                  color: "text.primary",
                  borderColor: "divider",
                  "&:hover": {
                    borderColor: "primary.main",
                    bgcolor: "grey.50",
                  },
                }}
              >
                Recommend chores
              </Button>
            ) : null}

            {!homeProfileExists && (
              <Button
                variant="outlined"
                fullWidth
                size="small"
                startIcon={<Home fontSize="small" />}
                disabled={!onCreateHomeProfile && !onQuickAction}
                onClick={() => {
                  if (onCreateHomeProfile) {
                    onCreateHomeProfile();
                    return;
                  }
                  onQuickAction("Generate my home profile");
                }}
                sx={{
                  justifyContent: "flex-start",
                  textTransform: "none",
                  fontSize: "0.82rem",
                  borderRadius: "8px",
                  color: "text.primary",
                  borderColor: "divider",
                  "&:hover": {
                    borderColor: "primary.main",
                    bgcolor: "grey.50",
                  },
                }}
              >
                Create home profile
              </Button>
            )}

            {QUICK_COMMANDS.map(({ label, icon: Icon, prompt }) => (
              <Button
                key={label}
                variant="outlined"
                fullWidth
                size="small"
                startIcon={<Icon fontSize="small" />}
                onClick={() => onQuickAction(prompt)}
                sx={{
                  justifyContent: "flex-start",
                  textTransform: "none",
                  fontSize: "0.82rem",
                  borderRadius: "8px",
                  color: "text.primary",
                  borderColor: "divider",
                  "&:hover": {
                    borderColor: "primary.main",
                    bgcolor: "grey.50",
                  },
                }}
              >
                {label}
              </Button>
            ))}
          </Stack>
        </CardContent>
      </Card>

      {/* Jump To */}
      <Card variant="outlined">
        <CardHeader
          avatar={<LinkIcon color="action" sx={{ fontSize: 20 }} />}
          title={
            <Typography variant="subtitle1" fontWeight={600}>
              Jump To
            </Typography>
          }
          sx={{ pb: 1 }}
        />
        <CardContent sx={{ pt: 0 }}>
          <Stack divider={<Divider flexItem />}>
            <Button
              variant="text"
              fullWidth
              size="small"
              startIcon={<FormatListBulleted fontSize="small" />}
              onClick={() => navigate("/chores")}
              sx={{
                justifyContent: "flex-start",
                textTransform: "none",
                fontSize: "0.82rem",
                color: "text.primary",
                py: 1,
              }}
            >
              View All Tasks
            </Button>
            <Button
              variant="text"
              fullWidth
              size="small"
              startIcon={<Groups fontSize="small" />}
              onClick={() => navigate("/helpers")}
              sx={{
                justifyContent: "flex-start",
                textTransform: "none",
                fontSize: "0.82rem",
                color: "text.primary",
                py: 1,
              }}
            >
              Manage Helpers
            </Button>
            <Button
              variant="text"
              fullWidth
              size="small"
              startIcon={<NotificationsActive fontSize="small" color="error" />}
              onClick={() => navigate("/alerts")}
              sx={{
                justifyContent: "flex-start",
                textTransform: "none",
                fontSize: "0.82rem",
                color: "text.primary",
                py: 1,
              }}
            >
              View Alerts ({alertCount})
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
