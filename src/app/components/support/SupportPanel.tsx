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
  TextField,
  Typography,
  Chip,
  IconButton,
} from "@mui/material";
import {
  Search,
  ErrorOutline,
  CheckCircle,
  AccessTime,
  Send,
  Person,
} from "@mui/icons-material";

export function SupportPanel() {
  const [selectedTicket, setSelectedTicket] = useState<number | null>(null);

  const tickets = [
    {
      id: 1,
      household: "Smith Family",
      user: "John Smith",
      email: "john.smith@email.com",
      subject: "Unable to add new chore",
      message: "I'm trying to add a new chore but the 'Add Chore' button doesn't seem to be working.",
      status: "open",
      priority: "high",
      category: "Technical Issue",
      created: "2 hours ago",
      lastUpdate: "1 hour ago",
      responses: [
        {
          from: "user",
          message: "I'm trying to add a new chore but the 'Add Chore' button doesn't seem to be working.",
          timestamp: "2 hours ago",
        },
      ],
    },
    {
      id: 2,
      household: "Johnson Home",
      user: "Sarah Johnson",
      email: "sarah.j@email.com",
      subject: "Question about helper scheduling",
      message: "How do I set up recurring appointments for my cleaning service?",
      status: "in-progress",
      priority: "medium",
      category: "How-to Question",
      created: "5 hours ago",
      lastUpdate: "30 minutes ago",
      responses: [
        {
          from: "user",
          message: "How do I set up recurring appointments for my cleaning service?",
          timestamp: "5 hours ago",
        },
        {
          from: "support",
          message: "Hi Sarah! I can help you with that. You'll find a 'Recurring' option in the helper settings.",
          timestamp: "4 hours ago",
        },
      ],
    },
  ];

  const stats = {
    open: tickets.filter((t) => t.status === "open").length,
    inProgress: tickets.filter((t) => t.status === "in-progress").length,
    resolved: tickets.filter((t) => t.status === "resolved").length,
    avgResponseTime: "2.3 hours",
  };

  const currentTicket = tickets.find((t) => t.id === selectedTicket);

  return (
    <Box p={4}>
      {/* Header */}
      <Box mb={4}>
        <Typography variant="h4" fontWeight="bold">
          Support Panel
        </Typography>
        <Typography color="textSecondary">
          Manage and respond to user support requests
        </Typography>
      </Box>

      {/* Stats */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))" gap={2} mb={4}>
        <Card>
          <CardContent>
            <Typography variant="h5" color="error" fontWeight="bold">
              {stats.open}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              Open Tickets
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h5" color="warning.main" fontWeight="bold">
              {stats.inProgress}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              In Progress
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h5" color="success.main" fontWeight="bold">
              {stats.resolved}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              Resolved Today
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h5" color="primary" fontWeight="bold">
              {stats.avgResponseTime}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              Avg. Response Time
            </Typography>
          </CardContent>
        </Card>
      </Box>

      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))" gap={4}>
        {/* Tickets List */}
        <Card>
          <CardHeader title="Support Tickets" subheader="All user support requests" />
          <Divider />
          <CardContent>
            <TextField
              placeholder="Search tickets..."
              fullWidth
              InputProps={{
                startAdornment: <Search sx={{ mr: 1, color: "action.active" }} />,
              }}
              sx={{ mb: 2 }}
            />
            <Tabs value="all" variant="scrollable">
              <Tab label="All" value="all" />
              <Tab label="Open" value="open" />
              <Tab label="Resolved" value="resolved" />
            </Tabs>
            <Box mt={2}>
              {tickets.map((ticket) => (
                <Card
                  key={ticket.id}
                  variant="outlined"
                  sx={{
                    mb: 2,
                    cursor: "pointer",
                    borderColor: selectedTicket === ticket.id ? "primary.main" : "divider",
                  }}
                  onClick={() => setSelectedTicket(ticket.id)}
                >
                  <CardContent>
                    <Typography variant="body1" fontWeight="bold">
                      {ticket.subject}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      {ticket.household} • {ticket.user}
                    </Typography>
                    <Chip
                      label={ticket.status}
                      color={ticket.status === "open" ? "error" : "warning"}
                      size="small"
                      sx={{ mt: 1 }}
                    />
                  </CardContent>
                </Card>
              ))}
            </Box>
          </CardContent>
        </Card>

        {/* Ticket Details */}
        <Card>
          {currentTicket ? (
            <>
              <CardHeader
                title={currentTicket.subject}
                subheader={`${currentTicket.household} • ${currentTicket.user} • ${currentTicket.email}`}
              />
              <Divider />
              <CardContent>
                {currentTicket.responses.map((response, idx) => (
                  <Box
                    key={idx}
                    display="flex"
                    justifyContent={response.from === "user" ? "flex-start" : "flex-end"}
                    mb={2}
                  >
                    {response.from === "user" && (
                      <Person sx={{ mr: 1, color: "action.active" }} />
                    )}
                    <Box
                      sx={{
                        p: 2,
                        borderRadius: 2,
                        backgroundColor: response.from === "user" ? "grey.200" : "primary.main",
                        color: response.from === "user" ? "text.primary" : "common.white",
                      }}
                    >
                      <Typography variant="body2">{response.message}</Typography>
                      <Typography variant="caption" sx={{ mt: 1, display: "block" }}>
                        {response.timestamp}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </CardContent>
              <Divider />
              <CardContent>
                <TextField
                  placeholder="Type your response..."
                  multiline
                  rows={3}
                  fullWidth
                  sx={{ mb: 2 }}
                />
                <Box display="flex" justifyContent="space-between" alignItems="center">
                  <FormControl size="small" sx={{ minWidth: 150 }}>
                    <InputLabel>Status</InputLabel>
                    <Select defaultValue="in-progress">
                      <MenuItem value="open">Open</MenuItem>
                      <MenuItem value="in-progress">In Progress</MenuItem>
                      <MenuItem value="resolved">Resolved</MenuItem>
                    </Select>
                  </FormControl>
                  <Button variant="contained" startIcon={<Send />}>
                    Send Reply
                  </Button>
                </Box>
              </CardContent>
            </>
          ) : (
            <CardContent>
              <Typography variant="h6" align="center">
                No ticket selected
              </Typography>
              <Typography variant="body2" color="textSecondary" align="center">
                Select a ticket from the list to view details and respond.
              </Typography>
            </CardContent>
          )}
        </Card>
      </Box>
    </Box>
  );
}
