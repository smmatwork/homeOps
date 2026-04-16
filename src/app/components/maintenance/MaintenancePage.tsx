import { useEffect, useState, useCallback } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  AutoAwesome,
  CalendarMonth,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Schedule,
  SkipNext,
  Warning,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import {
  fetchMaintenancePlan,
  fetchHomeFeatures,
  generateMaintenancePlan,
  type MaintenancePlanEntry,
} from "../../services/maintenanceApi";
import { supabase } from "../../services/supabaseClient";

const SEASONS = [
  { key: "winter", label: "Winter", months: [1, 2] },
  { key: "pre_monsoon", label: "Pre-Monsoon / Summer", months: [3, 4, 5] },
  { key: "monsoon", label: "Monsoon", months: [6, 7, 8, 9] },
  { key: "post_monsoon", label: "Post-Monsoon / Autumn", months: [10, 11] },
  { key: "year_end", label: "Year End", months: [12] },
];

const MONTH_FULL = ["","January","February","March","April","May","June","July","August","September","October","November","December"];

type ChipColor = "default" | "primary" | "warning" | "success" | "error";
const STATUS: Record<string, { label: string; color: ChipColor }> = {
  upcoming: { label: "Upcoming", color: "default" }, scheduled: { label: "Scheduled", color: "primary" },
  in_progress: { label: "In Progress", color: "warning" }, done: { label: "Done", color: "success" },
  overdue: { label: "Overdue", color: "error" }, skipped: { label: "Skipped", color: "default" },
};

const monthRange = (m: number[]) => m.length === 1 ? MONTH_FULL[m[0]] : `${MONTH_FULL[m[0]]} - ${MONTH_FULL[m[m.length - 1]]}`;

