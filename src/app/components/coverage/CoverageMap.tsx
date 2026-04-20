import { Box, Chip, Paper, Stack, Tooltip, Typography } from "@mui/material";
import { Build, Person, Warning } from "@mui/icons-material";
import type { CoverageRow } from "../../services/coverageApi";

interface CoverageMapProps {
  spaces: string[];
  rows: CoverageRow[];
  onCellClick?: (row: CoverageRow) => void;
}

const CADENCES: CoverageRow["cadence"][] = ["daily", "weekly", "biweekly", "monthly"];

function cellColor(row: CoverageRow): string {
  if (row.choreCount === 0 && row.deviceKeys.length === 0) return "error.lighter";
  if (row.deviceKeys.length > 0 && row.helperId) return "info.lighter";
  if (row.deviceKeys.length > 0) return "success.lighter";
  if (row.helperId) return "primary.lighter";
  if (row.choreCount > 0) return "warning.lighter";
  return "background.paper";
}

function CellContent({ row }: { row: CoverageRow }) {
  const isGap = row.choreCount === 0 && row.deviceKeys.length === 0;

  if (isGap) {
    return (
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Warning fontSize="inherit" color="error" />
        <Typography variant="caption" color="error">Gap</Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={0.25}>
      {row.deviceKeys.length > 0 && (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Build fontSize="inherit" />
          <Typography variant="caption" noWrap>
            {row.deviceKeys.length} device{row.deviceKeys.length > 1 ? "s" : ""}
          </Typography>
        </Stack>
      )}
      {row.helperName && (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Person fontSize="inherit" />
          <Typography variant="caption" noWrap>{row.helperName}</Typography>
        </Stack>
      )}
      {row.choreCount > 0 && !row.helperName && (
        <Typography variant="caption" color="text.secondary">
          {row.choreCount} chore{row.choreCount > 1 ? "s" : ""}
        </Typography>
      )}
    </Stack>
  );
}

export function CoverageMap({ spaces, rows, onCellClick }: CoverageMapProps) {
  if (spaces.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 3, textAlign: "center" }}>
        <Typography color="text.secondary">
          No spaces configured. Set up your home profile first.
        </Typography>
      </Paper>
    );
  }

  const rowByKey = new Map(rows.map((r) => [`${r.space}::${r.cadence}`, r]));

  return (
    <Box>
      <Stack direction="row" spacing={1} mb={2} flexWrap="wrap" useFlexGap>
        <Chip size="small" label="Device" sx={{ bgcolor: "success.lighter" }} icon={<Build fontSize="small" />} />
        <Chip size="small" label="Helper" sx={{ bgcolor: "primary.lighter" }} icon={<Person fontSize="small" />} />
        <Chip size="small" label="Both" sx={{ bgcolor: "info.lighter" }} />
        <Chip size="small" label="Chores only" sx={{ bgcolor: "warning.lighter" }} />
        <Chip size="small" label="Gap" sx={{ bgcolor: "error.lighter" }} icon={<Warning fontSize="small" />} />
      </Stack>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: `minmax(140px, 1.5fr) repeat(${CADENCES.length}, minmax(120px, 1fr))`,
          gap: 0.5,
        }}
      >
        {/* Header row */}
        <Box sx={{ p: 1 }} />
        {CADENCES.map((cad) => (
          <Box
            key={cad}
            sx={{
              p: 1,
              textAlign: "center",
              fontWeight: 600,
              textTransform: "capitalize",
              borderBottom: 2,
              borderColor: "divider",
            }}
          >
            <Typography variant="caption" fontWeight={600}>{cad}</Typography>
          </Box>
        ))}

        {/* Data rows */}
        {spaces.map((space) => (
          <Box key={space} sx={{ display: "contents" }}>
            <Box
              sx={{
                p: 1,
                fontWeight: 500,
                borderRight: 1,
                borderColor: "divider",
                display: "flex",
                alignItems: "center",
              }}
            >
              <Typography variant="body2" noWrap title={space}>{space}</Typography>
            </Box>
            {CADENCES.map((cad) => {
              const row = rowByKey.get(`${space}::${cad}`);
              if (!row) {
                return <Box key={cad} sx={{ p: 1 }} />;
              }
              return (
                <Tooltip
                  key={cad}
                  title={row.deviceKeys.length > 0 ? row.deviceKeys.join(", ") : ""}
                  arrow
                >
                  <Paper
                    variant="outlined"
                    onClick={() => onCellClick?.(row)}
                    sx={{
                      p: 1,
                      bgcolor: cellColor(row),
                      cursor: onCellClick ? "pointer" : "default",
                      minHeight: 56,
                      display: "flex",
                      alignItems: "center",
                      "&:hover": onCellClick ? { borderColor: "primary.main" } : undefined,
                    }}
                  >
                    <CellContent row={row} />
                  </Paper>
                </Tooltip>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
