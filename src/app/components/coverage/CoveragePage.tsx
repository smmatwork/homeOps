import { useState, useCallback } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import { Home as HomeIcon, Refresh } from "@mui/icons-material";
import { Link as RouterLink } from "react-router";
import { useI18n } from "../../i18n";
import { CoverageDashboard } from "./CoverageDashboard";
import { HelperCapacityCard } from "./HelperCapacityCard";

/**
 * Coverage page — single-purpose audit view.
 *
 * The page renders the CoverageDashboard inline as its main content. There's
 * no longer a wizard, no separate map view, no "Audit vs. Bulk Add" decision
 * for the user. The audit IS the page.
 */
export function CoveragePage() {
  const { t } = useI18n();
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 1100, mx: "auto" }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "stretch", sm: "flex-start" }}
        mb={3}
        gap={2}
      >
        <Box>
          <Typography variant="h4" fontWeight={700}>
            {t("coverage.title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("coverage_audit.subtitle")}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            variant="outlined"
            startIcon={<HomeIcon />}
            component={RouterLink}
            to="/home-profile"
          >
            {t("nav.home_profile")}
          </Button>
          <Button
            variant="outlined"
            startIcon={<Refresh />}
            onClick={handleRefresh}
          >
            {t("common.refresh")}
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={3}>
        <HelperCapacityCard refreshKey={refreshKey} />
        <CoverageDashboard refreshKey={refreshKey} onApplied={handleRefresh} />
      </Stack>
    </Box>
  );
}