export function MaintenancePage() {
  const { householdId } = useAuth();
  const { t } = useI18n();

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [plan, setPlan] = useState<MaintenancePlanEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);

  const [doneDialog, setDoneDialog] = useState<MaintenancePlanEntry | null>(null);
  const [scheduleDialog, setScheduleDialog] = useState<MaintenancePlanEntry | null>(null);
  const [actualCost, setActualCost] = useState("");
  const [doneNotes, setDoneNotes] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    setError(null);
    const result = await fetchMaintenancePlan(householdId, year);
    setLoading(false);
    if (result.error) { setError(result.error); return; }
    setPlan(result.plan);
  }, [householdId, year]);

  useEffect(() => { void load(); }, [load]);

  const handleGenerate = async () => {
    if (!householdId) return;
    setGenerating(true);
    setError(null);

    // Fetch home profile for home_type
    const { data: profile } = await supabase
      .from("home_profiles")
      .select("home_type")
      .eq("household_id", householdId)
      .maybeSingle();

    const homeType = profile?.home_type ? String(profile.home_type) : "apartment";

    // Fetch home features
    const { features } = await fetchHomeFeatures(householdId);
    const featureKeys = new Set(features.map((f) => f.featureKey));

    const result = await generateMaintenancePlan(householdId, year, homeType, featureKeys);
    setGenerating(false);

    if (result.ok === false) { setError(result.error); return; }
    setSnack(`Generated ${result.count} maintenance items`);
    await load();
  };

  const updatePlanItem = async (id: string, patch: Record<string, unknown>) => {
    setBusy(true);
    const { error: err } = await supabase
      .from("maintenance_plan")
      .update(patch)
      .eq("id", id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    await load();
  };

  const handleSkip = async (item: MaintenancePlanEntry) => {
    await updatePlanItem(item.id, { status: "skipped" });
    setSnack("Item skipped");
  };

  const handleScheduleSubmit = async () => {
    if (!scheduleDialog || !scheduleDate) return;
    await updatePlanItem(scheduleDialog.id, {
      status: "scheduled",
      scheduled_date: scheduleDate,
    });
    setScheduleDialog(null);
    setScheduleDate("");
    setSnack("Item scheduled");
  };

  const handleDoneSubmit = async () => {
    if (!doneDialog) return;
    await updatePlanItem(doneDialog.id, {
      status: "done",
      completed_date: new Date().toISOString().slice(0, 10),
      actual_cost: actualCost ? Number(actualCost) : null,
      notes: doneNotes || null,
    });
    setDoneDialog(null);
    setActualCost("");
    setDoneNotes("");
    setSnack("Marked as done");
  };

  const grouped = SEASONS.map((season) => ({
    ...season,
    items: plan.filter(
      (p) => p.targetMonth !== null && season.months.includes(p.targetMonth),
    ),
  }));

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 1200, mx: "auto" }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight={700}>
            Maintenance Calendar
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Annual home maintenance plan by season
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AutoAwesome />}
          onClick={() => void handleGenerate()}
          disabled={generating || !householdId}
        >
          {generating ? "Generating..." : "Generate Plan"}
        </Button>
      </Stack>

      <Stack direction="row" alignItems="center" justifyContent="center" spacing={2} mb={3}>
        <IconButton onClick={() => setYear((y) => y - 1)}>
          <ChevronLeft />
        </IconButton>
        <Typography variant="h6" fontWeight={600} sx={{ minWidth: 60, textAlign: "center" }}>
          {year}
        </Typography>
        <IconButton onClick={() => setYear((y) => y + 1)}>
          <ChevronRight />
        </IconButton>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress />
        </Box>
      ) : plan.length === 0 ? (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: "center", py: 6 }}>
            <CalendarMonth sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
            <Typography color="text.secondary">
              No maintenance items for {year}. Click "Generate Plan" to create one.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={4}>
          {grouped.map((season) => (
            <Box key={season.key}>
              <Typography variant="h6" fontWeight={600} gutterBottom>
                {season.label}
                <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                  ({monthRange(season.months)})
                </Typography>
              </Typography>

              {season.items.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ ml: 1, mb: 1 }}>
                  No items this season
                </Typography>
              ) : (
                <Stack spacing={1.5}>
                  {season.items.map((item) => {
                    const tpl = item.template;
                    const costMin = tpl?.estimatedCostMin;
                    const costMax = tpl?.estimatedCostMax;
                    const procurement = tpl?.procurementItems;
                    const isDone = item.status === "done" || item.status === "skipped";

                    return (
                      <Card key={item.id} variant="outlined">
                        <CardContent sx={{ "&:last-child": { pb: 2 } }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                            <Stack spacing={0.5} flex={1}>
                              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                <Typography variant="subtitle1" fontWeight={600}>
                                  {item.title}
                                </Typography>
                                <Chip
                                  size="small"
                                  label={(STATUS[item.status] ?? STATUS.upcoming).label}
                                  color={(STATUS[item.status] ?? STATUS.upcoming).color}
                                />
                                {item.targetMonth && (
                                  <Chip size="small" label={MONTH_FULL[item.targetMonth]} variant="outlined" />
                                )}
                              </Stack>

                              <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center">
                                {(costMin != null || costMax != null) && (
                                  <Typography variant="body2" color="text.secondary">
                                    Est. cost: {costMin != null && costMax != null
                                      ? `₹${costMin.toLocaleString()} - ₹${costMax.toLocaleString()}`
                                      : `₹${(costMin ?? costMax)!.toLocaleString()}${costMin != null ? "+" : ""}`}
                                  </Typography>
                                )}
                                {item.vendor ? (
                                  <Typography variant="body2" color="text.secondary">
                                    Vendor: {item.vendor.name}
                                  </Typography>
                                ) : (
                                  <Stack direction="row" spacing={0.5} alignItems="center">
                                    <Warning sx={{ fontSize: 16, color: "warning.main" }} />
                                    <Typography variant="body2" color="warning.main">
                                      No vendor
                                    </Typography>
                                  </Stack>
                                )}
                                {item.actualCost != null && (
                                  <Typography variant="body2" color="success.main">
                                    Actual: ₹{item.actualCost.toLocaleString()}
                                  </Typography>
                                )}
                              </Stack>

                              {procurement && procurement.length > 0 && (
                                <Typography variant="body2" color="text.secondary">
                                  Procurement: {procurement.map((p) => p.name).join(", ")}
                                </Typography>
                              )}
                            </Stack>

                            {!isDone && (
                              <Stack direction="row" spacing={0.5}>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  startIcon={<Schedule />}
                                  onClick={() => { setScheduleDialog(item); setScheduleDate(""); }}
                                >
                                  Schedule
                                </Button>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  color="success"
                                  startIcon={<CheckCircle />}
                                  onClick={() => {
                                    setDoneDialog(item);
                                    setActualCost("");
                                    setDoneNotes("");
                                  }}
                                >
                                  Done
                                </Button>
                                <IconButton size="small" onClick={() => void handleSkip(item)} title="Skip">
                                  <SkipNext fontSize="small" />
                                </IconButton>
                              </Stack>
                            )}
                          </Stack>
                        </CardContent>
                      </Card>
                    );
                  })}
                </Stack>
              )}
            </Box>
          ))}
        </Stack>
      )}

      <Dialog open={!!scheduleDialog} onClose={() => setScheduleDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Schedule: {scheduleDialog?.title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label="Scheduled date"
              type="date"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              size="small"
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setScheduleDialog(null)} disabled={busy}>{t("common.cancel")}</Button>
          <Button
            variant="contained"
            onClick={() => void handleScheduleSubmit()}
            disabled={busy || !scheduleDate}
          >
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!doneDialog} onClose={() => setDoneDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Mark Done: {doneDialog?.title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label="Actual cost (₹)"
              type="number"
              value={actualCost}
              onChange={(e) => setActualCost(e.target.value)}
              size="small"
              fullWidth
            />
            <TextField
              label="Notes"
              value={doneNotes}
              onChange={(e) => setDoneNotes(e.target.value)}
              size="small"
              fullWidth
              multiline
              minRows={2}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDoneDialog(null)} disabled={busy}>{t("common.cancel")}</Button>
          <Button
            variant="contained"
            color="success"
            onClick={() => void handleDoneSubmit()}
            disabled={busy}
          >
            Mark Done
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!snack}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Box>
  );
}
