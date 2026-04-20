import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useI18n } from "../../i18n";

type RunRow = {
  id: string;
  type: "vitest" | "playwright";
  mode: "run" | "ui" | "watch";
  status: "queued" | "running" | "passed" | "failed";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  log_path: string;
  summary: string | null;
  report_path?: string | null;
};

type ScheduleRow = {
  id: string;
  name: string;
  cron_expr: string;
  enabled: 0 | 1;
  type: "vitest" | "playwright";
  mode: "run" | "ui" | "watch";
  created_at: string;
  last_run_at: string | null;
};

function formatIso(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function statusColor(status: RunRow["status"]) {
  if (status === "passed") return "success" as const;
  if (status === "failed") return "error" as const;
  if (status === "running") return "warning" as const;
  return "default" as const;
}

export function TestsDashboard() {
  const { t } = useI18n();
  const baseUrl = (import.meta.env.VITE_TEST_RUNNER_URL as string | undefined) ?? "http://localhost:4010";

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("Nightly Vitest");
  const [newCronExpr, setNewCronExpr] = useState("0 2 * * *");
  const [newType, setNewType] = useState<ScheduleRow["type"]>("vitest");
  const [newMode, setNewMode] = useState<ScheduleRow["mode"]>("run");

  const canUseWatch = newType === "vitest";

  useEffect(() => {
    if (!canUseWatch && newMode === "watch") setNewMode("run");
  }, [canUseWatch, newMode]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [runsRes, schedulesRes] = await Promise.all([
        fetch(`${baseUrl}/runs?limit=50`),
        fetch(`${baseUrl}/schedules`),
      ]);

      const runsJson = await runsRes.json();
      const schedulesJson = await schedulesRes.json();

      if (!runsJson?.ok) throw new Error(runsJson?.error || "Failed to load runs");
      if (!schedulesJson?.ok) throw new Error(schedulesJson?.error || "Failed to load schedules");

      setRuns(Array.isArray(runsJson.runs) ? runsJson.runs : []);
      setSchedules(Array.isArray(schedulesJson.schedules) ? schedulesJson.schedules : []);
    } catch (e) {
      setError(String(e));
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(id);
  }, [load]);

  const startRun = useCallback(
    async (type: RunRow["type"], mode: RunRow["mode"]) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${baseUrl}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, mode }),
        });
        const json = await res.json();
        if (!json?.ok) throw new Error(json?.error || "Failed to start run");
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [baseUrl, load],
  );

  const createSchedule = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          cron_expr: newCronExpr,
          enabled: true,
          type: newType,
          mode: newMode,
        }),
      });
      const json = await res.json();
      if (!json?.ok) throw new Error(json?.error || "Failed to create schedule");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, load, newCronExpr, newMode, newName, newType]);

  const toggleSchedule = useCallback(
    async (s: ScheduleRow) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${baseUrl}/schedules/${s.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: s.name,
            cron_expr: s.cron_expr,
            enabled: !(s.enabled === 1),
            type: s.type,
            mode: s.mode,
          }),
        });
        const json = await res.json();
        if (!json?.ok) throw new Error(json?.error || "Failed to update schedule");
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [baseUrl, load],
  );

  const deleteSchedule = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${baseUrl}/schedules/${id}`, { method: "DELETE" });
        const json = await res.json();
        if (!json?.ok) throw new Error(json?.error || "Failed to delete schedule");
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [baseUrl, load],
  );

  const runsById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);

  return (
    <Box display="flex" flexDirection="column" gap={2}>
      <Box>
        <Typography variant="h5" fontWeight={800}>
          {t("tests.title")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t("tests.subtitle")}
        </Typography>
      </Box>

      {error ? (
        <Card variant="outlined">
          <CardContent>
            <Typography color="error" fontWeight={600}>
              {error}
            </Typography>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("tests.run_now")} subheader={t("tests.run_now_help")} />
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} spacing={1} flexWrap="wrap">
            <Button variant="contained" disabled={busy} onClick={() => startRun("vitest", "run")}
              sx={{ textTransform: "none" }}>
              {t("tests.run_vitest")}
            </Button>
            <Button variant="outlined" disabled={busy} onClick={() => startRun("vitest", "watch")}
              sx={{ textTransform: "none" }}>
              {t("tests.run_vitest_watch")}
            </Button>
            <Button variant="outlined" disabled={busy} onClick={() => startRun("vitest", "ui")}
              sx={{ textTransform: "none" }}>
              {t("tests.run_vitest_ui")}
            </Button>
            <Divider flexItem orientation="vertical" sx={{ display: { xs: "none", md: "block" } }} />
            <Button variant="contained" disabled={busy} onClick={() => startRun("playwright", "run")}
              sx={{ textTransform: "none" }}>
              {t("tests.run_playwright")}
            </Button>
            <Button variant="outlined" disabled={busy} onClick={() => startRun("playwright", "ui")}
              sx={{ textTransform: "none" }}>
              {t("tests.run_playwright_ui")}
            </Button>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title={t("tests.schedules")} subheader={t("tests.schedules_help")} />
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ md: "center" }}>
            <TextField label={t("tests.schedule_name")} value={newName} onChange={(e) => setNewName(e.target.value)} size="small" fullWidth />
            <TextField label={t("tests.cron_expr")} value={newCronExpr} onChange={(e) => setNewCronExpr(e.target.value)} size="small" fullWidth />
            <FormControl size="small" fullWidth>
              <InputLabel>{t("tests.type")}</InputLabel>
              <Select value={newType} label={t("tests.type")} onChange={(e) => setNewType(e.target.value as any)}>
                <MenuItem value="vitest">Vitest</MenuItem>
                <MenuItem value="playwright">Playwright</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>{t("tests.mode")}</InputLabel>
              <Select value={newMode} label={t("tests.mode")} onChange={(e) => setNewMode(e.target.value as any)}>
                <MenuItem value="run">Run</MenuItem>
                <MenuItem value="ui">UI</MenuItem>
                <MenuItem value="watch" disabled={!canUseWatch}>
                  Watch
                </MenuItem>
              </Select>
            </FormControl>
            <Button variant="contained" disabled={busy} onClick={createSchedule} sx={{ textTransform: "none", whiteSpace: "nowrap" }}>
              {t("tests.add_schedule")}
            </Button>
          </Stack>

          <Divider sx={{ my: 2 }} />

          <Stack spacing={1}>
            {schedules.length === 0 ? (
              <Typography color="text.secondary">{t("tests.no_schedules")}</Typography>
            ) : (
              schedules.map((s) => (
                <Card key={s.id} variant="outlined">
                  <CardContent>
                    <Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ md: "center" }} justifyContent="space-between">
                      <Box>
                        <Typography fontWeight={700}>{s.name}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {s.type} • {s.mode} • {s.cron_expr}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t("tests.last_run")}: {formatIso(s.last_run_at)}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={1}>
                        <Button variant="outlined" disabled={busy} onClick={() => toggleSchedule(s)} sx={{ textTransform: "none" }}>
                          {s.enabled === 1 ? t("tests.disable") : t("tests.enable")}
                        </Button>
                        <Button variant="outlined" color="error" disabled={busy} onClick={() => deleteSchedule(s.id)} sx={{ textTransform: "none" }}>
                          {t("common.delete")}
                        </Button>
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              ))
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title={t("tests.recent_runs")} subheader={t("tests.recent_runs_help")} />
        <CardContent>
          <Stack spacing={1.5}>
            {runs.length === 0 ? (
              <Typography color="text.secondary">{t("tests.no_runs")}</Typography>
            ) : (
              runs.map((r) => (
                <Card key={r.id} variant="outlined">
                  <CardContent>
                    <Stack direction={{ xs: "column", md: "row" }} spacing={1} justifyContent="space-between" alignItems={{ md: "center" }}>
                      <Box>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography fontWeight={700}>
                            {r.type} • {r.mode}
                          </Typography>
                          <Chip size="small" label={r.status} color={statusColor(r.status)} />
                        </Stack>
                        <Typography variant="body2" color="text.secondary">
                          {t("tests.created")}: {formatIso(r.created_at)}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {t("tests.started")}: {formatIso(r.started_at)}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {t("tests.finished")}: {formatIso(r.finished_at)}
                        </Typography>
                        {r.summary ? (
                          <Typography variant="caption" color="text.secondary" display="block" sx={{ whiteSpace: "pre-wrap" }}>
                            {r.summary}
                          </Typography>
                        ) : null}
                      </Box>

                      <Stack direction="row" spacing={1}>
                        <Button
                          variant="outlined"
                          component="a"
                          href={`${baseUrl}/runs/${r.id}/log`}
                          target="_blank"
                          rel="noreferrer"
                          sx={{ textTransform: "none" }}
                        >
                          {t("tests.view_log")}
                        </Button>
                        {r.report_path ? (
                          <Button
                            variant="outlined"
                            component="a"
                            href={`${baseUrl}/runs/${r.id}/report`}
                            target="_blank"
                            rel="noreferrer"
                            sx={{ textTransform: "none" }}
                          >
                            {t("tests.view_report")}
                          </Button>
                        ) : null}
                        {runsById.get(r.id)?.status === "running" ? (
                          <Button
                            variant="outlined"
                            color="error"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await fetch(`${baseUrl}/runs/${r.id}/cancel`, { method: "POST" });
                                await load();
                              } catch {
                              } finally {
                                setBusy(false);
                              }
                            }}
                            sx={{ textTransform: "none" }}
                          >
                            {t("tests.cancel")}
                          </Button>
                        ) : null}
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              ))
            )}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
