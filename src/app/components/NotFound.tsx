"use client";

import { Box, Typography, Button } from "@mui/material";
import { Home as HomeIcon } from "@mui/icons-material";
import { Link } from "react-router";

export function NotFound() {
  return (
    <Box
      display="flex"
      justifyContent="center"
      alignItems="center"
      minHeight="100vh"
      sx={{
        backgroundColor: "background.default",
        padding: 4,
      }}
    >
      <Box textAlign="center">
        <Typography variant="h1" fontWeight="bold" color="text.secondary">
          404
        </Typography>
        <Typography variant="h4" fontWeight="bold" color="text.primary" mt={2}>
          Page Not Found
        </Typography>
        <Typography variant="body1" color="text.secondary" mt={1} mb={4}>
          Sorry, the page you're looking for doesn't exist or has been moved.
        </Typography>
        <Link to="/">
          <Button
            variant="contained"
            size="large"
            startIcon={<HomeIcon />}
            sx={{ textTransform: "none" }}
          >
            Back to Dashboard
          </Button>
        </Link>
      </Box>
    </Box>
  );
}
