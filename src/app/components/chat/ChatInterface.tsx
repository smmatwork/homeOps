import { useState, useRef, useEffect, useCallback, useMemo, useReducer } from "react";
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Snackbar,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  Paper,
  Rating,
  Menu,
  MenuItem,
} from "@mui/material";
import {
  SmartToy,
  GraphicEq,
  Person,
  Feedback as FeedbackIcon,
  Logout,
  Edit,
  Delete,
  Bolt,
  ExpandMore,
  ExpandLess,
  Home,
  BarChart,
} from "@mui/icons-material";
import { keyframes } from "@emotion/react";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { QuickActionsPanel } from "./QuickActionsPanel";
import { inferSpaceFromText, normalizeChoreTextFromUserUtterance, normalizeSpaceName } from "./chatTextUtils";
import { buildThreadKey, useClarificationStore } from "../../stores/clarificationThreadStore";
import { useSarvamChat } from "../../hooks/useSarvamChat";
import { ONBOARDING_SYSTEM_PROMPT } from "../../services/sarvamApi";
import { useSarvamSTT, type SpeechLang } from "../../hooks/useSarvamSTT";
import { parseAgentActionsFromAssistantText, parseAutomationSuggestionsFromAssistantText, parseClarificationFromAssistantText, parseToolCallsFromAssistantText, type AgentCreateAction, type AutomationSuggestion, type ToolCall } from "../../services/agentActions";
import { OnboardingPanel } from "./OnboardingPanel";
import { loadCoverageDraft } from "../../experiments/coverage/coverageDraftStorage";
import { agentCreate, agentListHelpers, executeToolCall, semanticReindex, semanticSearch } from "../../services/agentApi";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { supabase } from "../../services/supabaseClient";
import { CoverageExperimentEntry } from "../../experiments/coverage/CoverageExperimentEntry";
import { useHomeProfileWizard } from "../home-profile/useHomeProfileWizard";
import { HomeProfileWizard } from "../home-profile/HomeProfileWizard";
import { useNavigate } from "react-router";
import Sanscript from "@sanskrit-coders/sanscript";
import {
  HOME_PROFILE_TEMPLATES,
  normalizeSpacesToRooms,
} from "../../config/homeProfileTemplates";

type HelperOption = { id: string; name: string; type: string | null; phone: string | null };

type ChoreDraft = {
  id: string;
  action: AgentCreateAction;
};

type HomeProfileRow = {
  home_type: string | null;
  bhk: number | null;
  spaces: string[] | null;
  space_counts: Record<string, unknown> | null;
  has_balcony: boolean | null;
  num_bathrooms: number | null;
  has_pets: boolean | null;
  has_kids: boolean | null;
  flooring_type: string | null;
};

type DeleteChorePreviewRow = {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
};

type ChatDeleteChoresFlow =
  | { phase: "idle" }
  | { phase: "awaiting_scope" }
  | {
      phase: "awaiting_confirm";
      scope: "overdue" | "completed" | "all";
      choreIds: string[];
      preview: DeleteChorePreviewRow[];
    };

type ChatDeleteChoresSpecificFlow = {
  phase: "select_specific";
  preview: DeleteChorePreviewRow[];
  selectedIds: Record<string, boolean>;
};

const ENABLE_COVERAGE_EXPERIMENT = String(import.meta.env.VITE_EXPERIMENT_COVERAGE ?? "").trim() === "1";
const ENABLE_CHORE_RECS_EXPERIMENT = String(import.meta.env.VITE_EXPERIMENT_CHORE_RECS ?? "").trim() === "1";

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalizeDatetimeLocal(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Parse local datetime explicitly (avoid browser differences) and emit strict ISO with an explicit offset.
  // Orchestrator expects a strict ISO timestamp like 2026-04-01T23:35:00+05:30.
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = Number(m[6] ?? "0");
  const d = new Date(yyyy, mm - 1, dd, hh, mi, ss, 0);
  if (Number.isNaN(d.getTime())) return null;

  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy2 = d.getFullYear();
  const mm2 = pad(d.getMonth() + 1);
  const dd2 = pad(d.getDate());
  const hh2 = pad(d.getHours());
  const mi2 = pad(d.getMinutes());
  const ss2 = pad(d.getSeconds());

  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzOffsetMin);
  const tzh = pad(Math.floor(abs / 60));
  const tzm = pad(abs % 60);
  return `${yyyy2}-${mm2}-${dd2}T${hh2}:${mi2}:${ss2}${sign}${tzh}:${tzm}`;
}

 

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: any): any => {
    if (v === null || v === undefined) return v;
    if (typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(normalize);
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = normalize(v[k]);
    }
    return out;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return String(value);
  }
}

function toolCallDedupeKey(tc: ToolCall): string {
  const args: any = tc.args ?? {};
  const table = typeof args.table === "string" ? args.table.trim().toLowerCase() : "";
  if (tc.tool === "db.insert" && table === "chores") {
    const rec = args.record && typeof args.record === "object" && !Array.isArray(args.record) ? { ...(args.record as any) } : {};
    // Drop volatile/unimportant fields if present.
    delete (rec as any).id;
    delete (rec as any).created_at;
    delete (rec as any).updated_at;
    delete (rec as any).completed_at;
    const meta0 = rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata) ? (rec.metadata as any) : null;
    const space0 = typeof meta0?.space === "string" ? String(meta0.space).trim() : "";
    const spaceNorm = normalizeSpaceName(space0);
    const spaceKey = /^(all\s+)?balcon(y|ies)$/.test(spaceNorm) || /^(all\s+)?bath(room)?s?$/.test(spaceNorm) ? null : (space0 || null);
    const cadenceKey = typeof meta0?.cadence === "string" ? String(meta0.cadence).trim() || null : null;

    const keyRec = {
      title: typeof rec.title === "string" ? rec.title.trim() : "",
      description: typeof rec.description === "string" ? rec.description.trim() : rec.description ?? null,
      due_at: typeof rec.due_at === "string" ? rec.due_at.trim() : rec.due_at ?? null,
      helper_id: typeof rec.helper_id === "string" ? rec.helper_id.trim() : rec.helper_id ?? null,
      metadata: { space: spaceKey, cadence: cadenceKey },
    };
    return `${tc.tool}:${table}:${stableStringify(keyRec)}`;
  }
  return `${tc.tool}:${stableStringify(args)}`;
}

const EMPTY_THREAD_ANSWERS: Record<string, unknown> = {};
const EMPTY_APPROVED_TOOLCALL_KEYS: Record<string, boolean> = {};

function buildClientChoreToolCall(params: { userText: string; dueAt: string; space: string }): ToolCall {
  const { userText, dueAt, space } = params;
  const norm = normalizeChoreTextFromUserUtterance(userText);
  const tc: ToolCall = {
    id: `client_chore_${Date.now()}`,
    tool: "db.insert",
    args: {
      table: "chores",
      record: {
        title: norm.title,
        description: norm.description,
        due_at: dueAt,
        priority: 2,
        metadata: { space },
      },
    },
    reason: "Create a chore based on the user's request",
  };
  return tc;
}

function getThreadAnswersNow(threadKey: string): Record<string, unknown> {
  const tk = String(threadKey || "").trim();
  if (!tk) return EMPTY_THREAD_ANSWERS;
  try {
    const st = useClarificationStore.getState();
    return (st.getThread(tk).answers as any) ?? EMPTY_THREAD_ANSWERS;
  } catch {
    return EMPTY_THREAD_ANSWERS;
  }
}

function titleizeSpace(value: string): string {
  const v = normalizeSpaceName(value);
  if (!v) return "";
  return v
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function sanitizeClarificationOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of options) {
    const s = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (s.length > 60) continue;
    if (/[\r\n]/.test(String(raw ?? ""))) continue;
    const lower = s.toLowerCase();
    if (lower.includes("tool_calls") || lower.includes("json") || lower.includes("payload") || lower.includes("must") || lower.includes("do not")) {
      continue;
    }
    if (lower.includes("http://") || lower.includes("https://")) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(s);
  }
  return out;
}

function filterBathroomOptionsIfNeeded(options: string[], title: string): string[] {
  const t = String(title ?? "").toLowerCase();
  const wantsBathroom = t.includes("bathroom") || t.includes("bath") || t.includes("washroom") || t.includes("toilet") || t.includes("restroom");
  if (!wantsBathroom) return options;
  const bath = options.filter((o) => {
    const s = String(o ?? "").toLowerCase();
    return s.includes("bath") || s.includes("wash") || s.includes("toilet") || s.includes("restroom") || s.includes("powder");
  });
  return bath.length > 0 ? bath : options;
}

function defaultScheduleDateTimeLocal(): { date: string; time: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const mins = now.getMinutes();
  const rounded = Math.ceil(mins / 5) * 5;
  const d2 = new Date(now);
  d2.setMinutes(rounded, 0, 0);
  const hh = pad(d2.getHours());
  const mi = pad(d2.getMinutes());
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}` };
}

function normalizeScheduleDateInput(value: string): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  // Already ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  // Common locale formats: dd/mm/yyyy or dd-mm-yyyy
  const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return "";
  const dd = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  const yyyy = String(m[3]);
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeScheduleTimeInput(value: string): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  // 24h HH:MM
  const m24 = v.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const hh = String(Math.max(0, Math.min(23, Number(m24[1]) || 0))).padStart(2, "0");
    const mi = String(Math.max(0, Math.min(59, Number(m24[2]) || 0))).padStart(2, "0");
    return `${hh}:${mi}`;
  }
  // 12h formats like "12:11 PM" / "12:11PM" / "12:11 p.m."
  const m12 = v.match(/^(\d{1,2}):(\d{2})\s*([aApP])\.?\s*([mM])\.?$/);
  if (!m12) return "";
  let hh = Number(m12[1]) || 0;
  const mi = Math.max(0, Math.min(59, Number(m12[2]) || 0));
  const ap = String(m12[3]).toLowerCase();
  if (ap === "p" && hh < 12) hh += 12;
  if (ap === "a" && hh === 12) hh = 0;
  hh = Math.max(0, Math.min(23, hh));
  return `${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
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

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function wantsScheduleIntentFromText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /\b(schedule|book|plan|set\s*(up)?|set\s+a\s+time)\b/i.test(t);
}

type SpaceCategory =
  | "bathroom"
  | "balcony"
  | "kitchen"
  | "bedroom"
  | "living"
  | "dining"
  | "utility"
  | "study"
  | "parking"
  | "garden"
  | "";

type ClientChorePhase = "idle" | "need_space" | "need_schedule" | "need_approval" | "executing" | "done" | "error";

type ClientChoreSession = {
  phase: ClientChorePhase;
  threadKey: string;
  requestText: string;
  category: SpaceCategory;
  spaceOptions: string[];
  selectedSpaces: string[];
  dueAt: string;
  toolCall: ToolCall | null;
  error: string | null;
};

type ClientChoreAction =
  | { type: "RESET" }
  | { type: "START"; threadKey: string; requestText: string; category: SpaceCategory; spaceOptions: string[] }
  | { type: "SET_SPACES"; selectedSpaces: string[] }
  | { type: "SET_DUE_AT"; dueAt: string }
  | { type: "SET_TOOLCALL"; toolCall: ToolCall }
  | { type: "NEED_APPROVAL" }
  | { type: "EXECUTING" }
  | { type: "DONE" }
  | { type: "ERROR"; error: string };

const EMPTY_CLIENT_CHORE_SESSION: ClientChoreSession = {
  phase: "idle",
  threadKey: "",
  requestText: "",
  category: "",
  spaceOptions: [],
  selectedSpaces: [],
  dueAt: "",
  toolCall: null,
  error: null,
};

function clientChoreReducer(state: ClientChoreSession, action: ClientChoreAction): ClientChoreSession {
  switch (action.type) {
    case "RESET":
      return EMPTY_CLIENT_CHORE_SESSION;
    case "START":
      return {
        ...EMPTY_CLIENT_CHORE_SESSION,
        phase: action.spaceOptions.length > 1 ? "need_space" : "need_schedule",
        threadKey: action.threadKey,
        requestText: action.requestText,
        category: action.category,
        spaceOptions: action.spaceOptions,
        selectedSpaces: action.spaceOptions.length === 1 ? [action.spaceOptions[0]] : [],
      };
    case "SET_SPACES":
      return { ...state, selectedSpaces: action.selectedSpaces, phase: state.dueAt ? "need_approval" : "need_schedule", error: null };
    case "SET_DUE_AT":
      return { ...state, dueAt: action.dueAt, phase: state.selectedSpaces.length > 0 ? "need_approval" : "need_space", error: null };
    case "SET_TOOLCALL":
      return { ...state, toolCall: action.toolCall };
    case "NEED_APPROVAL":
      return { ...state, phase: "need_approval", error: null };
    case "EXECUTING":
      return { ...state, phase: "executing", error: null };
    case "DONE":
      return { ...state, phase: "done", error: null };
    case "ERROR":
      return { ...state, phase: "error", error: action.error };
    default:
      return state;
  }
}

function spaceCategoryFromText(text: string): SpaceCategory {
  const t = String(text || "").toLowerCase();
  if (/\b(bath(room)?|washroom|restroom|toilet|powder\s*room)\b/i.test(t)) return "bathroom";
  if (/\b(balcony|terrace|deck)\b/i.test(t)) return "balcony";
  if (/\b(kitchen|pantry)\b/i.test(t)) return "kitchen";
  if (/\b(bed(room)?|master\s*bed(room)?)\b/i.test(t)) return "bedroom";
  if (/\b(living\s*room|hall|lounge)\b/i.test(t)) return "living";
  if (/\b(dining\s*room|dining\s*area)\b/i.test(t)) return "dining";
  if (/\b(utility|laundry)\b/i.test(t)) return "utility";
  if (/\b(study|office)\b/i.test(t)) return "study";
  if (/\b(parking|garage)\b/i.test(t)) return "parking";
  if (/\b(garden|yard)\b/i.test(t)) return "garden";
  return "";
}

function matchSpaceCategory(category: SpaceCategory, norm: string): boolean {
  if (!category) return false;
  if (category === "bathroom") return norm.includes("bath") || norm.includes("wash") || norm.includes("toilet") || norm.includes("powder");
  if (category === "balcony") return norm.includes("balcony") || norm.includes("terrace") || norm.includes("deck");
  if (category === "kitchen") return norm.includes("kitchen") || norm.includes("pantry");
  if (category === "bedroom") return norm.includes("bed") || norm.includes("master bedroom") || norm.includes("guest bedroom");
  if (category === "living") return norm.includes("living") || norm.includes("hall") || norm.includes("lounge");
  if (category === "dining") return norm.includes("dining");
  if (category === "utility") return norm.includes("utility") || norm.includes("laundry");
  if (category === "study") return norm.includes("study") || norm.includes("office");
  if (category === "parking") return norm.includes("parking") || norm.includes("garage");
  if (category === "garden") return norm.includes("garden") || norm.includes("yard");
  return false;
}

function allLabelForCategory(category: SpaceCategory): string {
  if (!category) return "";
  if (category === "bathroom") return "All bathrooms";
  if (category === "balcony") return "All balconies";
  if (category === "living") return "All living rooms";
  if (category === "dining") return "All dining areas";
  return `All ${category}s`;
}

function withLocalTime(d: Date, hours: number, minutes: number): Date {
  const x = new Date(d);
  x.setHours(hours, minutes, 0, 0);
  return x;
}

function nextWeekday(from: Date, weekday0Sun: number): Date {
  const base = startOfLocalDay(from);
  const cur = base.getDay();
  const delta = (weekday0Sun - cur + 7) % 7;
  const days = delta === 0 ? 7 : delta;
  const out = new Date(base);
  out.setDate(base.getDate() + days);
  return out;
}

function nthWeekdayOfMonth(year: number, month0: number, weekday0Sun: number, n: number): Date {
  const first = new Date(year, month0, 1);
  const firstDay = first.getDay();
  const delta = (weekday0Sun - firstDay + 7) % 7;
  const dayOfMonth = 1 + delta + (n - 1) * 7;
  return new Date(year, month0, dayOfMonth);
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

function weekdayShort(weekday0Sun: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday0Sun] ?? "";
}

function computeSchedule(params: { cadence: string; now?: Date }): { dueAt: string | null; label: string } {
  const now = params.now ?? new Date();
  const cadence = params.cadence;

  // Defaults:
  // - daily: tomorrow morning
  // - weekly: next Monday
  // - biweekly: next 2nd/4th Monday (whichever comes next)
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

  return { dueAt: null, label: "" };
}

