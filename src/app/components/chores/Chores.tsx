import { useEffect, useMemo, useState } from "react";
import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  CircularProgress,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  Chip,
  IconButton,
  Alert,
  FormControlLabel,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import {
  Add,
  Edit,
  Delete,
  RestoreFromTrash,
  CheckCircle,
  AccessTime,
  ErrorOutline,
  ReportProblem,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { agentCreate } from "../../services/agentApi";
import { executeToolCall } from "../../services/agentApi";
import { useI18n } from "../../i18n";
import { normalizeSpacesToRooms } from "../../config/homeProfileTemplates";
import { Link as RouterLink, useNavigate } from "react-router";
import { HealthAndSafety, Sync } from "@mui/icons-material";
import { useSyncSchedule } from "../../hooks/useSyncSchedule";
import { SyncResultsDrawer } from "./SyncResultsDrawer";
import { HelperDailyView } from "./HelperDailyView";
import { CreateChoreDialog } from "./CreateChoreDialog";
import { EditChoreDialog } from "./EditChoreDialog";
import { ChoreListView } from "./ChoreListView";
import { CoverageDashboard } from "../coverage/CoverageDashboard";

type ChoreRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  completed_at: string | null;
  helper_id: string | null;
  metadata: Record<string, unknown> | null;
  deleted_at?: string | null;
  created_at: string;
};

type CoverageCadence = "daily" | "weekly" | "biweekly" | "monthly";

type CoverageBaseline = {
  default: CoverageCadence[];
  kitchen: CoverageCadence[];
  bathroom: CoverageCadence[];
  balcony: CoverageCadence[];
  terrace: CoverageCadence[];
  garage: CoverageCadence[];
  utility: CoverageCadence[];
};

type HelperRow = {
  id: string;
  household_id: string;
  name: string;
  type: string | null;
  phone: string | null;
  notes: string | null;
  daily_capacity_minutes: number;
  created_at: string;
};

type HelperTimeOffRow = {
  id: string;
  household_id: string;
  helper_id: string;
  start_at: string;
  end_at: string;
};

