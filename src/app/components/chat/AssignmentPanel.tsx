/**
 * Assignment panel — two assignment patterns:
 * 1. By helper specialty (cook → kitchen, maid → cleaning)
 * 2. By floor/area (ground floor → Roopa, first floor → Bhimappa)
 * Then: editable assignment list with frequency dropdowns.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { CheckCircle, Person, Layers } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import {
  buildAssignmentPlan,
  inferRoleTags,
  type AssignableChore,
  type AssignableHelper,
  type AssignmentPlan,
} from "../../services/choreAssigner";
import { floorLabel } from "../../config/homeProfileTemplates";
import { useI18n } from "../../i18n";

interface AssignmentPanelProps {
  onDismiss: () => void;
  onComplete: (count: number) => void;
}

interface HelperInfo { id: string; name: string; type: string; capacityMinutes: number; }
interface RoomInfo { displayName: string; floor: number | null; }

type Step = "pick_pattern" | "by_specialty" | "by_floor" | "assignments" | "applying" | "done";

const CADENCE_OPTIONS = ["daily", "every_2_days", "weekly", "biweekly", "monthly"] as const;

const SPECIALTY_AREAS = [
  { key: "all_cleaning", label: "All cleaning (sweep, mop, dust)", tags: ["cleaning", "sweeping", "mopping", "dusting", "bathroom", "bedroom", "living", "general"] },
  { key: "kitchen", label: "Kitchen & cooking", tags: ["kitchen", "cooking", "dining"] },
  { key: "bedrooms", label: "Bedrooms & living areas", tags: ["bedroom", "living", "dusting"] },
  { key: "bathrooms", label: "Bathrooms", tags: ["bathroom", "cleaning"] },
  { key: "outdoor", label: "Outdoor & garden", tags: ["garden", "outdoor", "balcony", "garage"] },
  { key: "laundry", label: "Laundry & ironing", tags: ["laundry", "washing", "ironing"] },
];

export function AssignmentPanel({ onDismiss, onComplete }: AssignmentPanelProps) {
  const { householdId, accessToken } = useAuth();
  const { lang } = useI18n();
  const [step, setStep] = useState<Step>("pick_pattern");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [helpers, setHelpers] = useState<HelperInfo[]>([]);
  const [rawChores, setRawChores] = useState<AssignableChore[]>([]);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);

  // Specialty preferences: helperId → selected area keys
  const [specialtyPrefs, setSpecialtyPrefs] = useState<Record<string, string[]>>({});

  // Floor preferences: floor number → helperId
  const [floorPrefs, setFloorPrefs] = useState<Record<string, string>>({});

  // Editable assignments: choreId → { helperId, cadence }
  const [assignments, setAssignments] = useState<Record<string, { helperId: string | null; cadence: string }>>({});

  const [applyProgress, setApplyProgress] = useState(0);
  const [applyTotal, setApplyTotal] = useState(0);

  // ── Load data ───────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!householdId) { setLoading(false); return; }
    setLoading(true);

    const [helpersRes, choresRes, profileRes] = await Promise.all([
      supabase.from("helpers").select("id,name,type,daily_capacity_minutes").eq("household_id", householdId),
      supabase.from("chores").select("id,title,metadata,helper_id,status")
        .eq("household_id", householdId).is("helper_id", null).is("deleted_at", null).neq("status", "completed"),
      supabase.from("home_profiles").select("spaces").eq("household_id", householdId).maybeSingle(),
    ]);

    setLoading(false);
    if (helpersRes.error || choresRes.error) {
      setError(helpersRes.error?.message ?? choresRes.error?.message ?? "Error");
      return;
    }

    const h: HelperInfo[] = (helpersRes.data ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id), name: String(r.name),
      type: String(r.type ?? "General"),
      capacityMinutes: Number(r.daily_capacity_minutes ?? 120),
    }));

    const c: AssignableChore[] = (choresRes.data ?? []).map((r: Record<string, unknown>) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id), title: String(r.title ?? ""),
        space: typeof meta.space === "string" ? meta.space : "",
        cadence: typeof meta.cadence === "string" ? meta.cadence : "weekly",
        estimatedMinutes: typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : 0,
        currentHelperId: null,
      };
    });

    // Parse rooms with floors
    let spaces = profileRes.data?.spaces;
    if (typeof spaces === "string") { try { spaces = JSON.parse(spaces); } catch { spaces = []; } }
    const roomList: RoomInfo[] = Array.isArray(spaces) ? spaces.map((s: unknown) => {
      if (typeof s === "string") return { displayName: s, floor: null };
      if (s && typeof s === "object") {
        const o = s as Record<string, unknown>;
        return {
          displayName: String(o.display_name ?? o.template_name ?? ""),
          floor: typeof o.floor === "number" ? o.floor : null,
        };
      }
      return { displayName: "", floor: null };
    }).filter((r: RoomInfo) => r.displayName) : [];

    setHelpers(h);
    setRawChores(c);
    setRooms(roomList);

    // Pre-fill specialty prefs from helper type
    const sp: Record<string, string[]> = {};
    for (const helper of h) {
      const tags = inferRoleTags(helper.type || null);
      let bestKey = "all_cleaning";
      let bestScore = 0;
      for (const area of SPECIALTY_AREAS) {
        const score = area.tags.filter((t) => tags.includes(t)).length;
        if (score > bestScore) { bestScore = score; bestKey = area.key; }
      }
      sp[helper.id] = [bestKey];
    }
    setSpecialtyPrefs(sp);
  }, [householdId]);

  useEffect(() => { void loadData(); }, [loadData]);

  // ── Floors available ────────────────────────────────────────────

  const floors = useMemo(() => {
    const floorSet = new Set<number>();
    for (const r of rooms) { if (r.floor !== null) floorSet.add(r.floor); }
    return [...floorSet].sort((a, b) => a - b);
  }, [rooms]);

  // Room names by floor
  const roomsByFloor = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const r of rooms) {
      if (r.floor === null) continue;
      if (!map[r.floor]) map[r.floor] = [];
      map[r.floor].push(r.displayName);
    }
    return map;
  }, [rooms]);

  // ── Generate assignments ────────────────────────────────────────

  const generateBySpecialty = () => {
    const assignableHelpers: AssignableHelper[] = helpers.map((h) => {
      const selectedKeys = specialtyPrefs[h.id] ?? [];
      const tags: string[] = [];
      for (const key of selectedKeys) {
        const area = SPECIALTY_AREAS.find((a) => a.key === key);
        if (area) tags.push(...area.tags);
      }
      return {
        id: h.id, name: h.name, type: h.type || null,
        dailyCapacityMinutes: h.capacityMinutes,
        roleTags: tags.length > 0 ? [...new Set(tags)] : inferRoleTags(h.type || null),
      };
    });
    const result = buildAssignmentPlan(rawChores, assignableHelpers);
    applyPlanToState(result);
    setStep("assignments");
  };

  const generateByFloor = () => {
    // Build a map: room name → helperId based on floor assignment
    const roomToHelper: Record<string, string> = {};
    for (const [floorStr, helperId] of Object.entries(floorPrefs)) {
      const floorNum = Number(floorStr);
      for (const roomName of (roomsByFloor[floorNum] ?? [])) {
        roomToHelper[roomName.toLowerCase()] = helperId;
      }
    }

    // Assign chores based on their space matching a room's floor
    const map: Record<string, { helperId: string | null; cadence: string }> = {};
    for (const chore of rawChores) {
      const spaceLower = chore.space.toLowerCase();
      const helperId = roomToHelper[spaceLower] ?? null;
      map[chore.id] = { helperId, cadence: chore.cadence };
    }
    setAssignments(map);
    setStep("assignments");
  };

  const applyPlanToState = (result: AssignmentPlan) => {
    const map: Record<string, { helperId: string | null; cadence: string }> = {};
    for (const a of result.assignments) {
      const chore = rawChores.find((c) => c.id === a.choreId);
      map[a.choreId] = { helperId: a.helperId, cadence: chore?.cadence ?? "weekly" };
    }
    setAssignments(map);
  };

  // ── Apply ───────────────────────────────────────────────────────

  const applyAssignments = async () => {
    if (!householdId || !accessToken) return;
    const toApply = Object.entries(assignments).filter(([, v]) => v.helperId);
    setStep("applying");
    setApplyTotal(toApply.length);
    setApplyProgress(0);
    setError(null);

    for (let i = 0; i < toApply.length; i++) {
      const [choreId, { helperId, cadence }] = toApply[i];
      const chore = rawChores.find((c) => c.id === choreId);
      const res = await executeToolCall({
        accessToken, householdId, scope: "household",
        toolCall: {
          id: `assign_${choreId}_${Date.now()}`,
          tool: "db.update",
          args: {
            table: "chores", id: choreId,
            patch: {
              helper_id: helperId,
              metadata: { ...(chore ? { space: chore.space } : {}), cadence, source: "assignment_panel" },
            },
          },
          reason: "Assign chore",
        },
      });
      if (!res.ok) {
        setError(`Failed: ${"error" in res ? res.error : "unknown"}`);
        setStep("assignments");
        return;
      }
      setApplyProgress(i + 1);
    }
    setStep("done");
    onComplete(toApply.length);
  };

  // ── Stats ───────────────────────────────────────────────────────

  const assignedCount = Object.values(assignments).filter((v) => v.helperId).length;
  const statCounts: Record<string, number> = {};
  for (const [, v] of Object.entries(assignments)) {
    if (v.helperId) statCounts[v.helperId] = (statCounts[v.helperId] ?? 0) + 1;
  }

  // ── Render ──────────────────────────────────────────────────────

  if (loading) {
    return <Paper variant="outlined" sx={{ p: 3, borderRadius: 2, maxWidth: 600, mx: "auto", maxHeight: "70vh", overflowY: "auto" }}>
      <Box display="flex" justifyContent="center" py={2}><CircularProgress size={24} /></Box>
    </Paper>;
  }

  if (step === "done") {
    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 600, mx: "auto", bgcolor: "success.50" }}>
        <Stack spacing={1} alignItems="center" py={1}>
          <CheckCircle color="success" sx={{ fontSize: 36 }} />
          <Typography variant="subtitle1" fontWeight={700}>{applyProgress} chore{applyProgress === 1 ? "" : "s"} assigned!</Typography>
          <Button size="small" variant="contained" onClick={onDismiss}>Done</Button>
        </Stack>
      </Paper>
    );
  }

  if (step === "applying") {
    return (
      <Paper variant="outlined" sx={{ p: 3, borderRadius: 2, maxWidth: 600, mx: "auto", maxHeight: "70vh", overflowY: "auto" }}>
        <Stack spacing={2} alignItems="center">
          <CircularProgress size={28} />
          <Typography variant="body2">Assigning... {applyProgress}/{applyTotal}</Typography>
          <LinearProgress variant="determinate" value={applyTotal > 0 ? (applyProgress / applyTotal) * 100 : 0} sx={{ width: "100%", height: 5, borderRadius: 1 }} />
        </Stack>
      </Paper>
    );
  }

  // ── Step 1: Pick pattern ────────────────────────────────────────

  if (step === "pick_pattern") {
    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 600, mx: "auto", maxHeight: "70vh", overflowY: "auto" }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>How should chores be assigned?</Typography>
            <Typography variant="body2" color="text.secondary">
              Pick a pattern that matches how your household works.
            </Typography>
          </Box>

          <Stack spacing={1.5}>
            <Card
              variant="outlined"
              sx={{ cursor: "pointer", "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" } }}
              onClick={() => setStep("by_specialty")}
            >
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Person color="primary" />
                  <Box>
                    <Typography variant="subtitle2" fontWeight={700}>By helper's specialty</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Maid handles cleaning, cook handles kitchen, driver handles outdoor — assign based on what each person does best.
                    </Typography>
                  </Box>
                </Stack>
              </CardContent>
            </Card>

            <Card
              variant="outlined"
              sx={{
                cursor: floors.length > 1 ? "pointer" : "default",
                opacity: floors.length > 1 ? 1 : 0.5,
                "&:hover": floors.length > 1 ? { borderColor: "primary.main", bgcolor: "action.hover" } : {},
              }}
              onClick={() => { if (floors.length > 1) setStep("by_floor"); }}
            >
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Layers color={floors.length > 1 ? "primary" : "disabled"} />
                  <Box>
                    <Typography variant="subtitle2" fontWeight={700}>By floor / area</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {floors.length > 1
                        ? `Your home has ${floors.length} floors. Assign one helper per floor.`
                        : "Your home has a single floor — this pattern works with multi-floor homes."}
                    </Typography>
                  </Box>
                </Stack>
              </CardContent>
            </Card>
          </Stack>

          <Button variant="text" size="small" onClick={onDismiss} sx={{ alignSelf: "flex-start", color: "text.secondary" }}>
            Not now
          </Button>
        </Stack>
      </Paper>
    );
  }

  // ── Step 2a: By specialty ───────────────────────────────────────

  if (step === "by_specialty") {
    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 600, mx: "auto", maxHeight: "70vh", overflowY: "auto" }}>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>What does each helper handle?</Typography>
            <Typography variant="body2" color="text.secondary">
              Select the areas each helper covers. Chores will be matched accordingly.
            </Typography>
          </Box>

          {helpers.map((h) => (
            <Card key={h.id} variant="outlined">
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" spacing={1} alignItems="center" mb={1}>
                  <Typography variant="subtitle2" fontWeight={700}>{h.name}</Typography>
                  <Chip size="small" label={h.type} variant="outlined" sx={{ fontSize: 11 }} />
                </Stack>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {SPECIALTY_AREAS.map((area) => {
                    const selected = (specialtyPrefs[h.id] ?? []).includes(area.key);
                    return (
                      <Chip
                        key={area.key} label={area.label} size="small"
                        color={selected ? "primary" : "default"}
                        variant={selected ? "filled" : "outlined"}
                        onClick={() => {
                          setSpecialtyPrefs((prev) => {
                            const cur = prev[h.id] ?? [];
                            return { ...prev, [h.id]: selected ? cur.filter((k) => k !== area.key) : [...cur, area.key] };
                          });
                        }}
                        sx={{ cursor: "pointer" }}
                      />
                    );
                  })}
                </Stack>
              </CardContent>
            </Card>
          ))}

          <Stack direction="row" spacing={1}>
            <Button variant="contained" size="small" onClick={generateBySpecialty}>Show assignments</Button>
            <Button variant="outlined" size="small" onClick={() => setStep("pick_pattern")}>Back</Button>
          </Stack>
        </Stack>
      </Paper>
    );
  }

  // ── Step 2b: By floor ───────────────────────────────────────────

  if (step === "by_floor") {
    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 600, mx: "auto", maxHeight: "70vh", overflowY: "auto" }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>Assign a helper to each floor</Typography>
            <Typography variant="body2" color="text.secondary">
              All chores on a floor will be assigned to the selected helper.
            </Typography>
          </Box>

          {floors.map((f) => {
            const floorRooms = roomsByFloor[f] ?? [];
            return (
              <Card key={f} variant="outlined">
                <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                  <Stack spacing={1}>
                    <Typography variant="subtitle2" fontWeight={700}>
                      {floorLabel(f, lang as "en" | "hi" | "kn")}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {floorRooms.slice(0, 6).join(", ")}{floorRooms.length > 6 ? ` +${floorRooms.length - 6} more` : ""}
                    </Typography>
                    <TextField
                      select size="small" fullWidth
                      label="Assign to"
                      value={floorPrefs[String(f)] ?? ""}
                      onChange={(e) => setFloorPrefs((prev) => ({ ...prev, [String(f)]: e.target.value }))}
                    >
                      <MenuItem value="" sx={{ color: "text.secondary" }}><em>Not assigned</em></MenuItem>
                      {helpers.map((h) => (
                        <MenuItem key={h.id} value={h.id}>{h.name} ({h.type})</MenuItem>
                      ))}
                    </TextField>
                  </Stack>
                </CardContent>
              </Card>
            );
          })}

          <Stack direction="row" spacing={1}>
            <Button variant="contained" size="small" onClick={generateByFloor}
              disabled={Object.values(floorPrefs).every((v) => !v)}>
              Show assignments
            </Button>
            <Button variant="outlined" size="small" onClick={() => setStep("pick_pattern")}>Back</Button>
          </Stack>
        </Stack>
      </Paper>
    );
  }

  // ── Step 3: Editable assignment list ────────────────────────────

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, maxWidth: 600, mx: "auto", maxHeight: "70vh", overflowY: "auto" }}>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" fontWeight={700}>Review & edit assignments</Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {helpers.map((h) => (
              <Chip key={h.id} size="small" label={`${h.name}: ${statCounts[h.id] ?? 0}`} variant="outlined" sx={{ fontSize: 11 }} />
            ))}
          </Stack>
        </Stack>

        <Typography variant="body2" color="text.secondary">
          Change the helper or frequency for any chore. Unassigned chores are highlighted.
        </Typography>

        <Box sx={{ maxHeight: 400, overflowY: "auto" }}>
          <Stack spacing={0.5}>
            {Object.entries(assignments).map(([choreId, { helperId, cadence }]) => {
              const chore = rawChores.find((c) => c.id === choreId);
              if (!chore) return null;
              return (
                <Stack key={choreId} direction="row" spacing={0.75} alignItems="center"
                  sx={{ py: 0.5, px: 1, borderRadius: 1, bgcolor: helperId ? "transparent" : "warning.50" }}>
                  <Box flex={1} minWidth={0}>
                    <Typography variant="body2" noWrap fontWeight={500} sx={{ fontSize: 13 }}>{chore.title}</Typography>
                    {chore.space && <Typography variant="caption" color="text.secondary">{chore.space}</Typography>}
                  </Box>
                  <TextField select size="small" value={cadence}
                    onChange={(e) => setAssignments((prev) => ({ ...prev, [choreId]: { ...prev[choreId], cadence: e.target.value } }))}
                    sx={{ minWidth: 95 }} SelectProps={{ native: true, sx: { fontSize: 12 } }}>
                    {CADENCE_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </TextField>
                  <TextField select size="small" value={helperId ?? ""}
                    onChange={(e) => setAssignments((prev) => ({ ...prev, [choreId]: { ...prev[choreId], helperId: e.target.value || null } }))}
                    sx={{ minWidth: 120 }} SelectProps={{ sx: { fontSize: 12 } }}>
                    <MenuItem value="" sx={{ fontSize: 12, color: "text.secondary" }}><em>Unassigned</em></MenuItem>
                    {helpers.map((h) => <MenuItem key={h.id} value={h.id} sx={{ fontSize: 12 }}>{h.name}</MenuItem>)}
                  </TextField>
                </Stack>
              );
            })}
          </Stack>
        </Box>

        <Stack direction="row" spacing={1}>
          <Button variant="contained" size="small" disabled={assignedCount === 0} onClick={() => void applyAssignments()}>
            Apply ({assignedCount})
          </Button>
          <Button variant="outlined" size="small" onClick={() => setStep("pick_pattern")}>Change pattern</Button>
          <Button variant="text" size="small" onClick={onDismiss} sx={{ color: "text.secondary" }}>Not now</Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