function buildRecommendedChoreActions(params: {
  householdId: string;
  home: HomeProfileRow;
  coverage: ReturnType<typeof loadCoverageDraft>;
}): AgentCreateAction[] {
  const { householdId, home, coverage } = params;

  const spaces = Array.isArray(home.spaces) ? home.spaces.map(String).filter(Boolean) : [];
  const spacesNormalized = spaces.map(normalizeSpaceName);

  const robotVacEnabled = Boolean(coverage?.devices?.robot_vacuum);
  const robotVacRooms = robotVacEnabled
    ? uniqStrings((coverage?.coveredAreasByDevice?.robot_vacuum ?? []).map(String).filter(Boolean))
    : [];
  const robotVacRoomsNorm = new Set(robotVacRooms.map(normalizeSpaceName));

  const suggestions: Array<{ title: string; description: string; priority: number; metadata?: Record<string, unknown> }> = [];

  const hasKitchen = spacesNormalized.some((s) => s.includes("kitchen"));
  const hasLiving = spacesNormalized.some((s) => s.includes("living"));

  if (hasKitchen) {
    suggestions.push({
      title: "Kitchen cleanup",
      description: "Daily: wipe counters + clear sink + take out wet waste if needed.",
      priority: 2,
      metadata: { cadence: "daily" },
    });
  }

  if (hasLiving) {
    suggestions.push({
      title: "Living room tidy",
      description: "Daily: quick reset (put things back, fold blankets, clear surfaces).",
      priority: 1,
      metadata: { cadence: "daily" },
    });
  }

  const numBaths = typeof home.num_bathrooms === "number" && Number.isFinite(home.num_bathrooms) ? home.num_bathrooms : null;
  if ((numBaths ?? 0) > 0) {
    suggestions.push({
      title: "Clean bathrooms",
      description: `Weekly: clean ${numBaths === 1 ? "the bathroom" : `all ${numBaths} bathrooms`} (toilet, sink, floor).`,
      priority: 3,
      metadata: { cadence: "weekly", bathrooms: numBaths },
    });
  }

  const balconyCountRaw = home.space_counts && typeof home.space_counts === "object" ? (home.space_counts as any).balcony : null;
  const balconyCount = typeof balconyCountRaw === "number" && Number.isFinite(balconyCountRaw) ? balconyCountRaw : home.has_balcony ? 1 : 0;
  if (balconyCount > 0) {
    suggestions.push({
      title: "Clean balcony",
      description: `Biweekly: sweep + wipe balcony (${balconyCount === 1 ? "1" : balconyCount} balcony).`,
      priority: 1,
      metadata: { cadence: "biweekly", balconies: balconyCount },
    });
  }

  suggestions.push({
    title: "Dust surfaces",
    description: "Weekly: dust common areas and wipe frequently touched surfaces.",
    priority: 2,
    metadata: { cadence: "weekly" },
  });

  for (const s of spaces) {
    const norm = normalizeSpaceName(s);
    const label = titleizeSpace(s);
    if (!norm) continue;
    if (norm.includes("bath")) continue;
    if (norm.includes("toilet")) continue;
    if (norm.includes("wash")) continue;
    if (norm.includes("utility")) continue;
    if (robotVacRoomsNorm.has(norm)) continue;
    suggestions.push({
      title: `Sweep and mop ${label}`,
      description: robotVacEnabled
        ? "Weekly: sweep and mop this room (not covered by the robot vacuum)."
        : "Weekly: sweep and mop this room.",
      priority: 2,
      metadata: { cadence: "weekly", space: label, skippedBecauseRobotVacuum: false },
    });
  }

  if (robotVacEnabled && robotVacRooms.length > 0) {
    suggestions.push({
      title: "Check robot vacuum schedule",
      description: `Weekly: confirm the robot vacuum ran for ${robotVacRooms.length} covered area(s).`,
      priority: 1,
      metadata: { cadence: "weekly", device: "robot_vacuum" },
    });
  }

  const capped = suggestions.slice(0, 12);
  const actions: AgentCreateAction[] = capped.map((s) => {
    const meta = (s.metadata ?? {}) as Record<string, unknown>;
    const cadence = typeof meta.cadence === "string" ? meta.cadence : "";
    const sched = computeSchedule({ cadence });
    const mergedMeta = {
      ...meta,
      schedule_label: sched.label,
    };

    return {
      type: "create",
      table: "chores",
      record: {
        household_id: householdId,
        title: s.title,
        description: s.description,
        priority: s.priority,
        status: "pending",
        due_at: sched.dueAt,
        metadata: mergedMeta,
      },
      reason: `Recommended chore based on home profile + automation coverage: ${s.title}`,
    };
  });
  return actions;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function shouldOverrideHouseholdId(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const v = value.trim();
  if (!v) return true;
  if (v === "YOUR_HOUSEHOLD_ID") return true;
  if (v === "<HOUSEHOLD_ID>") return true;
  if (!isUuidLike(v)) return true;
  return false;
}

function wantsListForTable(params: { userText: string; table: string }): boolean {
  const text = params.userText.trim().toLowerCase();
  const table = params.table;
  if (!text) return false;

  if (table === "chores") {
    return /\bchores?\b/.test(text) && /\b(list|show|get|what|pending|overdue|all)\b/.test(text);
  }
  if (table === "helpers") {
    return /\bhelpers?\b/.test(text) && /\b(list|show|get|what|all)\b/.test(text);
  }
  if (table === "alerts") {
    return /\balerts?\b/.test(text) && /\b(list|show|get|what|open|all)\b/.test(text);
  }
  return true;
}

// ─── Animations ────────────────────────────────────────────────────────────────
const bounceTyping = keyframes`
  0%, 60%, 100% { transform: translateY(0);    opacity: 1;   }
  30%            { transform: translateY(-6px); opacity: 0.7; }
`;

// ─── Constants ─────────────────────────────────────────────────────────────────
const LANG_LABELS: Record<SpeechLang, string> = {
  "en-IN": "EN",
  "hi-IN": "हिं",
  "kn-IN": "ಕನ್",
};
const TYPING_DOT_DELAYS = [0, 0.18, 0.36];

const hasKey =
  !!import.meta.env.VITE_SARVAM_API_KEY &&
  import.meta.env.VITE_SARVAM_API_KEY !== "your_sarvam_api_key_here";

// ─── Typing Indicator ──────────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-end" sx={{ mb: 2 }}>
      <Avatar sx={{ width: 32, height: 32, bgcolor: "primary.main", flexShrink: 0 }}>
        <SmartToy sx={{ fontSize: 18 }} />
      </Avatar>
      <Box
        sx={{
          px: 2,
          py: 1.5,
          bgcolor: "secondary.main",
          borderRadius: "18px",
          borderTopLeftRadius: "4px",
          display: "flex",
          alignItems: "center",
          gap: 0.5,
        }}
      >
        {TYPING_DOT_DELAYS.map((delay, i) => (
          <Box
            key={i}
            sx={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              bgcolor: "text.disabled",
              animation: `${bounceTyping} 1.1s ${delay}s ease-in-out infinite`,
            }}
          />
        ))}
      </Box>
    </Stack>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────