function normalizeSpaceName(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function uniqStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function datetimeLocalFromIso(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function isoFromDatetimeLocal(value: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function nextLocalMorningIso(now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function todayDateString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDateTimeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(d);
}

function stableHashInt(value: string): number {
  const s = String(value ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function startOfLocalWeekMonday(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // move to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

export function Chores() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const scheduleSync = useSyncSchedule();
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [view, setView] = useState<"all" | "pending" | "in-progress" | "completed">("all");
  const [mode, setMode] = useState<"coverage" | "list" | "daily">("daily");
  const [coverageSubMode, setCoverageSubMode] = useState<"audit" | "matrix">("audit");
  const [coverageRefreshKey, setCoverageRefreshKey] = useState(0);
  const [spaceFilter, setSpaceFilter] = useState<string | null>(null);
  const [cadenceFilter, setCadenceFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [spaceClarifyOpen, setSpaceClarifyOpen] = useState(false);
  const [spaceClarifyTitle, setSpaceClarifyTitle] = useState<string>("");
  const [spaceClarifyOptions, setSpaceClarifyOptions] = useState<string[]>([]);
  const [spaceClarifySelection, setSpaceClarifySelection] = useState<string>("");
  const [spaceClarifyError, setSpaceClarifyError] = useState<string | null>(null);
  const [spaceClarifyPending, setSpaceClarifyPending] = useState<null | ((space: string) => Promise<void>)>(null);
  const [dedupeDialogOpen, setDedupeDialogOpen] = useState(false);
  const [dedupeTargets, setDedupeTargets] = useState<string[]>([]);
  const [dedupeGroupsCount, setDedupeGroupsCount] = useState(0);

  const [localizeDialogOpen, setLocalizeDialogOpen] = useState(false);
  const [localizeTargets, setLocalizeTargets] = useState<
    Array<{ id: string; title: string; description: string | null; nextTitle: string; nextDescription: string | null }>
  >([]);

  const [autoFillDialogOpen, setAutoFillDialogOpen] = useState(false);
  const [autoFillBusy, setAutoFillBusy] = useState(false);
  const [autoFillDrafts, setAutoFillDrafts] = useState<
    Array<{
      id: string;
      space: string;
      cadence: "daily" | "weekly" | "biweekly" | "monthly";
      title: string;
      description: string;
      priority: number;
      dueAt: string | null;
      metadata: Record<string, unknown>;
    }>
  >([]);
  const [autoFillSelected, setAutoFillSelected] = useState<Record<string, boolean>>({});

  const [editOpen, setEditOpen] = useState(false);
  const [editChore, setEditChore] = useState<ChoreRow | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState("pending");
  const [editPriority, setEditPriority] = useState("1");
  const [editDueAt, setEditDueAt] = useState("");
  const [editHelperId, setEditHelperId] = useState<string>("");
  const [editSpace, setEditSpace] = useState("");
  const [editSubspace, setEditSubspace] = useState("");
  const [editCadence, setEditCadence] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const { accessToken, householdId, user } = useAuth();

  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chores, setChores] = useState<ChoreRow[]>([]);
  const [homeSpaces, setHomeSpaces] = useState<string[]>([]);
  const [homeProfileId, setHomeProfileId] = useState<string | null>(null);
  const [homeNumBathrooms, setHomeNumBathrooms] = useState<number | null>(null);
  const [homeSpaceCounts, setHomeSpaceCounts] = useState<Record<string, number>>({});
  const [coverageBaseline, setCoverageBaseline] = useState<CoverageBaseline>({
    default: ["weekly"],
    kitchen: ["daily", "weekly"],
    bathroom: ["weekly"],
    balcony: ["monthly"],
    terrace: ["monthly"],
    garage: ["monthly"],
    utility: ["weekly"],
  });
  const [baselineDialogOpen, setBaselineDialogOpen] = useState(false);
  const [baselineDraft, setBaselineDraft] = useState<CoverageBaseline | null>(null);
  const [helpers, setHelpers] = useState<HelperRow[]>([]);
  const [helperTimeOffRows, setHelperTimeOffRows] = useState<HelperTimeOffRow[]>([]);

  const categoryOptions = useMemo(() => ["", "Cleaning", "Maintenance", "Cooking food"] as const, []);

  const helperOnLeaveAt = (helperId: string | null, atIso: string | null): boolean => {
    if (!helperId || !atIso) return false;
    const tms = new Date(atIso).getTime();
    if (Number.isNaN(tms)) return false;
    for (const r of helperTimeOffRows) {
      if (r.helper_id !== helperId) continue;
      const start = new Date(r.start_at).getTime();
      const end = new Date(r.end_at).getTime();
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      if (start <= tms && tms < end) return true;
    }
    return false;
  };

  const [snackOpen, setSnackOpen] = useState(false);
  const [snackSeverity, setSnackSeverity] = useState<"success" | "error" | "info">("success");
  const [snackMessage, setSnackMessage] = useState<string>("");

  const [dailyDate, setDailyDate] = useState<string>(() => todayDateString());
  const [dailyOnlyCadence, setDailyOnlyCadence] = useState<boolean>(false);

  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newHelperId, setNewHelperId] = useState<string>("");
  const [newCadence, setNewCadence] = useState<string>("");
  const [newDueAt, setNewDueAt] = useState<string>("");

  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChoreRow | null>(null);

  const [selectedChoreIds, setSelectedChoreIds] = useState<Record<string, boolean>>({});
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);

  const showSnack = (severity: "success" | "error" | "info", message: string) => {
    setSnackSeverity(severity);
    setSnackMessage(message);
    setSnackOpen(true);
  };

  const restoreChore = async (chore: ChoreRow) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid || !chore?.id) {
      showSnack("error", t("common.missing_session"));
      return;
    }

    setBusy(true);
    try {
      const upd = await executeToolCall({
        accessToken: token,
        householdId: hid,
        scope: "household",
        toolCall: {
          id: `chores_restore_${chore.id}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: chore.id, patch: { deleted_at: null } },
          reason: `Restore chore: ${chore.title}`,
        },
      });
      if (!upd.ok) {
        showSnack("error", "error" in upd ? upd.error : t("common.update_failed"));
        return;
      }

      setChores((prev) => prev.map((c) => (c.id === chore.id ? { ...c, deleted_at: null } : c)));
      showSnack("success", "Restored.");
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setBusy(false);
    }
  };

  const CHORE_SELECT = "id,title,description,status,priority,due_at,completed_at,helper_id,metadata,deleted_at,created_at";

  const applyDeletedFilter = <T,>(q: any): any => (includeDeleted ? q : q.is("deleted_at", null));

  const toggleChoreSelected = (id: string, checked: boolean) => {
    setSelectedChoreIds((prev) => {
      const next = { ...prev };
      if (checked) next[id] = true;
      else delete next[id];
      return next;
    });
  };

  const clearChoreSelection = () => setSelectedChoreIds({});

  const confirmDeleteChore = (chore: ChoreRow) => {
    setDeleteTarget(chore);
    setDeleteDialogOpen(true);
  };

  const runDeleteChore = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const target = deleteTarget;
    if (!token || !hid || !target?.id) {
      setDeleteDialogOpen(false);
      showSnack("error", t("common.missing_session"));
      return;
    }

    setBusy(true);
    setDeleteDialogOpen(false);
    try {
      const del = await executeToolCall({
        accessToken: token,
        householdId: hid,
        scope: "household",
        toolCall: {
          id: `chores_delete_${target.id}_${Date.now()}`,
          tool: "db.delete",
          args: { table: "chores", id: target.id },
          reason: `Delete chore: ${target.title}`,
        },
      });

      if (!del.ok) {
        showSnack("error", "error" in del ? del.error : t("common.delete_failed"));
        return;
      }

      setChores((prev) => prev.filter((c) => c.id !== target.id));
      setDeleteTarget(null);
      {
        const msg = `Deleted chore${target.title ? ` "${target.title}"` : ""}.`;
        showSnack("success", msg);
        try {
          window.dispatchEvent(new CustomEvent("homeops:chat-notify", { detail: { message: msg } }));
        } catch {
          // ignore
        }
      }
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setBusy(false);
    }
  };

  const detectAmbiguousAreaChore = (params: { title: string; description: string; metadata: Record<string, unknown>; spaces: string[] }) => {
    const meta = params.metadata ?? {};
    const existingSpace = typeof (meta as any).space === "string" ? String((meta as any).space).trim() : "";
    if (existingSpace) return { ok: true as const };

    const text = `${params.title} ${params.description}`.trim().toLowerCase();
    const wantsBathroom = /\b(bath(room)?|washroom|restroom|toilet|powder\s*room)\b/.test(text);
    const wantsBalcony = /\b(balcony|terrace|deck)\b/.test(text);
    if (!wantsBathroom && !wantsBalcony) return { ok: true as const };

    const normalizedSpaces = (Array.isArray(params.spaces) ? params.spaces : []).map((s) => ({ raw: String(s), norm: normalizeSpaceName(String(s)) }));
    const matches = normalizedSpaces
      .filter((s) => {
        if (wantsBathroom) return s.norm.includes("bath") || s.norm.includes("wash") || s.norm.includes("toilet") || s.norm.includes("powder");
        if (wantsBalcony) return s.norm.includes("balcony") || s.norm.includes("terrace") || s.norm.includes("deck");
        return false;
      })
      .map((s) => s.raw);

    const options = uniqStrings(matches);
    if (options.length <= 1) return { ok: true as const };
    return {
      ok: false as const,
      title: wantsBathroom ? "Which bathroom?" : "Which balcony?",
      options,
    };
  };

  const openSpaceClarification = (params: { title: string; options: string[]; onSelect: (space: string) => Promise<void> }) => {
    setSpaceClarifyError(null);
    setSpaceClarifyTitle(params.title);
    setSpaceClarifyOptions(params.options);
    setSpaceClarifySelection("");
    setSpaceClarifyPending(() => params.onSelect);
    setSpaceClarifyOpen(true);
  };

  const createManualChore = async (params?: { forcedSpace?: string }) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", t("common.missing_session"));
      return;
    }

    const title = newTitle.trim();
    if (!title) {
      showSnack("error", t("chores.missing_title"));
      return;
    }

    const dueIso = isoFromDatetimeLocal(newDueAt);
    let helperId: string | null = newHelperId.trim() || null;
    const helperOnLeave = helperOnLeaveAt(helperId, dueIso);
    if (helperOnLeave) helperId = null;

    const description = newDescription.trim();
    const dueAtIso = dueIso;

    const meta: Record<string, unknown> = {
      cadence: newCadence.trim() || null,
    };
    if (params?.forcedSpace) meta.space = params.forcedSpace;

    const ambiguous = detectAmbiguousAreaChore({ title, description, metadata: meta, spaces: homeSpaces });
    if (!ambiguous.ok) {
      openSpaceClarification({
        title: ambiguous.title,
        options: ambiguous.options,
        onSelect: async (space) => {
          setSpaceClarifyOpen(false);
          setSpaceClarifyPending(null);
          await createManualChore({ forcedSpace: space });
        },
      });
      return;
    }

    setBusy(true);
    try {
      const res = await agentCreate({
        accessToken: token,
        table: "chores",
        record: {
          household_id: hid,
          title,
          description: description || null,
          status: "pending",
          priority: 1,
          due_at: dueAtIso,
          helper_id: helperId,
          metadata: {
            space: params?.forcedSpace ?? null,
            cadence: newCadence.trim() || null,
            helper_unassigned_reason: helperOnLeave ? "helper_on_leave" : null,
          },
        },
        reason: "Manual chore creation",
      });
      if (!res.ok) {
        showSnack("error", "error" in res ? res.error : t("common.create_failed"));
        return;
      }

      const { data: refreshed, error: refreshError } = await supabase
        .from("chores")
        .select("id,title,description,status,priority,due_at,completed_at,helper_id,metadata,created_at")
        .eq("household_id", hid)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (refreshError) {
        showSnack("error", refreshError.message);
        return;
      }
      setChores((refreshed ?? []) as ChoreRow[]);
      showSnack("success", t("chores.created"));
      setDialogOpen(false);
      setNewTitle("");
      setNewDescription("");
      setNewHelperId("");
      setNewCadence("");
      setNewDueAt("");
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setBusy(false);
    }
  };

  const applyIndianChoreLocalization = (text: unknown): unknown => {
    if (typeof text !== "string") return text;
    const s = text;
    const rules: Array<[RegExp, string]> = [
      [/\bvacuuming\b/gi, "sweeping and mopping"],
      [/\bvacuumed\b/gi, "swept and mopped"],
      [/\bvacuum\b/gi, "sweep and mop"],
    ];
    return rules.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
  };

  const openLocalizationDialog = () => {
    const candidates: Array<{ id: string; title: string; description: string | null; nextTitle: string; nextDescription: string | null }> = [];
    for (const c of chores) {
      const nextTitle = String(applyIndianChoreLocalization(c.title) ?? c.title);
      const nextDescRaw = applyIndianChoreLocalization(c.description);
      const nextDescription = typeof nextDescRaw === "string" ? nextDescRaw : c.description;
      if (nextTitle !== c.title || nextDescription !== c.description) {
        candidates.push({ id: c.id, title: c.title, description: c.description, nextTitle, nextDescription });
      }
    }
    setLocalizeTargets(candidates);
    setLocalizeDialogOpen(true);
  };

  const runLocalization = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", t("common.missing_session"));
      return;
    }
    if (localizeTargets.length === 0) {
      setLocalizeDialogOpen(false);
      showSnack("info", t("chores.no_localization_needed"));
      return;
    }

    setBusy(true);
    try {
      for (const target of localizeTargets) {
        const upd = await executeToolCall({
          accessToken: token,
          householdId: hid,
          scope: "household",
          toolCall: {
            id: `chores_localize_${target.id}_${Date.now()}`,
            tool: "db.update",
            args: {
              table: "chores",
              id: target.id,
              patch: {
                title: target.nextTitle,
                description: target.nextDescription,
              },
            },
            reason: "Localize chore wording to Indian context",
          },
        });
        if (!upd.ok) {
          showSnack("error", "error" in upd ? upd.error : t("common.update_failed"));
          return;
        }
      }

      const { data: refreshed, error: refreshError } = await supabase
        .from("chores")
        .select("id,title,description,status,priority,due_at,completed_at,helper_id,metadata,created_at")
        .eq("household_id", hid)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (refreshError) {
        showSnack("error", refreshError.message);
        return;
      }
      setChores((refreshed ?? []) as ChoreRow[]);
      showSnack("success", `${t("chores.localized")} ${localizeTargets.length} ${t("chores.chore_s")}`);
      setLocalizeDialogOpen(false);
      setLocalizeTargets([]);
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setBusy(false);
    }
  };

  const normalizeKeyPart = (value: unknown): string => {
    return String(value ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  };

  const normalizeSpace = (value: unknown): string => {
    return String(value ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  };

  const getMetaStrings = (c: ChoreRow): { space: string; subspace: string; cadence: string } => {
    const meta = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? (c.metadata as any) : {};
    const spaceRaw = typeof meta.space === "string" ? String(meta.space).trim() : "";
    const subspaceRaw = typeof meta.subspace === "string" ? String(meta.subspace).trim() : "";
    const cadenceRaw = typeof meta.cadence === "string" ? String(meta.cadence).trim() : "";
    return {
      space: spaceRaw || t("chores.unassigned"),
      subspace: subspaceRaw,
      cadence: cadenceRaw || "",
    };
  };

  const computeDuplicateDeletions = (rows: ChoreRow[]): { deleteIds: string[]; groups: number } => {
    const groups = new Map<string, ChoreRow[]>();
    for (const c of rows) {
      const { space, subspace, cadence } = getMetaStrings(c);
      const key = [normalizeKeyPart(c.title), normalizeKeyPart(space), normalizeKeyPart(subspace), normalizeKeyPart(cadence)].join("|");
      const arr = groups.get(key) ?? [];
      arr.push(c);
      groups.set(key, arr);
    }

    const deleteIds: string[] = [];
    let groupCount = 0;

    for (const arr of groups.values()) {
      if (arr.length <= 1) continue;
      groupCount += 1;

      const completed = arr.filter((c) => c.status === "completed" || !!c.completed_at);
      const sortNewestFirst = (a: ChoreRow, b: ChoreRow) => {
        const ams = new Date(a.created_at).getTime();
        const bms = new Date(b.created_at).getTime();
        return (Number.isFinite(bms) ? bms : 0) - (Number.isFinite(ams) ? ams : 0);
      };

      const keep = (completed.length > 0 ? completed.sort(sortNewestFirst)[0] : arr.sort(sortNewestFirst)[0]) as ChoreRow;

      for (const c of arr) {
        if (c.id === keep.id) continue;
        deleteIds.push(c.id);
      }
    }

    return { deleteIds, groups: groupCount };
  };

  const openDedupeDialog = () => {
    const { deleteIds, groups } = computeDuplicateDeletions(chores);
    setDedupeTargets(deleteIds);
    setDedupeGroupsCount(groups);
    if (deleteIds.length === 0) {
      showSnack("info", t("chores.no_duplicates_found"));
      return;
    }
    setDedupeDialogOpen(true);
  };

  const runDedupeDeletion = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", t("common.missing_session"));
      return;
    }
    if (dedupeTargets.length === 0) {
      setDedupeDialogOpen(false);
      return;
    }

    setBusy(true);
    setDedupeDialogOpen(false);
    try {
      for (const id of dedupeTargets) {
        const del = await executeToolCall({
          accessToken: token,
          householdId: hid,
          scope: "household",
          toolCall: {
            id: `dedupe_delete_${id}_${Date.now()}`,
            tool: "db.delete",
            args: { table: "chores", id },
            reason: "Remove duplicate chore (title + space + cadence).",
          },
        });
        if (!del.ok) {
          showSnack("error", "error" in del ? del.error : t("common.delete_failed"));
          return;
        }
      }

      const { data: refreshed, error: refreshError } = await supabase
        .from("chores")
        .select("id,title,description,status,priority,due_at,completed_at,helper_id,metadata,created_at")
        .eq("household_id", hid)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (refreshError) {
        showSnack("error", refreshError.message);
        return;
      }

      setChores((refreshed ?? []) as ChoreRow[]);
      setDedupeTargets([]);
      setDedupeGroupsCount(0);
      showSnack("success", `${t("chores.removed")} ${dedupeTargets.length} ${t("chores.duplicate_chore_s")}`);
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!householdId.trim()) return;

    let cancelled = false;
    (async () => {
      setBusy(true);
      setLoadError(null);
      const base = supabase
        .from("chores")
        .select(CHORE_SELECT)
        .eq("household_id", householdId.trim());
      const { data, error } = await applyDeletedFilter(base).order("created_at", { ascending: false });

      if (cancelled) return;
      setBusy(false);
      if (error) {
        setLoadError(error.message);
        return;
      }
      setChores((data ?? []) as ChoreRow[]);
    })();

    return () => {
      cancelled = true;
    };
  }, [householdId, includeDeleted]);

  useEffect(() => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;
    if (helpers.length === 0) return;
    const hasCook = helpers.some((h) => h.name.trim().toLowerCase() === "cook");
    if (hasCook) return;

    let cancelled = false;
    (async () => {
      const res = await executeToolCall({
        accessToken: token,
        householdId: hid,
        scope: "household",
        toolCall: {
          id: `helpers_create_cook_${Date.now()}`,
          tool: "db.insert",
          args: {
            table: "helpers",
            record: {
              name: "Cook",
              type: "cook",
              notes: "Cooking",
              phone: null,
            },
          },
          reason: "Ensure cook helper exists",
        },
      });
      if (cancelled) return;
      if (!res.ok) return;
      const { data, error } = await supabase
        .from("helpers")
        .select("id,household_id,name,type,phone,notes,daily_capacity_minutes,created_at")
        .eq("household_id", hid)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (!error) setHelpers((data ?? []) as HelperRow[]);
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, householdId, helpers]);

  const helpersById = useMemo(() => new Map(helpers.map((h) => [h.id, h] as const)), [helpers]);
  const helperName = (id: string | null): string => {
    if (!id) return t("chores.unassigned");
    return helpersById.get(id)?.name ?? t("common.unknown");
  };

  const extractCategory = (c: ChoreRow): string => {
    const meta = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? (c.metadata as any) : {};
    return typeof meta.category === "string" ? String(meta.category).trim() : "";
  };

  const assignChore = async (chore: ChoreRow, nextHelperId: string | null) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", t("common.missing_session"));
      return;
    }
    if (helperOnLeaveAt(nextHelperId, chore.due_at)) {
      showSnack("info", t("helpers.helper_on_leave"));
      return;
    }
    setBusy(true);
    const upd = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `chores_assign_${chore.id}_${Date.now()}`,
        tool: "db.update",
        args: {
          table: "chores",
          id: chore.id,
          patch: {
            helper_id: nextHelperId,
          },
        },
        reason: "Assign chore",
      },
    });
    setBusy(false);
    if (!upd.ok) {
      showSnack("error", "error" in upd ? upd.error : t("common.update_failed"));
      return;
    }
    setChores((prev) => prev.map((c) => (c.id === chore.id ? { ...c, helper_id: nextHelperId } : c)));
    showSnack("success", `${t("chores.assigned_to")} ${helperName(nextHelperId)}`);
  };

  const openBaselineEditor = () => {
    setBaselineDraft({ ...coverageBaseline });
    setBaselineDialogOpen(true);
  };

  const saveBaseline = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", t("common.missing_session"));
      return;
    }
    if (!baselineDraft) {
      showSnack("error", t("chores.missing_baseline_draft"));
      return;
    }

    let profileId = homeProfileId;
    if (!profileId) {
      const { data: hp, error: hpError } = await supabase
        .from("home_profiles")
        .select("household_id")
        .eq("household_id", hid)
        .limit(1)
        .maybeSingle();
      if (hpError) {
        showSnack("error", hpError.message);
        return;
      }
      profileId = typeof (hp as any)?.household_id === "string" ? String((hp as any).household_id) : null;
      if (profileId) setHomeProfileId(profileId);
    }
    if (!profileId) {
      showSnack("error", t("chores.no_home_profile"));
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("home_profiles")
        .select("metadata")
        .eq("household_id", profileId)
        .limit(1)
        .maybeSingle();
      if (error) {
        showSnack("error", error.message);
        return;
      }
      const currentMeta: Record<string, unknown> =
        (data as any)?.metadata && typeof (data as any).metadata === "object" && !Array.isArray((data as any).metadata)
          ? ((data as any).metadata as Record<string, unknown>)
          : {};
      const nextMeta = { ...currentMeta, coverage_baseline: baselineDraft };

      const upd = await executeToolCall({
        accessToken: token,
        householdId: hid,
        scope: "household",
        toolCall: {
          id: `coverage_baseline_${Date.now()}`,
          tool: "db.update",
          args: { table: "home_profiles", id: profileId, patch: { metadata: nextMeta } },
          reason: "Update coverage baseline",
        },
      });
      if (!upd.ok) {
        showSnack("error", "error" in upd ? upd.error : t("common.update_failed"));
        return;
      }

      setCoverageBaseline(baselineDraft);
      setBaselineDialogOpen(false);
      setBaselineDraft(null);
      showSnack("success", t("chores.baseline_updated"));
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!householdId.trim()) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("helpers")
        .select("id,household_id,name,type,phone,notes,daily_capacity_minutes,created_at")
        .eq("household_id", householdId.trim())
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        setHelpers([]);
        return;
      }
      setHelpers((data ?? []) as HelperRow[]);
    })();

    return () => {
      cancelled = true;
    };
  }, [householdId]);

  useEffect(() => {
    const hid = householdId.trim();
    if (!hid) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("member_time_off")
        .select("id,household_id,helper_id,start_at,end_at")
        .eq("household_id", hid)
        .eq("member_kind", "helper")
        .order("start_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        setHelperTimeOffRows([]);
        return;
      }
      setHelperTimeOffRows((data ?? []) as HelperTimeOffRow[]);
    })();

    return () => {
      cancelled = true;
    };
  }, [householdId]);

  const openEdit = (chore: ChoreRow) => {
    setEditChore(chore);
    setEditTitle(chore.title ?? "");
    setEditDescription(chore.description ?? "");
    setEditStatus(chore.status ?? "pending");
    setEditPriority(String(typeof chore.priority === "number" && Number.isFinite(chore.priority) ? chore.priority : 1));
    setEditDueAt(datetimeLocalFromIso(chore.due_at));
    setEditHelperId(chore.helper_id ?? "");
    const meta = chore.metadata && typeof chore.metadata === "object" && !Array.isArray(chore.metadata) ? (chore.metadata as any) : {};
    setEditSpace(typeof meta.space === "string" ? String(meta.space).trim() : "");
    setEditSubspace(typeof meta.subspace === "string" ? String(meta.subspace).trim() : "");
    setEditCadence(typeof meta.cadence === "string" ? String(meta.cadence).trim() : "");
    setEditCategory(typeof meta.category === "string" ? String(meta.category).trim() : "");
    setEditOpen(true);
  };

  const saveEdit = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid || !editChore?.id) {
      showSnack("error", t("common.missing_session"));
      return;
    }

    const nextPriority = Math.max(1, Math.min(3, Number(editPriority) || 1));
    const nextDueAt = isoFromDatetimeLocal(editDueAt);

    if (helperOnLeaveAt(editHelperId.trim() || null, nextDueAt)) {
      showSnack("info", t("helpers.helper_on_leave"));
      return;
    }

    const baseMeta: Record<string, unknown> =
      editChore.metadata && typeof editChore.metadata === "object" && !Array.isArray(editChore.metadata)
        ? (editChore.metadata as Record<string, unknown>)
        : {};
    const nextMeta: Record<string, unknown> = { ...baseMeta };
    if (editSpace.trim()) nextMeta.space = editSpace.trim();
    else delete (nextMeta as any).space;
    if (editSubspace.trim()) nextMeta.subspace = editSubspace.trim();
    else delete (nextMeta as any).subspace;
    if (editCadence.trim()) nextMeta.cadence = editCadence.trim();
    else delete (nextMeta as any).cadence;
    if (editCategory.trim()) nextMeta.category = editCategory.trim();
    else delete (nextMeta as any).category;

    setEditBusy(true);
    const upd = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `chores_edit_${editChore.id}_${Date.now()}`,
        tool: "db.update",
        args: {
          table: "chores",
          id: editChore.id,
          patch: {
            title: editTitle.trim() || editChore.title,
            description: editDescription.trim() || null,
            status: editStatus,
            priority: nextPriority,
            due_at: nextDueAt,
            helper_id: editHelperId.trim() || null,
            metadata: nextMeta,
          },
        },
        reason: "Edit chore from chore card",
      },
    });
    setEditBusy(false);

    if (!upd.ok) {
      showSnack("error", "error" in upd ? upd.error : t("common.update_failed"));
      return;
    }

    const { data: refreshed, error: refreshError } = await supabase
      .from("chores")
      .select("id,title,description,status,priority,due_at,completed_at,helper_id,metadata,created_at")
      .eq("household_id", hid)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (refreshError) {
      showSnack("error", refreshError.message);
      return;
    }
    setChores((refreshed ?? []) as ChoreRow[]);

    setEditOpen(false);
    setEditChore(null);
    showSnack("success", t("chores.chore_updated"));
  };

  useEffect(() => {
    if (!householdId.trim()) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("home_profiles")
        .select("household_id, spaces, space_counts, num_bathrooms, metadata")
        .eq("household_id", householdId.trim())
        .maybeSingle();

      if (cancelled) return;
      if (error) {
        setHomeSpaces([]);
        return;
      }

      const row = (data as any) ?? null;
      setHomeProfileId(typeof row?.household_id === "string" ? row.household_id : null);
      setHomeNumBathrooms(typeof row?.num_bathrooms === "number" && Number.isFinite(row.num_bathrooms) ? row.num_bathrooms : null);

      const countsRaw = row?.space_counts;
      const nextCounts: Record<string, number> =
        countsRaw && typeof countsRaw === "object" && !Array.isArray(countsRaw)
          ? Object.fromEntries(
              Object.entries(countsRaw as Record<string, unknown>)
                .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
                .map(([k, v]) => [String(k), Number(v)]),
            )
          : {};
      setHomeSpaceCounts(nextCounts);

      const meta = row?.metadata;
      const baselineRaw =
        meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as any).coverage_baseline : null;
      if (baselineRaw && typeof baselineRaw === "object" && !Array.isArray(baselineRaw)) {
        const pickArr = (key: keyof CoverageBaseline, fallback: CoverageCadence[]): CoverageCadence[] => {
          const v = (baselineRaw as any)[key];
          return Array.isArray(v) ? (v as unknown[]).map(String).filter(Boolean) as CoverageCadence[] : fallback;
        };
        setCoverageBaseline({
          default: pickArr("default", ["weekly"]),
          kitchen: pickArr("kitchen", ["daily", "weekly"]),
          bathroom: pickArr("bathroom", ["weekly"]),
          balcony: pickArr("balcony", ["monthly"]),
          terrace: pickArr("terrace", ["monthly"]),
          garage: pickArr("garage", ["monthly"]),
          utility: pickArr("utility", ["weekly"]),
        });
      }
      // Spaces may be either string[] (legacy) or RoomEntry[] (current format).
      // Defensive: if the JSONB column comes back as a string, parse it.
      let rawSpacesField: unknown = (data as any)?.spaces;
      if (typeof rawSpacesField === "string") {
        try {
          rawSpacesField = JSON.parse(rawSpacesField);
        } catch {
          // leave as-is, normalizeSpacesToRooms will return []
        }
      }
      const rooms = normalizeSpacesToRooms(rawSpacesField);
      const rawSpaces = rooms
        .map((rm) => (rm.display_name || rm.template_name || "").trim())
        .filter(Boolean);
      const seen = new Set<string>();
      const spaces: string[] = [];
      for (const s of rawSpaces) {
        const k = normalizeSpace(s);
        if (!k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        spaces.push(s);
      }
      setHomeSpaces(spaces);
    })();

    return () => {
      cancelled = true;
    };
  }, [householdId]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle color="success" />;
      case "in-progress":
        return <AccessTime color="warning" />;
      default:
        return <ErrorOutline color="action" />;
    }
  };

  const filteredChores = useMemo(
    () => {
      const byStatus = view === "all" ? chores : chores.filter((chore) => chore.status === view);
      const bySpace = spaceFilter
        ? byStatus.filter((chore) => {
            const { space } = getMetaStrings(chore);
            return normalizeSpace(space) === normalizeSpace(spaceFilter);
          })
        : byStatus;
      const byCadence = cadenceFilter
        ? bySpace.filter((chore) => {
            const { cadence } = getMetaStrings(chore);
            return normalizeSpace(cadence) === normalizeSpace(cadenceFilter);
          })
        : bySpace;
      const byCategory = categoryFilter
        ? byCadence.filter((chore) => normalizeSpace(extractCategory(chore)) === normalizeSpace(categoryFilter))
        : byCadence;
      return byCategory;
    },
    [chores, view, spaceFilter, cadenceFilter, categoryFilter],
  );

  const runBulkDelete = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const ids = selectedVisibleIds;
    if (!token || !hid) {
      setBulkDeleteDialogOpen(false);
      showSnack("error", t("common.missing_session"));
      return;
    }
    if (ids.length === 0) {
      setBulkDeleteDialogOpen(false);
      return;
    }

    setBusy(true);
    setBulkDeleteDialogOpen(false);
    try {
      for (const id of ids) {
        const del = await executeToolCall({
          accessToken: token,
          householdId: hid,
          scope: "household",
          toolCall: {
            id: `chores_bulk_delete_${id}_${Date.now()}`,
            tool: "db.delete",
            args: { table: "chores", id },
            reason: "Bulk delete chores",
          },
        });
        if (!del.ok) {
          showSnack("error", "error" in del ? del.error : t("common.delete_failed"));
          return;
        }
      }

      const idSet = new Set(ids);
      setChores((prev) => prev.filter((c) => !idSet.has(c.id)));
      setSelectedChoreIds((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      {
        const msg = `Deleted ${ids.length} chore${ids.length === 1 ? "" : "s"}.`;
        showSnack("success", msg);
        try {
          window.dispatchEvent(new CustomEvent("homeops:chat-notify", { detail: { message: msg } }));
        } catch {
          // ignore
        }
      }
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setBusy(false);
    }
  };

  const groupChoresByHelper = (rows: ChoreRow[]): { unassigned: ChoreRow[]; byHelper: Array<{ helper: HelperRow; chores: ChoreRow[] }> } => {
    const unassigned = rows.filter((c) => !c.helper_id);
    const byId = new Map<string, ChoreRow[]>();
    for (const c of rows) {
      if (!c.helper_id) continue;
      const arr = byId.get(c.helper_id) ?? [];
      arr.push(c);
      byId.set(c.helper_id, arr);
    }
    const helperOrder = [...helpers].sort((a, b) => a.name.localeCompare(b.name));
    const byHelper = helperOrder
      .map((h) => ({ helper: h, chores: byId.get(h.id) ?? [] }))
      .filter((x) => x.chores.length > 0);
    return { unassigned, byHelper };
  };

  const renderChoreCard = (chore: ChoreRow) => {
    const category = extractCategory(chore);
    const isDeleted = !!chore.deleted_at;
    return (
      <Card key={chore.id}>
        <CardHeader
          title={
            <Box display="flex" alignItems="center" gap={1}>
              {getStatusIcon(chore.status)}
              <Typography variant="h6">{chore.title}</Typography>
            </Box>
          }
          subheader={chore.description}
          action={
            <Box>
              <IconButton onClick={() => void reportNotDone(chore)} disabled={busy} aria-label={t("chores.aria_report_not_done")}>
                <ReportProblem />
              </IconButton>
              <IconButton onClick={() => openEdit(chore)} disabled={busy} aria-label={t("chores.aria_edit_chore")}>
                <Edit />
              </IconButton>
              {isDeleted ? (
                <IconButton onClick={() => void restoreChore(chore)} disabled={busy} aria-label="Restore">
                  <RestoreFromTrash />
                </IconButton>
              ) : (
                <IconButton color="error" onClick={() => confirmDeleteChore(chore)} disabled={busy} aria-label={t("common.delete")}>
                  <Delete />
                </IconButton>
              )}
            </Box>
          }
        />
        <CardContent>
          <Box display="flex" flexWrap="wrap" gap={1} mb={2} alignItems="center">
            <Chip label={chore.status} color={chore.status === "completed" ? "success" : "default"} />
            <Chip
              label={`priority ${typeof chore.priority === "number" ? chore.priority : 1}`}
              color={(chore.priority ?? 1) >= 3 ? "error" : (chore.priority ?? 1) === 2 ? "warning" : "info"}
            />
            {(() => {
              const { space, subspace, cadence } = getMetaStrings(chore);
              const spaceLabel = subspace ? `${space} · ${subspace}` : space;
              return (
                <>
                  <Chip label={spaceLabel} />
                  {cadence ? <Chip label={cadence} /> : null}
                </>
              );
            })()}
            {category ? <Chip label={category} /> : null}
          </Box>

          <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" mb={1}>
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel>{t("chores.assign_to")}</InputLabel>
              <Select
                label={t("chores.assign_to")}
                value={chore.helper_id ?? ""}
                onChange={(e) => void assignChore(chore, String(e.target.value || "").trim() || null)}
              >
                <MenuItem value="">{t("chores.unassigned")}</MenuItem>
                {helpers
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((h) => (
                    <MenuItem key={h.id} value={h.id} disabled={helperOnLeaveAt(h.id, chore.due_at)}>
                      {h.name}
                    </MenuItem>
                  ))}
              </Select>
            </FormControl>
            <Typography variant="caption" color="textSecondary">
              {t("chores.current")}: {helperName(chore.helper_id)}
              {chore.helper_id && helperOnLeaveAt(chore.helper_id, chore.due_at) ? (
                <Chip size="small" color="warning" label={t("helpers.on_leave")} sx={{ ml: 1 }} />
              ) : null}
            </Typography>
          </Box>

          {chore.due_at ? (
            <Typography variant="body2" color="textSecondary">
              {t("chores.due")}: <strong>{localDateTimeLabel(chore.due_at)}</strong>
            </Typography>
          ) : null}
        </CardContent>
      </Card>
    );
  };

  const renderChoreListRow = (chore: ChoreRow) => {
    const { space, subspace, cadence } = getMetaStrings(chore);
    const spaceLabel = subspace ? `${space} · ${subspace}` : space;
    const dueLabel = localDateTimeLabel(chore.due_at);
    const isDeleted = !!chore.deleted_at;

    return (
      <Card key={chore.id} variant="outlined" sx={{ borderRadius: 2 }}>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "auto 1fr",
              md: "auto minmax(260px, 2fr) minmax(160px, 1fr) minmax(140px, 0.9fr) minmax(180px, 1fr) auto",
            },
            gap: 1,
            alignItems: "center",
            px: 1.5,
            py: 1,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "flex-start", pt: 0.25 }}>
            <Checkbox
              size="small"
              checked={!!selectedChoreIds[chore.id]}
              onChange={(e) => toggleChoreSelected(chore.id, e.target.checked)}
              disabled={busy}
              inputProps={{ "aria-label": "Select chore" }}
            />
          </Box>

          <Box sx={{ minWidth: 0 }}>
            <Box display="flex" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
              {getStatusIcon(chore.status)}
              <Typography variant="subtitle1" fontWeight={700} noWrap sx={{ minWidth: 0 }}>
                {chore.title}
              </Typography>
              <Chip
                size="small"
                label={`P${typeof chore.priority === "number" ? chore.priority : 1}`}
                color={(chore.priority ?? 1) >= 3 ? "error" : (chore.priority ?? 1) === 2 ? "warning" : "info"}
                sx={{ ml: "auto", display: { xs: "none", sm: "inline-flex" } }}
              />
            </Box>
            {chore.description ? (
              <Typography variant="body2" color="textSecondary" noWrap>
                {chore.description}
              </Typography>
            ) : null}
          </Box>

          <Box sx={{ display: { xs: "flex", md: "block" }, gap: 1, flexWrap: "wrap" }}>
            <Typography variant="caption" color="textSecondary">
              {t("chores.space")}
            </Typography>
            <Typography variant="body2" fontWeight={600} sx={{ ml: { xs: 0.5, md: 0 } }}>
              {spaceLabel || t("chores.none")}
            </Typography>
            {cadence ? (
              <Typography variant="caption" color="textSecondary" sx={{ ml: { xs: 1, md: 0 } }}>
                {cadence}
              </Typography>
            ) : null}
          </Box>

          <Box sx={{ display: { xs: "flex", md: "block" }, gap: 1, flexWrap: "wrap" }}>
            <Typography variant="caption" color="textSecondary">
              {t("chores.helper")}
            </Typography>
            <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" sx={{ ml: { xs: 0.5, md: 0 } }}>
              <Typography variant="body2" fontWeight={600}>
                {helperName(chore.helper_id) || t("chores.unassigned")}
              </Typography>
              {chore.helper_id && helperOnLeaveAt(chore.helper_id, chore.due_at) ? (
                <Chip size="small" color="warning" label={t("helpers.on_leave")} />
              ) : null}
            </Box>
          </Box>

          <Box sx={{ display: { xs: "flex", md: "block" }, gap: 1, flexWrap: "wrap" }}>
            <Typography variant="caption" color="textSecondary">
              {t("chores.due")}
            </Typography>
            <Typography variant="body2" fontWeight={600} sx={{ ml: { xs: 0.5, md: 0 } }}>
              {dueLabel || t("chores.none")}
            </Typography>
          </Box>

          <Box sx={{ display: "flex", justifyContent: { xs: "flex-start", md: "flex-end" }, gap: 0.5 }}>
            <IconButton onClick={() => void reportNotDone(chore)} disabled={busy} aria-label={t("chores.aria_report_not_done")} size="small">
              <ReportProblem fontSize="small" />
            </IconButton>
            <IconButton onClick={() => openEdit(chore)} disabled={busy} aria-label={t("chores.aria_edit_chore")} size="small">
              <Edit fontSize="small" />
            </IconButton>
            {isDeleted ? (
              <IconButton size="small" onClick={() => void restoreChore(chore)} disabled={busy} aria-label="Restore">
                <RestoreFromTrash fontSize="small" />
              </IconButton>
            ) : (
              <IconButton color="error" size="small" onClick={() => confirmDeleteChore(chore)} disabled={busy} aria-label={t("common.delete")}>
                <Delete fontSize="small" />
              </IconButton>
            )}
          </Box>

          <Box sx={{ display: { xs: "flex", sm: "none" }, gap: 1, gridColumn: "1 / -1" }}>
            <Chip
              size="small"
              label={`P${typeof chore.priority === "number" ? chore.priority : 1}`}
              color={(chore.priority ?? 1) >= 3 ? "error" : (chore.priority ?? 1) === 2 ? "warning" : "info"}
            />
            <Chip size="small" label={chore.status} color={chore.status === "completed" ? "success" : chore.status === "in-progress" ? "warning" : "default"} />
          </Box>
        </Box>
      </Card>
    );
  };

  const dailyCadenceCounts = useMemo(() => {
    let explicitDaily = 0;
    let inferredDaily = 0;
    for (const c of chores) {
      const { cadence } = getMetaStrings(c);
      const norm = normalizeSpace(cadence);
      if (!norm) inferredDaily += 1;
      else if (norm === "daily") explicitDaily += 1;
    }
    return { explicitDaily, inferredDaily };
  }, [chores]);

  const dailyChores = useMemo(() => {
    const dateKey = (dailyDate ?? "").trim();
    if (!dateKey) return [] as ChoreRow[];

    const start = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(start.getTime())) return [] as ChoreRow[];
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const dayOfWeek = start.getDay(); // 0..6
    const dayOfMonth = start.getDate(); // 1..31
    const weekIndex = Math.floor(startOfLocalWeekMonday(start).getTime() / (7 * 24 * 60 * 60 * 1000));

    const occursOnSelectedDateByCadence = (chore: ChoreRow): boolean => {
      const { cadence } = getMetaStrings(chore);
      const c = normalizeSpace(cadence);
      if (!c) return true;
      if (c === "daily") return true;

      const h = stableHashInt(chore.id);

      if (c === "weekly") {
        const assignedDow = h % 7;
        return dayOfWeek === assignedDow;
      }

      if (c === "biweekly") {
        const assignedDow = h % 7;
        const parity = (h >> 3) % 2;
        return dayOfWeek === assignedDow && weekIndex % 2 === parity;
      }

      if (c === "monthly") {
        const assignedDom = (h % 28) + 1;
        return dayOfMonth === assignedDom;
      }

      return false;
    };

    const withinDayByDueAt = chores.filter((c) => {
      if (!c.due_at) return false;
      const t = new Date(c.due_at).getTime();
      return t >= start.getTime() && t < end.getTime();
    });

    const scheduledOnThisDate = chores.filter((c) => occursOnSelectedDateByCadence(c));

    if (dailyOnlyCadence) {
      return scheduledOnThisDate.filter((c) => {
        const { cadence } = getMetaStrings(c);
        const norm = normalizeSpace(cadence);
        return norm === "daily" || !norm;
      });
    }

    return Array.from(new Map([...scheduledOnThisDate, ...withinDayByDueAt].map((c) => [c.id, c])).values());
  }, [chores, dailyDate, dailyOnlyCadence]);

  const visibleChores = useMemo(() => {
    if (mode === "daily") return dailyChores;
    if (mode === "list") return filteredChores;
    return [] as ChoreRow[];
  }, [mode, dailyChores, filteredChores]);

  const selectedVisibleIds = useMemo(() => {
    const ids = new Set(visibleChores.map((c) => c.id));
    return Object.keys(selectedChoreIds).filter((id) => ids.has(id));
  }, [selectedChoreIds, visibleChores]);

  const allVisibleSelected = visibleChores.length > 0 && selectedVisibleIds.length === visibleChores.length;
  const someVisibleSelected = selectedVisibleIds.length > 0 && selectedVisibleIds.length < visibleChores.length;

  const selectAllVisible = (checked: boolean) => {
    setSelectedChoreIds((prev) => {
      const next = { ...prev };
      if (checked) {
        for (const c of visibleChores) next[c.id] = true;
      } else {
        for (const c of visibleChores) delete next[c.id];
      }
      return next;
    });
  };

  const cadenceBuckets = useMemo(() => ["daily", "weekly", "biweekly", "monthly"] as const, []);

  const baseCoverage = useMemo(() => {
    const counts: Record<string, Record<string, number>> = {};

    const spaceKeyToDisplay = new Map<string, string>();
    const addSpace = (raw: string): string => {
      const trimmed = String(raw || "").trim();
      const k = normalizeSpace(trimmed);
      if (!k) return "";
      const existing = spaceKeyToDisplay.get(k);
      if (existing) return existing;
      spaceKeyToDisplay.set(k, trimmed);
      return trimmed;
    };

    for (const s of homeSpaces) addSpace(s);
    for (const c of chores) {
      const meta = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? (c.metadata as any) : {};
      const cadence = typeof meta.cadence === "string" ? String(meta.cadence).trim() : "";
      const spaceRaw = typeof meta.space === "string" ? String(meta.space).trim() : "";
      const space = spaceRaw || "Unassigned";
      const displaySpace = addSpace(space) || "Unassigned";
      const bucket = cadenceBuckets.includes(cadence as any) ? cadence : "";
      if (!counts[displaySpace]) counts[displaySpace] = {};
      counts[displaySpace][bucket] = (counts[displaySpace][bucket] ?? 0) + 1;
    }

    const spaces = Array.from(spaceKeyToDisplay.values()).sort((a, b) => a.localeCompare(b));
    let max = 0;
    for (const s of spaces) {
      for (const k of cadenceBuckets) {
        max = Math.max(max, counts[s]?.[k] ?? 0);
      }
    }
    max = Math.max(1, max);
    return { counts, spaces, max };
  }, [chores, cadenceBuckets, homeSpaces]);

  const coverage = useMemo(() => {
    const counts: Record<string, Record<string, number>> = {};

    const spaceKeyToDisplay = new Map<string, string>();
    const addSpace = (raw: string): string => {
      const trimmed = String(raw || "").trim();
      const k = normalizeSpace(trimmed);
      if (!k) return "";
      const existing = spaceKeyToDisplay.get(k);
      if (existing) return existing;
      spaceKeyToDisplay.set(k, trimmed);
      return trimmed;
    };

    for (const s of homeSpaces) addSpace(s);
    for (const c of chores) {
      const meta = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? (c.metadata as any) : {};
      const cadence = typeof meta.cadence === "string" ? String(meta.cadence).trim() : "";
      const spaceRaw = typeof meta.space === "string" ? String(meta.space).trim() : "";
      const space = spaceRaw || "Unassigned";
      const displaySpace = addSpace(space) || "Unassigned";
      const bucket = cadenceBuckets.includes(cadence as any) ? cadence : "";
      if (!counts[displaySpace]) counts[displaySpace] = {};
      counts[displaySpace][bucket] = (counts[displaySpace][bucket] ?? 0) + 1;
    }

    const spaces = Array.from(spaceKeyToDisplay.values()).sort((a, b) => a.localeCompare(b));

    for (const s of spaces) {
      if (!counts[s]) counts[s] = {};
      const total = cadenceBuckets.reduce((acc, k) => acc + (counts[s]?.[k] ?? 0), 0);
      if (total === 0) {
        counts[s].monthly = 1;
      }
    }

    let max = 0;
    for (const s of spaces) {
      for (const k of cadenceBuckets) {
        max = Math.max(max, counts[s]?.[k] ?? 0);
      }
    }
    max = Math.max(1, max);
    return { counts, spaces, max };
  }, [chores, cadenceBuckets, homeSpaces]);

  const startOfLocalDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };

  const withLocalTime = (d: Date, h: number, m: number) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x;
  };

  const weekdayShort = (n: number) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n] ?? "";

  const nextWeekday = (from: Date, day: number) => {
    const d = startOfLocalDay(from);
    const diff = (day - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
    return d;
  };

  const nthWeekdayOfMonth = (year: number, month: number, weekday: number, nth: number) => {
    const first = new Date(year, month, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    const day = 1 + offset + (nth - 1) * 7;
    return new Date(year, month, day);
  };

  const ordinal = (n: number) => {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return `${n}st`;
    if (mod10 === 2 && mod100 !== 12) return `${n}nd`;
    if (mod10 === 3 && mod100 !== 13) return `${n}rd`;
    return `${n}th`;
  };

  const computeSchedule = (params: { cadence: string; now?: Date }): { dueAt: string | null; label: string } => {
    const now = params.now ?? new Date();
    const cadence = params.cadence;

    if (cadence === "daily") {
      const d = startOfLocalDay(now);
      d.setDate(d.getDate() + 1);
      const due = withLocalTime(d, 9, 0);
      return { dueAt: due.toISOString(), label: weekdayShort(due.getDay()) };
    }

    if (cadence === "weekly") {
      const dueDay = nextWeekday(now, 1);
      const due = withLocalTime(dueDay, 9, 0);
      return { dueAt: due.toISOString(), label: weekdayShort(due.getDay()) };
    }

    if (cadence === "biweekly") {
      const y = now.getFullYear();
      const m = now.getMonth();
      const secondMon = nthWeekdayOfMonth(y, m, 1, 2);
      const fourthMon = nthWeekdayOfMonth(y, m, 1, 4);
      const candidates: Array<{ n: number; date: Date }> = [
        { n: 2, date: secondMon },
        { n: 4, date: fourthMon },
      ];

      const after = startOfLocalDay(now);
      const upcomingThisMonth = candidates
        .filter((c) => startOfLocalDay(c.date).getTime() > after.getTime())
        .sort((a, b) => a.date.getTime() - b.date.getTime());

      const pick =
        upcomingThisMonth[0] ??
        (() => {
          const ny = m === 11 ? y + 1 : y;
          const nm = (m + 1) % 12;
          return { n: 2, date: nthWeekdayOfMonth(ny, nm, 1, 2) };
        })();

      const due = withLocalTime(pick.date, 9, 0);
      return { dueAt: due.toISOString(), label: `${ordinal(pick.n)} ${weekdayShort(due.getDay())}` };
    }

    if (cadence === "monthly") {
      const d = startOfLocalDay(now);
      d.setMonth(d.getMonth() + 1);
      d.setDate(1);
      const due = withLocalTime(d, 9, 0);
      return { dueAt: due.toISOString(), label: "Monthly" };
    }

    return { dueAt: null, label: "" };
  };

  const cadenceTargetsForSpace = (space: string): CoverageCadence[] => {
    const k = normalizeSpace(space);
    if (/kitchen/.test(k)) return coverageBaseline.kitchen;
    if (/bath|toilet|washroom|wc/.test(k)) return coverageBaseline.bathroom;
    if (/balcony/.test(k)) return coverageBaseline.balcony;
    if (/terrace/.test(k)) return coverageBaseline.terrace;
    if (/garage|parking|car porch|carport/.test(k)) return coverageBaseline.garage;
    if (/utility|laundry/.test(k)) return coverageBaseline.utility;
    return coverageBaseline.default;
  };

  const buildAutoFillRecommendations = (opts?: { only?: { space: string; cadence: CoverageCadence } }) => {
    const norm = (s: string) => normalizeSpace(s);
    const isKitchen = (s: string) => /kitchen/.test(norm(s));
    const isBathroom = (s: string) => /bath|toilet|washroom|wc/.test(norm(s));
    const isBalcony = (s: string) => /balcony/.test(norm(s));
    const isTerrace = (s: string) => /terrace/.test(norm(s));
    const isGarage = (s: string) => /garage|parking|car porch|carport/.test(norm(s));
    const isUtility = (s: string) => /utility|laundry/.test(norm(s));

    const mk = (params: {
      space: string;
      cadence: "daily" | "weekly" | "biweekly" | "monthly";
      subspace?: string | null;
      title: string;
      description: string;
      priority: number;
    }) => {
      const id = `${normalizeSpace(params.space)}_${params.cadence}_${normalizeKeyPart(params.title)}`;
      const sched = computeSchedule({ cadence: params.cadence });
      const baseMeta: Record<string, unknown> = {
        cadence: params.cadence,
        space: params.space,
        schedule_label: sched.label,
      };
      const meta = params.subspace ? { ...baseMeta, subspace: params.subspace } : baseMeta;
      return {
        id,
        space: params.space,
        cadence: params.cadence,
        title: params.title,
        description: params.description,
        priority: params.priority,
        dueAt: sched.dueAt,
        metadata: meta,
      };
    };

    const drafts: typeof autoFillDrafts = [];

    const bathroomCount = homeNumBathrooms && homeNumBathrooms > 0 ? Math.floor(homeNumBathrooms) : 0;
    const balconyCountRaw = homeSpaceCounts["balcony"];
    const balconyCount = typeof balconyCountRaw === "number" && balconyCountRaw > 0 ? Math.floor(balconyCountRaw) : 0;

    const spaces = opts?.only ? [opts.only.space] : coverage.spaces;
    for (const space of spaces) {
      const targets = cadenceTargetsForSpace(space);
      for (const cadence of targets) {
        if (opts?.only && cadence !== opts.only.cadence) continue;
        const existing = baseCoverage.counts[space]?.[cadence] ?? 0;
        if (existing > 0) continue;

        if (isBathroom(space) && cadence === "weekly" && bathroomCount > 1) {
          for (let i = 1; i <= bathroomCount; i += 1) {
            const subspace = `Bathroom ${i}`;
            drafts.push(
              mk({
                space: "Bathroom",
                subspace,
                cadence,
                title: `Clean bathroom (${subspace})`,
                description: "Weekly: scrub toilet, sink, tiles, and mop floor.",
                priority: 3,
              }),
            );
          }
          continue;
        }

        if (isBalcony(space) && cadence === "monthly" && balconyCount > 1) {
          for (let i = 1; i <= balconyCount; i += 1) {
            const subspace = `Balcony ${i}`;
            drafts.push(
              mk({
                space: "Balcony",
                subspace,
                cadence,
                title: `Sweep and mop balcony (${subspace})`,
                description: "Monthly: sweep, remove dust/cobwebs, and mop/wipe surfaces.",
                priority: 1,
              }),
            );
          }
          continue;
        }

        if (isKitchen(space) && cadence === "daily") {
          drafts.push(
            mk({
              space,
              cadence,
              title: `Kitchen daily wipe-down`,
              description: "Daily: wipe counters/stove, quick sink scrub, and clear food waste.",
              priority: 3,
            }),
          );
          continue;
        }
        if (isKitchen(space) && cadence === "weekly") {
          drafts.push(
            mk({
              space,
              cadence,
              title: "Kitchen deep clean",
              description: "Weekly: clean hob/chimney area, wipe cabinets, mop floor, and clean sink drain.",
              priority: 2,
            }),
          );
          continue;
        }
        if (isBathroom(space) && cadence === "weekly") {
          drafts.push(
            mk({
              space,
              cadence,
              title: `Clean ${space}`,
              description: "Weekly: scrub toilet, sink, tiles, and mop floor.",
              priority: 3,
            }),
          );
          continue;
        }
        if ((isBalcony(space) || isTerrace(space) || isGarage(space)) && cadence === "monthly") {
          drafts.push(
            mk({
              space,
              cadence,
              title: `Sweep and mop ${space}`,
              description: "Monthly: sweep, remove dust/cobwebs, and mop/wipe surfaces.",
              priority: 1,
            }),
          );
          continue;
        }
        if (isUtility(space) && cadence === "weekly") {
          drafts.push(
            mk({
              space,
              cadence,
              title: `Clean ${space}`,
              description: "Weekly: wipe surfaces, clear lint/dust, and mop floor.",
              priority: 1,
            }),
          );
          continue;
        }

        drafts.push(
          mk({
            space,
            cadence,
            title: `Sweep and mop ${space}`,
            description: "Weekly: sweep and mop this space.",
            priority: 2,
          }),
        );
      }
    }

    const deduped = Array.from(new Map(drafts.map((d) => [d.id, d])).values());
    setAutoFillDrafts(deduped);
    setAutoFillSelected(
      deduped.reduce<Record<string, boolean>>((acc, d) => {
        acc[d.id] = true;
        return acc;
      }, {}),
    );
    setAutoFillDialogOpen(true);
  };

  const runAutoFill = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", t("common.missing_session"));
      return;
    }
    const selected = autoFillDrafts.filter((d) => autoFillSelected[d.id] !== false);
    if (selected.length === 0) {
      showSnack("info", t("chores.no_recommendations_selected"));
      return;
    }

    const estimateMinutesForCadence = (cadence: CoverageCadence): number => {
      if (cadence === "daily") return 15;
      if (cadence === "weekly") return 45;
      if (cadence === "biweekly") return 60;
      if (cadence === "monthly") return 90;
      return 30;
    };

    const cadenceRank = (cadence: CoverageCadence): number => {
      if (cadence === "daily") return 4;
      if (cadence === "weekly") return 3;
      if (cadence === "biweekly") return 2;
      if (cadence === "monthly") return 1;
      return 0;
    };

    const nowIso = new Date().toISOString();

    setAutoFillBusy(true);
    try {
      const helperCapacity = new Map<string, number>();
      for (const h of helpers) {
        const mins = typeof h.daily_capacity_minutes === "number" && Number.isFinite(h.daily_capacity_minutes) ? h.daily_capacity_minutes : 120;
        helperCapacity.set(h.id, Math.max(0, Math.round(mins)));
      }

      const { data: leaveRows, error: leaveErr } = await supabase
        .from("member_time_off")
        .select("helper_id")
        .eq("household_id", hid)
        .eq("member_kind", "helper")
        .lte("start_at", nowIso)
        .gt("end_at", nowIso);
      if (leaveErr) {
        showSnack("error", leaveErr.message);
        return;
      }

      const onLeave = new Set<string>();
      for (const r of (leaveRows ?? []) as Array<{ helper_id: string | null }>) {
        if (typeof r.helper_id === "string" && r.helper_id) onLeave.add(r.helper_id);
      }

      const remainingByHelper = new Map<string, number>();
      for (const [hid2, mins] of helperCapacity.entries()) {
        if (onLeave.has(hid2)) continue;
        remainingByHelper.set(hid2, mins);
      }

      const pickHelperForMinutes = (needMinutes: number): { helperId: string | null; unassignedReason: string | null } => {
        if (remainingByHelper.size === 0) return { helperId: null, unassignedReason: "no_available_helpers" };

        let bestId: string | null = null;
        let bestRemaining = -1;
        for (const [id, rem] of remainingByHelper.entries()) {
          if (rem < needMinutes) continue;
          if (rem > bestRemaining) {
            bestRemaining = rem;
            bestId = id;
          }
        }

        if (!bestId) return { helperId: null, unassignedReason: "insufficient_capacity" };
        remainingByHelper.set(bestId, (remainingByHelper.get(bestId) ?? 0) - needMinutes);
        return { helperId: bestId, unassignedReason: null };
      };

      const planned = selected
        .slice(0)
        .sort((a, b) => {
          const ar = cadenceRank(a.cadence);
          const br = cadenceRank(b.cadence);
          if (br !== ar) return br - ar;
          return (b.priority ?? 1) - (a.priority ?? 1);
        })
        .map((d) => {
          const est = estimateMinutesForCadence(d.cadence);
          const pick = pickHelperForMinutes(est);
          return { d, estMinutes: est, helperId: pick.helperId, helperUnassignedReason: pick.unassignedReason };
        });

      for (const p of planned) {
        const d = p.d;
        const meta: Record<string, unknown> = {
          ...(d.metadata ?? {}),
          planned_minutes: p.estMinutes,
          helper_unassigned_reason: p.helperUnassignedReason,
        };
        const res = await agentCreate({
          accessToken: token,
          table: "chores",
          record: {
            household_id: hid,
            title: d.title,
            description: d.description,
            status: "pending",
            priority: d.priority,
            due_at: d.dueAt,
            helper_id: p.helperId,
            metadata: meta,
          },
          reason: "Auto-fill missing chore coverage",
        });
        if (!res.ok) {
          showSnack("error", "error" in res ? res.error : t("common.create_failed"));
          return;
        }
      }

      const { data: refreshed, error: refreshError } = await supabase
        .from("chores")
        .select("id,title,description,status,priority,due_at,completed_at,helper_id,metadata,created_at")
        .eq("household_id", hid)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (refreshError) {
        showSnack("error", refreshError.message);
        return;
      }
      setChores((refreshed ?? []) as ChoreRow[]);
      showSnack("success", `${t("chores.created")} ${selected.length} ${t("chores.chore_s")}`);
      setAutoFillDialogOpen(false);
      setAutoFillDrafts([]);
      setAutoFillSelected({});
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setAutoFillBusy(false);
    }
  };

  const enterListMode = (next: { space?: string | null; cadence?: string | null }) => {
    setMode("list");
    setSpaceFilter(next.space ?? null);
    setCadenceFilter(next.cadence ?? null);
    setView("all");
  };

  const enterDailyMode = () => {
    setMode("daily");
    setSpaceFilter(null);
    setCadenceFilter(null);
    setView("all");
    setDailyDate((prev) => (prev && prev.trim() ? prev : todayDateString()));
  };

  const reportNotDone = async (chore: ChoreRow) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      showSnack("error", t("common.missing_session"));
      return;
    }

    setBusy(true);
    try {
      const { data: existing, error: existingError } = await supabase
        .from("chores")
        .select("id,status")
        .eq("household_id", hid)
        .is("deleted_at", null)
        .neq("status", "completed")
        .filter("metadata->>makeup_for_chore_id", "eq", chore.id)
        .limit(1);

      if (existingError) {
        showSnack("error", existingError.message);
        return;
      }
      if (existing && existing.length > 0) {
        showSnack("info", t("chores.makeup_already_exists"));
        return;
      }

      const createdAt = new Date().toISOString();
      const makeupDueAt = nextLocalMorningIso(new Date());
      const makeupTitle = chore.title;
      const basePriority = typeof chore.priority === "number" && Number.isFinite(chore.priority) ? chore.priority : 1;
      const bumpedPriority = Math.min(3, Math.max(1, basePriority + 1));

      let helperIdForMakeup: string | null = chore.helper_id ?? null;
      if (helperIdForMakeup) {
        const nowIso = new Date().toISOString();
        const { data: leaveRows, error: leaveErr } = await supabase
          .from("member_time_off")
          .select("id,start_at,end_at")
          .eq("household_id", hid)
          .eq("member_kind", "helper")
          .eq("helper_id", helperIdForMakeup)
          .lte("start_at", nowIso)
          .gt("end_at", nowIso)
          .limit(1);
        if (leaveErr) {
          showSnack("error", leaveErr.message);
          return;
        }
        if (leaveRows && leaveRows.length > 0) {
          helperIdForMakeup = null;
        }
      }

      const makeupMetadata: Record<string, unknown> = {
        source: "report_not_done",
        makeup_for_chore_id: chore.id,
        reported_at: createdAt,
        reported_by_user_id: user?.id ?? null,
        helper_unassigned_reason: helperIdForMakeup ? null : chore.helper_id ? "helper_on_leave" : null,
      };

      const res = await agentCreate({
        accessToken: token,
        table: "chores",
        record: {
          household_id: hid,
          title: makeupTitle,
          description: chore.description ?? null,
          priority: bumpedPriority,
          status: "pending",
          due_at: makeupDueAt,
          helper_id: helperIdForMakeup,
          metadata: makeupMetadata,
        },
        reason: "User reported chore not done; created make-up task.",
      });

      if (!res.ok) {
        showSnack("error", "error" in res ? res.error : t("common.create_failed"));
        return;
      }

      const originalMeta: Record<string, unknown> =
        chore.metadata && typeof chore.metadata === "object" && !Array.isArray(chore.metadata)
          ? (chore.metadata as Record<string, unknown>)
          : {};
      const disputesRaw = (originalMeta as any).disputes;
      const disputes = Array.isArray(disputesRaw) ? disputesRaw.slice(0) : [];
      disputes.push({ at: createdAt, by_user_id: user?.id ?? null, type: "not_done" });

      const updatedMeta = { ...originalMeta, disputes };

      const upd = await executeToolCall({
        accessToken: token,
        householdId: hid,
        scope: "household",
        toolCall: {
          id: `report_not_done_patch_${chore.id}_${Date.now()}`,
          tool: "db.update",
          args: { table: "chores", id: chore.id, patch: { metadata: updatedMeta } },
          reason: "User reported chore not done; attach dispute metadata.",
        },
      });
      if (!upd.ok) {
        showSnack("error", "error" in upd ? upd.error : t("common.update_failed"));
        return;
      }

      const { data: refreshed, error: refreshError } = await supabase
        .from("chores")
        .select("id,title,description,status,priority,due_at,completed_at,helper_id,metadata,created_at")
        .eq("household_id", hid)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (refreshError) {
        showSnack("error", refreshError.message);
        return;
      }
      setChores((refreshed ?? []) as ChoreRow[]);
      showSnack("success", t("chores.reported_makeup_created"));
    } catch (e) {
      showSnack("error", e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 1200, mx: "auto" }}>
      {/* ── Page header ─────────────────────────────────────────────── */}
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight={700}>{t("chores.title")}</Typography>
          <Typography variant="body2" color="text.secondary">{t("chores.subtitle")}</Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            variant="outlined"
            startIcon={<Sync />}
            disabled={scheduleSync.busy}
            onClick={async () => {
              const result = await scheduleSync.sync({ mode: "confirm", trigger: "manual" });
              if (result && (result.schedulerMutations.length > 0 || result.reactorAdjustments.length > 0)) {
                setSyncDrawerOpen(true);
              }
            }}
          >
            {scheduleSync.busy ? t("engine.syncing") : t("engine.sync_schedule")}
          </Button>
          <Button variant="contained" startIcon={<Add />} onClick={() => setDialogOpen(true)}>
            {t("chores.add_chore")}
          </Button>
        </Stack>
      </Stack>

      {/* ── View mode toggle ─────────────────────────────────────────── */}
      <Stack direction="row" spacing={1} alignItems="center" mb={3}>
        {mode !== "coverage" ? (
          <ToggleButtonGroup
            value={mode}
            exclusive
            size="small"
            onChange={(_, next) => {
              if (next === "daily") enterDailyMode();
              else if (next === "list") enterListMode({ space: null, cadence: null });
            }}
          >
            <ToggleButton value="daily">{t("chores.helper_view")}</ToggleButton>
            <ToggleButton value="list">{t("chores.task_view")}</ToggleButton>
          </ToggleButtonGroup>
        ) : null}

        {mode === "coverage" ? (
          <Button variant="outlined" size="small" onClick={enterDailyMode}>
            {t("chores.helper_view")}
          </Button>
        ) : (
          <Button
            variant="outlined"
            size="small"
            onClick={() => { setMode("coverage"); setSpaceFilter(null); setCadenceFilter(null); }}
          >
            {t("chores.coverage")}
          </Button>
        )}
      </Stack>

      {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}

      {/* Assignment nudge — show when many chores are unassigned */}
      {chores.filter((c) => !c.helper_id && c.status !== "completed").length > 5 && (
        <Paper variant="outlined" sx={{ px: 2, py: 1, mb: 2, borderRadius: 2, bgcolor: "info.50", borderColor: "info.200" }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box flex={1}>
              <Typography variant="body2" fontWeight={600}>
                {chores.filter((c) => !c.helper_id && c.status !== "completed").length} chores not yet assigned to helpers
              </Typography>
            </Box>
            <Button size="small" variant="contained" onClick={() => navigate("/chat?assign=true")}>
              Assign now
            </Button>
          </Stack>
        </Paper>
      )}

      {busy && chores.length === 0 ? (
        <Box display="flex" justifyContent="center" py={6}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {/* ── Daily (helper) view ───────────────────────────────────── */}
          {mode === "daily" && (
            <Stack spacing={2}>
              <Stack direction="row" spacing={2} alignItems="center">
                <TextField
                  label={t("chores.date")}
                  type="date"
                  size="small"
                  value={dailyDate}
                  onChange={(e) => setDailyDate(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
                <Typography variant="caption" color="text.secondary">
                  {Intl.DateTimeFormat().resolvedOptions().timeZone}
                </Typography>
              </Stack>
              <HelperDailyView date={dailyDate} />
            </Stack>
          )}

          {/* ── Task list view ────────────────────────────────────────── */}
          {mode === "list" && (
            <ChoreListView
              chores={chores}
              helpers={helpers}
              busy={busy}
              spaceFilter={spaceFilter}
              cadenceFilter={cadenceFilter}
              onClearFilters={() => { setSpaceFilter(null); setCadenceFilter(null); setCategoryFilter(null); }}
              onEdit={openEdit}
              onDelete={confirmDeleteChore}
              onRestore={(c) => void restoreChore(c)}
              onReportNotDone={(c) => void reportNotDone(c)}
              onBulkDelete={(ids) => {
                setSelectedChoreIds(Object.fromEntries(ids.map((id) => [id, true])));
                setBulkDeleteDialogOpen(true);
              }}
              helperOnLeave={helperOnLeaveAt}
            />
          )}

          {/* ── Coverage view ────────────────────────────────────────── */}
          {mode === "coverage" && (
            <Stack spacing={2}>
              {/* Sub-mode toggle */}
              <Stack direction="row" spacing={1} alignItems="center">
                <ToggleButtonGroup
                  value={coverageSubMode}
                  exclusive
                  size="small"
                  onChange={(_, v) => { if (v) setCoverageSubMode(v); }}
                >
                  <ToggleButton value="audit">{t("coverage.audit_view")}</ToggleButton>
                  <ToggleButton value="matrix">{t("coverage.matrix_view")}</ToggleButton>
                </ToggleButtonGroup>
                <Button size="small" variant="outlined" onClick={() => buildAutoFillRecommendations()} disabled={busy || coverage.spaces.length === 0}>
                  {t("chores.autofill_missing")}
                </Button>
              </Stack>

              {coverageSubMode === "audit" ? (
                <CoverageDashboard
                  refreshKey={coverageRefreshKey}
                  onApplied={() => setCoverageRefreshKey((k) => k + 1)}
                />
              ) : (
                <Card variant="outlined">
                  <CardHeader
                    title={<Typography variant="h6">{t("chores.coverage")}</Typography>}
                    subheader={t("chores.planned_frequency")}
                  />
                  <CardContent>
                    {coverage.spaces.length === 0 ? (
                      <Box textAlign="center" py={4}>
                        <Typography variant="body2" color="text.secondary" mb={2}>{t("planner.empty_coverage")}</Typography>
                      </Box>
                    ) : (
                      <Box sx={{ maxHeight: "min(70vh, 560px)", overflow: "auto", border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
                        <Box display="grid" gridTemplateColumns={`minmax(200px, 1fr) repeat(${cadenceBuckets.length}, minmax(120px, 1fr))`} gap={1} alignItems="stretch" sx={{ p: 1 }}>
                          <Box sx={{ position: "sticky", top: 0, left: 0, zIndex: 3, bgcolor: "background.paper" }} />
                          {cadenceBuckets.map((c) => (
                            <Box key={c} px={0.5} py={0.25} sx={{ position: "sticky", top: 0, zIndex: 2, bgcolor: "background.paper" }}>
                              <Typography variant="caption" color="text.secondary" fontWeight={700}>
                                {t(`chores.${c}`)}
                              </Typography>
                            </Box>
                          ))}

                          {coverage.spaces.map((space) => (
                            <>
                              <Box key={`${space}_label`} px={0.75} py={0.5} sx={{ cursor: "pointer", position: "sticky", left: 0, zIndex: 1, bgcolor: "background.paper" }} onClick={() => enterListMode({ space, cadence: null })}>
                                <Typography variant="body2" fontWeight={700} noWrap title={space}>{space}</Typography>
                              </Box>
                              {cadenceBuckets.map((cadence) => {
                                const n = coverage.counts[space]?.[cadence] ?? 0;
                                const targets = cadenceTargetsForSpace(space);
                                const isTarget = targets.includes(cadence as CoverageCadence);
                                const isGap = isTarget && (baseCoverage.counts[space]?.[cadence] ?? 0) === 0;
                                const intensity = n === 0 ? 0 : Math.min(1, n / coverage.max);
                                return (
                                  <Box
                                    key={`${space}_${cadence}`}
                                    px={0.5} py={0.5}
                                    sx={{
                                      borderRadius: 1,
                                      border: "1px solid",
                                      borderColor: isGap ? "error.main" : "divider",
                                      bgcolor: n === 0
                                        ? isTarget ? "rgba(244, 67, 54, 0.06)" : "transparent"
                                        : `rgba(25, 118, 210, ${0.10 + intensity * 0.35})`,
                                      cursor: n > 0 || isGap ? "pointer" : "default",
                                    }}
                                    onClick={() => {
                                      if (n > 0) { enterListMode({ space, cadence }); return; }
                                      if (isGap) buildAutoFillRecommendations({ only: { space, cadence: cadence as CoverageCadence } });
                                    }}
                                  >
                                    <Box display="flex" alignItems="center" justifyContent="space-between">
                                      <Typography variant="caption" fontWeight={700}>{n === 0 ? "" : n}</Typography>
                                      {isTarget && <Typography variant="caption" color={isGap ? "error.main" : "text.secondary"}>{isGap ? "!" : "•"}</Typography>}
                                    </Box>
                                  </Box>
                                );
                              })}
                            </>
                          ))}
                        </Box>
                      </Box>
                    )}
                  </CardContent>
                </Card>
              )}
            </Stack>
          )}
        </>
      )}

      {/* ── Dialogs ─────────────────────────────────────────────────── */}
      <CreateChoreDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        helpers={helpers}
        busy={busy}
        onSave={(data) => {
          setNewTitle(data.title);
          setNewDescription(data.description);
          setNewHelperId(data.helperId);
          setNewCadence(data.cadence);
          setNewDueAt(data.dueAt);
          void createManualChore();
        }}
      />

      <EditChoreDialog
        open={editOpen}
        chore={editChore}
        onClose={() => setEditOpen(false)}
        helpers={helpers}
        busy={editBusy}
        helperOnLeave={(hid, dueAt) => helperOnLeaveAt(hid, dueAt)}
        onSave={async (data) => {
          setEditTitle(data.title);
          setEditDescription(data.description);
          setEditStatus(data.status);
          setEditPriority(String(data.priority));
          setEditDueAt(data.dueAt);
          setEditHelperId(data.helperId);
          setEditSpace(data.space);
          setEditCadence(data.cadence);
          await saveEdit();
        }}
      />

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("common.delete")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t("chores.confirm_delete").replace("{title}", deleteTarget?.title ?? "")}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>{t("common.cancel")}</Button>
          <Button color="error" variant="contained" disabled={busy} onClick={() => void runDeleteChore()}>{t("common.delete")}</Button>
        </DialogActions>
      </Dialog>

      {/* Bulk delete confirmation */}
      <Dialog open={bulkDeleteDialogOpen} onClose={() => setBulkDeleteDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("chores.confirm_bulk_delete_title").replace("{count}", String(selectedVisibleIds.length))}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t("chores.confirm_bulk_delete_message")}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkDeleteDialogOpen(false)}>{t("common.cancel")}</Button>
          <Button color="error" variant="contained" disabled={busy || selectedVisibleIds.length === 0} onClick={() => void runBulkDelete()}>{t("common.delete")}</Button>
        </DialogActions>
      </Dialog>

      {/* Space clarify */}
      <Dialog open={spaceClarifyOpen} onClose={() => { setSpaceClarifyOpen(false); setSpaceClarifyPending(null); }} maxWidth="xs" fullWidth>
        <DialogTitle>{spaceClarifyTitle || t("chores.choose_space")}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={1}>
            {spaceClarifyError && <Alert severity="error">{spaceClarifyError}</Alert>}
            <Autocomplete
              options={spaceClarifyOptions}
              value={spaceClarifySelection || null}
              onChange={(_, v) => setSpaceClarifySelection(typeof v === "string" ? v : "")}
              renderInput={(params) => <TextField {...params} label={t("chores.space")} size="small" />}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setSpaceClarifyOpen(false); setSpaceClarifyPending(null); }}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={async () => {
            const sel = spaceClarifySelection.trim();
            if (!sel) { setSpaceClarifyError(t("chores.choose_space_error")); return; }
            if (!spaceClarifyPending) { setSpaceClarifyOpen(false); return; }
            try { await spaceClarifyPending(sel); } catch (e) { setSpaceClarifyError(e instanceof Error ? e.message : "Error"); }
          }}>{t("chores.apply")}</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snackOpen} autoHideDuration={4000} onClose={() => setSnackOpen(false)}>
        <Alert onClose={() => setSnackOpen(false)} severity={snackSeverity} sx={{ width: "100%" }}>
          {snackMessage}
        </Alert>
      </Snackbar>

      <SyncResultsDrawer
        open={syncDrawerOpen}
        onClose={() => setSyncDrawerOpen(false)}
        result={scheduleSync.result}
        onApplied={async () => {
          const hid = householdId.trim();
          if (!hid) return;
          const { data } = await supabase
            .from("chores")
            .select(CHORE_SELECT)
            .eq("household_id", hid)
            .is("deleted_at", null)
            .order("created_at", { ascending: false });
          if (data) setChores(data as ChoreRow[]);
        }}
      />
    </Box>
  );
}
