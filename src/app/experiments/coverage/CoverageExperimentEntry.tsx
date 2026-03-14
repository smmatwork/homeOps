import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  DialogActions,
  DialogContent,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { supabase } from "../../services/supabaseClient";
import {
  clearCoverageDraft,
  defaultCoverageDraft,
  loadCoverageDraft,
  saveCoverageDraft,
  type CoverageDraft,
} from "./coverageDraftStorage";

type DeviceKey = keyof CoverageDraft["devices"];

const DEVICE_LABELS: Record<DeviceKey, string> = {
  robot_vacuum: "Robot vacuum",
  robot_mop: "Robot mop",
  dishwasher: "Dishwasher",
  washing_machine: "Washing machine",
  clothes_dryer: "Clothes dryer",
  air_purifier: "Air purifier",
  vacuum_cleaner: "Vacuum cleaner",
  steam_mop: "Steam mop",
  microwave_oven: "Microwave / oven",
  water_heater_geyser: "Water heater (geyser)",
  ro_service_contract: "RO / purifier service contract",
  water_purifier: "Water purifier",
  pest_control_contract: "Pest control contract",
};

const CONF_LABELS: Record<CoverageDraft["confidenceByDevice"][DeviceKey], string> = {
  reliable: "Reliable",
  sometimes: "Sometimes",
  flaky: "Flaky",
};

const WEEKDAY_LABELS: Array<{ day: number; label: string }> = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

function isZoneDevice(key: string): boolean {
  // Guard rail: only devices that directly automate chores should be treated as coverage-mapped.
  // (e.g. robot vacuum / robot mop). Other machines can exist but shouldn't show in the room coverage step.
  return key === "robot_vacuum" || key === "robot_mop";
}

