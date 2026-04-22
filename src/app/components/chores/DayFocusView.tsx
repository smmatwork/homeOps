import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { ErrorOutline, WarningAmber } from "@mui/icons-material";
import { useI18n } from "../../i18n";
import { ChoreCard, type ChoreRow, getMetaStrings } from "./ChoreCard";
import {
  daysUntil,
  isoInRange,
  startOfLocalDay,
  type DateRange,
} from "../../services/dateRange";

interface DayFocusViewProps {
  chores: ChoreRow[];
  helpers: Array<{ id: string; name: string; type: string | null }>;
  busy: boolean;
  onEdit: (chore: ChoreRow) => void;
  onDelete: (chore: ChoreRow) => void;
  onRestore: (chore: ChoreRow) => void;
  onFlagNotDone: (chore: ChoreRow) => void;
  helperOnLeave: (helperId: string | null, dueAt: string | null) => boolean;
}

const STATUS_TABS = ["all", "pending", "in_progress"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

function matchesStatusTab(status: string, tab: StatusTab): boolean {
  if (tab === "all") return true;
  if (tab === "in_progress") return status === "in-progress" || status === "in_progress";
  return status === tab;
}

function isReopened(c: ChoreRow): boolean {
  return !!c.reopened_at && c.status !== "done" && c.status !== "completed" && c.status !== "auto_completed";
}

function isDoneToday(c: ChoreRow): boolean {
  if (c.status !== "done" && c.status !== "completed" && c.status !== "auto_completed") return false;
  if (!c.completed_at) return false;
  const d = new Date(c.completed_at);
  if (Number.isNaN(d.getTime())) return false;
  const start = startOfLocalDay();
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return d >= start && d < end;
}

function reopenedReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Reopened";
  switch (reason) {
    case "helper_leave":
      return "Helper was on leave";
    case "feedback":
      return "Flagged as not done";
    case "manual":
      return "Manually reopened";
    default:
      return `Reopened (${reason})`;
  }
}

