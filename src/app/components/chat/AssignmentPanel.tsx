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
import { CheckCircle, Person, Layers, Chat, EditNote } from "@mui/icons-material";
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
  /** Called when user picks "Other" pattern — hands off to the chat agent */
  onSwitchToChat?: () => void;
}

interface HelperInfo {
  id: string;
  name: string;
  type: string;
  capacityMinutes: number;
  kind: "helper" | "member";
  workDays: string[]; // ["mon","tue","wed","thu","fri"]
  startTime: string;  // "10:30"
  endTime: string;    // "12:30"
}
interface RoomInfo { displayName: string; floor: number | null; }

type Step = "pick_pattern" | "by_specialty" | "by_floor" | "assignments" | "applying" | "done";

const CADENCE_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "alternate_days", label: "Alternate days" },
  { value: "every_3_days", label: "Every 3 days" },
  { value: "every_4_days", label: "Every 4 days" },
  { value: "weekly_mon", label: "Weekly — Mon" },
  { value: "weekly_tue", label: "Weekly — Tue" },
  { value: "weekly_wed", label: "Weekly — Wed" },
  { value: "weekly_thu", label: "Weekly — Thu" },
  { value: "weekly_fri", label: "Weekly — Fri" },
  { value: "weekly_sat", label: "Weekly — Sat" },
  { value: "weekly_sun", label: "Weekly — Sun" },
  { value: "biweekly_mon", label: "Alternate week — Mon" },
  { value: "biweekly_sat", label: "Alternate week — Sat" },
  { value: "monthly_1st_sat", label: "Monthly — 1st Sat" },
  { value: "monthly_1st_sun", label: "Monthly — 1st Sun" },
  { value: "monthly_2nd_sat", label: "Monthly — 2nd Sat" },
  { value: "monthly_3rd_sat", label: "Monthly — 3rd Sat" },
  { value: "monthly_last_sat", label: "Monthly — Last Sat" },
] as const;

/** Map legacy cadence values to the new day-specific format */
function normalizeCadence(raw: string): string {
  switch (raw) {
    case "weekly": return "weekly_sat";
    case "biweekly": return "biweekly_sat";
    case "every_2_days": return "alternate_days";
    case "monthly": return "monthly_1st_sat";
    default: return CADENCE_OPTIONS.some((o) => o.value === raw) ? raw : "weekly_sat";
  }
}

const SPECIALTY_AREAS = [
  { key: "all_cleaning", label: "All cleaning (sweep, mop, dust)", tags: ["cleaning", "sweeping", "mopping", "dusting", "bathroom", "bedroom", "living", "general"] },
  { key: "kitchen", label: "Kitchen & cooking", tags: ["kitchen", "cooking", "dining"] },
  { key: "bedrooms", label: "Bedrooms & living areas", tags: ["bedroom", "living", "dusting"] },
  { key: "bathrooms", label: "Bathrooms", tags: ["bathroom", "cleaning"] },
  { key: "outdoor", label: "Outdoor & garden", tags: ["garden", "outdoor", "balcony", "garage"] },
  { key: "laundry", label: "Laundry & ironing", tags: ["laundry", "washing", "ironing"] },
];