export function CoverageExperimentEntry(props: { householdId: string; onClose: () => void }) {
  const householdId = String(props.householdId ?? "").trim();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CoverageDraft>(() => loadCoverageDraft(householdId) ?? defaultCoverageDraft());
  const [homeSpaces, setHomeSpaces] = useState<string[]>([]);
  const [otherMachineInput, setOtherMachineInput] = useState("");
  const [saveBannerOpen, setSaveBannerOpen] = useState(false);

  const persistDraft = () => {
    if (!householdId) return;
    saveCoverageDraft(householdId, draft);
  };

  useEffect(() => {
    setDraft(loadCoverageDraft(householdId) ?? defaultCoverageDraft());
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from("home_profiles")
        .select("spaces")
        .eq("household_id", householdId)
        .maybeSingle();
      if (cancelled) return;
      setBusy(false);
      if (error) {
        setLoadError("We couldn't load your home spaces. You can still continue by adding areas manually.");
        setHomeSpaces([]);
        return;
      }
      const spaces = Array.isArray((data as any)?.spaces) ? ((data as any).spaces as unknown[]).map(String).filter(Boolean) : [];
      setHomeSpaces(spaces);
      setDraft((prev) => {
        if (prev.areas.length > 0) return prev;
        return { ...prev, areas: spaces };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    saveCoverageDraft(householdId, draft);
  }, [householdId, draft]);

  const areas = useMemo(() => {
    const a = Array.from(new Set(draft.areas.map((x) => x.trim()).filter(Boolean)));
    return a;
  }, [draft.areas]);

  const updateDevice = (k: DeviceKey, v: boolean) => {
    setDraft((prev) => ({ ...prev, devices: { ...prev.devices, [k]: v } }));
  };

  const updateConfidence = (k: DeviceKey, v: CoverageDraft["confidenceByDevice"][DeviceKey]) => {
    setDraft((prev) => ({ ...prev, confidenceByDevice: { ...prev.confidenceByDevice, [k]: v } }));
  };

  const toggleCoveredAreaForDevice = (deviceKey: string, area: string) => {
    setDraft((prev) => {
      const current = Array.isArray(prev.coveredAreasByDevice?.[deviceKey]) ? prev.coveredAreasByDevice[deviceKey] : [];
      const exists = current.some((x) => x.toLowerCase() === area.toLowerCase());
      const next = exists ? current.filter((x) => x.toLowerCase() !== area.toLowerCase()) : [...current, area];
      return {
        ...prev,
        coveredAreasByDevice: {
          ...(prev.coveredAreasByDevice ?? {}),
          [deviceKey]: next,
        },
      };
    });
  };

  const updateScheduleType = (deviceKey: string, type: "none" | "on_demand" | "weekly") => {
    setDraft((prev) => {
      const current = prev.schedulesByDevice?.[deviceKey] ?? { type: "none", days: [], time: "" };
      return {
        ...prev,
        schedulesByDevice: {
          ...(prev.schedulesByDevice ?? {}),
          [deviceKey]: { ...current, type },
        },
      };
    });
  };

  const toggleScheduleDay = (deviceKey: string, day: number) => {
    setDraft((prev) => {
      const current = prev.schedulesByDevice?.[deviceKey] ?? { type: "weekly", days: [], time: "09:00" };
      const days = Array.isArray(current.days) ? current.days : [];
      const exists = days.includes(day);
      const nextDays = exists ? days.filter((d) => d !== day) : [...days, day];
      return {
        ...prev,
        schedulesByDevice: {
          ...(prev.schedulesByDevice ?? {}),
          [deviceKey]: { ...current, type: "weekly", days: nextDays },
        },
      };
    });
  };

  const updateScheduleTime = (deviceKey: string, time: string) => {
    setDraft((prev) => {
      const current = prev.schedulesByDevice?.[deviceKey] ?? { type: "weekly", days: [], time: "09:00" };
      return {
        ...prev,
        schedulesByDevice: {
          ...(prev.schedulesByDevice ?? {}),
          [deviceKey]: { ...current, time },
        },
      };
    });
  };

  const body = (() => {
    if (!householdId) {
      return <Alert severity="warning">Link your home first (Agent Setup → Set up my home), then configure coverage.</Alert>;
    }

    if (step === 0) {
      return (
        <Stack spacing={2}>
          <Alert severity="info">
            Experimental. Data is saved only to this browser (localStorage) and can be cleared anytime.
          </Alert>
          {loadError ? <Alert severity="warning">{loadError}</Alert> : null}
          <Typography variant="body2" color="text.secondary">
            Select any devices/subscriptions you use. This helps HomeOps know what’s already automated.
          </Typography>
          <Stack spacing={1.25}>
            {(Object.keys(DEVICE_LABELS) as DeviceKey[]).map((k) => (
              <Stack key={k} direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
                <FormControlLabel
                  control={<Switch checked={!!draft.devices[k]} onChange={(e) => updateDevice(k, e.target.checked)} />}
                  label={DEVICE_LABELS[k]}
                  sx={{ flex: 1 }}
                />
                <FormControl size="small" sx={{ minWidth: 160 }}>
                  <InputLabel>Reliability</InputLabel>
                  <Select
                    label="Reliability"
                    value={draft.confidenceByDevice[k]}
                    onChange={(e) => updateConfidence(k, e.target.value as any)}
                    disabled={!draft.devices[k]}
                  >
                    {(Object.keys(CONF_LABELS) as Array<keyof typeof CONF_LABELS>).map((v) => (
                      <MenuItem key={v} value={v}>
                        {CONF_LABELS[v]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            ))}
          </Stack>

          <Divider />

          <Stack spacing={1}>
            <Typography variant="subtitle2" fontWeight={700}>
              Other machines
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Add any other device that helps you run your home.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <TextField
                label="Add a machine"
                value={otherMachineInput}
                onChange={(e) => setOtherMachineInput(e.target.value)}
                size="small"
                fullWidth
                placeholder="e.g. Garment steamer"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const v = otherMachineInput.trim();
                  if (!v) return;
                  setDraft((prev) => ({
                    ...prev,
                    otherMachines: Array.from(new Set([...(prev.otherMachines ?? []), v])),
                  }));
                  setOtherMachineInput("");
                }}
              />
              <Button
                variant="outlined"
                sx={{ flexShrink: 0 }}
                disabled={!otherMachineInput.trim()}
                onClick={() => {
                  const v = otherMachineInput.trim();
                  if (!v) return;
                  setDraft((prev) => ({
                    ...prev,
                    otherMachines: Array.from(new Set([...(prev.otherMachines ?? []), v])),
                  }));
                  setOtherMachineInput("");
                }}
              >
                Add
              </Button>
            </Stack>

            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              {(draft.otherMachines ?? []).length === 0 ? (
                <Chip label="None" size="small" variant="outlined" />
              ) : (
                (draft.otherMachines ?? []).map((m) => (
                  <Chip
                    key={m}
                    label={m}
                    size="small"
                    variant="outlined"
                    onDelete={() =>
                      setDraft((prev) => ({
                        ...prev,
                        otherMachines: (prev.otherMachines ?? []).filter((x) => x !== m),
                      }))
                    }
                  />
                ))
              )}
            </Stack>
          </Stack>
        </Stack>
      );
    }

    if (step === 1) {
      return (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Review your automation coverage. For devices like robot vacuum/mop, select the rooms they cover and set a schedule.
          </Typography>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <TextField
              label="Add area"
              size="small"
              placeholder="e.g. kitchen"
              fullWidth
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = (e.target as HTMLInputElement).value.trim();
                if (!v) return;
                setDraft((prev) => ({ ...prev, areas: Array.from(new Set([...prev.areas, v])) }));
                (e.target as HTMLInputElement).value = "";
              }}
            />
            <Button
              variant="outlined"
              sx={{ flexShrink: 0 }}
              onClick={() => {
                if (homeSpaces.length === 0) return;
                setDraft((prev) => ({ ...prev, areas: Array.from(new Set([...prev.areas, ...homeSpaces])) }));
              }}
              disabled={homeSpaces.length === 0}
            >
              Use Home Profile spaces
            </Button>
          </Stack>

          <Box>
            <Typography variant="caption" color="text.secondary" display="block" mb={0.75}>
              Areas (rooms / zones)
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              {areas.length === 0 ? <Chip label="No areas yet" size="small" variant="outlined" /> : null}
              {areas.map((a) => (
                <Chip
                  key={a}
                  label={a}
                  size="small"
                  variant="outlined"
                  onDelete={() =>
                    setDraft((prev) => {
                      const nextAreas = prev.areas.filter((x) => x.trim().toLowerCase() !== a.trim().toLowerCase());
                      const nextCovered: Record<string, string[]> = { ...(prev.coveredAreasByDevice ?? {}) };
                      for (const k of Object.keys(nextCovered)) {
                        nextCovered[k] = (nextCovered[k] ?? []).filter((x) => x.trim().toLowerCase() !== a.trim().toLowerCase());
                      }
                      return { ...prev, areas: nextAreas, coveredAreasByDevice: nextCovered };
                    })
                  }
                />
              ))}
            </Stack>
          </Box>

          <Divider />

          <Stack spacing={1.25}>
            {(Object.keys(DEVICE_LABELS) as DeviceKey[])
              .filter((k) => !!draft.devices[k] && isZoneDevice(k))
              .map((k) => {
                const covered = Array.isArray(draft.coveredAreasByDevice?.[k]) ? draft.coveredAreasByDevice[k] : [];
                const sched = draft.schedulesByDevice?.[k] ?? { type: "weekly", days: [], time: "09:00" };
                return (
                  <Box key={k} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 1.25 }}>
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={700}>
                          {DEVICE_LABELS[k]}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                          Select rooms covered and schedule.
                        </Typography>
                      </Box>

                      <FormControl size="small" sx={{ minWidth: 160 }}>
                        <InputLabel>Schedule</InputLabel>
                        <Select
                          label="Schedule"
                          value={sched.type}
                          onChange={(e) => updateScheduleType(k, e.target.value as any)}
                        >
                          <MenuItem value="weekly">Weekly</MenuItem>
                          <MenuItem value="on_demand">On-demand</MenuItem>
                          <MenuItem value="none">No schedule</MenuItem>
                        </Select>
                      </FormControl>
                    </Stack>

                    <Stack spacing={1} mt={1}>
                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                          Rooms covered
                        </Typography>
                        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                          {areas.length === 0 ? <Chip label="Add areas above" size="small" variant="outlined" /> : null}
                          {areas.map((a) => {
                            const selected = covered.some((x) => x.toLowerCase() === a.toLowerCase());
                            return (
                              <Chip
                                key={`${k}:${a}`}
                                label={a}
                                size="small"
                                color={selected ? "primary" : "default"}
                                variant={selected ? "filled" : "outlined"}
                                onClick={() => toggleCoveredAreaForDevice(k, a)}
                              />
                            );
                          })}
                        </Stack>
                      </Box>

                      {sched.type === "weekly" ? (
                        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                              Days
                            </Typography>
                            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                              {WEEKDAY_LABELS.map(({ day, label }) => {
                                const selected = Array.isArray(sched.days) && sched.days.includes(day);
                                return (
                                  <Chip
                                    key={`${k}:day:${day}`}
                                    label={label}
                                    size="small"
                                    color={selected ? "primary" : "default"}
                                    variant={selected ? "filled" : "outlined"}
                                    onClick={() => toggleScheduleDay(k, day)}
                                  />
                                );
                              })}
                            </Stack>
                          </Box>
                          <TextField
                            label="Time"
                            type="time"
                            size="small"
                            value={typeof sched.time === "string" ? sched.time : ""}
                            onChange={(e) => updateScheduleTime(k, e.target.value)}
                            InputLabelProps={{ shrink: true }}
                            sx={{ width: { xs: "100%", sm: 160 } }}
                          />
                        </Stack>
                      ) : null}
                    </Stack>
                  </Box>
                );
              })}

            {(Object.keys(DEVICE_LABELS) as DeviceKey[]).filter((k) => !!draft.devices[k] && isZoneDevice(k)).length === 0 ? (
              <Alert severity="info">
                No room-based automations selected yet. Turn on Robot vacuum / Robot mop / Air purifier in the Devices step to configure coverage.
              </Alert>
            ) : null}
          </Stack>
        </Stack>
      );
    }

    return (
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          Summary (draft). This shows what automation devices you have, which rooms they cover, and their schedule.
        </Typography>
        <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 1.5 }}>
          <Typography variant="body2" fontWeight={700} mb={1}>
            Automated coverage
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
            {(Object.keys(DEVICE_LABELS) as DeviceKey[])
              .filter((k) => !!draft.devices[k])
              .map((k) => {
                const conf = draft.confidenceByDevice?.[k] ?? "reliable";
                const sched = draft.schedulesByDevice?.[k];
                const covered = Array.isArray(draft.coveredAreasByDevice?.[k]) ? draft.coveredAreasByDevice[k] : [];
                const schedText =
                  !sched || sched.type === "none"
                    ? "No schedule"
                    : sched.type === "on_demand"
                      ? "On-demand"
                      : `Weekly (${Array.isArray(sched.days) && sched.days.length > 0 ? sched.days.length : 0} days) at ${sched.time || ""}`.trim();
                const coverageText = isZoneDevice(k) ? `Rooms: ${covered.length > 0 ? covered.join(", ") : "(not selected)"}` : "(room coverage not applicable)";
                return `- ${DEVICE_LABELS[k]} — ${coverageText} — ${schedText} — ${CONF_LABELS[conf as any] ?? "Reliable"}`;
              })
              .join("\n") || "No devices selected yet."}
          </Typography>
        </Box>
        <Alert severity="info">
          To remove this experiment entirely, you can delete <code>src/app/experiments/coverage</code> and remove the single button/import in
          the Agent Setup dialog.
        </Alert>
      </Stack>
    );
  })();

  return (
    <>
      <Snackbar
        open={saveBannerOpen}
        autoHideDuration={2000}
        onClose={() => setSaveBannerOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="success" variant="filled" sx={{ width: "100%" }}>
          Saved automated coverage.
        </Alert>
      </Snackbar>
      <DialogContent>
        <Stack spacing={2} mt={0.5}>
          <Stepper activeStep={step} alternativeLabel>
            <Step>
              <StepLabel>Devices</StepLabel>
            </Step>
            <Step>
              <StepLabel>Areas</StepLabel>
            </Step>
            <Step>
              <StepLabel>Summary</StepLabel>
            </Step>
          </Stepper>

          {busy ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography variant="caption" color="text.secondary">
                Loading…
              </Typography>
            </Stack>
          ) : null}

          {body}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          color="error"
          variant="text"
          onClick={() => {
            clearCoverageDraft(householdId);
            setDraft(defaultCoverageDraft());
            setStep(0);
          }}
          disabled={!householdId}
        >
          Clear
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={props.onClose}>Close</Button>
        <Button variant="outlined" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          Back
        </Button>
        <Button
          variant="contained"
          onClick={() => {
            if (step >= 2) {
              persistDraft();
              setSaveBannerOpen(true);
              window.setTimeout(() => props.onClose(), 650);
              return;
            }
            setStep((s) => Math.min(2, s + 1));
          }}
        >
          {step >= 2 ? "Done" : "Next"}
        </Button>
      </DialogActions>
    </>
  );
}
