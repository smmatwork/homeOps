import { useState } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Tab,
  Tabs,
  TextField,
  Typography,
  Chip,
  IconButton,
} from "@mui/material";
import {
  Add,
  Edit,
  Delete,
  CheckCircle,
  AccessTime,
  ErrorOutline,
} from "@mui/icons-material";

export function Chores() {
  const [view, setView] = useState<"all" | "pending" | "in-progress" | "completed">("all");
  const [dialogOpen, setDialogOpen] = useState(false);

  const chores = [
    { id: 1, title: "Take out trash", assignee: "John", due: "Today, 6:00 PM", status: "pending", priority: "high", category: "Daily", description: "Take all trash bins to the curb" },
    { id: 2, title: "Grocery shopping", assignee: "Sarah", due: "Tomorrow, 10:00 AM", status: "in-progress", priority: "medium", category: "Weekly", description: "Get items from shopping list" },
    { id: 3, title: "Clean bathrooms", assignee: "Mike", due: "Mar 3, 2:00 PM", status: "pending", priority: "medium", category: "Weekly", description: "Clean all bathrooms thoroughly" },
    { id: 4, title: "Vacuum living room", assignee: "Emma", due: "Mar 2, 4:00 PM", status: "completed", priority: "low", category: "Daily", description: "Vacuum carpets and rugs" },
    { id: 5, title: "Water plants", assignee: "John", due: "Today, 8:00 AM", status: "completed", priority: "low", category: "Daily", description: "Water all indoor and outdoor plants" },
    { id: 6, title: "Meal prep for week", assignee: "Sarah", due: "Mar 4, 1:00 PM", status: "pending", priority: "high", category: "Weekly", description: "Prepare meals for the upcoming week" },
  ];

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

  const filteredChores = view === "all" ? chores : chores.filter((chore) => chore.status === view);

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
                <Chip label={chore.priority} color={chore.priority === "high" ? "error" : chore.priority === "medium" ? "warning" : "info"} />
                <Chip label={chore.category} variant="outlined" />
              </Box>
              <Typography variant="body2" color="textSecondary">
                Assigned to: <strong>{chore.assignee}</strong>
              </Typography>
              <Typography variant="body2" color="textSecondary">
                Due: <strong>{chore.due}</strong>
              </Typography>
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
    </Box>
  );
}