export function ChatInterface(props: { embedded?: boolean; onboarding?: boolean } = {}) {
  const navigate = useNavigate();
  const isOnboarding = props.onboarding ?? false;
  const { t, lang: uiLang, setLang: setUiLang } = useI18n();
  const [input, setInput] = useState("");
  const [lang, setLang] = useState<SpeechLang>("en-IN");
  const [sttError, setSttError] = useState<string | null>(null);

  const instanceIdRef = useRef<string>("");
  if (!instanceIdRef.current) instanceIdRef.current = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

  const [spaceClarifyOpen, setSpaceClarifyOpen] = useState(false);
  const [spaceClarifyTitle, setSpaceClarifyTitle] = useState<string>("");
  const [spaceClarifyOptions, setSpaceClarifyOptions] = useState<string[]>([]);
  const [spaceClarifySelection, setSpaceClarifySelection] = useState<string[]>([]);
  const [spaceClarifyMulti, setSpaceClarifyMulti] = useState(false);
  const [spaceClarifyPending, setSpaceClarifyPending] = useState<null | ((sel: string) => Promise<void>)>(null);
  const [spaceClarifyError, setSpaceClarifyError] = useState<string | null>(null);

  const drawerQuickCommandsStorageKey = "homeops.chat.drawer.quick_commands_panel_open";
  const [drawerQuickCommandsOpen, setDrawerQuickCommandsOpen] = useState<boolean>(() => {
    if (!props.embedded) return false;
    try {
      const raw = localStorage.getItem(drawerQuickCommandsStorageKey);
      if (raw === "true") return true;
      if (raw === "false") return false;
      return false;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!props.embedded) return;
    try {
      localStorage.setItem(drawerQuickCommandsStorageKey, String(drawerQuickCommandsOpen));
    } catch {
      // ignore
    }
  }, [drawerQuickCommandsOpen, props.embedded]);

  const {
    accessToken: authedAccessToken,
    householdId: authedHouseholdId,
    user: authedUser,
    lastError: authedLastError,
    signOut,
    refreshHouseholdId,
    bootstrapHousehold,
  } = useAuth();

  const [agentAccessToken, setAgentAccessToken] = useState("");
  const [agentHouseholdId, setAgentHouseholdId] = useState("");
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [coverageExperimentOpen, setCoverageExperimentOpen] = useState(false);
  const [quickCommandsCollapsed, setQuickCommandsCollapsed] = useState(true);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentSuccess, setAgentSuccess] = useState<string | null>(null);

  const [homeSpacesCache, setHomeSpacesCache] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const handler = () => setAgentDialogOpen(true);
    window.addEventListener("homeops:open-agent-setup", handler as EventListener);
    return () => window.removeEventListener("homeops:open-agent-setup", handler as EventListener);
  }, []);

  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapSuccess, setBootstrapSuccess] = useState<string | null>(null);

  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolSuccess, setToolSuccess] = useState<string | null>(null);

  const [deleteChoresFlow, setDeleteChoresFlow] = useState<ChatDeleteChoresFlow | ChatDeleteChoresSpecificFlow>({ phase: "idle" });

  const deleteChoresFlowStorageKey = "homeops.chat.delete_chores_flow";
  const deleteChoresFlowChannelName = "homeops:delete-chores-flow";
  const deleteChoresFlowChannelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    try {
      // BroadcastChannel works across components and across tabs.
      deleteChoresFlowChannelRef.current = new BroadcastChannel(deleteChoresFlowChannelName);
      return () => {
        try {
          deleteChoresFlowChannelRef.current?.close();
        } catch {
          // ignore
        }
        deleteChoresFlowChannelRef.current = null;
      };
    } catch {
      // ignore (older browsers)
      return;
    }
  }, []);

  const persistDeleteChoresFlow = useCallback((next: ChatDeleteChoresFlow | ChatDeleteChoresSpecificFlow) => {
    try {
      if (!next || next.phase === "idle") {
        localStorage.removeItem(deleteChoresFlowStorageKey);
      } else {
        localStorage.setItem(deleteChoresFlowStorageKey, JSON.stringify(next));
      }
    } catch {
      // ignore
    }
  }, []);

  const broadcastDeleteChoresFlow = useCallback((next: ChatDeleteChoresFlow | ChatDeleteChoresSpecificFlow) => {
    try {
      window.dispatchEvent(
        new CustomEvent("homeops:delete-chores-flow", {
          detail: { source: instanceIdRef.current, ts: Date.now(), flow: next },
        }),
      );
    } catch {
      // ignore
    }

    try {
      deleteChoresFlowChannelRef.current?.postMessage({ source: instanceIdRef.current, ts: Date.now(), flow: next });
    } catch {
      // ignore
    }
  }, []);

  const setDeleteChoresFlowSynced = useCallback((next: ChatDeleteChoresFlow | ChatDeleteChoresSpecificFlow) => {
    setDeleteChoresFlow(next);
    persistDeleteChoresFlow(next);
    broadcastDeleteChoresFlow(next);
  }, [persistDeleteChoresFlow, broadcastDeleteChoresFlow]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(deleteChoresFlowStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof parsed.phase === "string") {
        setDeleteChoresFlowSynced(parsed as any);
      }
    } catch {
      // ignore
    }
  }, [setDeleteChoresFlowSynced]);

  useEffect(() => {
    let last = 0;
    const applyIncoming = (detail: any) => {
      const source = typeof detail?.source === "string" ? detail.source : "";
      const ts = typeof detail?.ts === "number" ? detail.ts : Date.now();
      const flow = detail?.flow as any;
      if (source && source === instanceIdRef.current) return;
      if (ts <= last) return;
      last = ts;
      if (!flow || typeof flow !== "object" || typeof flow.phase !== "string") return;
      // Do not override while we're executing tools, except allow an incoming idle to clear the UI.
      if (toolBusy && flow.phase !== "idle") return;
      setDeleteChoresFlow(flow as any);
      persistDeleteChoresFlow(flow as any);
    };

    const handler = (ev: Event) => {
      const ce = ev as CustomEvent;
      const detail = (ce as any)?.detail as any;
      applyIncoming(detail);
    };

    const bc = deleteChoresFlowChannelRef.current;
    const bcHandler = (ev: MessageEvent) => {
      applyIncoming(ev?.data);
    };

    const storageHandler = (ev: StorageEvent) => {
      if (ev.key !== deleteChoresFlowStorageKey) return;
      if (!ev.newValue) {
        applyIncoming({ source: "storage", ts: Date.now(), flow: { phase: "idle" } });
        return;
      }
      try {
        const parsed = JSON.parse(ev.newValue);
        if (parsed && typeof parsed === "object" && typeof parsed.phase === "string") {
          applyIncoming({ source: "storage", ts: Date.now(), flow: parsed });
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener("homeops:delete-chores-flow", handler as EventListener);
    window.addEventListener("storage", storageHandler);
    try {
      bc?.addEventListener("message", bcHandler);
    } catch {
      // ignore
    }
    return () => window.removeEventListener("homeops:delete-chores-flow", handler as EventListener);
  }, [toolBusy, persistDeleteChoresFlow]);

  const [helpers, setHelpers] = useState<HelperOption[]>([]);
  const [helperLoadError, setHelperLoadError] = useState<string | null>(null);

  const [choreDrafts, setChoreDrafts] = useState<ChoreDraft[]>([]);
  const [selectedChoreDraftIds, setSelectedChoreDraftIds] = useState<Record<string, boolean>>({});
  const [editChoreDraftId, setEditChoreDraftId] = useState<string | null>(null);
  const [accountAnchorEl, setAccountAnchorEl] = useState<HTMLElement | null>(null);
  const accountMenuOpen = Boolean(accountAnchorEl);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileFullName, setProfileFullName] = useState("");

  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackSuccess, setFeedbackSuccess] = useState<string | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<number | null>(5);
  const [feedbackMessage, setFeedbackMessage] = useState("");

  const [clearChatConfirmOpen, setClearChatConfirmOpen] = useState(false);

  const openAccountMenu = (el: HTMLElement) => setAccountAnchorEl(el);
  const closeAccountMenu = () => setAccountAnchorEl(null);

  const loadProfile = useCallback(async () => {
    if (!authedUser?.id) return;
    setProfileError(null);
    setProfileBusy(true);
    const { data, error } = await supabase.from("profiles").select("full_name").eq("id", authedUser.id).maybeSingle();
    setProfileBusy(false);
    if (error) {
      setProfileError("We couldn't load your profile right now.");
      return;
    }
    const fromDb = data?.full_name ? String(data.full_name) : "";
    const fromMeta = typeof (authedUser.user_metadata as any)?.full_name === "string" ? String((authedUser.user_metadata as any).full_name) : "";
    setProfileFullName(fromDb || fromMeta || "");
  }, [authedUser]);

  const saveProfile = useCallback(async () => {
    if (!authedUser?.id) return;
    setProfileError(null);
    setProfileBusy(true);
    const next = profileFullName.trim();
    const { error } = await supabase.from("profiles").update({ full_name: next || null }).eq("id", authedUser.id);
    setProfileBusy(false);
    if (error) {
      setProfileError("We couldn't save your profile. Please try again.");
      return;
    }
    setProfileDialogOpen(false);
  }, [authedUser, profileFullName]);

  const submitFeedback = useCallback(async () => {
    if (!authedUser?.id) {
      setFeedbackError("Please log in to send feedback.");
      return;
    }
    const rating = typeof feedbackRating === "number" ? Math.floor(feedbackRating) : null;
    if (!rating || rating < 1 || rating > 5) {
      setFeedbackError("Please select a rating (1 to 5).");
      return;
    }

    setFeedbackError(null);
    setFeedbackSuccess(null);
    setFeedbackBusy(true);
    const { error } = await supabase.from("app_feedback").insert({
      user_id: authedUser.id,
      household_id: authedHouseholdId.trim() || null,
      rating,
      message: feedbackMessage.trim() || null,
      page: typeof window !== "undefined" ? window.location.pathname : null,
      metadata: { source: "chat" },
    });
    setFeedbackBusy(false);
    if (error) {
      setFeedbackError("We couldn't send your feedback right now. Please try again.");
      return;
    }
    setFeedbackSuccess("Thanks — your feedback was sent.");
    setFeedbackMessage("");
    setFeedbackRating(5);
  }, [authedUser, authedHouseholdId, feedbackMessage, feedbackRating]);

  const getAgentSetup = useCallback(() => {
    const token = authedAccessToken.trim() || agentAccessToken.trim();
    const householdId = authedHouseholdId.trim() || agentHouseholdId.trim();
    return { token, householdId };
  }, [authedAccessToken, agentAccessToken, authedHouseholdId, agentHouseholdId]);

  const ensureHomeSpacesForValidation = useCallback(
    async (householdId: string): Promise<string[]> => {
      const hid = householdId.trim();
      if (!hid) return [];
      const { data, error } = await supabase
        .from("home_profiles")
        .select("spaces, space_counts, num_bathrooms, bhk")
        .eq("household_id", hid)
        .limit(1)
        .maybeSingle();
      if (error) return [];
      const spacesRaw = Array.isArray((data as any)?.spaces) ? ((data as any).spaces as unknown[]).map(String).filter(Boolean) : [];
      const spaces = uniqStrings(spacesRaw);
      setHomeSpacesCache((prev) => ({ ...prev, [hid]: spaces }));
      return spaces;
    },
    [homeSpacesCache],
  );

  function detectAmbiguousAreaChoreClient(
    record: Record<string, unknown>,
    spaces: string[],
  ):
    | { ok: true }
    | {
        ok: false;
        error: string;
        title: string;
        options: string[];
      } {
    const meta = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) ? (record.metadata as Record<string, unknown>) : null;
    const existingSpaceRaw = meta && typeof meta.space === "string" ? String(meta.space).trim() : "";
    const existingSpaceNorm = normalizeSpaceName(existingSpaceRaw);
    // "All X" is a valid explicit selection from the clarification dialog.
    // Treat it as resolved so we don't re-prompt.
    if (existingSpaceNorm.startsWith("all ")) return { ok: true };
    // Treat generic placeholders as ambiguous so we can prompt for exact space labels.
    // Example: "bathroom", "bathrooms", "all bathrooms", "balcony", "balconies".
    const isGenericSpace =
      !existingSpaceNorm ||
      /^(all\s+)?bath(room)?s?$/.test(existingSpaceNorm) ||
      /^(all\s+)?(washroom|restroom|toilet|powder\s*room)s?$/.test(existingSpaceNorm) ||
      /^(all\s+)?balcon(y|ies)$/.test(existingSpaceNorm) ||
      /^(all\s+)?(terrace|deck)s?$/.test(existingSpaceNorm);
    if (existingSpaceRaw && !isGenericSpace) return { ok: true };

    const title = typeof record.title === "string" ? record.title : "";
    const description = typeof record.description === "string" ? record.description : "";
    const text = `${title} ${description}`.trim().toLowerCase();

    const category = spaceCategoryFromText(text);
    if (!category) return { ok: true };

    const normalizedSpaces = (Array.isArray(spaces) ? spaces : []).map((s) => ({ raw: String(s), norm: normalizeSpaceName(String(s)) }));
    const matches = normalizedSpaces.filter((s) => matchSpaceCategory(category, s.norm)).map((s) => s.raw);

    const uniq = uniqStrings(matches);
    if (uniq.length <= 1) return { ok: true };

    const which = category === "living" ? "living room" : category === "dining" ? "dining area" : category;
    const titleLabel = `Which ${which}?`;
    const err = `This chore mentions a ${which}, but your home has multiple ${which}s. Please choose one or more spaces.`;
    return { ok: false, error: err, title: titleLabel, options: uniq };
  }

  const openSpaceClarification = useCallback(
    (params: { title: string; options: string[]; multi?: boolean; onSelect: (sel: string) => Promise<void> }) => {
      setSpaceClarifyTitle(params.title);
      setSpaceClarifyOptions(params.options);
      setSpaceClarifySelection([]);
      setSpaceClarifyMulti(Boolean(params.multi));
      setSpaceClarifyPending(() => params.onSelect);
      setSpaceClarifyOpen(true);
    },
    [],
  );

  function withHouseholdId(tc: ToolCall, householdId: string): ToolCall {
    const args = (tc.args ?? {}) as Record<string, unknown>;
    return { ...tc, args: { ...args, household_id: householdId } };
  }

  const onboardingPrompt = isOnboarding ? ONBOARDING_SYSTEM_PROMPT : undefined;
  const { messages, sendMessage, appendUserMessage, isStreaming, error: chatError, memoryReady, memoryScope, setMemoryScope, appendAssistantMessage, clearHistory, conversationId } = useSarvamChat(onboardingPrompt ? { systemPrompt: onboardingPrompt } : undefined);

  // Auto-trigger the agent greeting when onboarding starts, with state context
  const onboardingSentRef = useRef(false);
  useEffect(() => {
    if (isOnboarding && !onboardingSentRef.current && memoryReady) {
      onboardingSentRef.current = true;
      const hid = authedHouseholdId.trim() || agentHouseholdId.trim();
      const uid = authedUser?.id ?? "";
      if (hid && uid) {
        // Detect current state and include it in the opening message
        void (async () => {
          const { detectOnboardingState, buildOnboardingContext } = await import("../../services/onboardingState");
          const state = await detectOnboardingState(hid, uid);
          const context = buildOnboardingContext(state);
          const greeting = state.homeProfileExists
            ? `I'm continuing my home setup. Here's what's done so far:\n\n${context}`
            : "Hi, I'm new here. Help me set up my home.";
          void sendMessage(greeting);
        })();
      } else {
        void sendMessage("Hi, I'm new here. Help me set up my home.");
      }
    }
  }, [isOnboarding, memoryReady, sendMessage, authedHouseholdId, agentHouseholdId, authedUser?.id]);

  const homeProfileWizardHook = useHomeProfileWizard({
    getAgentSetup: () => {
      const token = authedAccessToken.trim() || agentAccessToken.trim();
      const householdId = authedHouseholdId.trim() || agentHouseholdId.trim();
      return { token, householdId };
    },
    memoryScope,
    appendAssistantMessage,
    setToolBusy,
    setToolError,
    setToolSuccess,
  });
  const {
    homeProfileDraft, setHomeProfileDraft,
    homeProfileBusy, homeProfileError,
    homeProfileWizardOpen, setHomeProfileWizardOpen,
    homeProfileWizardStep, setHomeProfileWizardStep,
    homeProfileNewSpace, setHomeProfileNewSpace,
    homeProfileMode, setHomeProfileMode,
    homeProfileExists,
    reviewHomeProfile, refreshHomeProfileExists,
    saveHomeProfileDraft, openHomeProfileWizard, closeHomeProfileWizard,
    updateHomeProfileRecord, goNextHomeProfileStep, goBackHomeProfileStep,
  } = homeProfileWizardHook;

  const latestUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m: any = messages[i];
      if (m?.role === "user" && typeof m?.content === "string") return String(m.content);
    }
    return "";
  }, [messages]);

  const [clientConversationId] = useState<string>(() => {
    try {
      const k = "homeops.chat.client_conversation_id";
      const existing = sessionStorage.getItem(k);
      if (existing && existing.trim()) return existing.trim();
      const next = `client_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(k, next);
      return next;
    } catch {
      return `client_${Date.now()}`;
    }
  });

  const threadKey = useMemo(() => {
    const { householdId } = getAgentSetup();
    const cid = (conversationId || "").trim() || clientConversationId.trim();
    return buildThreadKey({ householdId, conversationId: cid });
  }, [getAgentSetup, conversationId, clientConversationId]);

  const dismissedClarificationKey = useClarificationStore((s) => (threadKey ? s.getThread(threadKey).dismissedClarificationKey : null));
  const setDismissedClarificationKey = useClarificationStore((s) => s.setDismissedClarificationKey);
  const threadAnswers = useClarificationStore((s) => (threadKey ? s.getThread(threadKey).answers : EMPTY_THREAD_ANSWERS));
  const setThreadAnswer = useClarificationStore((s) => s.setAnswer);
  const clearThreadAnswers = useClarificationStore((s) => s.clearAnswers);
  const approvedToolCallKeys = useClarificationStore((s) => (threadKey ? s.getThread(threadKey).approvedToolCallKeys : EMPTY_APPROVED_TOOLCALL_KEYS));
  const setToolCallApproved = useClarificationStore((s) => s.setToolCallApproved);

  const dismissedClarificationKeyRef = useRef<string | null>(null);

  useEffect(() => {
    dismissedClarificationKeyRef.current = dismissedClarificationKey;
  }, [dismissedClarificationKey]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const scheduleCardRef = useRef<HTMLDivElement>(null);
  const spaceCardRef = useRef<HTMLDivElement>(null);
  const approvalCardRef = useRef<HTMLDivElement>(null);

  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduleDialogValue, setScheduleDialogValue] = useState<string>("");
  const [scheduleDialogDate, setScheduleDialogDate] = useState<string>("");
  const [scheduleDialogTime, setScheduleDialogTime] = useState<string>("");
  const [scheduleDialogError, setScheduleDialogError] = useState<string | null>(null);
  const [schedulePendingToolCall, setSchedulePendingToolCall] = useState<null | ToolCall>(null);
  const [schedulePendingDraftIds, setSchedulePendingDraftIds] = useState<string[] | null>(null);

  const openedScheduleClarificationKeyRef = useRef<string | null>(null);
  const openedSpaceClarificationKeyRef = useRef<string | null>(null);

  const [pendingClarification, setPendingClarification] = useState<null | {
    kind: string;
    spaces?: string[];
    due_at?: string;
  }>(null);

  const pendingClarificationRef = useRef<null | { kind: string; spaces?: string[]; due_at?: string }>(null);
  useEffect(() => {
    pendingClarificationRef.current = pendingClarification;
  }, [pendingClarification]);

  const [clientChoreSession, dispatchClientChore] = useReducer(clientChoreReducer, EMPTY_CLIENT_CHORE_SESSION);

  const startClientChoreSession = useCallback(
    async (requestText: string) => {
      const { householdId } = getAgentSetup();
      if (!householdId) return;
      const category = spaceCategoryFromText(requestText);
      const spaces = await ensureHomeSpacesForValidation(householdId);
      const normalizedSpaces = (Array.isArray(spaces) ? spaces : []).map((s) => ({ raw: String(s), norm: normalizeSpaceName(String(s)) }));
      const matches = normalizedSpaces.filter((s) => matchSpaceCategory(category, s.norm)).map((s) => s.raw);
      const uniqMatches = uniqStrings(matches);

      if (category && uniqMatches.length === 0) {
        dispatchClientChore({ type: "ERROR", error: `I couldn't find any matching ${category} spaces in your home profile.` });
        return;
      }

      dispatchClientChore({ type: "START", threadKey, requestText, category, spaceOptions: category ? uniqMatches : [] });
    },
    [ensureHomeSpacesForValidation, getAgentSetup, threadKey],
  );

  const confirmClientSchedule = useCallback(async (rawValue: string, dateValue: string, timeValue: string) => {
    const rawFromField = String(rawValue || "").trim();
    let raw = rawFromField;
    if (!raw) {
      const d = String(dateValue || "").trim();
      const t0 = String(timeValue || "").trim();
      if (!d || !t0) {
        setScheduleDialogError("Please choose a date and time.");
        return;
      }
      raw = `${d}T${t0}`;
    }
    const normalized = normalizeDatetimeLocal(raw);
    if (!normalized) {
      setScheduleDialogError("Please choose a valid date and time.");
      return;
    }

    dispatchClientChore({ type: "SET_DUE_AT", dueAt: normalized });
  }, []);

  // Drive clarification UI from the session machine.
  useEffect(() => {
    if (clientChoreSession.phase !== "need_space") return;
    if (!clientChoreSession.category) return;
    const allLabel = allLabelForCategory(clientChoreSession.category);
    const which = clientChoreSession.category === "living" ? "living room" : clientChoreSession.category === "dining" ? "dining area" : clientChoreSession.category;
    const title = `Which ${which}?`;
    const options = allLabel ? [allLabel, ...clientChoreSession.spaceOptions] : clientChoreSession.spaceOptions;

    const inferred = inferSpaceFromText(options, clientChoreSession.requestText);
    if (inferred) {
      const sels = normalizeSpaceName(inferred).startsWith("all ") ? clientChoreSession.spaceOptions : [inferred];
      dispatchClientChore({ type: "SET_SPACES", selectedSpaces: sels });
      return;
    }

    openSpaceClarification({
      title,
      options,
      multi: true,
      onSelect: async (space) => {
        const selsRaw = String(space)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const sels = selsRaw.some((s) => normalizeSpaceName(s).startsWith("all ")) ? clientChoreSession.spaceOptions : selsRaw;
        dispatchClientChore({ type: "SET_SPACES", selectedSpaces: sels });
      },
    });
  }, [clientChoreSession.phase, clientChoreSession.category, clientChoreSession.spaceOptions, openSpaceClarification]);

  useEffect(() => {
    if (clientChoreSession.phase !== "need_schedule") return;
    setSpaceClarifyOpen(false);
    setScheduleDialogError(null);
    setScheduleDialogValue("");
    const dflt = defaultScheduleDateTimeLocal();
    setScheduleDialogDate(dflt.date);
    setScheduleDialogTime(dflt.time);
    setSchedulePendingToolCall(null);
    setSchedulePendingDraftIds(null);
    setScheduleDialogOpen(true);
  }, [clientChoreSession.phase]);

  useEffect(() => {
    if (clientChoreSession.phase !== "need_approval") return;
    setSpaceClarifyOpen(false);
    setScheduleDialogOpen(false);
    if (clientChoreSession.toolCall) return;
    if (!clientChoreSession.dueAt) return;
    if (clientChoreSession.selectedSpaces.length === 0) return;
    const tc = buildClientChoreToolCall({
      userText: clientChoreSession.requestText,
      dueAt: clientChoreSession.dueAt,
      space: clientChoreSession.selectedSpaces.join(", "),
    });
    dispatchClientChore({ type: "SET_TOOLCALL", toolCall: tc });
  }, [clientChoreSession.phase, clientChoreSession.toolCall, clientChoreSession.dueAt, clientChoreSession.selectedSpaces, clientChoreSession.requestText]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  // Load saved agent setup
  useEffect(() => {
    try {
      const savedToken = localStorage.getItem("homeops.agent.access_token") ?? "";
      const savedHousehold = localStorage.getItem("homeops.agent.household_id") ?? "";
      if (savedToken) setAgentAccessToken(savedToken);
      if (savedHousehold) setAgentHouseholdId(savedHousehold);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const handler = (ev: Event) => {
      const ce = ev as CustomEvent;
      const detail = ce?.detail as any;
      const msg = typeof detail?.message === "string" ? detail.message.trim() : "";
      if (!msg) return;
      appendAssistantMessage(msg);
    };
    window.addEventListener("homeops:chat-notify", handler as EventListener);
    return () => window.removeEventListener("homeops:chat-notify", handler as EventListener);
  }, [appendAssistantMessage]);

  // Prefer the authenticated session token/household over the legacy Agent Setup values.
  useEffect(() => {
    if (authedAccessToken.trim()) setAgentAccessToken(authedAccessToken.trim());
    if (authedHouseholdId.trim()) setAgentHouseholdId(authedHouseholdId.trim());
    if (authedAccessToken.trim() && !authedHouseholdId.trim()) {
      void refreshHouseholdId();
    }
  }, [authedAccessToken, authedHouseholdId, refreshHouseholdId]);

  // Persist agent setup
  useEffect(() => {
    try {
      if (agentAccessToken.trim()) localStorage.setItem("homeops.agent.access_token", agentAccessToken.trim());
      if (agentHouseholdId.trim()) localStorage.setItem("homeops.agent.household_id", agentHouseholdId.trim());
    } catch {
      // ignore
    }
  }, [agentAccessToken, agentHouseholdId]);

  // Voice transcript appends to input
  const handleTranscript = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  const isAffirmative = useCallback((text: string): boolean => {
    const t = (text || "").trim().toLowerCase();
    if (!t) return false;
    return t === "yes" || t === "y" || t === "ok" || t === "okay" || t === "sure" || t === "proceed" || t === "do it";
  }, []);

  const isNegative = useCallback((text: string): boolean => {
    const t = (text || "").trim().toLowerCase();
    if (!t) return false;
    return t === "no" || t === "n" || t === "cancel" || t === "stop" || t === "don\"t" || t === "do not";
  }, []);

  const parseDeleteScope = useCallback((text: string): "overdue" | "completed" | "all" | null => {
    const t = (text || "").trim().toLowerCase();
    if (!t) return null;
    if (t.includes("overdue")) return "overdue";
    if (t.includes("completed") || t.includes("done")) return "completed";
    if (t === "all" || t.includes("all chores") || t.includes("everything")) return "all";
    return null;
  }, []);

  const isSpecificDeleteScope = useCallback((text: string): boolean => {
    const t = (text || "").trim().toLowerCase();
    if (!t) return false;
    if (t.includes("specific")) return true;
    if (t.includes("some") && t.includes("chores")) return true;
    if (t.includes("select") && t.includes("chores")) return true;
    return false;
  }, []);

  const loadSpecificChoresPreview = useCallback(async () => {
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      appendAssistantMessage("Missing access_token or household_id. Click Agent Setup to confirm your session.");
      setDeleteChoresFlowSynced({ phase: "idle" });
      return;
    }

    setToolBusy(true);
    setToolError(null);
    try {
      const { data, error } = await supabase
        .from("chores")
        .select("id,title,status,due_at")
        .eq("household_id", householdId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(25);

      if (error) {
        setToolError(error.message || "Couldn’t load chores.");
        appendAssistantMessage(`⚠️ ${error.message || "Couldn’t load chores."}`);
        setDeleteChoresFlowSynced({ phase: "idle" });
        return;
      }

      const rows = Array.isArray(data) ? (data as any[]) : [];
      const preview: DeleteChorePreviewRow[] = rows
        .map((r) => ({
          id: String(r?.id ?? ""),
          title: typeof r?.title === "string" ? r.title : "(untitled)",
          status: typeof r?.status === "string" ? r.status : "",
          due_at: typeof r?.due_at === "string" ? r.due_at : null,
        }))
        .filter((r) => r.id);

      if (preview.length === 0) {
        appendAssistantMessage("I couldn’t find any chores to delete.");
        setDeleteChoresFlowSynced({ phase: "idle" });
        return;
      }

      appendAssistantMessage("Select the chores you want to delete from the card below, then click Delete selected.");
      setDeleteChoresFlowSynced({ phase: "select_specific", preview, selectedIds: {} });
    } finally {
      setToolBusy(false);
    }
  }, [appendAssistantMessage, getAgentSetup, setDeleteChoresFlowSynced]);

  const runDeleteScopePreview = useCallback(async (scope: "overdue" | "completed" | "all") => {
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      appendAssistantMessage("Missing access_token or household_id. Click Agent Setup to confirm your session.");
      setDeleteChoresFlowSynced({ phase: "idle" });
      return;
    }

    setToolBusy(true);
    setToolError(null);
    try {
      const nowIso = new Date().toISOString();
      let q = supabase
        .from("chores")
        .select("id,title,status,due_at")
        .eq("household_id", householdId)
        .is("deleted_at", null);

      if (scope === "completed") {
        q = q.eq("status", "completed");
      } else if (scope === "overdue") {
        q = q
          .neq("status", "completed")
          .not("due_at", "is", null)
          .lt("due_at", nowIso);
      }

      const { data, error } = await q.order("due_at", { ascending: true }).limit(50);
      if (error) {
        setToolError(error.message || "Couldn’t load chores.");
        appendAssistantMessage(`⚠️ ${error.message || "Couldn’t load chores."}`);
        setDeleteChoresFlowSynced({ phase: "idle" });
        return;
      }

      const rows = Array.isArray(data) ? (data as any[]) : [];
      const preview: DeleteChorePreviewRow[] = rows.map((r) => ({
        id: String(r?.id ?? ""),
        title: typeof r?.title === "string" ? r.title : "(untitled)",
        status: typeof r?.status === "string" ? r.status : "",
        due_at: typeof r?.due_at === "string" ? r.due_at : null,
      })).filter((r) => r.id);
      const ids = preview.map((r) => r.id);

      if (ids.length === 0) {
        appendAssistantMessage(scope === "overdue" ? "You have 0 overdue chores." : scope === "completed" ? "You have 0 completed chores." : "You have 0 chores.");
        setDeleteChoresFlowSynced({ phase: "idle" });
        return;
      }

      appendAssistantMessage(
        `Found ${ids.length} ${scope} chore${ids.length === 1 ? "" : "s"}. Review the cards below and click Delete to confirm, or Cancel.`,
      );
      setDeleteChoresFlowSynced({ phase: "awaiting_confirm", scope, choreIds: ids, preview });
    } finally {
      setToolBusy(false);
    }
  }, [appendAssistantMessage, getAgentSetup, isNegative, memoryScope, t, setDeleteChoresFlowSynced]);

  const runDeleteChores = useCallback(async (scope: "overdue" | "completed" | "all", choreIds: string[]) => {
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      appendAssistantMessage("Missing access_token or household_id. Click Agent Setup to confirm your session.");
      setDeleteChoresFlowSynced({ phase: "idle" });
      return;
    }
    if (!Array.isArray(choreIds) || choreIds.length === 0) {
      appendAssistantMessage("No chores selected to delete.");
      setDeleteChoresFlowSynced({ phase: "idle" });
      return;
    }

    setToolBusy(true);
    setToolError(null);
    try {
      let okCount = 0;
      for (const id of choreIds) {
        const tc: ToolCall = {
          id: `chat_delete_${id}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
          tool: "db.delete",
          args: { table: "chores", id },
          reason: `Delete ${scope} chores (chat)`,
        };
        const res = await executeToolCall({
          accessToken: token,
          householdId,
          scope: memoryScope,
          toolCall: withHouseholdId(tc, householdId),
        });
        if (!res.ok) {
          const msg = "error" in res ? res.error : t("chat.tool_execution_failed");
          setToolError(msg);
          appendAssistantMessage(`⚠️ Delete failed after ${okCount} chore(s): ${msg}`);
          setDeleteChoresFlowSynced({ phase: "idle" });
          return;
        }
        okCount += 1;
      }

      const msg = `Deleted ${okCount} chore${okCount === 1 ? "" : "s"}.`;
      setToolSuccess(msg);
      appendAssistantMessage(msg);
    } finally {
      setToolBusy(false);
      setDeleteChoresFlowSynced({ phase: "idle" });
    }
  }, [appendAssistantMessage, executeToolCall, getAgentSetup, memoryScope, t, setDeleteChoresFlowSynced]);

  // Client chore orchestration is driven exclusively by ClientChoreSession below.

  const {
    isListening,
    isTranscribing,
    toggle: toggleMic,
    supported: voiceSupported,
    sttMode,
  } = useSarvamSTT(lang, handleTranscript, setSttError);

  const executeApprovedClientToolCall = useCallback(async (tc: ToolCall) => {
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      const msg = "Missing access_token or household_id. Open Agent Setup to confirm your session token + household id.";
      appendAssistantMessage(msg);
      throw new Error(msg);
    }

    setToolError(null);
    setToolSuccess(null);
    setToolBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId,
      scope: memoryScope,
      toolCall: withHouseholdId(tc, householdId),
    });
    setToolBusy(false);
    if (!res.ok) {
      const msg = "error" in res ? res.error : t("chat.tool_execution_failed");
      setToolError(msg);
      throw new Error(msg);
    }

    if (threadKey) setToolCallApproved(threadKey, toolCallDedupeKey(tc));
    if (threadKey) clearThreadAnswers(threadKey);
    setToolSuccess(t("chat.executed_tool").replace("{tool}", tc.tool));
    appendAssistantMessage(res.summary);

    // Reset all client chore UI selectors so the next chore starts from scratch.
    setSpaceClarifyOpen(false);
    setSpaceClarifyPending(null);
    setSpaceClarifyError(null);
    setSpaceClarifySelection([]);
    setScheduleDialogOpen(false);
    setScheduleDialogError(null);
    setScheduleDialogValue("");
    setScheduleDialogDate("");
    setScheduleDialogTime("");
    setSchedulePendingToolCall(null);
    setSchedulePendingDraftIds(null);
    return;
  }, [appendAssistantMessage, executeToolCall, getAgentSetup, memoryScope, t, threadKey, setToolCallApproved, clearThreadAnswers]);

  useEffect(() => {
    const wantApproval = clientChoreSession.phase === "need_approval" && clientChoreSession.toolCall;
    const target = wantApproval ? approvalCardRef.current : scheduleDialogOpen ? scheduleCardRef.current : spaceClarifyOpen ? spaceCardRef.current : null;
    if (!target) return;
    // rAF tends to be more reliable than setTimeout(0) for scrolling to newly-rendered cards.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          const scroller = messagesScrollRef.current;
          if (scroller) {
            const scrollerRect = scroller.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            const currentScrollTop = scroller.scrollTop;
            const offsetWithinScroller = targetRect.top - scrollerRect.top;
            const nextScrollTop = currentScrollTop + offsetWithinScroller - scrollerRect.height / 2 + targetRect.height / 2;
            scroller.scrollTo({ top: Math.max(0, nextScrollTop), behavior: "smooth" });
          } else {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        } catch {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      });
    });
  }, [spaceClarifyOpen, scheduleDialogOpen, clientChoreSession.phase, clientChoreSession.toolCall]);

  const approveClientChore = useCallback(async () => {
    try {
      setToolError(null);
      setToolSuccess(null);

      if (!clientChoreSession.toolCall) return;
      dispatchClientChore({ type: "EXECUTING" });
      await executeApprovedClientToolCall(clientChoreSession.toolCall);
      dispatchClientChore({ type: "DONE" });
      dispatchClientChore({ type: "RESET" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't execute";
      console.error("approveClientChore failed", e);
      setToolError(msg);
      appendAssistantMessage(`⚠️ ${msg}`);
      dispatchClientChore({ type: "ERROR", error: msg });
    }
  }, [clientChoreSession.toolCall, executeApprovedClientToolCall]);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;

    let trimmed = input.trim();
    const derivedTransliterationMode: "off" | "hi" | "kn" = lang === "hi-IN" ? "hi" : lang === "kn-IN" ? "kn" : "off";
    if (derivedTransliterationMode !== "off") {
      try {
        trimmed = Sanscript.t(trimmed, "itrans", derivedTransliterationMode === "hi" ? "devanagari" : "kannada");
      } catch {
        // ignore transliteration errors and send raw text
      }
    }
    const lower = trimmed.toLowerCase();

    if (deleteChoresFlow.phase === "awaiting_scope") {
      const scope = parseDeleteScope(lower);
      if (scope) {
        appendUserMessage(trimmed);
        setInput("");
        await runDeleteScopePreview(scope);
        return;
      }
      if (isSpecificDeleteScope(lower)) {
        appendUserMessage(trimmed);
        setInput("");
        await loadSpecificChoresPreview();
        return;
      }
      if (isNegative(lower)) {
        appendUserMessage(trimmed);
        setInput("");
        appendAssistantMessage("Okay — I won’t delete anything.");
        setDeleteChoresFlowSynced({ phase: "idle" });
        return;
      }
      // If the message doesn’t look like a delete scope response at all,
      // reset the stale delete flow and let the message proceed normally
      // (e.g., the user changed their mind and is asking something else).
      setDeleteChoresFlowSynced({ phase: "idle" });
      // Fall through to normal message handling below.
    }

    if (deleteChoresFlow.phase === "awaiting_confirm") {
      if (isAffirmative(lower)) {
        appendUserMessage(trimmed);
        setInput("");
        await runDeleteChores(deleteChoresFlow.scope, deleteChoresFlow.choreIds);
        return;
      }
      if (isNegative(lower)) {
        appendUserMessage(trimmed);
        setInput("");
        appendAssistantMessage("Cancelled — no chores were deleted.");
        setDeleteChoresFlowSynced({ phase: "idle" });
        return;
      }
      appendUserMessage(trimmed);
      setInput("");
      appendAssistantMessage("Please click Delete in the preview card, or reply YES to confirm deletion / NO to cancel.");
      return;
    }

    if (deleteChoresFlow.phase === "select_specific") {
      // While the selection card is open, keep chat deterministic.
      if (isNegative(lower)) {
        appendUserMessage(trimmed);
        setInput("");
        appendAssistantMessage("Cancelled — no chores were deleted.");
        setDeleteChoresFlowSynced({ phase: "idle" });
        return;
      }

      appendUserMessage(trimmed);
      setInput("");
      appendAssistantMessage("Please use the selection card to choose chores, then click Delete selected. (Or type CANCEL to stop.)");
      return;
    }

    const isChoresDeleteIntent = (text: string): boolean => {
      const t = (text || "").trim().toLowerCase();
      if (!t) return false;
      if (!/\bchore(s)?\b/.test(t)) return false;
      // Only match when "delete/remove" refers to the chores themselves,
      // not to a field within a chore (e.g., "remove the description" or
      // "remove from the title" should NOT trigger the delete flow).
      const isFieldEdit = /\b(description|title|name|text|wording)\b/.test(t)
        || /\b(change|update|edit|modify|replace|instead|mention)\b/.test(t);
      if (isFieldEdit) return false;
      if (/\b(delete|remove|clear|erase)\b/.test(t)) return true;
      if (/\bmark\s+as\s+deleted\b/.test(t)) return true;
      return false;
    };

    if (isChoresDeleteIntent(lower)) {
      appendUserMessage(trimmed);
      setInput("");
      appendAssistantMessage(
        "Which chores do you want to delete — all, completed, overdue, or only specific ones?",
      );
      setDeleteChoresFlowSynced({ phase: "awaiting_scope" });
      return;
    }

    // If the assistant is currently streaming, ignore sends.
    if (isStreaming) return;

    sendMessage(trimmed);
    setInput("");
  }, [
    input,
    isStreaming,
    sendMessage,
    appendAssistantMessage,
    lang,
    appendUserMessage,
    setDeleteChoresFlowSynced,
    deleteChoresFlow.phase,
    deleteChoresFlow.phase === "awaiting_confirm" ? deleteChoresFlow.scope : "",
    deleteChoresFlow.phase === "awaiting_confirm" ? stableStringify(deleteChoresFlow.choreIds) : "",
    runDeleteChores,
    runDeleteScopePreview,
    loadSpecificChoresPreview,
  ]);

  const handleQuickAction = useCallback((prompt: string) => {
    setInput(prompt);
  }, []);

  const handleLangChange = (_: React.MouseEvent, value: SpeechLang | null) => {
    if (!value) return;
    setLang(value);
    if (value === "hi-IN") setUiLang("hi");
    else if (value === "kn-IN") setUiLang("kn");
    else setUiLang("en");
  };

  // Determine if a "thinking" placeholder should show (streaming started but no content yet)
  const lastMsg = messages[messages.length - 1];
  const showTypingDots =
    isStreaming && lastMsg?.role === "assistant" && lastMsg.content === "";

  const latestAssistantText = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant") return m.content;
    }
    return "";
  })();

  const proposedActions = parseAgentActionsFromAssistantText(latestAssistantText);
  const proposedAutomationSuggestions = parseAutomationSuggestionsFromAssistantText(latestAssistantText);
  const proposedToolCalls = parseToolCallsFromAssistantText(latestAssistantText);
  const proposedClarification = parseClarificationFromAssistantText(latestAssistantText);
  // Onboarding state is now managed by OnboardingPanel (state machine),
  // not keyword detection. The panel is rendered below the messages.

  const proposedClarificationKey = useMemo(() => {
    if (!proposedClarification) return "";
    try {
      return JSON.stringify(proposedClarification);
    } catch {
      return String((proposedClarification as any)?.kind ?? "");
    }
  }, [proposedClarification]);
  const hasChoreCreateActions = useMemo(
    () => proposedActions.some((a) => a.type === "create" && a.table === "chores"),
    [proposedActions],
  );
  const isReadOnlyRpc = (tc: ToolCall): boolean => {
    if (tc.tool !== "query.rpc") return false;
    const nm = (tc.args as any)?.name;
    return (
      nm === "resolve_helper" ||
      nm === "resolve_space" ||
      nm === "count_chores_assigned_to" ||
      nm === "count_chores" ||
      nm === "group_chores_by_status" ||
      nm === "group_chores_by_assignee" ||
      nm === "list_chores_enriched"
    );
  };

  const proposedWriteToolCalls = proposedToolCalls
    .filter((tc) => tc.tool !== "db.select")
    .filter((tc) => !isReadOnlyRpc(tc))
    // If the model emits BOTH actions (for chore drafts) and tool_calls (db.insert chores),
    // hide the insert tool calls to avoid duplicate approvals.
    .filter((tc) => {
      const table = (tc.args as any)?.table;
      if (!hasChoreCreateActions) return true;
      if (tc.tool === "db.insert" && table === "chores") return false;
      return true;
    });
  const dedupedWriteToolCalls = useMemo(() => {
    const seen = new Set<string>();
    const out: ToolCall[] = [];
    for (const tc of proposedWriteToolCalls) {
      const key = toolCallDedupeKey(tc);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tc);
    }
    return out;
  }, [proposedWriteToolCalls]);

  const [toolCallOverridesByKey, setToolCallOverridesByKey] = useState<Record<string, ToolCall>>({});
  const pendingSpaceToolCallKeyRef = useRef<string | null>(null);

  const [showSemanticDebug, setShowSemanticDebug] = useState<boolean>(() => {
    try {
      return (localStorage.getItem("homeops.debug.semantic") ?? "").trim() === "1";
    } catch {
      return false;
    }
  });

  const [semanticDebugQuery, setSemanticDebugQuery] = useState<string>("");
  const [semanticDebugBusy, setSemanticDebugBusy] = useState(false);
  const [semanticDebugError, setSemanticDebugError] = useState<string | null>(null);
  const [semanticDebugMatches, setSemanticDebugMatches] = useState<any[]>([]);
  const [semanticDebugLastReindex, setSemanticDebugLastReindex] = useState<string>("");

  useEffect(() => {
    try {
      localStorage.setItem("homeops.debug.semantic", showSemanticDebug ? "1" : "0");
    } catch {
      // ignore
    }
  }, [showSemanticDebug]);

  // If a proposed chore insert references an ambiguous space (e.g. multiple balconies),
  // prompt for a specific space BEFORE showing approval cards.
  useEffect(() => {
    if (spaceClarifyOpen) return;
    if (dedupedWriteToolCalls.length === 0) return;

    const { householdId } = getAgentSetup();
    if (!householdId) return;

    let cancelled = false;

    (async () => {
      for (const tc0 of dedupedWriteToolCalls) {
        if (cancelled) return;
        const key = toolCallDedupeKey(tc0);
        if (pendingSpaceToolCallKeyRef.current === key) return;
        const tc = toolCallOverridesByKey[key] ?? tc0;

        if (tc.tool !== "db.insert") continue;
        const args: any = tc.args ?? {};
        if (args.table !== "chores") continue;
        const record = args.record && typeof args.record === "object" && !Array.isArray(args.record) ? (args.record as Record<string, unknown>) : null;
        if (!record) continue;

        const storedSpacesRaw = (threadAnswers as any)?.spaces;
        const storedSpaces = Array.isArray(storedSpacesRaw)
          ? storedSpacesRaw.map(String).map((s) => s.trim()).filter(Boolean)
          : [];

        const spaces = await ensureHomeSpacesForValidation(householdId);
        if (cancelled) return;
        const ambiguous = detectAmbiguousAreaChoreClient(record, spaces);
        if (ambiguous.ok) continue;

        const recordTitle = typeof record.title === "string" ? record.title : "";
        const recordDesc = typeof record.description === "string" ? record.description : "";
        const recordText = `${recordTitle} ${recordDesc}`.trim();
        const inferred =
          inferSpaceFromText((ambiguous as any).options ?? [], recordText) ||
          inferSpaceFromText((ambiguous as any).options ?? [], latestUserText);
        if (inferred) {
          if (threadKey) setThreadAnswer(threadKey, { spaces: [inferred] });
          const args2: any = tc.args ?? {};
          const rec2 = args2.record && typeof args2.record === "object" && !Array.isArray(args2.record) ? args2.record : {};
          const meta2 =
            rec2?.metadata && typeof rec2.metadata === "object" && !Array.isArray(rec2.metadata) ? { ...rec2.metadata } : {};
          const patched: ToolCall = {
            ...tc,
            args: {
              ...args2,
              record: {
                ...rec2,
                metadata: { ...meta2, space: inferred },
              },
            },
          };
          setToolCallOverridesByKey((prev) => ({ ...prev, [key]: patched }));
          pendingSpaceToolCallKeyRef.current = null;
          continue;
        }

        if (storedSpaces.length > 0) {
          const space = storedSpaces.join(", ");
          const args2: any = tc.args ?? {};
          const rec2 = args2.record && typeof args2.record === "object" && !Array.isArray(args2.record) ? args2.record : {};
          const meta2 = rec2?.metadata && typeof rec2.metadata === "object" && !Array.isArray(rec2.metadata) ? { ...rec2.metadata } : {};
          const patched: ToolCall = {
            ...tc,
            args: {
              ...args2,
              record: {
                ...rec2,
                metadata: { ...meta2, space },
              },
            },
          };
          setToolCallOverridesByKey((prev) => ({ ...prev, [key]: patched }));
          pendingSpaceToolCallKeyRef.current = null;
          continue;
        }

        pendingSpaceToolCallKeyRef.current = key;
        if (!ambiguous.ok) {
          const amb = ambiguous as { ok: false; error: string; title: string; options: string[] };
          openSpaceClarification({
            title: amb.title,
            options: amb.title.toLowerCase().includes("bathroom") ? ["All bathrooms", ...amb.options] : amb.options,
            multi: amb.title.toLowerCase().includes("bathroom"),
            onSelect: async (space) => {
              if (threadKey) {
                const sels = String(space)
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                setThreadAnswer(threadKey, { spaces: sels });
              }
              const args2: any = tc.args ?? {};
              const rec2 = args2.record && typeof args2.record === "object" && !Array.isArray(args2.record) ? args2.record : {};
              const meta2 =
                rec2?.metadata && typeof rec2.metadata === "object" && !Array.isArray(rec2.metadata) ? { ...rec2.metadata } : {};
              const patched: ToolCall = {
                ...tc,
                args: {
                  ...args2,
                  record: {
                    ...rec2,
                    metadata: { ...meta2, space },
                  },
                },
              };
              setToolCallOverridesByKey((prev) => ({ ...prev, [key]: patched }));
              pendingSpaceToolCallKeyRef.current = null;
            },
          });
        }
        return;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [spaceClarifyOpen, dedupedWriteToolCalls, toolCallOverridesByKey, ensureHomeSpacesForValidation, openSpaceClarification, getAgentSetup, latestUserText]);

  const hasProposals =
    proposedActions.length > 0 ||
    proposedAutomationSuggestions.length > 0 ||
    proposedWriteToolCalls.length > 0 ||
    choreDrafts.length > 0;

  const [autoExecutedToolCallIds, setAutoExecutedToolCallIds] = useState<Record<string, boolean>>({});

  const [automationSuggestionBusyId, setAutomationSuggestionBusyId] = useState<string | null>(null);

  const recentUserTextWindow = useMemo(() => {
    const parts: string[] = [];
    let count = 0;
    for (let i = messages.length - 1; i >= 0 && count < 6; i -= 1) {
      const m: any = messages[i];
      if (m?.role !== "user") continue;
      const c = typeof m?.content === "string" ? String(m.content).trim() : "";
      if (!c) continue;
      parts.unshift(c);
      count += 1;
    }
    return parts.join("\n");
  }, [messages]);

  const userProvidedExplicitDatetime = useMemo(() => {
    const t = (recentUserTextWindow || "").toLowerCase();
    if (!t.trim()) return false;
    // Cheap check: detect explicit time or date tokens.
    if (/\b\d{1,2}:\d{2}\b/.test(t)) return true;
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(t)) return true;
    if (/\b(today|tomorrow)\b/.test(t)) return true;
    return false;
  }, [recentUserTextWindow]);

  const hasAnyExplicitDatetime = useMemo(() => {
    return userProvidedExplicitDatetime;
  }, [userProvidedExplicitDatetime]);

  const recentWantsSchedule = useMemo(() => {
    const t = (recentUserTextWindow || "").toLowerCase();
    if (!t.trim()) return false;
    return /\b(schedule|book|plan|set\s*(up)?|set\s+a\s+time)\b/i.test(t);
  }, [recentUserTextWindow]);

  const approveAutomationSuggestion = useCallback(async (s: AutomationSuggestion, idx: number) => {
    setToolError(null);
    setToolSuccess(null);
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      setToolError("Missing access_token or household_id. Click Agent Setup to confirm your session token + household id.");
      return;
    }

    const id = `as_${Date.now()}_${idx}`;
    setAutomationSuggestionBusyId(id);

    const suggested = (s.suggested_automation ?? {}) as Record<string, unknown>;
    const createAutomationRecord: Record<string, unknown> = {
      ...suggested,
      title: typeof suggested.title === "string" ? suggested.title : s.title,
      description: typeof suggested.description === "string" ? suggested.description : s.body ?? null,
      status: typeof suggested.status === "string" ? suggested.status : "active",
    };

    const tcSuggestion: ToolCall = {
      id: `as_suggest_${Date.now()}`,
      tool: "db.insert",
      args: {
        table: "automation_suggestions",
        record: {
          status: "approved",
          title: s.title,
          body: s.body ?? null,
          suggested_automation: suggested,
          decided_at: new Date().toISOString(),
        },
      },
      reason: s.reason,
    };

    const tcAutomation: ToolCall = {
      id: `as_auto_${Date.now()}`,
      tool: "db.insert",
      args: {
        table: "automations",
        record: createAutomationRecord,
      },
      reason: s.reason,
    };

    const res1 = await executeToolCall({
      accessToken: token,
      householdId,
      scope: memoryScope,
      toolCall: withHouseholdId(tcSuggestion, householdId),
    });
    if (!res1.ok) {
      setAutomationSuggestionBusyId(null);
      setToolError("error" in res1 ? res1.error : t("chat.tool_execution_failed"));
      return;
    }

    const res2 = await executeToolCall({
      accessToken: token,
      householdId,
      scope: memoryScope,
      toolCall: withHouseholdId(tcAutomation, householdId),
    });
    setAutomationSuggestionBusyId(null);

    if (!res2.ok) {
      setToolError("error" in res2 ? res2.error : t("chat.tool_execution_failed"));
      return;
    }

    setToolSuccess(res2.summary);
    appendAssistantMessage(res2.summary);
  }, [appendAssistantMessage, getAgentSetup, memoryScope, t]);

  const rejectAutomationSuggestion = useCallback(async (s: AutomationSuggestion, idx: number) => {
    setToolError(null);
    setToolSuccess(null);
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      setToolError("Missing access_token or household_id. Click Agent Setup to confirm your session token + household id.");
      return;
    }

    const id = `as_${Date.now()}_${idx}`;
    setAutomationSuggestionBusyId(id);

    const suggested = (s.suggested_automation ?? {}) as Record<string, unknown>;
    const tc: ToolCall = {
      id: `as_reject_${Date.now()}`,
      tool: "db.insert",
      args: {
        table: "automation_suggestions",
        record: {
          status: "rejected",
          title: s.title,
          body: s.body ?? null,
          suggested_automation: suggested,
          decided_at: new Date().toISOString(),
        },
      },
      reason: s.reason,
    };

    const res = await executeToolCall({
      accessToken: token,
      householdId,
      scope: memoryScope,
      toolCall: withHouseholdId(tc, householdId),
    });
    setAutomationSuggestionBusyId(null);

    if (!res.ok) {
      setToolError("error" in res ? res.error : t("chat.tool_execution_failed"));
      return;
    }

    setToolSuccess(res.summary);
    appendAssistantMessage(res.summary);
  }, [appendAssistantMessage, getAgentSetup, memoryScope, t]);

  const toolCallKey = useCallback((tc: ToolCall) => {
    const args = tc.args ?? {};
    let argsKey = "";
    try {
      argsKey = JSON.stringify(args);
    } catch {
      argsKey = String(args);
    }
    return `${tc.tool}:${argsKey}`;
  }, []);

  // Convert incoming chore create actions into editable drafts
  useEffect(() => {
    if (isStreaming) return;
    const incoming = proposedActions.filter((a) => a.type === "create" && a.table === "chores");
    if (incoming.length === 0) return;

    setChoreDrafts(
      incoming.map((a, idx) => ({
        id: `${Date.now()}_${idx}`,
        action: {
          ...a,
          record: { ...a.record },
        },
      })),
    );
  }, [latestAssistantText, isStreaming]);

  useEffect(() => {
    if (isStreaming) return;
    const incoming = proposedActions.filter((a) => a.type === "create" && a.table === "home_profiles");
    if (incoming.length === 0) return;

    if (homeProfileExists) {
      void reviewHomeProfile();
      return;
    }
    const latest = incoming[incoming.length - 1];
    const latestRecord = (latest.record ?? {}) as Record<string, unknown>;
    const nextHomeType = typeof latestRecord.home_type === "string" ? latestRecord.home_type : "apartment";
    const nextBhk = asNumberOrNull(latestRecord.bhk) ?? 2;
    // Find the best matching template, fall back to 2BHK apartment.
    const matchedTemplate =
      HOME_PROFILE_TEMPLATES.find((t) => t.home_type === nextHomeType && t.bhk === nextBhk) ??
      HOME_PROFILE_TEMPLATES.find((t) => t.home_type === nextHomeType) ??
      HOME_PROFILE_TEMPLATES.find((t) => t.key === "2bhk_apartment")!;
    const rooms = normalizeSpacesToRooms(latestRecord.spaces).length > 0
      ? normalizeSpacesToRooms(latestRecord.spaces)
      : matchedTemplate.rooms;
    setHomeProfileDraft({
      id: `${Date.now()}`,
      action: {
        ...latest,
        record: {
          ...latest.record,
          home_type: nextHomeType,
          bhk: nextBhk,
          spaces: rooms,
          floors: matchedTemplate.floors_default,
          square_feet: asNumberOrNull(latestRecord.square_feet) ?? matchedTemplate.square_feet_min ?? null,
        },
      },
    });
    setHomeProfileMode("edit");
    setHomeProfileWizardStep(1); // Skip template picker; agent already chose a type.
    setHomeProfileWizardOpen(true);
  }, [latestAssistantText, isStreaming, homeProfileExists, reviewHomeProfile]);

  // Load helpers list for household
  useEffect(() => {
    const token = agentAccessToken.trim();
    const householdId = agentHouseholdId.trim();
    if (!token || !householdId) return;

    let cancelled = false;
    (async () => {
      setHelperLoadError(null);
      const res = await agentListHelpers({ accessToken: token, householdId });
      if (cancelled) return;
      if (!res.ok) {
        setHelperLoadError("error" in res ? res.error : "Failed to load helpers");
        setHelpers([]);
        return;
      }
      setHelpers(res.helpers);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentAccessToken, agentHouseholdId]);

  const applyAction = useCallback(async (action: AgentCreateAction) => {
    setAgentError(null);
    setAgentSuccess(null);

    const token = agentAccessToken.trim();
    if (!token) {
      setAgentError("Missing access token. Click Agent Setup and paste your JWT.");
      return;
    }

    const householdId = agentHouseholdId.trim();
    if (!householdId) {
      setAgentError("Missing household_id. Click Agent Setup and paste your household UUID.");
      return;
    }

    const record = { ...action.record, household_id: (action.record.household_id ?? householdId) };

    if (action.table === "chores") {
      const wantsSchedule = recentWantsSchedule;
      if (wantsSchedule && !hasAnyExplicitDatetime) {
        setAgentError("Please provide a date and time to schedule this chore.");
        return;
      }
      const spaces = await ensureHomeSpacesForValidation(String(record.household_id ?? ""));
      const ambiguous = detectAmbiguousAreaChoreClient(record as Record<string, unknown>, spaces);
      if (!ambiguous.ok) {
        const amb = ambiguous as { ok: false; error: string; title: string; options: string[] };
        openSpaceClarification({
          title: amb.title,
          options: amb.options,
          multi: amb.title.toLowerCase().includes("bathroom"),
          onSelect: async (space) => {
            const meta =
              (record as any).metadata && typeof (record as any).metadata === "object" && !Array.isArray((record as any).metadata)
                ? ((record as any).metadata as Record<string, unknown>)
                : {};
            const nextRecord = { ...record, metadata: { ...meta, space } };
            setSpaceClarifyOpen(false);
            setSpaceClarifyPending(null);
            setAgentBusy(true);
            const res = await agentCreate({
              accessToken: token,
              table: action.table,
              record: nextRecord as Record<string, unknown>,
              reason: action.reason,
            });
            setAgentBusy(false);
            if (!res.ok) {
              setAgentError("error" in res ? res.error : t("common.create_failed"));
              return;
            }
            setAgentSuccess(`Created 1 ${action.table} item.`);
          },
        });
        return;
      }
    }

    setAgentBusy(true);
    const res = await agentCreate({
      accessToken: token,
      table: action.table,
      record: record as Record<string, unknown>,
      reason: action.reason,
    });
    setAgentBusy(false);

    if (!res.ok) {
      setAgentError("error" in res ? res.error : t("common.create_failed"));
      return;
    }

    setAgentSuccess(`Created 1 ${action.table} item.`);
  }, [agentAccessToken, agentHouseholdId, ensureHomeSpacesForValidation, openSpaceClarification, t, recentWantsSchedule, userProvidedExplicitDatetime]);

  const submitChoreDrafts = useCallback(async () => {
    setAgentError(null);
    setAgentSuccess(null);

    const token = agentAccessToken.trim();
    if (!token) {
      setAgentError("Missing access token. Click Agent Setup and paste your JWT.");
      return;
    }
    const householdId = agentHouseholdId.trim();
    if (!householdId) {
      setAgentError("Missing household_id. Click Agent Setup and paste your household UUID.");
      return;
    }
    if (choreDrafts.length === 0) return;

    const selected = choreDrafts.filter((d) => selectedChoreDraftIds[d.id] !== false);
    if (selected.length === 0) {
      setAgentError("No chores selected.");
      return;
    }

    const wantsSchedule = recentWantsSchedule;
    if (wantsSchedule && !hasAnyExplicitDatetime) {
      setScheduleDialogError(null);
      setScheduleDialogValue("");
      const dflt = defaultScheduleDateTimeLocal();
      setScheduleDialogDate(dflt.date);
      setScheduleDialogTime(dflt.time);
      setSchedulePendingToolCall(null);
      setSchedulePendingDraftIds(selected.map((d) => d.id));
      setScheduleDialogOpen(true);
      return;
    }

    const createSelectedChores = async (drafts: ChoreDraft[]) => {
      setAgentBusy(true);
      let okCount = 0;
      for (const d of drafts) {
        const record = { ...d.action.record, household_id: householdId };
        const res = await agentCreate({
          accessToken: token,
          table: "chores",
          record: record as Record<string, unknown>,
          reason: d.action.reason,
        });
        if (!res.ok) {
          setAgentBusy(false);
          setAgentError("error" in res ? res.error : t("common.create_failed"));
          return;
        }
        okCount += 1;
      }
      setAgentBusy(false);
      setAgentSuccess(`Created ${okCount} chores.`);
      setChoreDrafts([]);
      setSelectedChoreDraftIds({});
    };

    const spaces = await ensureHomeSpacesForValidation(householdId);
    for (const d of selected) {
      const record = { ...d.action.record, household_id: householdId } as Record<string, unknown>;
      const ambiguous = detectAmbiguousAreaChoreClient(record, spaces);
      if (!ambiguous.ok) {
        const amb = ambiguous as { ok: false; error: string; title: string; options: string[] };
        openSpaceClarification({
          title: amb.title,
          options: amb.options,
          multi: amb.title.toLowerCase().includes("bathroom"),
          onSelect: async (space) => {
            // If multi-select was used, `space` will be a comma-separated list.
            const selectedSpaces = String(space)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const spacesToApply = selectedSpaces.length > 0 ? selectedSpaces : [space];

            const base = selected.find((x) => x.id === d.id);
            if (!base) return;
            const r0 = base.action.record as any;
            const meta0 = r0?.metadata && typeof r0.metadata === "object" && !Array.isArray(r0.metadata) ? { ...r0.metadata } : {};

            const expanded: ChoreDraft[] = spacesToApply.map((sp) => ({
              ...base,
              id: spacesToApply.length > 1 ? `${base.id}_${normalizeSpaceName(sp)}` : base.id,
              action: {
                ...base.action,
                record: {
                  ...base.action.record,
                  metadata: { ...meta0, space: sp },
                },
              },
            }));

            setChoreDrafts((prev) => {
              const out: ChoreDraft[] = [];
              for (const item of prev) {
                if (item.id === d.id) {
                  out.push(...expanded);
                } else {
                  out.push(item);
                }
              }
              return out;
            });
            setSelectedChoreDraftIds((prev) => {
              const next = { ...prev };
              delete next[d.id];
              for (const item of expanded) next[item.id] = true;
              return next;
            });

            setSpaceClarifyOpen(false);
            setSpaceClarifyPending(null);
            await createSelectedChores(expanded);
          },
        });
        return;
      }
    }

    await createSelectedChores(selected);
  }, [agentAccessToken, agentHouseholdId, choreDrafts, selectedChoreDraftIds, ensureHomeSpacesForValidation, openSpaceClarification, t, recentWantsSchedule, userProvidedExplicitDatetime]);

  const generateRecommendedChores = useCallback(async () => {
    setAgentError(null);
    setAgentSuccess(null);

    const { householdId } = getAgentSetup();
    if (!householdId) {
      setAgentError(t("agent_setup.missing_household_id"));
      return;
    }

    setAgentBusy(true);
    try {
      const { data, error } = await supabase
        .from("home_profiles")
        .select("home_type, bhk, spaces, space_counts, has_balcony, num_bathrooms, has_pets, has_kids, flooring_type")
        .eq("household_id", householdId)
        .limit(1)
        .maybeSingle();

      if (error) {
        setAgentError(error.message);
        return;
      }
      if (!data) {
        setAgentError(t("chat.create_home_profile_first"));
        return;
      }

      const coverage = loadCoverageDraft(householdId);
      const actions = buildRecommendedChoreActions({ householdId, home: data as HomeProfileRow, coverage });

      const baseId = Date.now();
      const drafts: ChoreDraft[] = actions.map((a, idx) => ({
        id: `${baseId}_${idx}`,
        action: {
          ...a,
          record: { ...a.record },
        },
      }));

      setChoreDrafts(drafts);
      setSelectedChoreDraftIds(
        drafts.reduce<Record<string, boolean>>((acc, d) => {
          acc[d.id] = true;
          return acc;
        }, {}),
      );

      setAgentSuccess(`Prepared ${actions.length} recommended chores for review.`);
    } finally {
      setAgentBusy(false);
    }
  }, [getAgentSetup]);

  const approveToolCall = useCallback(async (tc: ToolCall) => {
    try {
      setToolError(null);
      setToolSuccess(null);

      const { token, householdId } = getAgentSetup();
      if (!token || !householdId) {
        setToolError("Missing access_token or household_id. Click Agent Setup to confirm your session token + household id.");
        appendAssistantMessage("Missing access_token or household_id. Click Agent Setup to confirm your session token + household id.");
        return;
      }
      setToolBusy(true);
      const tcWithHousehold = withHouseholdId(tc, householdId);

    if (tcWithHousehold.tool === "db.insert" && (tcWithHousehold.args as any)?.table === "chores") {
      const record = (tcWithHousehold.args as any)?.record;
      if (record && typeof record === "object" && !Array.isArray(record)) {
        const storedDueAt = typeof (threadAnswers as any)?.due_at === "string" ? String((threadAnswers as any).due_at).trim() : "";
        const storedSpacesRaw = (threadAnswers as any)?.spaces;
        const storedSpaces = Array.isArray(storedSpacesRaw)
          ? storedSpacesRaw.map(String).map((s) => s.trim()).filter(Boolean)
          : [];

        const existingDueAt = typeof (record as any).due_at === "string" ? String((record as any).due_at).trim() : "";
        if (!existingDueAt && storedDueAt) {
          (record as any).due_at = storedDueAt;
        }
        // If scheduling intent exists anywhere in the recent user window, require explicit date/time.
        // This prevents the model from inventing a due_at.
        if (recentWantsSchedule && !hasAnyExplicitDatetime) {
          if (storedDueAt) {
            (record as any).due_at = storedDueAt;
          } else {
          setToolBusy(false);
          setScheduleDialogError(null);
          setScheduleDialogValue("");
          const dflt = defaultScheduleDateTimeLocal();
          setScheduleDialogDate(dflt.date);
          setScheduleDialogTime(dflt.time);
          setSchedulePendingToolCall(tcWithHousehold);
          setScheduleDialogOpen(true);
          return;
          }
        }
        const spaces = await ensureHomeSpacesForValidation(householdId);
        const ambiguous = detectAmbiguousAreaChoreClient(record as Record<string, unknown>, spaces);
        if (!ambiguous.ok) {
          const amb = ambiguous as { ok: false; error: string; title: string; options: string[] };
          openSpaceClarification({
            title: amb.title,
            options: amb.title.toLowerCase().includes("bathroom") ? ["All bathrooms", ...amb.options] : amb.options,
            onSelect: async (space) => {
              if (threadKey) {
                const sels = String(space)
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                setThreadAnswer(threadKey, { spaces: sels });
              }
              const args = (tcWithHousehold.args ?? {}) as any;
              const rec = args?.record && typeof args.record === "object" && !Array.isArray(args.record) ? args.record : {};
              const meta = rec?.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata) ? { ...rec.metadata } : {};
              const patchedTc: ToolCall = {
                ...tcWithHousehold,
                args: {
                  ...args,
                  record: {
                    ...rec,
                    metadata: { ...meta, space },
                  },
                },
              };
              setSpaceClarifyOpen(false);
              setSpaceClarifyPending(null);
              setToolBusy(true);
              const res = await executeToolCall({
                accessToken: token,
                householdId,
                scope: memoryScope,
                toolCall: patchedTc,
              });
              setToolBusy(false);
              if (!res.ok) {
                setToolError("error" in res ? res.error : t("chat.tool_execution_failed"));
                return;
              }
              if (threadKey) setToolCallApproved(threadKey, toolCallDedupeKey(tc));
              setToolSuccess(t("chat.executed_tool").replace("{tool}", patchedTc.tool));
              appendAssistantMessage(res.summary);
            },
          });
          return;
        }
      }
    }

      let res = await executeToolCall({
        accessToken: token,
        householdId,
        scope: memoryScope,
        toolCall: tcWithHousehold,
      });

      if (!res.ok) {
        const status = "status" in res ? res.status : undefined;
        if (status === 403 && authedAccessToken.trim()) {
          try {
            await refreshHouseholdId();
          } catch {
            // ignore
          }
          const next = getAgentSetup();
          if (next.token && next.householdId && next.householdId !== householdId) {
            const retryTc = withHouseholdId(tc, next.householdId);
            res = await executeToolCall({
              accessToken: next.token,
              householdId: next.householdId,
              scope: memoryScope,
              toolCall: retryTc,
            });
          }
        }
      }
      setToolBusy(false);
      if (!res.ok) {
        const msg = "error" in res ? res.error : t("chat.tool_execution_failed");
        setToolError(msg);
        appendAssistantMessage(`⚠️ ${msg}`);
        return;
      }
      if (threadKey) setToolCallApproved(threadKey, toolCallDedupeKey(tc));
      setToolSuccess(t("chat.executed_tool").replace("{tool}", tc.tool));
      appendAssistantMessage(res.summary);
    } catch (e) {
      setToolBusy(false);
      const msg = e instanceof Error ? e.message : "Unknown error approving tool";
      console.error("approveToolCall failed", e);
      setToolError(msg);
      appendAssistantMessage(`⚠️ ${msg}`);
    }
  }, [memoryScope, appendAssistantMessage, refreshHouseholdId, authedAccessToken, ensureHomeSpacesForValidation, openSpaceClarification, t, recentWantsSchedule, userProvidedExplicitDatetime, threadAnswers, threadKey, setToolCallApproved, setThreadAnswer]);

  const runSemanticReindex = useCallback(async () => {
    setSemanticDebugError(null);
    setSemanticDebugBusy(true);
    try {
      const { token, householdId } = getAgentSetup();
      if (!token || !householdId) {
        setSemanticDebugError("Missing access_token or household_id. Click Agent Setup to confirm your session.");
        return;
      }
      const res = await semanticReindex({ accessToken: token, householdId, entityTypes: ["chores", "helpers", "alerts"] });
      if (!res.ok) {
        setSemanticDebugError("error" in res ? res.error : "Semantic reindex failed.");
        return;
      }
      setSemanticDebugLastReindex(`Indexed ${res.indexed} rows in ${res.batches} batches.`);
      appendAssistantMessage(`Semantic reindex complete. Indexed ${res.indexed} rows.`);
    } finally {
      setSemanticDebugBusy(false);
    }
  }, [appendAssistantMessage, getAgentSetup]);

  const runSemanticSearch = useCallback(async () => {
    setSemanticDebugError(null);
    setSemanticDebugBusy(true);
    try {
      const { token, householdId } = getAgentSetup();
      if (!token || !householdId) {
        setSemanticDebugError("Missing access_token or household_id. Click Agent Setup to confirm your session.");
        return;
      }
      const q = semanticDebugQuery.trim();
      if (!q) {
        setSemanticDebugError("Enter a query first.");
        return;
      }
      const res = await semanticSearch({
        accessToken: token,
        householdId,
        query: q,
        entityTypes: ["chores", "helpers", "alerts"],
        matchCount: 10,
        minSimilarity: 0.15,
      });
      if (!res.ok) {
        setSemanticDebugError("error" in res ? res.error : "Semantic search failed.");
        return;
      }
      setSemanticDebugMatches(res.matches as any[]);

      const lines = (res.matches ?? []).slice(0, 10).map((m: any) => {
        const et = typeof m?.entity_type === "string" ? m.entity_type : "";
        const title = typeof m?.title === "string" ? m.title : "";
        const sim = typeof m?.similarity === "number" ? m.similarity.toFixed(3) : "";
        return `- [${et}] ${title}${sim ? ` (sim=${sim})` : ""}`;
      });
      appendAssistantMessage(lines.length > 0 ? `Top semantic matches for "${q}":\n${lines.join("\n")}` : `No semantic matches for "${q}".`);
    } finally {
      setSemanticDebugBusy(false);
    }
  }, [appendAssistantMessage, getAgentSetup, semanticDebugQuery]);

  const confirmScheduleDialog = useCallback(async () => {
    const pending = schedulePendingToolCall;
    const rawFromField = scheduleDialogValue.trim();
    let raw = rawFromField;
    if (!raw) {
      const d = (scheduleDialogDate || "").trim();
      const t = (scheduleDialogTime || "").trim();
      if (!d || !t) {
        setScheduleDialogError("Please choose a date and time.");
        return;
      }
      raw = `${d}T${t}`;
    }
    const pendingDraftIds = schedulePendingDraftIds;
    const isClarificationFlow = Boolean(
      (pendingClarification && (pendingClarification.kind === "schedule" || pendingClarification.kind === "space_selection")) ||
        proposedClarification?.kind === "schedule",
    );
    if (!pending && (!pendingDraftIds || pendingDraftIds.length === 0) && !isClarificationFlow) {
      setScheduleDialogOpen(false);
      return;
    }
    if (!raw) {
      setScheduleDialogError("Please choose a date and time.");
      return;
    }
    const normalized = normalizeDatetimeLocal(raw);
    if (!normalized) {
      setScheduleDialogError("Please choose a valid date and time.");
      return;
    }

    if (threadKey) setThreadAnswer(threadKey, { due_at: normalized });

    setScheduleDialogOpen(false);
    setScheduleDialogError(null);
    setScheduleDialogValue("");
    setScheduleDialogDate("");
    setScheduleDialogTime("");
    setSchedulePendingToolCall(null);
    setSchedulePendingDraftIds(null);
    const clarificationSnapshot = pendingClarificationRef.current;
    if (proposedClarification?.kind === "schedule" && proposedClarificationKey) {
      dismissedClarificationKeyRef.current = proposedClarificationKey;
      if (threadKey) setDismissedClarificationKey(threadKey, proposedClarificationKey);
    } else {
      dismissedClarificationKeyRef.current = null;
      if (threadKey) setDismissedClarificationKey(threadKey, null);
    }

    // If this schedule dialog was opened by orchestrator clarification, respond via structured clarification_response.
    if (isClarificationFlow) {
      const spaces = (clarificationSnapshot?.spaces ?? []).map((s) => String(s).trim()).filter(Boolean);
      // Keep due_at in state so that if the assistant asks a follow-up space selection question,
      // we can include the schedule and avoid reopening the schedule picker.
      setPendingClarification({ kind: "schedule", spaces, due_at: normalized });
      const resp: any = { due_at: normalized };
      if (spaces.length > 0) resp.spaces = spaces;
      sendMessage(JSON.stringify({ clarification_response: resp }), { silent: true, allowWhileStreaming: true });
      return;
    }

    if (pendingDraftIds && pendingDraftIds.length > 0) {
      setChoreDrafts((prev) =>
        prev.map((d) =>
          pendingDraftIds.includes(d.id)
            ? {
                ...d,
                action: {
                  ...d.action,
                  record: {
                    ...d.action.record,
                    due_at: normalized,
                  },
                },
              }
            : d,
        ),
      );
      return;
    }

    const args: any = pending.args ?? {};
    const rec = args?.record && typeof args.record === "object" && !Array.isArray(args.record) ? args.record : {};
    const patched: ToolCall = {
      ...pending,
      args: {
        ...args,
        record: {
          ...rec,
          due_at: normalized,
        },
      },
    };
    await approveToolCall(patched);
  }, [approveToolCall, scheduleDialogValue, scheduleDialogDate, scheduleDialogTime, schedulePendingToolCall, schedulePendingDraftIds, pendingClarification, sendMessage, proposedClarification, proposedClarificationKey, threadKey, setThreadAnswer]);

  const executeReadOnlyToolCall = useCallback(async (tc: ToolCall) => {
    const isReadOnlyRpc = (v: ToolCall): boolean => {
      if (v.tool !== "query.rpc") return false;
      const nm = (v.args as any)?.name;
      return (
        nm === "resolve_helper" ||
        nm === "resolve_space" ||
        nm === "count_chores_assigned_to" ||
        nm === "count_chores" ||
        nm === "group_chores_by_status" ||
        nm === "group_chores_by_assignee" ||
        nm === "list_chores_enriched"
      );
    };

    if (tc.tool !== "db.select" && !isReadOnlyRpc(tc)) return;

    if (tc.tool === "db.select") {
      const table = typeof (tc.args as any)?.table === "string" ? String((tc.args as any).table) : "";
      const allowlistedTables = new Set<string>(["chores", "helpers", "alerts", "automations", "automation_suggestions", "home_profiles"]);
      if (table && !allowlistedTables.has(table)) return;
    }

    const key = toolCallKey(tc);
    if (autoExecutedToolCallIds[key]) return;

    setToolError(null);
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) return;

    setAutoExecutedToolCallIds((prev) => ({ ...prev, [key]: true }));

    const tcWithHousehold = withHouseholdId(tc, householdId);
    const res = await executeToolCall({
      accessToken: token,
      householdId,
      scope: memoryScope,
      toolCall: tcWithHousehold,
    });

    if (!res.ok) {
      setToolError("error" in res ? res.error : t("chat.could_not_fetch"));
      try {
        const msg = "error" in res ? res.error : t("chat.could_not_fetch");
        appendAssistantMessage(`⚠️ ${msg}`);
      } catch {
        // ignore
      }
      setAutoExecutedToolCallIds((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }

    appendAssistantMessage(res.summary);
  }, [autoExecutedToolCallIds, memoryScope, appendAssistantMessage, toolCallKey]);

  useEffect(() => {
    if (isStreaming) return;
    if (proposedToolCalls.length === 0) return;
    // New tool call set from assistant — allow selects to run again even if Sarvam reuses ids like tc_1.
    setAutoExecutedToolCallIds({});
  }, [isStreaming, latestAssistantText]);

  // Orchestrator clarification handling: open the right UI when agent-service emits a structured clarification.
  // Skip in onboarding mode — the inline forms handle all structured input.
  useEffect(() => {
    if (isOnboarding) return;
    if (isStreaming) return;
    if (!proposedClarification) return;

    let clarificationKey = "";
    try {
      clarificationKey = JSON.stringify(proposedClarification);
    } catch {
      clarificationKey = String(proposedClarification.kind ?? "");
    }
    if (dismissedClarificationKeyRef.current && dismissedClarificationKeyRef.current === clarificationKey) return;

    const storedDueAt = typeof (threadAnswers as any)?.due_at === "string" ? String((threadAnswers as any).due_at).trim() : "";
    const storedSpacesRaw = (threadAnswers as any)?.spaces;
    const storedSpaces = Array.isArray(storedSpacesRaw)
      ? storedSpacesRaw.map(String).map((s) => s.trim()).filter(Boolean)
      : [];

    if (proposedClarification.kind === "space_selection") {
      if (storedSpaces.length > 0) {
        const resp: any = { spaces: storedSpaces };
        if (storedDueAt) resp.due_at = storedDueAt;
        if (clarificationKey) {
          dismissedClarificationKeyRef.current = clarificationKey;
          if (threadKey) setDismissedClarificationKey(threadKey, clarificationKey);
        }
        sendMessage(JSON.stringify({ clarification_response: resp }), { silent: true, allowWhileStreaming: true });
        return;
      }
      if (spaceClarifyOpen && openedSpaceClarificationKeyRef.current === clarificationKey) return;

      const optionsRaw = Array.isArray(proposedClarification.options) ? proposedClarification.options.map(String).filter(Boolean) : [];
      const optionsClean = sanitizeClarificationOptions(optionsRaw);
      const title = proposedClarification.title || "Choose spaces";
      const options = filterBathroomOptionsIfNeeded(optionsClean, title);
      if (options.length === 0) return;

      const inferred = inferSpaceFromText(options, latestUserText);
      if (inferred) {
        const resp: any = { spaces: [inferred] };
        const dueAt = pendingClarificationRef.current?.due_at;
        if (dueAt) resp.due_at = dueAt;
        if (threadKey) setThreadAnswer(threadKey, { spaces: [inferred] });
        if (clarificationKey) {
          dismissedClarificationKeyRef.current = clarificationKey;
          if (threadKey) setDismissedClarificationKey(threadKey, clarificationKey);
        }
        sendMessage(JSON.stringify({ clarification_response: resp }), { silent: true, allowWhileStreaming: true });
        return;
      }

      openedSpaceClarificationKeyRef.current = clarificationKey;
      setPendingClarification((prev) =>
        prev?.kind === "space_selection"
          ? prev
          : {
              kind: "space_selection",
              spaces: prev?.spaces ?? [],
              due_at: prev?.due_at,
            },
      );
      openSpaceClarification({
        title,
        options,
        multi: Boolean(proposedClarification.multi ?? true),
        onSelect: async (sel) => {
          const sels = String(sel)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          setPendingClarification((prev) => ({ kind: "space_selection", spaces: sels, due_at: prev?.due_at }));
          if (threadKey) setThreadAnswer(threadKey, { spaces: sels });
          // If we already have due_at, respond immediately. Otherwise, wait for schedule clarification.
          const dueAt = pendingClarificationRef.current?.due_at;
          if (dueAt) {
            sendMessage(JSON.stringify({ clarification_response: { spaces: sels, due_at: dueAt } }), { silent: true, allowWhileStreaming: true });
          } else {
            sendMessage(JSON.stringify({ clarification_response: { spaces: sels } }), { silent: true, allowWhileStreaming: true });
          }

          // Dismiss this clarification so it doesn't reopen while the assistant text remains the same.
          if (clarificationKey) {
            dismissedClarificationKeyRef.current = clarificationKey;
            if (threadKey) setDismissedClarificationKey(threadKey, clarificationKey);
          }

          // Close the dialog after selection and clear pending clarification state.
          setSpaceClarifyOpen(false);
          setSpaceClarifyPending(null);
          setSpaceClarifyError(null);
          setSpaceClarifySelection([]);
          setPendingClarification(null);
          openedSpaceClarificationKeyRef.current = null;
        },
      });
      return;
    }

    if (proposedClarification.kind === "schedule") {
      const existingDueAt = pendingClarificationRef.current?.due_at || storedDueAt;
      if (existingDueAt) {
        const spaces = ((pendingClarificationRef.current?.spaces ?? []).length > 0 ? pendingClarificationRef.current?.spaces : storedSpaces)
          ?.map((s) => String(s).trim())
          .filter(Boolean);
        const resp: any = { due_at: existingDueAt };
        if (spaces.length > 0) resp.spaces = spaces;
        if (clarificationKey) {
          dismissedClarificationKeyRef.current = clarificationKey;
          if (threadKey) setDismissedClarificationKey(threadKey, clarificationKey);
        }
        sendMessage(JSON.stringify({ clarification_response: resp }), { silent: true, allowWhileStreaming: true });
        return;
      }

      // If the dialog is already open, don't reset the user's in-progress input even if the assistant text is still streaming.
      if (scheduleDialogOpen) return;

      openedScheduleClarificationKeyRef.current = clarificationKey;
      setPendingClarification((prev) =>
        prev?.kind === "schedule"
          ? prev
          : {
              kind: "schedule",
              spaces: prev?.spaces ?? [],
              due_at: prev?.due_at,
            },
      );
      setScheduleDialogError(null);
      setScheduleDialogValue("");
      const dflt = defaultScheduleDateTimeLocal();
      setScheduleDialogDate(dflt.date);
      setScheduleDialogTime(dflt.time);
      setSchedulePendingToolCall(null);
      setSchedulePendingDraftIds(null);
      setScheduleDialogOpen(true);
      return;
    }
  }, [isStreaming, proposedClarification, openSpaceClarification, sendMessage, pendingClarification, scheduleDialogOpen, scheduleDialogDate, scheduleDialogTime, threadAnswers, threadKey, setDismissedClarificationKey, setThreadAnswer]);

  // Fallback: if the model asks for space selection in plain English (without structured clarification JSON),
  // detect the "Available options:" pattern and show the multi-select dialog.
  useEffect(() => {
    if (isStreaming) return;
    if (proposedClarification) return;
    if (spaceClarifyOpen) return;

    const text = String(latestAssistantText || "");
    if (!text.trim()) return;

    const match = text.match(/Available options:\s*([\s\S]*?)(?:\.|\n)/i);
    if (!match) return;

    const raw = String(match[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const options = sanitizeClarificationOptions(raw);
    if (options.length === 0) return;

    const multi = /select\s+all\s+that\s+apply/i.test(text) || /select\s+all\s+that\s+are\s+relevant/i.test(text);
    const title = text.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "Choose spaces";

    setPendingClarification({ kind: "space_selection", spaces: [], due_at: undefined });
    openSpaceClarification({
      title,
      options: filterBathroomOptionsIfNeeded(options, title),
      multi,
      onSelect: async (sel) => {
        // Send a normal user-visible response (not JSON) to satisfy plain-English questions.
        await sendMessage(String(sel));
      },
    });
  }, [isStreaming, proposedClarification, spaceClarifyOpen, latestAssistantText, openSpaceClarification, sendMessage]);

  useEffect(() => {
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) return;
    // Auto-run at most one read-only tool call per assistant turn.
    const isReadOnlyRpc = (v: ToolCall): boolean => {
      if (v.tool !== "query.rpc") return false;
      const nm = (v.args as any)?.name;
      return (
        nm === "resolve_helper" ||
        nm === "resolve_space" ||
        nm === "count_chores_assigned_to" ||
        nm === "count_chores" ||
        nm === "group_chores_by_status" ||
        nm === "group_chores_by_assignee" ||
        nm === "list_chores_enriched"
      );
    };

    const firstRead = proposedToolCalls.find((tc) => tc.tool === "db.select" || isReadOnlyRpc(tc));
    if (firstRead) void executeReadOnlyToolCall(firstRead);
  }, [proposedToolCalls, executeReadOnlyToolCall, getAgentSetup]);

  const confirmClearChat = useCallback(() => {
    setClearChatConfirmOpen(false);
    clearHistory();
  }, [clearHistory]);

  return (
    <Stack sx={{ height: "100%", overflow: "hidden" }}>
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="flex-end"
        sx={{ mb: 2.5, flexShrink: 0 }}
      >
        <Box>
          <Typography variant="h5" fontWeight={700} lineHeight={1.2}>
            Chat Assistant
          </Typography>
          <Typography variant="body2" color="text.secondary" mt={0.25}>
            Use natural language to manage your household
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} alignItems="center">
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>Memory</InputLabel>
            <Select
              value={memoryScope}
              label="Memory"
              onChange={(e) => setMemoryScope(e.target.value === "household" ? "household" : "user")}
            >
              <MenuItem value="user">Personal</MenuItem>
              <MenuItem value="household">Household</MenuItem>
            </Select>
          </FormControl>

          {/* Language / STT picker */}
          <ToggleButtonGroup
            value={lang}
            exclusive
            onChange={handleLangChange}
            size="small"
            aria-label="Speech recognition language"
            sx={{ height: 32 }}
          >
            {(Object.keys(LANG_LABELS) as SpeechLang[]).map((l) => (
              <ToggleButton
                key={l}
                value={l}
                aria-label={l}
                sx={{ px: 1.5, fontSize: "0.72rem", fontWeight: 600, lineHeight: 1 }}
              >
                {LANG_LABELS[l]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <Button
            size="small"
            variant="outlined"
            disabled={isStreaming}
            onClick={() => setClearChatConfirmOpen(true)}
            sx={{ textTransform: "none" }}
          >
            Clear Chat
          </Button>

          <Button
            size="small"
            variant={showSemanticDebug ? "contained" : "outlined"}
            onClick={() => setShowSemanticDebug((prev) => !prev)}
            sx={{ textTransform: "none" }}
          >
            Debug
          </Button>
        </Stack>
      </Stack>

      {/* ── API key / error banners ───────────────────────────────────────── */}
      <Collapse in={!hasKey}>
        <Alert severity="info" sx={{ mb: 1.5, fontSize: "0.8rem" }}>
          Demo mode — add <strong>VITE_SARVAM_API_KEY</strong> to your{" "}
          <code>.env</code> file to enable full AI responses.
        </Alert>
      </Collapse>
      <Collapse in={!memoryReady}>
        <Alert severity="info" sx={{ mb: 1.5, fontSize: "0.8rem" }}>
          Loading long-term memory…
        </Alert>
      </Collapse>
      <Collapse in={!!homeProfileError}>
        <Alert
          severity="error"
          sx={{ mb: 1.5, fontSize: "0.8rem" }}
          action={
            <Button
              size="small"
              color="inherit"
              onClick={() => setAgentDialogOpen(true)}
              sx={{ textTransform: "none" }}
            >
              Open Agent Setup
            </Button>
          }
        >
          {homeProfileError}
        </Alert>
      </Collapse>
      <Collapse in={!!chatError}>
        <Alert
          severity="error"
          sx={{ mb: 1.5, fontSize: "0.8rem" }}
          action={
            <Button
              size="small"
              color="inherit"
              onClick={() => setAgentDialogOpen(true)}
              sx={{ textTransform: "none" }}
            >
              Open Agent Setup
            </Button>
          }
        >
          {chatError}
        </Alert>
      </Collapse>
      <Collapse in={!!sttError}>
        <Alert severity="warning" onClose={() => setSttError(null)} sx={{ mb: 1.5, fontSize: "0.8rem" }}>
          {sttError}
        </Alert>
      </Collapse>

      {false && (
        <Dialog
          open={spaceClarifyOpen}
          onClose={() => {
            setSpaceClarifyOpen(false);
            setSpaceClarifyPending(null);
            setSpaceClarifyError(null);
            setSpaceClarifySelection([]);
          }}
          maxWidth="xs"
          fullWidth
        />
      )}

      {false && (
        <Dialog
          open={scheduleDialogOpen}
          onClose={() => {
            setScheduleDialogOpen(false);
            openedScheduleClarificationKeyRef.current = null;
            setSchedulePendingToolCall(null);
            setSchedulePendingDraftIds(null);
            setScheduleDialogError(null);
            setScheduleDialogValue("");
            setScheduleDialogDate("");
            setScheduleDialogTime("");
            setPendingClarification(null);
            if (proposedClarification?.kind === "schedule" && proposedClarificationKey) {
              dismissedClarificationKeyRef.current = proposedClarificationKey;
              if (threadKey) setDismissedClarificationKey(threadKey, proposedClarificationKey);
            }
          }}
        />
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <Stack
        direction={props.embedded ? "column" : "row"}
        spacing={2}
        sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      >
        {/* Chat panel */}
        <Paper
          variant="outlined"
          sx={{
            flex: props.embedded ? 1 : 2,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRadius: "12px",
          }}
        >
          {/* Chat header */}
          <Stack
            direction="row"
            alignItems="center"
            spacing={1.5}
            sx={{
              px: 2,
              py: 1.5,
              borderBottom: "1px solid",
              borderColor: "divider",
              flexShrink: 0,
            }}
          >
            <Avatar sx={{ width: 34, height: 34, bgcolor: "primary.main" }}>
              <SmartToy sx={{ fontSize: 19 }} />
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle1" fontWeight={600} lineHeight={1.2}>
                Home Assistant
              </Typography>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  Powered by Sarvam AI
                </Typography>
                {sttMode === "sarvam" && voiceSupported && (
                  <Tooltip title="Using Sarvam Saaras v3 for voice transcription">
                    <GraphicEq sx={{ fontSize: 13, color: "primary.main" }} />
                  </Tooltip>
                )}
              </Stack>
            </Box>
            <Chip
              label={hasKey ? "AI Connected" : "Demo Mode"}
              size="small"
              color={hasKey ? "success" : "default"}
              variant="outlined"
              sx={{ fontSize: "0.7rem", height: 22 }}
            />

            {props.embedded ? (
              <Tooltip title={drawerQuickCommandsOpen ? "Hide quick commands" : "Show quick commands"}>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => setDrawerQuickCommandsOpen((v) => !v)}
                  aria-label={drawerQuickCommandsOpen ? "Hide quick commands" : "Show quick commands"}
                  startIcon={drawerQuickCommandsOpen ? <ExpandLess fontSize="small" /> : <Bolt fontSize="small" />}
                  sx={{ textTransform: "none", px: 1, minWidth: 0, ml: 0.5 }}
                >
                  Quick commands
                </Button>
              </Tooltip>
            ) : null}

            <IconButton
              size="small"
              onClick={(e) => openAccountMenu(e.currentTarget)}
              sx={{ ml: 0.5 }}
              aria-label="Account"
            >
              <Avatar sx={{ width: 28, height: 28, bgcolor: "grey.200", color: "text.primary" }}>
                <Person sx={{ fontSize: 18 }} />
              </Avatar>
            </IconButton>
          </Stack>

          {props.embedded ? (
            <Collapse in={drawerQuickCommandsOpen} timeout="auto" unmountOnExit>
              <Box sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
                <QuickActionsPanel
                  onQuickAction={handleQuickAction}
                  onCreateHomeProfile={openHomeProfileWizard}
                  onReviewHomeProfile={reviewHomeProfile}
                  onGenerateCoverage={ENABLE_COVERAGE_EXPERIMENT ? () => setCoverageExperimentOpen(true) : undefined}
                  onRecommendChores={ENABLE_CHORE_RECS_EXPERIMENT ? () => void generateRecommendedChores() : undefined}
                  homeProfileExists={homeProfileExists}
                  alertCount={3}
                  defaultQuickCommandsCollapsed
                  storageKey="homeops.chat.drawer.quick_commands_panel_open"
                />
              </Box>
            </Collapse>
          ) : null}

          <Menu anchorEl={accountAnchorEl} open={accountMenuOpen} onClose={closeAccountMenu}>
            <MenuItem
              disabled={isStreaming}
              onClick={() => {
                closeAccountMenu();
                setClearChatConfirmOpen(true);
              }}
            >
              Clear Chat
            </MenuItem>
            <MenuItem
              onClick={() => {
                closeAccountMenu();
                setProfileDialogOpen(true);
                void loadProfile();
              }}
            >
              <Person fontSize="small" style={{ marginRight: 8 }} />
              Profile
            </MenuItem>
            <MenuItem
              onClick={() => {
                closeAccountMenu();
                setFeedbackDialogOpen(true);
                setFeedbackError(null);
                setFeedbackSuccess(null);
              }}
            >
              <FeedbackIcon fontSize="small" style={{ marginRight: 8 }} />
              Send feedback
            </MenuItem>
            <MenuItem
              onClick={async () => {
                closeAccountMenu();
                await signOut();
                navigate("/login", { replace: true });
              }}
            >
              <Logout fontSize="small" style={{ marginRight: 8 }} />
              Logout
            </MenuItem>
          </Menu>

          <Dialog open={clearChatConfirmOpen} onClose={() => setClearChatConfirmOpen(false)}>
            <DialogTitle>Clear chat?</DialogTitle>
            <DialogContent>
              <Typography variant="body2">
                This will reset the current chat history in this browser session.
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setClearChatConfirmOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="contained" color="error" onClick={confirmClearChat}>
                Clear Chat
              </Button>
            </DialogActions>
          </Dialog>

          {/* Messages area */}
          <Box
            ref={messagesScrollRef}
            sx={{
              flex: 1,
              overflowY: "auto",
              px: 2,
              py: 2,
              minHeight: 0,
              "&::-webkit-scrollbar": { width: 4 },
              "&::-webkit-scrollbar-track": { bgcolor: "transparent" },
              "&::-webkit-scrollbar-thumb": {
                bgcolor: "grey.300",
                borderRadius: "4px",
              },
            }}
          >
            {messages.map((msg) => (
              <MessageBubble key={msg.id} {...msg} />
            ))}

            {scheduleDialogOpen && (
              <Paper ref={scheduleCardRef} variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 2, maxWidth: 520 }}>
                <Stack spacing={1.25}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    When should I schedule this?
                  </Typography>
                  {scheduleDialogError ? <Alert severity="error">{scheduleDialogError}</Alert> : null}
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                    <TextField
                      label="Date"
                      type="date"
                      value={scheduleDialogDate}
                      onChange={(e) => {
                        setScheduleDialogDate(normalizeScheduleDateInput(e.target.value));
                        setScheduleDialogValue("");
                      }}
                      size="small"
                      fullWidth
                      InputLabelProps={{ shrink: true }}
                      autoFocus
                    />
                    <TextField
                      label="Time"
                      type="time"
                      value={scheduleDialogTime}
                      onChange={(e) => {
                        setScheduleDialogTime(normalizeScheduleTimeInput(e.target.value));
                        setScheduleDialogValue("");
                      }}
                      size="small"
                      fullWidth
                      InputLabelProps={{ shrink: true }}
                      inputProps={{ step: 300 }}
                    />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}
                  </Typography>
                  <Stack direction="row" justifyContent="flex-end" spacing={1}>
                    <Button
                      onClick={() => {
                        setScheduleDialogOpen(false);
                        openedScheduleClarificationKeyRef.current = null;
                        setSchedulePendingToolCall(null);
                        setSchedulePendingDraftIds(null);
                        setScheduleDialogError(null);
                        setScheduleDialogValue("");
                        setScheduleDialogDate("");
                        setScheduleDialogTime("");
                        setPendingClarification(null);
                        if (proposedClarification?.kind === "schedule" && proposedClarificationKey) {
                          dismissedClarificationKeyRef.current = proposedClarificationKey;
                          if (threadKey) setDismissedClarificationKey(threadKey, proposedClarificationKey);
                        }
                      }}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="contained"
                      onClick={() => {
                        if (clientChoreSession.phase === "need_schedule") {
                          void confirmClientSchedule(scheduleDialogValue, scheduleDialogDate, scheduleDialogTime);
                          return;
                        }
                        void confirmScheduleDialog();
                      }}
                    >
                      Apply
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            )}

            {showSemanticDebug && (
              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 2, maxWidth: 520 }}>
                <Stack spacing={1.25}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    Semantic search (debug)
                  </Typography>
                  {semanticDebugError ? <Alert severity="error">{semanticDebugError}</Alert> : null}
                  {semanticDebugLastReindex ? (
                    <Typography variant="caption" color="text.secondary">
                      {semanticDebugLastReindex}
                    </Typography>
                  ) : null}
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                    <Button variant="outlined" disabled={semanticDebugBusy} onClick={() => void runSemanticReindex()}>
                      Re-index
                    </Button>
                    <TextField
                      value={semanticDebugQuery}
                      onChange={(e) => setSemanticDebugQuery(e.target.value)}
                      placeholder="Search chores/helpers/alerts..."
                      size="small"
                      fullWidth
                    />
                    <Button variant="contained" disabled={semanticDebugBusy} onClick={() => void runSemanticSearch()}>
                      Search
                    </Button>
                  </Stack>
                  {semanticDebugMatches.length > 0 ? (
                    <Stack spacing={0.5}>
                      {semanticDebugMatches.slice(0, 5).map((m: any, idx: number) => (
                        <Typography key={idx} variant="caption" sx={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                          [{String(m?.entity_type ?? "")}] {String(m?.title ?? "")} (sim={typeof m?.similarity === "number" ? m.similarity.toFixed(3) : ""})
                        </Typography>
                      ))}
                    </Stack>
                  ) : null}
                </Stack>
              </Paper>
            )}

            {clientChoreSession.phase === "need_approval" && clientChoreSession.toolCall && (
              <Paper ref={approvalCardRef} variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 2, maxWidth: 520 }}>
                <Stack spacing={1.25}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    Review & approve
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                    {clientChoreSession.requestText}
                  </Typography>
                  {(() => {
                    const args: any = clientChoreSession.toolCall?.args ?? {};
                    const rec: any = args?.record ?? {};
                    const meta: any = rec?.metadata ?? {};
                    const space = typeof meta?.space === "string" ? meta.space : "";
                    const dueAt = typeof rec?.due_at === "string" ? rec.due_at : "";
                    const secondary = `${space ? `space=${space}` : ""}${space && dueAt ? " · " : ""}${dueAt ? `due=${dueAt}` : ""}`.trim();
                    return secondary ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", whiteSpace: "normal", wordBreak: "break-word" }}>
                        {secondary}
                      </Typography>
                    ) : null;
                  })()}
                  {toolError ? <Alert severity="error">{toolError}</Alert> : null}
                  {toolSuccess ? <Alert severity="success">{toolSuccess}</Alert> : null}
                  <Stack direction="row" justifyContent="flex-end" spacing={1}>
                    <Button
                      onClick={() => {
                        dispatchClientChore({ type: "RESET" });
                      }}
                      disabled={toolBusy}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="contained"
                      disabled={toolBusy}
                      onClick={() => void approveClientChore()}
                    >
                      {t("chat.approve")}
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            )}

            {deleteChoresFlow.phase === "awaiting_confirm" && (
              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 2, maxWidth: 520 }}>
                <Stack spacing={1.25}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    Delete chores (preview)
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                    About to delete {deleteChoresFlow.choreIds.length} {deleteChoresFlow.scope} chore{deleteChoresFlow.choreIds.length === 1 ? "" : "s"}.
                  </Typography>

                  <List dense sx={{ pt: 0, pb: 0 }}>
                    {(deleteChoresFlow.preview ?? []).slice(0, 10).map((c) => {
                      const secondary = `${c.status ? `status=${c.status}` : ""}${c.status && c.due_at ? " · " : ""}${c.due_at ? `due=${c.due_at}` : ""}`.trim();
                      return (
                        <ListItem key={c.id} disableGutters sx={{ px: 0 }}>
                          <ListItemText
                            primary={c.title}
                            secondary={secondary || undefined}
                            primaryTypographyProps={{ sx: { whiteSpace: "normal", wordBreak: "break-word" } }}
                            secondaryTypographyProps={{ sx: { whiteSpace: "normal", wordBreak: "break-word" } }}
                          />
                        </ListItem>
                      );
                    })}
                  </List>

                  {(deleteChoresFlow.preview ?? []).length > 10 ? (
                    <Typography variant="caption" color="text.secondary">
                      Showing 10 of {deleteChoresFlow.preview.length}.
                    </Typography>
                  ) : null}

                  {toolError ? <Alert severity="error">{toolError}</Alert> : null}
                  {toolSuccess ? <Alert severity="success">{toolSuccess}</Alert> : null}

                  <Stack direction="row" justifyContent="flex-end" spacing={1}>
                    <Button
                      onClick={() => {
                        setDeleteChoresFlowSynced({ phase: "idle" });
                        appendAssistantMessage("Cancelled — no chores were deleted.");
                      }}
                      disabled={toolBusy}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      color="error"
                      variant="contained"
                      disabled={toolBusy}
                      onClick={() => void runDeleteChores(deleteChoresFlow.scope, deleteChoresFlow.choreIds)}
                    >
                      Delete
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            )}

            {deleteChoresFlow.phase === "select_specific" && (
              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 2, maxWidth: 520 }}>
                <Stack spacing={1.25}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    Delete chores (select specific)
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                    Choose one or more chores below, then click Delete selected.
                  </Typography>

                  <List dense sx={{ pt: 0, pb: 0 }}>
                    {(deleteChoresFlow.preview ?? []).map((c) => {
                      const checked = Boolean((deleteChoresFlow.selectedIds as any)?.[c.id]);
                      const secondary = `${c.status ? `status=${c.status}` : ""}${c.status && c.due_at ? " · " : ""}${c.due_at ? `due=${c.due_at}` : ""}`.trim();
                      return (
                        <ListItem
                          key={c.id}
                          disableGutters
                          sx={{ px: 0 }}
                          secondaryAction={(
                            <Checkbox
                              edge="end"
                              checked={checked}
                              onChange={(_, next) => {
                                setDeleteChoresFlow((prev) => {
                                  if (!prev || (prev as any).phase !== "select_specific") return prev as any;
                                  const p = prev as ChatDeleteChoresSpecificFlow;
                                  const selected = { ...(p.selectedIds ?? {}) };
                                  if (next) selected[c.id] = true;
                                  else delete selected[c.id];
                                  const out = { ...p, selectedIds: selected };
                                  setDeleteChoresFlowSynced(out);
                                  return out;
                                });
                              }}
                            />
                          )}
                        >
                          <ListItemText
                            primary={c.title}
                            secondary={secondary || undefined}
                            primaryTypographyProps={{ sx: { whiteSpace: "normal", wordBreak: "break-word" } }}
                            secondaryTypographyProps={{ sx: { whiteSpace: "normal", wordBreak: "break-word" } }}
                          />
                        </ListItem>
                      );
                    })}
                  </List>

                  {toolError ? <Alert severity="error">{toolError}</Alert> : null}
                  {toolSuccess ? <Alert severity="success">{toolSuccess}</Alert> : null}

                  <Stack direction="row" justifyContent="flex-end" spacing={1}>
                    <Button
                      onClick={() => {
                        setDeleteChoresFlowSynced({ phase: "idle" });
                        appendAssistantMessage("Cancelled — no chores were deleted.");
                      }}
                      disabled={toolBusy}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      color="error"
                      variant="contained"
                      disabled={toolBusy || Object.keys(deleteChoresFlow.selectedIds ?? {}).length === 0}
                      onClick={() => {
                        const ids = Object.keys(deleteChoresFlow.selectedIds ?? {}).filter((id) => (deleteChoresFlow.selectedIds as any)[id]);
                        void runDeleteChores("all", ids);
                      }}
                    >
                      Delete selected
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            )}

            {spaceClarifyOpen && (
              <Paper ref={spaceCardRef} variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 2, maxWidth: 520 }}>
                <Stack spacing={1.25}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    {spaceClarifyTitle || "Choose a space"}
                  </Typography>
                  {spaceClarifyError ? <Alert severity="error">{spaceClarifyError}</Alert> : null}
                  <Autocomplete
                    options={spaceClarifyOptions}
                    multiple={spaceClarifyMulti}
                    value={spaceClarifySelection}
                    onChange={(_, v) => {
                      if (Array.isArray(v)) {
                        setSpaceClarifySelection(v.map(String));
                        return;
                      }
                      setSpaceClarifySelection(v ? [String(v)] : []);
                    }}
                    disableCloseOnSelect={spaceClarifyMulti}
                    renderOption={(props, option, state) => (
                      <li {...props}>
                        {spaceClarifyMulti ? <Checkbox size="small" checked={state.selected} /> : null}
                        <ListItemText primary={option} />
                      </li>
                    )}
                    renderInput={(params) => (
                      <TextField {...params} label={spaceClarifyMulti ? "Spaces" : "Space"} size="small" autoFocus />
                    )}
                  />
                  <Stack direction="row" justifyContent="flex-end" spacing={1}>
                    <Button
                      onClick={() => {
                        setSpaceClarifyOpen(false);
                        setSpaceClarifyPending(null);
                        setSpaceClarifyError(null);
                        setSpaceClarifySelection([]);
                      }}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="contained"
                      onClick={async () => {
                        const sels = (spaceClarifySelection ?? []).map((s) => String(s).trim()).filter(Boolean);
                        if (sels.length === 0) {
                          setSpaceClarifyError(spaceClarifyMulti ? "Please choose one or more spaces." : "Please choose a space.");
                          return;
                        }
                        if (!spaceClarifyPending) {
                          setSpaceClarifyOpen(false);
                          return;
                        }
                        try {
                          await spaceClarifyPending(spaceClarifyMulti ? sels.join(", ") : sels[0]);
                        } catch (e) {
                          setSpaceClarifyError(e instanceof Error ? e.message : "Couldn't apply the selection");
                        }
                      }}
                    >
                      Apply
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            )}

            {/* Proposed agent actions (from latest assistant message) */}
            {(!isStreaming || hasProposals) && hasProposals && (
              <Box sx={{ mt: 1.5, mb: 2 }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1 }}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    Proposed actions
                  </Typography>
                  <Button size="small" variant="outlined" onClick={() => setAgentDialogOpen(true)}>
                    Agent Setup
                  </Button>
                </Box>

                {agentError && (
                  <Alert severity="error" sx={{ mb: 1 }}>
                    {agentError}
                  </Alert>
                )}
                {agentSuccess && (
                  <Alert severity="success" sx={{ mb: 1 }}>
                    {agentSuccess}
                  </Alert>
                )}

                {toolError && (
                  <Alert severity="error" sx={{ mb: 1 }}>
                    {toolError}
                  </Alert>
                )}
                {toolSuccess && (
                  <Alert severity="success" sx={{ mb: 1 }}>
                    {toolSuccess}
                  </Alert>
                )}

                {homeProfileError && (
                  <Alert severity="error" sx={{ mb: 1 }}>
                    {homeProfileError}
                  </Alert>
                )}

                <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
                  <Button size="small" variant="outlined" disabled={homeProfileBusy} onClick={reviewHomeProfile}>
                    {t("chat.review_home_profile")}
                  </Button>
                </Stack>

                {helperLoadError && (
                  <Alert severity="warning" sx={{ mb: 1 }}>
                    {helperLoadError}
                  </Alert>
                )}

                {choreDrafts.length > 0 && (
                  <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 1.5 }}>
                    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} spacing={1} sx={{ mb: 1 }}>
                      <Box>
                        <Typography variant="body2" fontWeight={700}>
                          {t("chat.recommended_chores")}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t("chat.recommended_chores_help")}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={1} justifyContent="flex-end">
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() =>
                            setSelectedChoreDraftIds((prev) => {
                              const allSelected = choreDrafts.every((d) => prev[d.id] !== false);
                              const next: Record<string, boolean> = {};
                              for (const d of choreDrafts) next[d.id] = !allSelected;
                              return next;
                            })
                          }
                        >
                          {t("chat.toggle_all")}
                        </Button>
                        <Button size="small" variant="contained" disabled={agentBusy} onClick={submitChoreDrafts}>
                          {t("chat.submit")}
                        </Button>
                      </Stack>
                    </Stack>

                    <List dense disablePadding>
                      {choreDrafts.map((d) => {
                        const r = d.action.record as Record<string, unknown>;
                        const title = typeof r.title === "string" ? r.title : "";
                        const description = typeof r.description === "string" ? r.description : "";
                        const meta = r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : null;
                        const scheduleLabel = meta && typeof meta.schedule_label === "string" ? String(meta.schedule_label).trim() : "";
                        const cadenceLabel = meta
                          ? typeof meta.cadence === "string"
                            ? String(meta.cadence).trim()
                            : typeof meta.frequency === "string"
                              ? String(meta.frequency).trim()
                              : ""
                          : "";
                        const checked = selectedChoreDraftIds[d.id] !== false;
                        const preview = description.trim().length > 80 ? `${description.trim().slice(0, 80)}…` : description.trim();
                        const secondary = `${cadenceLabel ? `${cadenceLabel} · ` : ""}${scheduleLabel ? `${scheduleLabel} · ` : ""}${preview}`.trim();

                        return (
                          <ListItem
                            key={d.id}
                            disablePadding
                            secondaryAction={
                              <Stack direction="row" spacing={0.5}>
                                <IconButton size="small" onClick={() => setEditChoreDraftId(d.id)} aria-label="Edit">
                                  <Edit fontSize="small" />
                                </IconButton>
                                <IconButton
                                  size="small"
                                  color="error"
                                  onClick={() => {
                                    setChoreDrafts((prev) => prev.filter((x) => x.id !== d.id));
                                    setSelectedChoreDraftIds((prev) => {
                                      const next = { ...prev };
                                      delete next[d.id];
                                      return next;
                                    });
                                  }}
                                  aria-label="Remove"
                                >
                                  <Delete fontSize="small" />
                                </IconButton>
                              </Stack>
                            }
                          >
                            <ListItemButton
                              dense
                              onClick={() =>
                                setSelectedChoreDraftIds((prev) => ({
                                  ...prev,
                                  [d.id]: !(prev[d.id] !== false),
                                }))
                              }
                            >
                              <Checkbox edge="start" checked={checked} tabIndex={-1} disableRipple />
                              <ListItemText primary={title || "(Untitled)"} secondary={secondary || undefined} />
                            </ListItemButton>
                          </ListItem>
                        );
                      })}
                    </List>

                    <Dialog
                      open={!!editChoreDraftId}
                      onClose={() => setEditChoreDraftId(null)}
                      disableEnforceFocus
                      disableRestoreFocus
                      maxWidth="sm"
                      fullWidth
                    >
                      <DialogTitle>{t("chat.edit_chore")}</DialogTitle>
                      <DialogContent>
                        {(() => {
                          const d = choreDrafts.find((x) => x.id === editChoreDraftId);
                          if (!d) return null;
                          const r = d.action.record as Record<string, unknown>;
                          const title = typeof r.title === "string" ? r.title : "";
                          const description = typeof r.description === "string" ? r.description : "";
                          const dueAt = typeof r.due_at === "string" ? r.due_at : "";
                          const priority = asNumberOrNull(r.priority) ?? 1;
                          const helperId = typeof r.helper_id === "string" ? r.helper_id : "";
                          const meta = r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : null;
                          const cadence = meta && typeof meta.cadence === "string" ? String(meta.cadence) : "";
                          const helperValue = helperId && helpers.some((h) => h.id === helperId) ? helperId : "";
                          return (
                            <Stack spacing={1.5} mt={1}>
                              <TextField
                                label={t("chat.chore_title")}
                                value={title}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setChoreDrafts((prev) =>
                                    prev.map((x) =>
                                      x.id === d.id ? { ...x, action: { ...x.action, record: { ...x.action.record, title: v } } } : x,
                                    ),
                                  );
                                }}
                                fullWidth
                                size="small"
                              />
                              <TextField
                                label={t("chat.chore_description")}
                                value={description}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setChoreDrafts((prev) =>
                                    prev.map((x) =>
                                      x.id === d.id
                                        ? { ...x, action: { ...x.action, record: { ...x.action.record, description: v } } }
                                        : x,
                                    ),
                                  );
                                }}
                                fullWidth
                                size="small"
                                multiline
                                minRows={3}
                              />
                              <FormControl fullWidth size="small">
                                <InputLabel>{t("chat.frequency")}</InputLabel>
                                <Select
                                  value={cadence}
                                  label={t("chat.frequency")}
                                  onChange={(e) => {
                                    const v = String(e.target.value);
                                    setChoreDrafts((prev) =>
                                      prev.map((x) =>
                                        x.id === d.id
                                          ? {
                                              ...x,
                                              action: {
                                                ...x.action,
                                                record: {
                                                  ...x.action.record,
                                                  metadata: {
                                                    ...(meta ?? {}),
                                                    cadence: v || null,
                                                  },
                                                },
                                              },
                                            }
                                          : x,
                                      ),
                                    );
                                  }}
                                >
                                  <MenuItem value="">
                                    <em>{t("chat.frequency_not_set")}</em>
                                  </MenuItem>
                                  <MenuItem value="daily">{t("chat.frequency_daily")}</MenuItem>
                                  <MenuItem value="weekly">{t("chat.frequency_weekly")}</MenuItem>
                                  <MenuItem value="biweekly">{t("chat.frequency_biweekly")}</MenuItem>
                                  <MenuItem value="monthly">{t("chat.frequency_monthly")}</MenuItem>
                                </Select>
                              </FormControl>
                              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                                <TextField
                                  label={t("chat.due")}
                                  type="datetime-local"
                                  value={dueAt}
                                  onChange={(e) => {
                                    const v = normalizeDatetimeLocal(e.target.value);
                                    setChoreDrafts((prev) =>
                                      prev.map((x) =>
                                        x.id === d.id
                                          ? { ...x, action: { ...x.action, record: { ...x.action.record, due_at: v ?? null } } }
                                          : x,
                                      ),
                                    );
                                  }}
                                  fullWidth
                                  size="small"
                                  InputLabelProps={{ shrink: true }}
                                />
                                <TextField
                                  label={t("chores.priority")}
                                  type="number"
                                  value={priority}
                                  onChange={(e) => {
                                    const v = asNumberOrNull(e.target.value) ?? 1;
                                    setChoreDrafts((prev) =>
                                      prev.map((x) =>
                                        x.id === d.id ? { ...x, action: { ...x.action, record: { ...x.action.record, priority: v } } } : x,
                                      ),
                                    );
                                  }}
                                  fullWidth
                                  size="small"
                                  inputProps={{ min: 1, max: 3 }}
                                />
                              </Stack>
                              <FormControl fullWidth size="small">
                                <InputLabel>{t("chat.helper")}</InputLabel>
                                <Select
                                  value={helperValue}
                                  label={t("chat.helper")}
                                  onChange={(e) => {
                                    const v = String(e.target.value);
                                    setChoreDrafts((prev) =>
                                      prev.map((x) =>
                                        x.id === d.id
                                          ? { ...x, action: { ...x.action, record: { ...x.action.record, helper_id: v || null } } }
                                          : x,
                                      ),
                                    );
                                  }}
                                >
                                  <MenuItem value="">
                                    <em>{t("chat.unassigned")}</em>
                                  </MenuItem>
                                  {helpers.map((h) => (
                                    <MenuItem key={h.id} value={h.id}>
                                      {h.name}{h.type ? ` (${h.type})` : ""}
                                    </MenuItem>
                                  ))}
                                </Select>
                              </FormControl>
                            </Stack>
                          );
                        })()}
                      </DialogContent>
                      <DialogActions>
                        <Button onClick={() => setEditChoreDraftId(null)}>{t("common.done")}</Button>
                      </DialogActions>
                    </Dialog>
                  </Paper>
                )}

                {proposedAutomationSuggestions.length > 0 && (
                  <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 1.5 }}>
                    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} spacing={1} sx={{ mb: 1 }}>
                      <Box>
                        <Typography variant="body2" fontWeight={700}>
                          {t("chat.recommended_automations")}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t("chat.recommended_automations_help")}
                        </Typography>
                      </Box>
                    </Stack>

                    <List dense disablePadding>
                      {proposedAutomationSuggestions.map((s, idx) => {
                        const suggested = (s.suggested_automation ?? {}) as Record<string, unknown>;
                        const cadence = typeof suggested.cadence === "string" ? suggested.cadence : "";
                        const status = typeof suggested.status === "string" ? suggested.status : "active";
                        const nextRunAt = typeof suggested.next_run_at === "string" ? suggested.next_run_at : "";
                        const preview = typeof s.body === "string" && s.body.trim().length > 0 ? s.body.trim() : "";
                        const secondary = `${cadence ? `${cadence} · ` : ""}${status ? `${status} · ` : ""}${nextRunAt ? `next=${nextRunAt} · ` : ""}${preview}`.trim();

                        return (
                          <ListItem
                            key={`${idx}_${s.title}`}
                            disablePadding
                            sx={{ pr: { xs: 0, sm: 22 }, alignItems: "flex-start" }}
                            secondaryAction={
                              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  color="error"
                                  disabled={!!automationSuggestionBusyId}
                                  onClick={() => rejectAutomationSuggestion(s, idx)}
                                >
                                  {t("chat.reject")}
                                </Button>
                                <Button
                                  size="small"
                                  variant="contained"
                                  disabled={!!automationSuggestionBusyId}
                                  onClick={() => approveAutomationSuggestion(s, idx)}
                                >
                                  {t("chat.approve")}
                                </Button>
                              </Stack>
                            }
                          >
                            <ListItemButton dense sx={{ alignItems: "flex-start" }}>
                              <ListItemText
                                primaryTypographyProps={{ sx: { pr: 1 } }}
                                secondaryTypographyProps={{ sx: { pr: 1, whiteSpace: "normal", wordBreak: "break-word" } }}
                                primary={s.title || "(Untitled)"}
                                secondary={secondary || undefined}
                              />
                            </ListItemButton>
                          </ListItem>
                        );
                      })}
                    </List>
                  </Paper>
                )}

                <Stack spacing={1}>
                  {dedupedWriteToolCalls
                    .filter((tc) => {
                      const k = toolCallDedupeKey(tc);
                      return !(approvedToolCallKeys as any)?.[k];
                    })
                    .map((tc) => {
                      const k = toolCallDedupeKey(tc);
                      return toolCallOverridesByKey[k] ?? tc;
                    })
                    .map((tc) => (
                    <Paper key={tc.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                      <Stack spacing={1}>
                        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                          <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={600}>
                            {tc.tool}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: "block", wordBreak: "break-word" }}>
                            {tc.reason ? tc.reason : "(no reason provided)"}
                          </Typography>

                          </Box>

                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Button
                              size="small"
                              variant="contained"
                              disabled={toolBusy}
                              onClick={() => approveToolCall(tc)}
                            >
                              {t("chat.approve")}
                            </Button>
                          </Stack>
                        </Stack>
                      </Stack>
                    </Paper>
                  ))}

                  {proposedActions.filter((a) => a.table !== "chores").map((a, idx) => (
                    <Paper key={idx} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={600}>
                            {t("chat.create_table").replace("{table}", a.table)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: "block", wordBreak: "break-word" }}>
                            {a.table === "helpers"
                              ? String((a.record as Record<string, unknown>).name ?? "(missing name)")
                              : String((a.record as Record<string, unknown>).title ?? "(missing title)")}
                          </Typography>
                        </Box>
                        <Button
                          size="small"
                          variant="contained"
                          disabled={agentBusy}
                          onClick={() => applyAction(a)}
                        >
                          {t("chat.apply")}
                        </Button>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              </Box>
            )}

            {showTypingDots && <TypingIndicator />}

            {/* State-driven onboarding panel — replaces keyword-based form detection */}
            {isOnboarding && (
              <Box sx={{ my: 1 }}>
                <OnboardingPanel
                  householdId={(authedHouseholdId || agentHouseholdId || "").trim()}
                  userId={authedUser?.id ?? ""}
                  onFormSubmitted={(msg) => void sendMessage(msg, { silent: true })}
                  onComplete={() => {
                    // Navigate away from onboarding mode
                    navigate("/", { replace: true });
                  }}
                />
              </Box>
            )}

            <div ref={messagesEndRef} />
          </Box>

          {/* Quick commands — collapsible */}
          {!isOnboarding && (
            <Box px={1} pb={0.5}>
              <Button
                size="small"
                onClick={() => setQuickCommandsCollapsed((p) => !p)}
                sx={{ textTransform: "none", color: "text.secondary", fontSize: "0.75rem", minWidth: 0, p: 0.5 }}
              >
                {quickCommandsCollapsed ? "▸ Quick actions" : "▾ Quick actions"}
              </Button>
              {!quickCommandsCollapsed && (
                <Stack direction="row" spacing={1} mt={0.5} flexWrap="wrap">
                  <Chip
                    icon={<Home sx={{ fontSize: 16 }} />}
                    label={homeProfileExists ? "Home Profile" : "Create Home Profile"}
                    size="small"
                    variant="outlined"
                    clickable
                    onClick={() => (homeProfileExists ? reviewHomeProfile() : openHomeProfileWizard())}
                    sx={{ fontSize: "0.78rem" }}
                  />
                  <Chip
                    icon={<BarChart sx={{ fontSize: 16 }} />}
                    label="Coverage Planner"
                    size="small"
                    variant="outlined"
                    clickable
                    onClick={() => setCoverageExperimentOpen(true)}
                    sx={{ fontSize: "0.78rem" }}
                  />
                </Stack>
              )}
            </Box>
          )}

          {/* Input */}
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            isListening={isListening}
            isTranscribing={isTranscribing}
            onMicToggle={toggleMic}
            voiceSupported={voiceSupported}
            lang={lang}
            transliterationMode={lang === "hi-IN" ? "hi" : lang === "kn-IN" ? "kn" : "off"}
            disabled={!!chatError}
          />
        </Paper>

        {/* Quick commands panel (desktop / non-embedded, hidden during onboarding) */}
        {!props.embedded && !isOnboarding ? (
          <Paper
            variant="outlined"
            sx={{
              flex: 1,
              minWidth: 260,
              maxWidth: 340,
              overflowY: "auto",
              flexShrink: 0,
              borderRadius: "12px",
              p: 2,
              "&::-webkit-scrollbar": { width: 4 },
              "&::-webkit-scrollbar-thumb": { bgcolor: "grey.300", borderRadius: "4px" },
            }}
          >
            <QuickActionsPanel
              onQuickAction={handleQuickAction}
              onCreateHomeProfile={openHomeProfileWizard}
              onReviewHomeProfile={reviewHomeProfile}
              onGenerateCoverage={ENABLE_COVERAGE_EXPERIMENT ? () => setCoverageExperimentOpen(true) : undefined}
              onRecommendChores={ENABLE_CHORE_RECS_EXPERIMENT ? () => void generateRecommendedChores() : undefined}
              homeProfileExists={homeProfileExists}
              alertCount={3}
              defaultQuickCommandsCollapsed={false}
              storageKey="homeops.chat.page.quick_commands_collapsed"
            />
          </Paper>
        ) : null}
      </Stack>

      <Dialog open={agentDialogOpen} onClose={() => setAgentDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Setup & Connection</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Alert severity="info">
              This app needs to know <strong>who you are</strong> (login) and <strong>which home</strong> you belong to.
              <br />
              Normally this is filled automatically after you sign up / log in.
            </Alert>
            <Alert severity="success">
              Your login status:
              <br />
              Logged in: {authedAccessToken.trim() ? "Yes" : "No"}
              <br />
              Signed in as: {authedUser?.email ? String(authedUser.email) : "(unknown)"}
              <br />
              Home linked: {authedHouseholdId.trim() ? "Yes" : "No"}
            </Alert>
            {authedLastError.trim() ? <Alert severity="warning">{authedLastError.trim()}</Alert> : null}

            {bootstrapError ? <Alert severity="error">{bootstrapError}</Alert> : null}
            {bootstrapSuccess ? <Alert severity="success">{bootstrapSuccess}</Alert> : null}

            {authedAccessToken.trim() ? (
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={bootstrapBusy}
                  onClick={async () => {
                    setBootstrapError(null);
                    setBootstrapSuccess(null);
                    setBootstrapBusy(true);
                    try {
                      await refreshHouseholdId();
                      setBootstrapSuccess("Checked your account and refreshed your home link.");
                    } catch (e) {
                      setBootstrapError(e instanceof Error ? e.message : "Couldn't refresh your home link");
                    } finally {
                      setBootstrapBusy(false);
                    }
                  }}
                >
                  Refresh my home link
                </Button>

                {!authedHouseholdId.trim() ? (
                  <Button
                    variant="contained"
                    size="small"
                    disabled={bootstrapBusy}
                    onClick={async () => {
                      setBootstrapError(null);
                      setBootstrapSuccess(null);
                      setBootstrapBusy(true);
                      try {
                        const res = await bootstrapHousehold();
                        if (!res.ok) {
                          setBootstrapError("error" in res ? res.error : "Couldn't set up your home");
                          return;
                        }
                        setBootstrapSuccess("Your home is now set up and linked to your account.");
                      } finally {
                        setBootstrapBusy(false);
                      }
                    }}
                  >
                    Set up my home
                  </Button>
                ) : null}

                <Button
                  variant="text"
                  size="small"
                  disabled={bootstrapBusy}
                  onClick={async () => {
                    setBootstrapError(null);
                    setBootstrapSuccess(null);
                    await signOut();
                    setBootstrapSuccess("You have been signed out. Please log in with the correct email.");
                  }}
                >
                  Sign out
                </Button>
              </Stack>
            ) : null}

            <TextField
              label="Advanced: Login token"
              value={agentAccessToken}
              onChange={(e) => setAgentAccessToken(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={3}
            />
            <TextField
              label="Advanced: Home ID"
              value={agentHouseholdId}
              onChange={(e) => setAgentHouseholdId(e.target.value)}
              fullWidth
              size="small"
            />

            {ENABLE_COVERAGE_EXPERIMENT ? (
              <Stack spacing={1}>
                <Divider />
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2" fontWeight={700} lineHeight={1.2}>
                      Coverage (Experimental)
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                      Configure what’s automated today. Saved locally and fully deletable.
                    </Typography>
                  </Box>
                  <Button variant="outlined" size="small" onClick={() => setCoverageExperimentOpen(true)}>
                    Open
                  </Button>
                </Stack>
              </Stack>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAgentDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={coverageExperimentOpen} onClose={() => setCoverageExperimentOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Automated Coverage (Experimental)</DialogTitle>
        <CoverageExperimentEntry householdId={authedHouseholdId.trim() || agentHouseholdId.trim()} onClose={() => setCoverageExperimentOpen(false)} />
      </Dialog>

      <HomeProfileWizard
        open={homeProfileWizardOpen}
        onClose={closeHomeProfileWizard}
        draft={homeProfileDraft}
        setDraft={setHomeProfileDraft}
        mode={homeProfileMode}
        setMode={setHomeProfileMode}
        step={homeProfileWizardStep}
        setStep={setHomeProfileWizardStep}
        newSpace={homeProfileNewSpace}
        setNewSpace={setHomeProfileNewSpace}
        busy={homeProfileBusy}
        error={homeProfileError}
        toolBusy={toolBusy}
        updateRecord={updateHomeProfileRecord}
        goNext={goNextHomeProfileStep}
        goBack={goBackHomeProfileStep}
        onSave={saveHomeProfileDraft}
      />

      <Dialog open={profileDialogOpen} onClose={() => setProfileDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Profile</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={1}>
            {profileError ? <Alert severity="error">{profileError}</Alert> : null}
            <TextField
              label="Your name"
              value={profileFullName}
              onChange={(e) => setProfileFullName(e.target.value)}
              fullWidth
              size="small"
              disabled={profileBusy}
            />
            <TextField
              label="Email"
              value={authedUser?.email ? String(authedUser.email) : ""}
              fullWidth
              size="small"
              disabled
            />
            <TextField
              label="Home ID"
              value={authedHouseholdId.trim()}
              fullWidth
              size="small"
              disabled
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={() => setProfileDialogOpen(false)} disabled={profileBusy}>
            Close
          </Button>
          <Button variant="contained" onClick={saveProfile} disabled={profileBusy}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={feedbackDialogOpen} onClose={() => setFeedbackDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Feedback</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={1}>
            {feedbackError ? <Alert severity="error">{feedbackError}</Alert> : null}
            {feedbackSuccess ? <Alert severity="success">{feedbackSuccess}</Alert> : null}
            <Box>
              <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                Rating
              </Typography>
              <Rating value={feedbackRating} onChange={(_, v) => setFeedbackRating(v)} />
            </Box>
            <TextField
              label="What can we improve? (optional)"
              value={feedbackMessage}
              onChange={(e) => setFeedbackMessage(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={3}
              disabled={feedbackBusy}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={() => setFeedbackDialogOpen(false)} disabled={feedbackBusy}>
            Close
          </Button>
          <Button variant="contained" onClick={submitFeedback} disabled={feedbackBusy}>
            Send
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
