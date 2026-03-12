import { useState } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  Settings,
  Group,
  Home,
  Notifications,
  Lock,
  Palette,
  Language,
  Storage,
  Mail,
  Security,
} from "@mui/icons-material";

export function AdminConfig() {
  const [tabValue, setTabValue] = useState("general");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [autoAssignChores, setAutoAssignChores] = useState(false);
  const [emailDigest, setEmailDigest] = useState(true);
  const [twoFactorAuth, setTwoFactorAuth] = useState(false);

  const handleTabChange = (event: React.SyntheticEvent, newValue: string) => {
    setTabValue(newValue);
  };

  return (
    <Box p={4}>
      {/* Header */}
      <Box mb={4}>
        <Typography variant="h4" fontWeight="bold">
          Admin Configuration
        </Typography>
        <Typography color="textSecondary">
          Manage household settings and preferences
        </Typography>
      </Box>

      {/* Tabs */}
      <Tabs value={tabValue} onChange={handleTabChange} variant="scrollable">
        <Tab label="General" value="general" />
        <Tab label="Members" value="members" />
        <Tab label="Notifications" value="notifications" />
        <Tab label="Security" value="security" />
        <Tab label="Integrations" value="integrations" />
      </Tabs>

      {/* General Settings */}
      {tabValue === "general" && (
        <Box mt={4}>
          <Card>
            <CardHeader
              title={
                <Box display="flex" alignItems="center" gap={1}>
                  <Home fontSize="small" />
                  Household Information
                </Box>
              }
              subheader="Basic information about your household"
            />
            <CardContent>
              <Box mb={2}>
                <TextField
                  fullWidth
                  label="Household Name"
                  defaultValue="The Smith Family"
                />
              </Box>
              <Box mb={2}>
                <TextField
                  fullWidth
                  label="Address"
                  defaultValue="123 Main Street, City, State 12345"
                />
              </Box>
              <Box display="flex" gap={2}>
                <FormControl fullWidth>
                  <InputLabel>Timezone</InputLabel>
                  <Select defaultValue="pst">
                    <MenuItem value="est">Eastern (EST)</MenuItem>
                    <MenuItem value="cst">Central (CST)</MenuItem>
                    <MenuItem value="mst">Mountain (MST)</MenuItem>
                    <MenuItem value="pst">Pacific (PST)</MenuItem>
                  </Select>
                </FormControl>
                <FormControl fullWidth>
                  <InputLabel>Language</InputLabel>
                  <Select defaultValue="en">
                    <MenuItem value="en">English</MenuItem>
                    <MenuItem value="es">Spanish</MenuItem>
                    <MenuItem value="fr">French</MenuItem>
                    <MenuItem value="de">German</MenuItem>
                  </Select>
                </FormControl>
              </Box>
              <Box mt={2}>
                <Button variant="contained">Save Changes</Button>
              </Box>
            </CardContent>
          </Card>
        </Box>
      )}

      {/* ...existing code for other tabs (members, notifications, security, integrations)... */}
    </Box>
  );
}
