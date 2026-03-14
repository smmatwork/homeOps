import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Stack,
  Paper,
  Typography,
  Chip,
  Avatar,
  IconButton,
  Menu,
  MenuItem,
  Rating,
  ToggleButtonGroup,
  ToggleButton,
  Alert,
  Collapse,
  Tooltip,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  FormControl,
  InputLabel,
  Select,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Checkbox,
  Stepper,
  Step,
  StepLabel,
  Autocomplete,
  Switch,
  FormControlLabel,
  Divider,
} from "@mui/material";
import { SmartToy, GraphicEq, Person, Feedback as FeedbackIcon, Logout, Edit, Delete } from "@mui/icons-material";
import { keyframes } from "@emotion/react";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { QuickActionsPanel } from "./QuickActionsPanel";
import { useSarvamChat } from "../../hooks/useSarvamChat";
import { useSarvamSTT, type SpeechLang } from "../../hooks/useSarvamSTT";
import { parseAgentActionsFromAssistantText, parseToolCallsFromAssistantText, type AgentCreateAction, type ToolCall } from "../../services/agentActions";
import { loadCoverageDraft } from "../../experiments/coverage/coverageDraftStorage";
import { agentCreate, agentListHelpers, executeToolCall } from "../../services/agentApi";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { CoverageExperimentEntry } from "../../experiments/coverage/CoverageExperimentEntry";
import { useNavigate } from "react-router";

type HelperOption = { id: string; name: string; type: string | null; phone: string | null };

type ChoreDraft = {
  id: string;
  action: AgentCreateAction;
};

type HomeProfileDraft = {
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
  // Keep as-is (datetime-local) and let Postgres parse if possible
  return trimmed;
}

