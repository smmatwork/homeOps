import { useState } from "react";
import {
  Box, Button, Card, CardContent, CardHeader, Chip,
  Avatar, Typography, Stack, Tabs, Tab, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
} from "@mui/material";
import { Phone, Mail, Schedule, Add, MoreVert, Place } from "@mui/icons-material";

const HELPERS = [
  { id: 1, name: "Maria Garcia",           role: "House Cleaner",   category: "Cleaning",     phone: "(555) 123-4567", email: "maria@clean.com",   schedule: "Tues & Fri, 9 AM",    status: "Active",   lastVisit: "Feb 27",  nextVisit: "Mar 4" },
  { id: 2, name: "John Smith",             role: "Plumber",         category: "Maintenance",  phone: "(555) 234-5678", email: "john@plumb.com",    schedule: "On-call",             status: "Active",   lastVisit: "Jan 15",  nextVisit: "N/A" },
  { id: 3, name: "Green Thumb Co.",        role: "Gardener",        category: "Outdoor",      phone: "(555) 345-6789", email: "info@green.com",    schedule: "Alt Mondays, 8 AM",   status: "Active",   lastVisit: "Feb 24",  nextVisit: "Mar 10" },
  { id: 4, name: "Sarah Johnson",          role: "Babysitter",      category: "Childcare",    phone: "(555) 456-7890", email: "sarah.j@email.com", schedule: "Weekends, flexible",  status: "Active",   lastVisit: "Feb 28",  nextVisit: "Mar 7" },
  { id: 5, name: "Tech Support Plus",      role: "IT Support",      category: "Technology",   phone: "(555) 567-8901", email: "support@tech.com",  schedule: "On-call",             status: "Inactive", lastVisit: "Dec 10",  nextVisit: "N/A" },
];

const CATEGORIES = ["All", "Cleaning", "Maintenance", "Outdoor", "Childcare", "Technology"];

const initials = (name: string) =>
  name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();

export function Helpers() {
  const [category, setCategory] = useState("All");
  const [dialogOpen, setDialogOpen] = useState(false);

  const filtered = category === "All" ? HELPERS : HELPERS.filter((h) => h.category === category);

  return (
    <Box sx={{ overflowY: "auto", height: "100%" }}>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Helpers &amp; Services</Typography>
          <Typography variant="body2" color="text.secondary">Manage household service providers</Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setDialogOpen(true)} sx={{ textTransform: "none" }}>
          Add Helper
        </Button>
      </Stack>

      {/* Category tabs */}
      <Tabs
        value={category}
        onChange={(_, v) => setCategory(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 3, borderBottom: "1px solid", borderColor: "divider" }}
      >
        {CATEGORIES.map((c) => (
          <Tab key={c} label={c} value={c} sx={{ textTransform: "none", minWidth: "unset" }} />
        ))}
      </Tabs>

      {/* Grid */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(280px, 1fr))" gap={2}>
        {filtered.map((helper) => (
          <Card key={helper.id} variant="outlined">
            <CardHeader
              avatar={
                <Avatar sx={{ bgcolor: "primary.main", width: 44, height: 44 }}>
                  {initials(helper.name)}
                </Avatar>
              }
              title={<Typography variant="subtitle1" fontWeight={600}>{helper.name}</Typography>}
              subheader={helper.role}
              action={<Box sx={{ cursor: "pointer", p: 1 }}><MoreVert fontSize="small" color="action" /></Box>}
              sx={{ pb: 1 }}
            />
            <Divider />
            <CardContent sx={{ pt: 1.5 }}>
              <Stack spacing={0.75} mb={1.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Phone fontSize="small" color="action" />
                  <Typography variant="body2" color="text.secondary">{helper.phone}</Typography>
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Mail fontSize="small" color="action" />
                  <Typography variant="body2" color="text.secondary" noWrap>{helper.email}</Typography>
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Schedule fontSize="small" color="action" />
                  <Typography variant="body2" color="text.secondary">{helper.schedule}</Typography>
                </Stack>
              </Stack>

              <Stack direction="row" spacing={1} mb={2}>
                <Chip label={helper.category} size="small" variant="outlined" />
                <Chip
                  label={helper.status}
                  size="small"
                  color={helper.status === "Active" ? "success" : "default"}
                />
              </Stack>

              <Box sx={{ bgcolor: "grey.50", borderRadius: 1, p: 1, mb: 2 }}>
                <Stack direction="row" justifyContent="space-between">
                  <Box>
                    <Typography variant="caption" color="text.secondary">Last Visit</Typography>
                    <Typography variant="body2" fontWeight={500}>{helper.lastVisit}</Typography>
                  </Box>
                  <Box textAlign="right">
                    <Typography variant="caption" color="text.secondary">Next Visit</Typography>
                    <Typography variant="body2" fontWeight={500}>{helper.nextVisit}</Typography>
                  </Box>
                </Stack>
              </Box>

              <Stack direction="row" spacing={1}>
                <Button variant="outlined" size="small" startIcon={<Phone fontSize="small" />} fullWidth sx={{ textTransform: "none" }}>
                  Call
                </Button>
                <Button variant="outlined" size="small" startIcon={<Mail fontSize="small" />} fullWidth sx={{ textTransform: "none" }}>
                  Email
                </Button>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Box>

      {/* Add Helper Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add New Helper</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="Name / Business Name" fullWidth size="small" />
            <TextField label="Role / Service Type" fullWidth size="small" />
            <Stack direction="row" spacing={2}>
              <TextField label="Phone" fullWidth size="small" />
              <TextField label="Email" fullWidth size="small" />
            </Stack>
            <TextField label="Schedule" fullWidth size="small" placeholder="e.g. Mondays 9:00 AM or On-call" />
            <TextField label="Notes" fullWidth size="small" multiline rows={2} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => setDialogOpen(false)}>Add Helper</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