export function AssignmentPanel({ onDismiss, onComplete, onSwitchToChat }: AssignmentPanelProps) {
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

    const [helpersRes, choresRes, profileRes, membersRes] = await Promise.all([
      supabase.from("helpers").select("id,name,type,daily_capacity_minutes,metadata").eq("household_id", householdId),
      supabase.from("chores").select("id,title,metadata,helper_id,status")
        .eq("household_id", householdId).is("helper_id", null).is("deleted_at", null).neq("status", "completed"),
      supabase.from("home_profiles").select("spaces").eq("household_id", householdId).maybeSingle(),
      supabase.from("household_people").select("id,display_name,person_type").eq("household_id", householdId),
    ]);

    setLoading(false);
    if (helpersRes.error || choresRes.error) {
      setError(helpersRes.error?.message ?? choresRes.error?.message ?? "Error");
      return;
    }

    const h: HelperInfo[] = (helpersRes.data ?? []).map((r: Record<string, unknown>) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const schedule = (meta.schedule ?? {}) as Record<string, unknown>;
      const days = (schedule.days ?? {}) as Record<string, boolean>;
      const workDays = Object.entries(days).filter(([, v]) => v).map(([k]) => k);
      const startTime = typeof schedule.start === "string" ? schedule.start : "";
      const endTime = typeof schedule.end === "string" ? schedule.end : "";

      // Compute actual capacity from schedule if available
      let capacityMinutes = Number(r.daily_capacity_minutes ?? 120);
      if (startTime && endTime) {
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        const scheduleMins = (eh * 60 + em) - (sh * 60 + sm);
        if (scheduleMins > 0) capacityMinutes = scheduleMins;
      }

      return {
        id: String(r.id), name: String(r.name),
        type: String(r.type ?? "General"),
        capacityMinutes,
        kind: "helper" as const,
        workDays,
        startTime,
        endTime,
      };
    });

    // Add household members (adults only) as potential assignees
    const members: HelperInfo[] = ((membersRes.data ?? []) as Array<Record<string, unknown>>)
      .filter((m) => String(m.person_type) === "adult")
      .map((m) => ({
        id: `member_${m.id}`,
        name: `${String(m.display_name)} (Self)`,
        type: "Household member",
        capacityMinutes: 60,
        kind: "member" as const,
        workDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        startTime: "",
        endTime: "",
      }));

    const allHelpers = [...h, ...members];

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

    setHelpers(allHelpers);
    setRawChores(c);
    setRooms(roomList);

    // Load persisted rules if they exist, otherwise infer from helper type
    const { data: rulesData } = await supabase
      .from("assignment_rules")
      .select("template_id, template_params, helper_id")
      .eq("household_id", householdId);

    const savedRules = (rulesData ?? []) as Array<{ template_id: string; template_params: Record<string, unknown>; helper_id: string }>;

    if (savedRules.length > 0) {
      // Restore specialty prefs from persisted rules
      const sp: Record<string, string[]> = {};
      const fp: Record<string, string> = {};
      for (const rule of savedRules) {
        if (rule.template_id.startsWith("specialty_")) {
          const areaKey = String((rule.template_params as Record<string, unknown>).area_key ?? "");
          if (!sp[rule.helper_id]) sp[rule.helper_id] = [];
          if (areaKey && !sp[rule.helper_id].includes(areaKey)) sp[rule.helper_id].push(areaKey);
        } else if (rule.template_id.startsWith("floor_")) {
          const floor = String(rule.template_id.slice(6));
          fp[floor] = rule.helper_id;
        }
      }
      if (Object.keys(sp).length > 0) setSpecialtyPrefs(sp);
      if (Object.keys(fp).length > 0) setFloorPrefs(fp);
    } else {
      // Default: infer from helper type
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
    }
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
        workDays: h.workDays,
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
      map[chore.id] = { helperId, cadence: normalizeCadence(chore.cadence) };
    }
    setAssignments(map);
    setStep("assignments");
  };

  const applyPlanToState = (result: AssignmentPlan) => {
    const map: Record<string, { helperId: string | null; cadence: string }> = {};
    for (const a of result.assignments) {
      const chore = rawChores.find((c) => c.id === a.choreId);
      map[a.choreId] = { helperId: a.helperId, cadence: normalizeCadence(chore?.cadence ?? "weekly") };
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
    // Persist assignment preferences as rules for future auto-assignment
    if (householdId) {
      try {
        // Delete existing rules for this household, then insert fresh
        await supabase.from("assignment_rules").delete().eq("household_id", householdId);
        const rules: Array<Record<string, unknown>> = [];

        if (Object.keys(specialtyPrefs).length > 0) {
          // Save specialty preferences
          for (const [helperId, areaKeys] of Object.entries(specialtyPrefs)) {
            for (const areaKey of areaKeys) {
              const area = SPECIALTY_AREAS.find((a) => a.key === areaKey);
              if (!area) continue;
              rules.push({
                household_id: householdId,
                template_id: `specialty_${areaKey}`,
                template_params: { area_key: areaKey, area_tags: area.tags },
                helper_id: helperId,
                weight: 1.0,
                source: "elicitation",
              });
            }
          }
        }

        if (Object.keys(floorPrefs).length > 0) {
          // Save floor preferences
          for (const [floorStr, helperId] of Object.entries(floorPrefs)) {
            if (!helperId) continue;
            rules.push({
              household_id: householdId,
              template_id: `floor_${floorStr}`,
              template_params: { floor: Number(floorStr), rooms: roomsByFloor[Number(floorStr)] ?? [] },
              helper_id: helperId,
              weight: 1.0,
              source: "elicitation",
            });
          }
        }

        if (rules.length > 0) {
          await supabase.from("assignment_rules").insert(rules);
        }
      } catch {
        // Non-critical — assignments were already applied
      }
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
            <Card
              variant="outlined"
              sx={{ cursor: "pointer", "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" } }}
              onClick={() => {
                // Go straight to assignments with no pre-assignment — all chores unassigned
                const map: Record<string, { helperId: string | null; cadence: string }> = {};
                for (const c of rawChores) {
                  map[c.id] = { helperId: null, cadence: normalizeCadence(c.cadence) };
                }
                setAssignments(map);
                setStep("assignments");
              }}
            >
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <EditNote color="primary" />
                  <Box>
                    <Typography variant="subtitle2" fontWeight={700}>Direct assignment</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Manually pick a helper for each chore yourself. No auto-suggestion — full control.
                    </Typography>
                  </Box>
                </Stack>
              </CardContent>
            </Card>

            <Card
              variant="outlined"
              sx={{ cursor: "pointer", "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" } }}
              onClick={() => {
                if (onSwitchToChat) {
                  onSwitchToChat();
                } else {
                  onDismiss();
                }
              }}
            >
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Chat color="primary" />
                  <Box>
                    <Typography variant="subtitle2" fontWeight={700}>Other — describe your pattern</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Tell the agent how your household works. e.g., "Roopa does ground floor mornings, Bhimappa does first floor afternoons, Pallab only cooks."
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
                <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
                  <Typography variant="subtitle2" fontWeight={700}>{h.name}</Typography>
                  <Chip size="small" label={h.type} variant="outlined" sx={{ fontSize: 11 }} />
                  <Chip size="small" label={`${h.capacityMinutes} min/day`} variant="outlined" sx={{ fontSize: 10 }} />
                </Stack>
                {h.workDays.length > 0 && (
                  <Typography variant="caption" color="text.secondary" mb={1} display="block">
                    {h.workDays.map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(", ")}
                    {h.startTime && h.endTime ? ` · ${h.startTime}–${h.endTime}` : ""}
                  </Typography>
                )}
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
                    sx={{ minWidth: 140 }} SelectProps={{ native: true, sx: { fontSize: 11 } }}>
                    {CADENCE_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
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