function normalizeSpaceName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function titleizeSpace(value: string): string {
  const v = value.trim().replace(/\s+/g, " ");
  if (!v) return v;
  return v.charAt(0).toUpperCase() + v.slice(1);
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
      title: `Vacuum ${label}`,
      description: robotVacEnabled
        ? "Weekly: vacuum this room (not covered by the robot vacuum)."
        : "Weekly: vacuum this room.",
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
export function ChatInterface() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [lang, setLang] = useState<SpeechLang>("en-IN");
  const [sttError, setSttError] = useState<string | null>(null);

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
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentSuccess, setAgentSuccess] = useState<string | null>(null);

  useEffect(() => {
    const handler = () => setAgentDialogOpen(true);
    window.addEventListener("homeops:open-agent-setup", handler as EventListener);
    return () => window.removeEventListener("homeops:open-agent-setup", handler as EventListener);
  }, []);

  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapSuccess, setBootstrapSuccess] = useState<string | null>(null);

  const [helpers, setHelpers] = useState<HelperOption[]>([]);
  const [helperLoadError, setHelperLoadError] = useState<string | null>(null);

  const [choreDrafts, setChoreDrafts] = useState<ChoreDraft[]>([]);
  const [selectedChoreDraftIds, setSelectedChoreDraftIds] = useState<Record<string, boolean>>({});
  const [editChoreDraftId, setEditChoreDraftId] = useState<string | null>(null);
  const [homeProfileDraft, setHomeProfileDraft] = useState<HomeProfileDraft | null>(null);
  const [homeProfileBusy, setHomeProfileBusy] = useState(false);
  const [homeProfileError, setHomeProfileError] = useState<string | null>(null);
  const [homeProfileWizardOpen, setHomeProfileWizardOpen] = useState(false);
  const [homeProfileWizardStep, setHomeProfileWizardStep] = useState(0);
  const [homeProfileNewSpace, setHomeProfileNewSpace] = useState("");
  const [homeProfileMode, setHomeProfileMode] = useState<"view" | "edit">("edit");
  const [homeProfileExists, setHomeProfileExists] = useState(false);

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

  const openAccountMenu = useCallback((el: HTMLElement) => setAccountAnchorEl(el), []);
  const closeAccountMenu = useCallback(() => setAccountAnchorEl(null), []);

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

  const getBaselineSpaces = useCallback((homeType: string, bhk: number) => {
    const ht = homeType.trim().toLowerCase();
    const n = Number.isFinite(bhk) && bhk > 0 ? Math.floor(bhk) : 2;
    const base: string[] = ["living room", "dining area", "kitchen"];
    for (let i = 1; i <= n; i += 1) base.push(`bedroom ${i}`);
    if (ht === "villa") base.push("stairs");
    return base;
  }, []);

  const getAgentSetup = useCallback(() => {
    const token = authedAccessToken.trim() || agentAccessToken.trim();
    const householdId = authedHouseholdId.trim() || agentHouseholdId.trim();
    return { token, householdId };
  }, [authedAccessToken, agentAccessToken, authedHouseholdId, agentHouseholdId]);

  const reviewHomeProfile = useCallback(async () => {
    setHomeProfileError(null);
    const { householdId } = getAgentSetup();
    if (!householdId) {
      setHomeProfileError("Missing household_id. Click Agent Setup to confirm your home is linked.");
      setAgentDialogOpen(true);
      return;
    }

    setHomeProfileBusy(true);
    let { data, error } = await supabase
      .from("home_profiles")
      .select("home_type, bhk, square_feet, floors, spaces, space_counts, has_balcony, has_pets, has_kids, flooring_type, num_bathrooms")
      .eq("household_id", householdId)
      .maybeSingle();

    // Backward-compatible fallback if migrations haven't been applied yet.
    const msg = (error as any)?.message ? String((error as any).message) : "";
    if (error && /schema cache/i.test(msg) && /(floors|square_feet|spaces|space_counts)/i.test(msg)) {
      const legacy = await supabase
        .from("home_profiles")
        .select("home_type, bhk, has_balcony, has_pets, has_kids, flooring_type, num_bathrooms")
        .eq("household_id", householdId)
        .maybeSingle();
      data = legacy.data as any;
      error = legacy.error as any;
      if (!legacy.error) {
        setHomeProfileError(
          "Your database is missing the latest home profile fields (floors/square feet/spaces). Apply the latest Supabase migration to enable these fields.",
        );
      }
    }
    setHomeProfileBusy(false);

    if (error) {
      setHomeProfileError("We couldn't load your home profile right now. Please try again.");
      return;
    }

    if (!data) {
      setHomeProfileExists(false);
      setHomeProfileError("You don't have a home profile yet. Click 'Create home profile' to set it up.");
      return;
    }

    setHomeProfileExists(true);

    setHomeProfileDraft({
      id: `${Date.now()}`,
      action: {
        type: "create",
        table: "home_profiles",
        record: {
          home_type: data?.home_type ?? "apartment",
          bhk: typeof data?.bhk === "number" ? data.bhk : 2,
          square_feet: typeof (data as any)?.square_feet === "number" ? (data as any).square_feet : null,
          floors: typeof (data as any)?.floors === "number" ? (data as any).floors : null,
          spaces: Array.isArray((data as any)?.spaces) ? (data as any).spaces : [],
          space_counts: (data as any)?.space_counts && typeof (data as any).space_counts === "object" ? (data as any).space_counts : {},
          has_balcony: typeof data?.has_balcony === "boolean" ? data.has_balcony : false,
          has_pets: typeof data?.has_pets === "boolean" ? data.has_pets : false,
          has_kids: typeof data?.has_kids === "boolean" ? data.has_kids : false,
          flooring_type: data?.flooring_type ?? null,
          num_bathrooms: typeof data?.num_bathrooms === "number" ? data.num_bathrooms : null,
        },
        reason: "Review and update home profile",
      },
    });
    setHomeProfileMode("view");
    setHomeProfileWizardStep(0);
    setHomeProfileWizardOpen(true);
  }, [getAgentSetup]);

  const refreshHomeProfileExists = useCallback(async () => {
    const { householdId } = getAgentSetup();
    if (!householdId) {
      setHomeProfileExists(false);
      return;
    }

    const { data, error } = await supabase
      .from("home_profiles")
      .select("household_id")
      .eq("household_id", householdId)
      .limit(1);

    if (error) {
      return;
    }

    setHomeProfileExists(Array.isArray(data) && data.length > 0);
  }, [getAgentSetup]);

  function withHouseholdId(tc: ToolCall, householdId: string): ToolCall {
    const args = (tc.args ?? {}) as Record<string, unknown>;
    return { ...tc, args: { ...args, household_id: householdId } };
  }


  const { messages, sendMessage, isStreaming, error: chatError, memoryReady, memoryScope, setMemoryScope, appendAssistantMessage } = useSarvamChat();

  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  const {
    isListening,
    isTranscribing,
    toggle: toggleMic,
    supported: voiceSupported,
    sttMode,
  } = useSarvamSTT(lang, handleTranscript, setSttError);

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return;

    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();
    const isHelpersQuery = /\bhelpers?\b/.test(lower) && /\b(list|show|get|what)\b/.test(lower);
    const isChoresQuery = /\bchores?\b/.test(lower) && /\b(list|show|get|what|pending|overdue)\b/.test(lower);
    const isAlertsQuery = /\balerts?\b/.test(lower) && /\b(list|show|get|what)\b/.test(lower);

    const directTable = isHelpersQuery ? "helpers" : isChoresQuery ? "chores" : isAlertsQuery ? "alerts" : null;

    if (directTable) {
      // Add the user message to the chat UI/history
      sendMessage(trimmed);
      setInput("");

      const { token, householdId } = getAgentSetup();
      if (!token || !householdId) return;

      const tc: ToolCall = {
        id: `direct_${directTable}_${Date.now()}`,
        tool: "db.select",
        args: {
          table: directTable,
          limit: 50,
        },
        reason: `Fetch ${directTable} from the database`,
      };

      void (async () => {
        setToolError(null);
        const res = await executeToolCall({
          accessToken: token,
          householdId,
          scope: memoryScope,
          toolCall: withHouseholdId(tc, householdId),
        });
        if (!res.ok) {
          setToolError("error" in res ? res.error : "Couldn’t fetch the information");
          return;
        }
        appendAssistantMessage(res.summary);
      })();

      return;
    }

    sendMessage(trimmed);
    setInput("");
  }, [input, isStreaming, sendMessage, memoryScope, appendAssistantMessage]);

  const handleQuickAction = useCallback((prompt: string) => {
    setInput(prompt);
  }, []);

  const handleLangChange = (_: React.MouseEvent, value: SpeechLang | null) => {
    if (value) setLang(value);
  };

  // Determine if a "thinking" placeholder should show (streaming started but no content yet)
  const lastMsg = messages[messages.length - 1];
  const showTypingDots =
    isStreaming && lastMsg?.role === "assistant" && lastMsg.content === "";

  const latestAssistantText = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant" && !m.streaming) return m.content;
    }
    return "";
  })();

  const proposedActions = parseAgentActionsFromAssistantText(latestAssistantText);
  const proposedToolCalls = parseToolCallsFromAssistantText(latestAssistantText);
  const proposedWriteToolCalls = proposedToolCalls.filter((tc) => tc.tool !== "db.select");

  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolSuccess, setToolSuccess] = useState<string | null>(null);

  const [autoExecutedToolCallIds, setAutoExecutedToolCallIds] = useState<Record<string, boolean>>({});

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
    const latestSpaces = Array.isArray(latestRecord.spaces)
      ? (latestRecord.spaces as unknown[]).map(String).filter(Boolean)
      : [];
    const baseline = getBaselineSpaces(nextHomeType, nextBhk);
    const mergedSpaces = latestSpaces.length > 0 ? latestSpaces : baseline;
    setHomeProfileDraft({
      id: `${Date.now()}`,
      action: {
        ...latest,
        record: { ...latest.record, spaces: mergedSpaces },
      },
    });
    setHomeProfileMode("edit");
    setHomeProfileWizardStep(0);
    setHomeProfileWizardOpen(true);
  }, [latestAssistantText, isStreaming, getBaselineSpaces, homeProfileExists, reviewHomeProfile]);

  const saveHomeProfileDraft = useCallback(async () => {
    if (!homeProfileDraft) return;
    setToolError(null);
    setToolSuccess(null);
    setHomeProfileError(null);
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      setToolError("Missing access_token or household_id. Click Agent Setup to confirm your session token + household id.");
      return;
    }

    setToolBusy(true);
    const tc: ToolCall = {
      id: `hp_${Date.now()}`,
      tool: "db.insert",
      args: {
        table: "home_profiles",
        record: homeProfileDraft.action.record,
      },
      reason: homeProfileDraft.action.reason,
    };

    const res = await executeToolCall({
      accessToken: token,
      householdId,
      scope: memoryScope,
      toolCall: withHouseholdId(tc, householdId),
    });
    setToolBusy(false);

    if (!res.ok) {
      setToolError("error" in res ? res.error : "Couldn’t save the home profile");
      return;
    }

    setToolSuccess(res.summary);
    appendAssistantMessage(res.summary);
    setHomeProfileDraft(null);
    setHomeProfileExists(true);
  }, [homeProfileDraft, memoryScope, appendAssistantMessage, getAgentSetup]);

  useEffect(() => {
    void refreshHomeProfileExists();
  }, [authedHouseholdId, agentHouseholdId, refreshHomeProfileExists]);

  const HOME_SPACE_SUGGESTIONS = useMemo(
    () => [
      "living room",
      "dining area",
      "work area",
      "study",
      "powder room",
      "utility room",
      "store room",
      "pantry",
      "pooja room",
      "balcony",
      "terrace",
      "deck",
      "home office",
      "gym",
      "basement",
      "lift",
      "battery room",
      "solar storage",
      "servant room",
      "laundry",
      "garden",
      "parking",
      "car porch",
    ],
    [],
  );

  const openHomeProfileWizard = useCallback(() => {
    if (homeProfileExists) {
      void reviewHomeProfile();
      return;
    }
    if (!homeProfileDraft) {
      const baseline = getBaselineSpaces("apartment", 2);
      setHomeProfileDraft({
        id: `${Date.now()}`,
        action: {
          type: "create",
          table: "home_profiles",
          record: {
            home_type: "apartment",
            bhk: 2,
            square_feet: null,
            floors: null,
            spaces: baseline,
            space_counts: {},
            has_balcony: false,
            has_pets: false,
            has_kids: false,
            flooring_type: null,
            num_bathrooms: null,
          },
          reason: "Draft home profile",
        },
      });
    }
    setHomeProfileMode("edit");
    setHomeProfileWizardStep(0);
    setHomeProfileWizardOpen(true);
  }, [homeProfileDraft, getBaselineSpaces, homeProfileExists, reviewHomeProfile]);

  const closeHomeProfileWizard = useCallback(() => {
    setHomeProfileWizardOpen(false);
    setHomeProfileNewSpace("");
  }, []);

  const updateHomeProfileRecord = useCallback((patch: Record<string, unknown>) => {
    setHomeProfileDraft((prev) =>
      prev
        ? {
            ...prev,
            action: {
              ...prev.action,
              record: { ...(prev.action.record as Record<string, unknown>), ...patch },
            },
          }
        : prev,
    );
  }, []);

  const goNextHomeProfileStep = useCallback(() => {
    setHomeProfileWizardStep((s) => Math.min(3, s + 1));
  }, []);

  const goBackHomeProfileStep = useCallback(() => {
    setHomeProfileWizardStep((s) => Math.max(0, s - 1));
  }, []);

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

    setAgentBusy(true);
    const res = await agentCreate({
      accessToken: token,
      table: action.table,
      record: record as Record<string, unknown>,
      reason: action.reason,
    });
    setAgentBusy(false);

    if (!res.ok) {
      setAgentError("error" in res ? res.error : "Create failed");
      return;
    }

    setAgentSuccess(`Created 1 ${action.table} item.`);
  }, [agentAccessToken, agentHouseholdId]);

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

    setAgentBusy(true);
    let okCount = 0;
    for (const d of selected) {
      const record = { ...d.action.record, household_id: householdId };
      const res = await agentCreate({
        accessToken: token,
        table: "chores",
        record: record as Record<string, unknown>,
        reason: d.action.reason,
      });
      if (!res.ok) {
        setAgentBusy(false);
        setAgentError("error" in res ? res.error : "Create failed");
        return;
      }
      okCount += 1;
    }
    setAgentBusy(false);
    setAgentSuccess(`Created ${okCount} chores.`);
    setChoreDrafts([]);
    setSelectedChoreDraftIds({});
  }, [agentAccessToken, agentHouseholdId, choreDrafts, selectedChoreDraftIds]);

  const generateRecommendedChores = useCallback(async () => {
    setAgentError(null);
    setAgentSuccess(null);

    const { householdId } = getAgentSetup();
    if (!householdId) {
      setAgentError("Missing household_id. Click Agent Setup to confirm your session token + household id.");
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
        setAgentError("Please create your home profile first, then generate recommendations.");
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
    setToolError(null);
    setToolSuccess(null);
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      setToolError("Missing access_token or household_id. Click Agent Setup to confirm your session token + household id.");
      return;
    }
    setToolBusy(true);
    const tcWithHousehold = withHouseholdId(tc, householdId);
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
      setToolError("error" in res ? res.error : "Tool execution failed");
      return;
    }
    setToolSuccess(`Executed ${tc.tool}.`);
    appendAssistantMessage(res.summary);
  }, [memoryScope, appendAssistantMessage, refreshHouseholdId, authedAccessToken]);

  const executeReadOnlyToolCall = useCallback(async (tc: ToolCall) => {
    if (tc.tool !== "db.select") return;

    const lastUserText = (() => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m && typeof (m as any).role === "string" && (m as any).role === "user") {
          const c = (m as any).content;
          return typeof c === "string" ? c : "";
        }
      }
      return "";
    })();

    const table = typeof tc.args?.table === "string" ? String(tc.args.table) : "";
    if (table && !wantsListForTable({ userText: lastUserText, table })) return;

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
      setToolError("error" in res ? res.error : "Couldn’t fetch the information");
      setAutoExecutedToolCallIds((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }

    appendAssistantMessage(res.summary);
  }, [autoExecutedToolCallIds, memoryScope, appendAssistantMessage, toolCallKey, messages]);

  useEffect(() => {
    if (isStreaming) return;
    if (proposedToolCalls.length === 0) return;
    // New tool call set from assistant — allow selects to run again even if Sarvam reuses ids like tc_1.
    setAutoExecutedToolCallIds({});
  }, [isStreaming, latestAssistantText]);

  useEffect(() => {
    if (isStreaming) return;
    if (proposedToolCalls.length === 0) return;
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) return;
    for (const tc of proposedToolCalls) {
      if (tc.tool === "db.select") {
        void executeReadOnlyToolCall(tc);
      }
    }
  }, [isStreaming, proposedToolCalls, executeReadOnlyToolCall, authedAccessToken, authedHouseholdId, agentAccessToken, agentHouseholdId]);

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

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <Stack
        direction="row"
        spacing={2}
        sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      >
        {/* Chat panel */}
        <Paper
          variant="outlined"
          sx={{
            flex: 2,
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

                {/* Home profile editing is accessible from Quick Commands and Review dialog. */}
              </Stack>
            </Box>
            <Chip
              label={hasKey ? "AI Connected" : "Demo Mode"}
              size="small"
              color={hasKey ? "success" : "default"}
              variant="outlined"
              sx={{ fontSize: "0.7rem", height: 22 }}
            />

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

          <Menu anchorEl={accountAnchorEl} open={accountMenuOpen} onClose={closeAccountMenu}>
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

          {/* Messages area */}
          <Box
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

            {/* Proposed agent actions (from latest assistant message) */}
            {!isStreaming && (proposedActions.length > 0 || proposedWriteToolCalls.length > 0 || choreDrafts.length > 0 || !!agentError || !!agentSuccess) && (
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
                    Review home profile
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
                          Recommended chores
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Select what you want, edit only if needed, then submit.
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
                          Toggle all
                        </Button>
                        <Button size="small" variant="contained" disabled={agentBusy} onClick={submitChoreDrafts}>
                          Submit
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
                        const checked = selectedChoreDraftIds[d.id] !== false;
                        const preview = description.trim().length > 80 ? `${description.trim().slice(0, 80)}…` : description.trim();
                        const secondary = `${scheduleLabel ? `${scheduleLabel} · ` : ""}${preview}`.trim();

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
                      maxWidth="sm"
                      fullWidth
                    >
                      <DialogTitle>Edit chore</DialogTitle>
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
                          return (
                            <Stack spacing={1.5} mt={1}>
                              <TextField
                                label="Title"
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
                                label="Description"
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
                              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                                <TextField
                                  label="Due"
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
                                  label="Priority (1-3)"
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
                                <InputLabel>Helper</InputLabel>
                                <Select
                                  value={helperId}
                                  label="Helper"
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
                                    <em>Unassigned</em>
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
                        <Button onClick={() => setEditChoreDraftId(null)}>Done</Button>
                      </DialogActions>
                    </Dialog>
                  </Paper>
                )}

                <Stack spacing={1}>
                  {proposedWriteToolCalls.map((tc) => (
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
                              Approve
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
                            Create {a.table}
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
                          Apply
                        </Button>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              </Box>
            )}

            {showTypingDots && <TypingIndicator />}

            <div ref={messagesEndRef} />
          </Box>

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
            disabled={isStreaming}
          />
        </Paper>

        {/* Sidebar */}
        <Box
          sx={{
            flex: 1,
            minWidth: 240,
            maxWidth: 300,
            overflowY: "auto",
            flexShrink: 0,
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
          />
        </Box>
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

      <Dialog open={homeProfileWizardOpen} onClose={closeHomeProfileWizard} maxWidth="sm" fullWidth>
        <DialogTitle>Home Profile</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            {homeProfileMode === "edit" && (
              <Stepper activeStep={homeProfileWizardStep} alternativeLabel>
                <Step>
                  <StepLabel>Basics</StepLabel>
                </Step>
                <Step>
                  <StepLabel>Spaces</StepLabel>
                </Step>
                <Step>
                  <StepLabel>Household</StepLabel>
                </Step>
                <Step>
                  <StepLabel>Review</StepLabel>
                </Step>
              </Stepper>
            )}

            {homeProfileDraft && (() => {
              const r = homeProfileDraft.action.record as Record<string, unknown>;
              const homeType = typeof r.home_type === "string" ? r.home_type : "apartment";
              const bhk = asNumberOrNull(r.bhk) ?? 2;
              const squareFeet = asNumberOrNull(r.square_feet);
              const floors = asNumberOrNull(r.floors);
              const spaces = Array.isArray(r.spaces) ? (r.spaces as unknown[]).map(String).filter(Boolean) : [];
              const spaceCountsRaw = r.space_counts && typeof r.space_counts === "object" ? (r.space_counts as Record<string, unknown>) : {};
              const balconyCount = asNumberOrNull(spaceCountsRaw.balcony);
              const terraceCount = asNumberOrNull(spaceCountsRaw.terrace);
              const hasBalcony = typeof r.has_balcony === "boolean" ? r.has_balcony : false;
              const hasPets = typeof r.has_pets === "boolean" ? r.has_pets : false;
              const hasKids = typeof r.has_kids === "boolean" ? r.has_kids : false;
              const flooringType = typeof r.flooring_type === "string" ? r.flooring_type : "";
              const numBathrooms = asNumberOrNull(r.num_bathrooms);

              const reviewLines: string[] = [];
              reviewLines.push(`Type: ${homeType}`);
              reviewLines.push(`BHK: ${bhk}`);
              if (typeof squareFeet === "number") reviewLines.push(`Area: ${squareFeet} sq ft`);
              if (typeof floors === "number") reviewLines.push(`Floors: ${floors}`);
              reviewLines.push(`Balcony: ${hasBalcony ? "Yes" : "No"}`);
              if (typeof balconyCount === "number") reviewLines.push(`Balconies: ${balconyCount}`);
              if (typeof terraceCount === "number") reviewLines.push(`Terraces: ${terraceCount}`);
              reviewLines.push(`Pets: ${hasPets ? "Yes" : "No"}`);
              reviewLines.push(`Kids: ${hasKids ? "Yes" : "No"}`);
              if (spaces.length > 0) reviewLines.push(`Spaces: ${spaces.join(", ")}`);
              if (typeof numBathrooms === "number") reviewLines.push(`Bathrooms: ${numBathrooms}`);
              if (flooringType.trim()) reviewLines.push(`Flooring: ${flooringType.trim()}`);

              if (homeProfileMode === "view") {
                return (
                  <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                      Here’s what’s saved for your home.
                    </Typography>
                    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                      <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                        {reviewLines.map((l) => `- ${l}`).join("\n")}
                      </Typography>
                    </Paper>
                  </Stack>
                );
              }

              if (homeProfileWizardStep === 0) {
                return (
                  <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                      Quick basics — you can add more details in the next steps.
                    </Typography>
                    <Stack spacing={1.5}>
                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                          Home type
                        </Typography>
                        <ToggleButtonGroup
                          exclusive
                          value={homeType}
                          onChange={(_, v) => {
                            if (!v) return;
                            const nextType = String(v);
                            const baseline = getBaselineSpaces(nextType, bhk);
                            const nextSpaces = spaces.length > 0 ? spaces : baseline;
                            updateHomeProfileRecord({ home_type: nextType, spaces: nextSpaces });
                          }}
                          fullWidth
                          size="small"
                        >
                          <ToggleButton value="apartment">Apartment</ToggleButton>
                          <ToggleButton value="villa">Villa</ToggleButton>
                        </ToggleButtonGroup>
                      </Box>

                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                          BHK
                        </Typography>
                        <ToggleButtonGroup
                          exclusive
                          value={String(bhk)}
                          onChange={(_, v) => {
                            if (!v) return;
                            const nextBhk = Number(v);
                            const baseline = getBaselineSpaces(homeType, nextBhk);
                            const nextSpaces = spaces.length > 0 ? spaces : baseline;
                            updateHomeProfileRecord({ bhk: nextBhk, spaces: nextSpaces });
                          }}
                          fullWidth
                          size="small"
                        >
                          <ToggleButton value="1">1</ToggleButton>
                          <ToggleButton value="2">2</ToggleButton>
                          <ToggleButton value="3">3</ToggleButton>
                          <ToggleButton value="4">4</ToggleButton>
                          <ToggleButton value="5">5+</ToggleButton>
                        </ToggleButtonGroup>
                      </Box>

                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                        <TextField
                          label="Area (sq ft) (optional)"
                          type="number"
                          value={typeof squareFeet === "number" ? squareFeet : ""}
                          onChange={(e) => updateHomeProfileRecord({ square_feet: asNumberOrNull(e.target.value) })}
                          fullWidth
                          size="small"
                          inputProps={{ min: 0, max: 200000 }}
                        />
                        <TextField
                          label="Floors (optional)"
                          type="number"
                          value={typeof floors === "number" ? floors : ""}
                          onChange={(e) => updateHomeProfileRecord({ floors: asNumberOrNull(e.target.value) })}
                          fullWidth
                          size="small"
                          inputProps={{ min: 0, max: 50 }}
                        />
                      </Stack>
                    </Stack>
                  </Stack>
                );
              }

              if (homeProfileWizardStep === 1) {
                const hasBalconySpace = spaces.some((s) => s.toLowerCase().includes("balcony"));
                const hasTerraceSpace = spaces.some((s) => s.toLowerCase().includes("terrace"));
                return (
                  <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                      Add notable spaces. You can select suggestions or type your own.
                    </Typography>
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                      <TextField
                        label="Add a space (free text)"
                        value={homeProfileNewSpace}
                        onChange={(e) => setHomeProfileNewSpace(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          const next = homeProfileNewSpace.trim();
                          if (!next) return;
                          const nextSpaces = Array.from(new Set([...spaces, next]));
                          const hasBalconyFromSpaces = nextSpaces.some((s) => s.toLowerCase().includes("balcony"));
                          updateHomeProfileRecord({ spaces: nextSpaces, has_balcony: hasBalcony || hasBalconyFromSpaces });
                          setHomeProfileNewSpace("");
                        }}
                        fullWidth
                        size="small"
                        placeholder="e.g. battery room"
                      />
                      <Button
                        variant="outlined"
                        onClick={() => {
                          const next = homeProfileNewSpace.trim();
                          if (!next) return;
                          const nextSpaces = Array.from(new Set([...spaces, next]));
                          const hasBalconyFromSpaces = nextSpaces.some((s) => s.toLowerCase().includes("balcony"));
                          updateHomeProfileRecord({ spaces: nextSpaces, has_balcony: hasBalcony || hasBalconyFromSpaces });
                          setHomeProfileNewSpace("");
                        }}
                        disabled={!homeProfileNewSpace.trim()}
                        sx={{ flexShrink: 0 }}
                      >
                        Add
                      </Button>
                    </Stack>

                    <Box>
                      <Typography variant="caption" color="text.secondary" display="block" mb={0.75}>
                        Common spaces (tap to select)
                      </Typography>
                      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                        {HOME_SPACE_SUGGESTIONS.map((opt) => {
                          const selected = spaces.some((s) => s.toLowerCase() === opt.toLowerCase());
                          return (
                            <Chip
                              key={opt}
                              label={opt}
                              size="small"
                              color={selected ? "primary" : "default"}
                              variant={selected ? "filled" : "outlined"}
                              onClick={() => {
                                const nextSpaces = selected
                                  ? spaces.filter((s) => s.toLowerCase() !== opt.toLowerCase())
                                  : Array.from(new Set([...spaces, opt]));
                                const hasBalconyFromSpaces = nextSpaces.some((s) => s.toLowerCase().includes("balcony"));
                                updateHomeProfileRecord({ spaces: nextSpaces, has_balcony: hasBalcony || hasBalconyFromSpaces });
                              }}
                            />
                          );
                        })}
                      </Stack>
                    </Box>

                    {spaces.length > 0 && (
                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block" mb={0.75}>
                          Selected spaces
                        </Typography>
                        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                          {spaces.map((s, idx) => (
                            <Chip
                              key={`${s}-${idx}`}
                              label={s}
                              size="small"
                              variant="outlined"
                              onDelete={() => {
                                const nextSpaces = spaces.filter((_, i) => i !== idx);
                                const hasBalconyFromSpaces = nextSpaces.some((x) => x.toLowerCase().includes("balcony"));
                                updateHomeProfileRecord({ spaces: nextSpaces, has_balcony: hasBalcony || hasBalconyFromSpaces });
                              }}
                            />
                          ))}
                        </Stack>
                      </Box>
                    )}

                    {(hasBalconySpace || hasTerraceSpace) && (
                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                        {hasBalconySpace && (
                          <TextField
                            label="Number of balconies (optional)"
                            type="number"
                            value={typeof balconyCount === "number" ? balconyCount : ""}
                            onChange={(e) => {
                              const next = asNumberOrNull(e.target.value);
                              updateHomeProfileRecord({
                                space_counts: { ...spaceCountsRaw, balcony: next ?? undefined },
                                has_balcony: true,
                              });
                            }}
                            fullWidth
                            size="small"
                            inputProps={{ min: 0, max: 50 }}
                          />
                        )}
                        {hasTerraceSpace && (
                          <TextField
                            label="Number of terraces (optional)"
                            type="number"
                            value={typeof terraceCount === "number" ? terraceCount : ""}
                            onChange={(e) => {
                              const next = asNumberOrNull(e.target.value);
                              updateHomeProfileRecord({
                                space_counts: { ...spaceCountsRaw, terrace: next ?? undefined },
                              });
                            }}
                            fullWidth
                            size="small"
                            inputProps={{ min: 0, max: 50 }}
                          />
                        )}
                      </Stack>
                    )}

                    <FormControlLabel
                      control={<Switch checked={hasBalcony} onChange={(e) => updateHomeProfileRecord({ has_balcony: e.target.checked })} />}
                      label="Has balcony"
                    />
                  </Stack>
                );
              }

              if (homeProfileWizardStep === 2) {
                return (
                  <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                      Household context — helps personalize schedules and recommendations.
                    </Typography>
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                      <FormControlLabel
                        control={<Switch checked={hasPets} onChange={(e) => updateHomeProfileRecord({ has_pets: e.target.checked })} />}
                        label="Pets"
                      />
                      <FormControlLabel
                        control={<Switch checked={hasKids} onChange={(e) => updateHomeProfileRecord({ has_kids: e.target.checked })} />}
                        label="Kids"
                      />
                    </Stack>
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                      <TextField
                        label="Balconies (optional)"
                        type="number"
                        value={typeof balconyCount === "number" ? balconyCount : ""}
                        onChange={(e) => {
                          const next = asNumberOrNull(e.target.value);
                          updateHomeProfileRecord({
                            space_counts: { ...spaceCountsRaw, balcony: next ?? undefined },
                            has_balcony: hasBalcony || (typeof next === "number" && next > 0),
                          });
                        }}
                        fullWidth
                        size="small"
                        inputProps={{ min: 0, max: 50 }}
                      />
                      <TextField
                        label="Bathrooms (optional)"
                        type="number"
                        value={typeof numBathrooms === "number" ? numBathrooms : ""}
                        onChange={(e) => updateHomeProfileRecord({ num_bathrooms: asNumberOrNull(e.target.value) })}
                        fullWidth
                        size="small"
                        inputProps={{ min: 0, max: 20 }}
                      />
                      <TextField
                        label="Flooring type (optional)"
                        value={flooringType}
                        onChange={(e) => updateHomeProfileRecord({ flooring_type: e.target.value || null })}
                        fullWidth
                        size="small"
                      />
                    </Stack>
                  </Stack>
                );
              }

              return (
                <Stack spacing={2}>
                  <Typography variant="body2" color="text.secondary">
                    Review your home profile. You can go back to edit anything.
                  </Typography>
                  <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                      {reviewLines.map((l) => `- ${l}`).join("\n")}
                    </Typography>
                  </Paper>
                </Stack>
              );
            })()}
          </Stack>
        </DialogContent>
        <DialogActions>
          {homeProfileMode === "view" ? (
            <>
              <Button variant="outlined" disabled={toolBusy || homeProfileBusy} onClick={closeHomeProfileWizard}>
                Close
              </Button>
              <Button
                variant="contained"
                disabled={toolBusy || homeProfileBusy || !homeProfileDraft}
                onClick={() => {
                  setHomeProfileMode("edit");
                  setHomeProfileWizardStep(0);
                }}
              >
                Edit
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outlined"
                disabled={toolBusy || homeProfileBusy}
                onClick={() => {
                  setHomeProfileDraft(null);
                  closeHomeProfileWizard();
                }}
              >
                Discard
              </Button>
              <Box sx={{ flex: 1 }} />
              <Button
                variant="text"
                disabled={homeProfileWizardStep === 0 || toolBusy || homeProfileBusy}
                onClick={goBackHomeProfileStep}
              >
                Back
              </Button>
              {homeProfileWizardStep < 3 ? (
                <Button variant="contained" disabled={toolBusy || homeProfileBusy || !homeProfileDraft} onClick={goNextHomeProfileStep}>
                  Next
                </Button>
              ) : (
                <Button
                  variant="contained"
                  disabled={toolBusy || homeProfileBusy || !homeProfileDraft}
                  onClick={async () => {
                    await saveHomeProfileDraft();
                    closeHomeProfileWizard();
                  }}
                >
                  Save
                </Button>
              )}
            </>
          )}
        </DialogActions>
      </Dialog>

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