export function DayFocusView(props: DayFocusViewProps) {
  const { chores, helpers, busy, onEdit, onDelete, onRestore, onFlagNotDone, helperOnLeave } = props;
  const { t } = useI18n();

  const [range, setRange] = useState<DateRange>("today");
  const [tab, setTab] = useState<StatusTab>("all");
  const [filterSpace, setFilterSpace] = useState<string>("");
  const [filterHelper, setFilterHelper] = useState<string>("");
  const [showDoneToday, setShowDoneToday] = useState<boolean>(false);

  const helpersById = useMemo(() => new Map(helpers.map((h) => [h.id, h])), [helpers]);

  const allSpaces = useMemo(() => {
    const s = new Set<string>();
    for (const c of chores) {
      const { space } = getMetaStrings(c);
      if (space) s.add(space);
    }
    return [...s].sort();
  }, [chores]);

  /* ── Classification buckets ───────────────────────────────────── */

  const { overdue, inRange, doneToday, counts } = useMemo(() => {
    const overdueList: ChoreRow[] = [];
    const inRangeList: ChoreRow[] = [];
    const doneTodayList: ChoreRow[] = [];

    for (const c of chores) {
      if (c.deleted_at) continue;

      const reopened = isReopened(c);
      const doneTodayFlag = isDoneToday(c);

      // Overdue bucket: Today view only, reopened chores
      if (range === "today" && reopened) {
        overdueList.push(c);
        continue;
      }

      // Done today: aggregated separately
      if (doneTodayFlag) {
        doneTodayList.push(c);
        continue;
      }

      // Hide already-finished chores from Today/Tomorrow/This-week lists.
      if (c.status === "done" || c.status === "completed" || c.status === "auto_completed") {
        continue;
      }

      if (isoInRange(c.due_at, range)) {
        inRangeList.push(c);
      }
    }

    const pendingCount = inRangeList.filter((c) => c.status === "pending").length;
    const inProgressCount = inRangeList.filter((c) =>
      c.status === "in-progress" || c.status === "in_progress",
    ).length;

    return {
      overdue: overdueList,
      inRange: inRangeList,
      doneToday: doneTodayList,
      counts: {
        total: inRangeList.length,
        pending: pendingCount,
        inProgress: inProgressCount,
        overdue: overdueList.length,
        doneToday: doneTodayList.length,
      },
    };
  }, [chores, range]);

  /* ── Apply filters on top of the in-range bucket ──────────────── */

  const filtered = useMemo(() => {
    return inRange.filter((c) => {
      if (!matchesStatusTab(c.status, tab)) return false;
      if (filterSpace && getMetaStrings(c).space !== filterSpace) return false;
      if (filterHelper) {
        if (filterHelper === "__unassigned__" && c.helper_id) return false;
        if (filterHelper !== "__unassigned__" && c.helper_id !== filterHelper) return false;
      }
      return true;
    });
  }, [inRange, tab, filterSpace, filterHelper]);

  /* ── Sort: overdue first (by age), then due_at, then priority ── */

  const sortedFiltered = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const aDue = a.due_at ? new Date(a.due_at).getTime() : Number.MAX_SAFE_INTEGER;
      const bDue = b.due_at ? new Date(b.due_at).getTime() : Number.MAX_SAFE_INTEGER;
      if (aDue !== bDue) return aDue - bDue;
      return b.priority - a.priority;
    });
  }, [filtered]);

  const sortedOverdue = useMemo(() => {
    return [...overdue].sort((a, b) => {
      const at = a.reopened_at ? new Date(a.reopened_at).getTime() : 0;
      const bt = b.reopened_at ? new Date(b.reopened_at).getTime() : 0;
      return bt - at;
    });
  }, [overdue]);

  const hasFilters = tab !== "all" || !!filterSpace || !!filterHelper;

  const clearFilters = () => {
    setTab("all");
    setFilterSpace("");
    setFilterHelper("");
  };

  const rangeLabel =
    range === "today"
      ? "today"
      : range === "tomorrow"
        ? "tomorrow"
        : range === "this_week"
          ? "this week"
          : range === "unscheduled"
            ? "unscheduled"
            : "all time";

  return (
    <Stack spacing={2}>
      {/* Date-range toggle */}
      <ToggleButtonGroup
        exclusive
        value={range}
        onChange={(_e, v) => { if (v) setRange(v); }}
        size="small"
      >
        <ToggleButton value="today">Today</ToggleButton>
        <ToggleButton value="tomorrow">Tomorrow</ToggleButton>
        <ToggleButton value="this_week">This week</ToggleButton>
        <ToggleButton value="unscheduled">Unscheduled</ToggleButton>
        <ToggleButton value="all">All</ToggleButton>
      </ToggleButtonGroup>

      {/* Overdue nudge — only shows in Today view when there are reopened chores */}
      {range === "today" && counts.overdue > 0 && (
        <Alert severity="warning" icon={<WarningAmber />}>
          <Typography variant="body2" fontWeight={600}>
            {counts.overdue} chore{counts.overdue === 1 ? " needs" : "s need"} attention
          </Typography>
          <Typography variant="caption" color="text.secondary">
            These were reopened — your feedback or a helper's leave means they weren't completed.
          </Typography>
        </Alert>
      )}

      {/* Summary bar */}
      <Card variant="outlined">
        <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
            <Typography variant="body2" sx={{ minWidth: 140 }}>
              <b>{counts.total}</b> due {rangeLabel}
            </Typography>
            {counts.pending > 0 && (
              <Chip size="small" label={`${counts.pending} pending`} variant="outlined" />
            )}
            {counts.inProgress > 0 && (
              <Chip size="small" color="warning" label={`${counts.inProgress} in progress`} variant="outlined" />
            )}
            {range === "today" && counts.doneToday > 0 && (
              <Chip
                size="small"
                color="success"
                label={`${counts.doneToday} done today`}
                variant="outlined"
              />
            )}
            <Box flexGrow={1} />
            {range === "today" && (
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={showDoneToday}
                    onChange={(e) => setShowDoneToday(e.target.checked)}
                  />
                }
                label={<Typography variant="caption">Show done today</Typography>}
              />
            )}
          </Stack>
        </CardContent>
      </Card>

      {/* Filters */}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Tabs value={tab} onChange={(_e, v) => setTab(v as StatusTab)} sx={{ minHeight: 32 }}>
          {STATUS_TABS.map((s) => (
            <Tab key={s} value={s} label={s === "in_progress" ? "In progress" : s.charAt(0).toUpperCase() + s.slice(1)} sx={{ minHeight: 32 }} />
          ))}
        </Tabs>

        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Space</InputLabel>
          <Select
            label="Space"
            value={filterSpace}
            onChange={(e) => setFilterSpace(String(e.target.value))}
          >
            <MenuItem value="">All</MenuItem>
            {allSpaces.map((s) => (
              <MenuItem key={s} value={s}>{s}</MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Helper</InputLabel>
          <Select
            label="Helper"
            value={filterHelper}
            onChange={(e) => setFilterHelper(String(e.target.value))}
          >
            <MenuItem value="">All</MenuItem>
            <MenuItem value="__unassigned__">Unassigned</MenuItem>
            {helpers.map((h) => (
              <MenuItem key={h.id} value={h.id}>{h.name}</MenuItem>
            ))}
          </Select>
        </FormControl>

        {hasFilters && (
          <Button size="small" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </Stack>

      {/* Overdue bucket (Today view only) */}
      {range === "today" && sortedOverdue.length > 0 && (
        <Stack spacing={1}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <ErrorOutline sx={{ fontSize: 16, color: "error.main" }} />
            <Typography variant="subtitle2" color="error.main">
              Needs attention ({sortedOverdue.length})
            </Typography>
          </Stack>
          <Stack spacing={1}>
            {sortedOverdue.map((c) => {
              const h = c.helper_id ? helpersById.get(c.helper_id) : null;
              return (
                <Box
                  key={c.id}
                  sx={{
                    borderLeft: 3,
                    borderColor: "error.main",
                    pl: 1,
                  }}
                >
                  <ChoreCard
                    chore={c}
                    helperName={h?.name ?? ""}
                    isOnLeave={helperOnLeave(c.helper_id, c.due_at)}
                    onEdit={() => onEdit(c)}
                    onDelete={() => onDelete(c)}
                    onRestore={() => onRestore(c)}
                    onFlagAsNotDone={() => onFlagNotDone(c)}
                    showEstimate
                  />
                  <Typography variant="caption" color="error.main" sx={{ ml: 1 }}>
                    {reopenedReasonLabel(c.reopened_reason)}
                  </Typography>
                </Box>
              );
            })}
          </Stack>
        </Stack>
      )}

      {/* Main list */}
      {busy && chores.length === 0 ? (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress size={24} />
        </Box>
      ) : sortedFiltered.length === 0 ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="body2" color="text.secondary" textAlign="center">
              {range === "today"
                ? "Nothing due today."
                : range === "tomorrow"
                  ? "Nothing due tomorrow yet."
                  : range === "this_week"
                    ? "Nothing due this week."
                    : range === "unscheduled"
                      ? "All chores have a scheduled date."
                      : "No chores match these filters."}
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1}>
          {sortedFiltered.map((c) => {
            const h = c.helper_id ? helpersById.get(c.helper_id) : null;
            const du = daysUntil(c.due_at);
            const isOverdueByDate = du !== null && du < 0;
            return (
              <Box
                key={c.id}
                sx={isOverdueByDate ? { borderLeft: 3, borderColor: "warning.light", pl: 1 } : undefined}
              >
                <ChoreCard
                  chore={c}
                  helperName={h?.name ?? ""}
                  isOnLeave={helperOnLeave(c.helper_id, c.due_at)}
                  onEdit={() => onEdit(c)}
                  onDelete={() => onDelete(c)}
                  onRestore={() => onRestore(c)}
                  onReportNotDone={() => onFlagNotDone(c)}
                  showEstimate
                />
              </Box>
            );
          })}
        </Stack>
      )}

      {/* Done-today reveal (Today view only) */}
      {range === "today" && showDoneToday && doneToday.length > 0 && (
        <Stack spacing={1}>
          <Typography variant="subtitle2" color="text.secondary">
            Done today ({doneToday.length})
          </Typography>
          <Stack spacing={1}>
            {doneToday.map((c) => {
              const h = c.helper_id ? helpersById.get(c.helper_id) : null;
              return (
                <Box key={c.id} sx={{ opacity: 0.6 }}>
                  <ChoreCard
                    chore={c}
                    helperName={h?.name ?? ""}
                    isOnLeave={false}
                    onEdit={() => onEdit(c)}
                    onDelete={() => onDelete(c)}
                    onRestore={() => onRestore(c)}
                    onFlagAsNotDone={() => onFlagNotDone(c)}
                    showEstimate
                  />
                  {c.status === "auto_completed" && (
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      Auto-completed (no explicit sign-off)
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
