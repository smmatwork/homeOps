"use client";

import { Box, Typography, Button } from "@mui/material";
import { Home as HomeIcon } from "@mui/icons-material";
import { Link } from "react-router";
import { useI18n } from "../i18n";

export function NotFound() {
  const { t } = useI18n();
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
          {t("not_found.title")}
        </Typography>
        <Typography variant="body1" color="text.secondary" mt={1} mb={4}>
          {t("not_found.subtitle")}
        </Typography>
        <Link to="/">
          <Button
            variant="contained"
            size="large"
            startIcon={<HomeIcon />}
            sx={{ textTransform: "none" }}
          >
            {t("not_found.back_to_dashboard")}
          </Button>
        </Link>
      </Box>
    </Box>
  );
}
