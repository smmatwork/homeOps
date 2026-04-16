import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Box, Button, Card, CardContent, CardHeader, Chip,
  Avatar, Typography, Stack, Tabs, Tab, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  CircularProgress,
  Snackbar,
  Alert,
  IconButton,
  Menu,
  MenuItem,
  FormControl,
  InputLabel,
  Select,
} from "@mui/material";
import { Phone, Schedule, Add, MoreVert, Delete } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import { useI18n } from "../../i18n";
import { HelperWorkloadCard } from "./HelperWorkloadCard";
import { HelperOnboardingFlow } from "./HelperOnboardingFlow";
import { HelperCard } from "./HelperCard";

type HelperRow = {
  id: string;
  household_id: string;
  name: string;
  type: string | null;
  phone: string | null;
  notes: string | null;
  daily_capacity_minutes: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type HelperPreferredLanguage = "en" | "hi" | "kn";

type HelperTimeOffRow = {
  id: string;
  household_id: string;
  helper_id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
  created_at: string;
};

type HelperFeedbackRow = {
  id: string;
  household_id: string;
  helper_id: string;
  author_id: string | null;
  rating: number;
  comment: string | null;
  occurred_at: string;
  created_at: string;
};

type HelperRewardRow = {
  id: string;
  household_id: string;
  helper_id: string;
  quarter: string;
  reward_type: string;
  amount: number | string | null;
  currency: string | null;
  reason: string | null;
  awarded_by: string | null;
  created_at: string;
};

type ChoreRow = {
  id: string;
  household_id: string;
  title: string;
  status: string;
  due_at: string | null;
  helper_id: string | null;
  deleted_at?: string | null;
};

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

function currentQuarterLabel(d: Date = new Date()): string {
  const y = d.getFullYear();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

const CATEGORIES = ["all", "cleaning", "maintenance", "outdoor", "childcare", "technology"] as const;

const initials = (name: string) =>
  name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();

function normalizeDatetimeLocal(raw: string): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfLocalDay(d: Date): Date {
  const x = startOfLocalDay(d);
  x.setDate(x.getDate() + 1);
  return x;
}

export function Helpers() {
  const { t } = useI18n();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [createHelperError, setCreateHelperError] = useState<string>("");
  const [createHelperBusy, setCreateHelperBusy] = useState(false);

  const { accessToken, householdId } = useAuth();
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [helpers, setHelpers] = useState<HelperRow[]>([]);
  const [todayBusy, setTodayBusy] = useState(false);
  const [todayChores, setTodayChores] = useState<ChoreRow[]>([]);

  const [snackOpen, setSnackOpen] = useState(false);
  const [snackSeverity, setSnackSeverity] = useState<"success" | "error" | "info">("success");
  const [snackMessage, setSnackMessage] = useState<string>("");

  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [newPreferredLanguage, setNewPreferredLanguage] = useState<HelperPreferredLanguage>("en");

  const [capacityOpen, setCapacityOpen] = useState(false);
  const [capacityHelper, setCapacityHelper] = useState<HelperRow | null>(null);
  const [capacityHours, setCapacityHours] = useState("2");
  const [capacityBusy, setCapacityBusy] = useState(false);

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleHelper, setScheduleHelper] = useState<HelperRow | null>(null);
  const [scheduleDays, setScheduleDays] = useState<Record<string, boolean>>({
    mon: true,
    tue: true,
    wed: true,
    thu: true,
    fri: true,
    sat: false,
    sun: false,
  });
  const [scheduleStart, setScheduleStart] = useState("09:00");
  const [scheduleEnd, setScheduleEnd] = useState("17:00");
  const [scheduleBusy, setScheduleBusy] = useState(false);

  const [timeOffOpen, setTimeOffOpen] = useState(false);
  const [timeOffHelper, setTimeOffHelper] = useState<HelperRow | null>(null);
  const [timeOffStart, setTimeOffStart] = useState("");
  const [timeOffEnd, setTimeOffEnd] = useState("");
  const [timeOffReason, setTimeOffReason] = useState("");
  const [timeOffBusy, setTimeOffBusy] = useState(false);
  const [timeOffRows, setTimeOffRows] = useState<HelperTimeOffRow[]>([]);

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackHelper, setFeedbackHelper] = useState<HelperRow | null>(null);
  const [feedbackRating, setFeedbackRating] = useState("5");
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackRows, setFeedbackRows] = useState<HelperFeedbackRow[]>([]);

  const [rewardsOpen, setRewardsOpen] = useState(false);
  const [rewardsHelper, setRewardsHelper] = useState<HelperRow | null>(null);
  const [rewardQuarter, setRewardQuarter] = useState(currentQuarterLabel());
  const [rewardType, setRewardType] = useState("bonus");
  const [rewardAmount, setRewardAmount] = useState("");
  const [rewardCurrency, setRewardCurrency] = useState("INR");
  const [rewardReason, setRewardReason] = useState("");
  const [rewardsBusy, setRewardsBusy] = useState(false);
  const [rewardRows, setRewardRows] = useState<HelperRewardRow[]>([]);

  const [helperMenuAnchor, setHelperMenuAnchor] = useState<HTMLElement | null>(null);
  const [helperMenuHelper, setHelperMenuHelper] = useState<HelperRow | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteHelperRow, setDeleteHelperRow] = useState<HelperRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [languageOpen, setLanguageOpen] = useState(false);
  const [languageHelper, setLanguageHelper] = useState<HelperRow | null>(null);
  const [languageValue, setLanguageValue] = useState<HelperPreferredLanguage>("en");
  const [languageBusy, setLanguageBusy] = useState(false);

  const showSnack = (severity: "success" | "error" | "info", message: string) => {
    setSnackSeverity(severity);
    setSnackMessage(message);
    setSnackOpen(true);
  };

  const openFeedback = async (helper: HelperRow) => {
    if (!accessToken || !householdId) return;
    setFeedbackHelper(helper);
    setFeedbackRating("5");
    setFeedbackComment("");
    setFeedbackRows([]);
    setFeedbackOpen(true);
    setFeedbackBusy(true);
    const { data, error } = await supabase
      .from("helper_feedback")
      .select("id, household_id, helper_id, author_id, rating, comment, occurred_at, created_at")
      .eq("household_id", householdId)
      .eq("helper_id", helper.id)
      .order("occurred_at", { ascending: false })
      .limit(10);
    setFeedbackBusy(false);
    if (error) {
      showSnack("error", error.message);
      return;
    }
    setFeedbackRows((data ?? []) as HelperFeedbackRow[]);
  };

  const submitFeedback = async () => {
    const token = accessToken;
    const hid = householdId;
    const helper = feedbackHelper;
    if (!token || !hid || !helper) return;

    const ratingNum = Number(feedbackRating);
    const rating = Number.isFinite(ratingNum) ? Math.round(ratingNum) : NaN;
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      showSnack("error", t("helpers.rating"));
      return;
    }

    setFeedbackBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helper_feedback_${helper.id}_${Date.now()}`,
        tool: "db.insert",
        args: {
          table: "helper_feedback",
          record: {
            household_id: hid,
            helper_id: helper.id,
            rating,
            comment: feedbackComment.trim() || null,
          },
        },
        reason: "Submit helper feedback",
      },
    });
    setFeedbackBusy(false);
    if (res.ok === false) {
      showSnack("error", res.error);
      return;
    }

    showSnack("success", t("helpers.feedback_submitted"));
    await openFeedback(helper);
  };

  const openRewards = async (helper: HelperRow) => {
    if (!accessToken || !householdId) return;
    setRewardsHelper(helper);
    setRewardQuarter(currentQuarterLabel());
    setRewardType("bonus");
    setRewardAmount("");
    setRewardCurrency("INR");
    setRewardReason("");
    setRewardRows([]);
    setRewardsOpen(true);
    setRewardsBusy(true);
    const { data, error } = await supabase
      .from("helper_rewards")
      .select("id, household_id, helper_id, quarter, reward_type, amount, currency, reason, awarded_by, created_at")
      .eq("household_id", householdId)
      .eq("helper_id", helper.id)
      .order("created_at", { ascending: false })
      .limit(10);
    setRewardsBusy(false);
    if (error) {
      showSnack("error", error.message);
      return;
    }
    setRewardRows((data ?? []) as HelperRewardRow[]);
  };

  const submitReward = async () => {
    const token = accessToken;
    const hid = householdId;
    const helper = rewardsHelper;
    if (!token || !hid || !helper) return;

    const quarter = rewardQuarter.trim();
    const type = rewardType.trim();
    if (!quarter || !type) return;

    const amountRaw = rewardAmount.trim();
    const amount = amountRaw ? Number(amountRaw) : null;
    if (amountRaw && (!Number.isFinite(amount) || amount < 0)) {
      showSnack("error", t("helpers.amount_optional"));
      return;
    }

    setRewardsBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helper_reward_${helper.id}_${Date.now()}`,
        tool: "db.insert",
        args: {
          table: "helper_rewards",
          record: {
            household_id: hid,
            helper_id: helper.id,
            quarter,
            reward_type: type,
            amount,
            currency: rewardCurrency.trim() || null,
            reason: rewardReason.trim() || null,
          },
        },
        reason: "Create helper quarterly reward",
      },
    });
    setRewardsBusy(false);
    if (res.ok === false) {
      showSnack("error", res.error);
      return;
    }

    showSnack("success", t("helpers.reward_created"));
    await openRewards(helper);
  };

  const getPreferredLanguage = (helper: HelperRow): HelperPreferredLanguage => {
    const meta = helper.metadata && typeof helper.metadata === "object" && !Array.isArray(helper.metadata) ? (helper.metadata as any) : {};
    const raw = typeof meta.preferred_language === "string" ? String(meta.preferred_language).trim() : "";
    if (raw === "hi" || raw === "kn" || raw === "en") return raw;
    return "en";
  };

  const openLanguageDialog = (helper: HelperRow) => {
    closeHelperMenu();
    setLanguageHelper(helper);
    setLanguageValue(getPreferredLanguage(helper));
    setLanguageOpen(true);
  };

  const savePreferredLanguage = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const helper = languageHelper;
    if (!token || !hid || !helper) return;

    const existingMeta = helper.metadata && typeof helper.metadata === "object" && !Array.isArray(helper.metadata) ? (helper.metadata as any) : {};
    const nextMeta = { ...existingMeta, preferred_language: languageValue };

    setLanguageBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helpers_language_${helper.id}_${Date.now()}`,
        tool: "db.update",
        args: { table: "helpers", id: helper.id, patch: { metadata: nextMeta } },
        reason: "Update helper preferred language",
      },
    });
    setLanguageBusy(false);
    if (!res.ok) {
      showSnack("error", "error" in res ? res.error : t("common.update_failed"));
      return;
    }

    setHelpers((prev) => prev.map((h) => (h.id === helper.id ? { ...h, metadata: nextMeta } : h)));
    setLanguageOpen(false);
    setLanguageHelper(null);
    showSnack("success", t("helpers.language_updated"));
  };

  const openCapacity = (helper: HelperRow) => {
    setCapacityHelper(helper);
    const mins = typeof helper.daily_capacity_minutes === "number" && Number.isFinite(helper.daily_capacity_minutes)
      ? helper.daily_capacity_minutes
      : 120;
    setCapacityHours(String(Math.max(0, mins / 60)));
    setCapacityOpen(true);
  };

  const getScheduleFromHelper = (helper: HelperRow): { days: Record<string, boolean>; start: string; end: string } => {
    const meta = helper.metadata && typeof helper.metadata === "object" && !Array.isArray(helper.metadata) ? (helper.metadata as any) : {};
    const sched = meta.schedule && typeof meta.schedule === "object" && !Array.isArray(meta.schedule) ? (meta.schedule as any) : {};

    const daysRaw = sched.days && typeof sched.days === "object" && !Array.isArray(sched.days) ? (sched.days as any) : {};
    const dayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const days: Record<string, boolean> = {
      mon: true,
      tue: true,
      wed: true,
      thu: true,
      fri: true,
      sat: false,
      sun: false,
    };
    for (const k of dayKeys) {
      if (typeof daysRaw[k] === "boolean") days[k] = daysRaw[k];
    }

    const start = typeof sched.start === "string" && /^\d{2}:\d{2}$/.test(sched.start) ? sched.start : "09:00";
    const end = typeof sched.end === "string" && /^\d{2}:\d{2}$/.test(sched.end) ? sched.end : "17:00";
    return { days, start, end };
  };

  const scheduleSummary = (helper: HelperRow): string => {
    const { days, start, end } = getScheduleFromHelper(helper);
    const parts: string[] = [];
    const push = (key: string, label: string) => {
      if (days[key]) parts.push(label);
    };
    push("mon", t("weekday.mon"));
    push("tue", t("weekday.tue"));
    push("wed", t("weekday.wed"));
    push("thu", t("weekday.thu"));
    push("fri", t("weekday.fri"));
    push("sat", t("weekday.sat"));
    push("sun", t("weekday.sun"));
    const dayStr = parts.length === 0 ? t("helpers.no_days") : parts.join(" ");
    return `${dayStr} · ${start}-${end}`;
  };

  const openSchedule = (helper: HelperRow) => {
    setScheduleHelper(helper);
    const sched = getScheduleFromHelper(helper);
    setScheduleDays(sched.days);
    setScheduleStart(sched.start);
    setScheduleEnd(sched.end);
    setScheduleOpen(true);
  };

  const saveSchedule = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const helper = scheduleHelper;
    if (!token || !hid || !helper) return;

    const start = (scheduleStart ?? "").trim();
    const end = (scheduleEnd ?? "").trim();
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      showSnack("error", t("helpers.enter_valid_times"));
      return;
    }

    const existingMeta = helper.metadata && typeof helper.metadata === "object" && !Array.isArray(helper.metadata) ? (helper.metadata as any) : {};
    const nextMeta = {
      ...existingMeta,
      schedule: {
        days: scheduleDays,
        start,
        end,
      },
    };

    setScheduleBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helpers_schedule_${helper.id}_${Date.now()}`,
        tool: "db.update",
        args: {
          table: "helpers",
          id: helper.id,
          patch: { metadata: nextMeta },
        },
        reason: "Update helper schedule",
      },
    });
    setScheduleBusy(false);
    if (!res.ok) {
      showSnack("error", "error" in res ? res.error : t("common.update_failed"));
      return;
    }

    setHelpers((prev) => prev.map((h) => (h.id === helper.id ? { ...h, metadata: nextMeta } : h)));
    setScheduleOpen(false);
    setScheduleHelper(null);
    showSnack("success", t("helpers.helper_schedule_updated"));
  };

  const saveCapacity = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const helper = capacityHelper;
    if (!token || !hid || !helper) return;

    const hoursNum = Number(capacityHours);
    if (!Number.isFinite(hoursNum) || hoursNum < 0 || hoursNum > 24) {
      showSnack("error", t("helpers.enter_valid_hours"));
      return;
    }
    const minutes = Math.round(hoursNum * 60);

    setCapacityBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helpers_capacity_${helper.id}_${Date.now()}`,
        tool: "db.update",
        args: {
          table: "helpers",
          id: helper.id,
          patch: { daily_capacity_minutes: minutes },
        },
        reason: "Update helper daily capacity",
      },
    });
    setCapacityBusy(false);
    if (!res.ok) {
      showSnack("error", "error" in res ? res.error : t("common.update_failed"));
      return;
    }

    setHelpers((prev) => prev.map((h) => (h.id === helper.id ? { ...h, daily_capacity_minutes: minutes } : h)));
    setCapacityOpen(false);
    setCapacityHelper(null);
    showSnack("success", t("helpers.helper_capacity_updated"));
  };

  useEffect(() => {
    if (!householdId.trim()) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from("helpers")
        .select("id,household_id,name,type,phone,notes,daily_capacity_minutes,metadata,created_at")
        .eq("household_id", householdId.trim())
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setBusy(false);
      if (error) {
        setLoadError(error.message);
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
      const start = startOfLocalDay(new Date());
      const end = endOfLocalDay(start);
      setTodayBusy(true);
      const { data, error } = await supabase
        .from("chores")
        .select("id,household_id,title,status,due_at,helper_id,deleted_at")
        .eq("household_id", hid)
        .is("deleted_at", null)
        .gte("due_at", start.toISOString())
        .lt("due_at", end.toISOString())
        .order("due_at", { ascending: true });
      if (cancelled) return;
      setTodayBusy(false);
      if (error) {
        setTodayChores([]);
        return;
      }
      setTodayChores((data ?? []) as ChoreRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  const filtered = useMemo(() => {
    if (category === "all") return helpers;
    const needle = String(category).toLowerCase();
    return helpers.filter((h) => (h.type ?? "").toLowerCase().includes(needle));
  }, [helpers, category]);

  const unassignedToday = useMemo(() => todayChores.filter((c) => !c.helper_id), [todayChores]);

  const createHelper = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) {
      setCreateHelperError(t("common.missing_session"));
      showSnack("error", t("common.missing_session"));
      return;
    }
    if (!newName.trim()) {
      setCreateHelperError(t("helpers.name_required"));
      showSnack("error", t("helpers.name_required"));
      return;
    }

    setCreateHelperBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helpers_create_${Date.now()}`,
        tool: "db.insert",
        args: {
          table: "helpers",
          record: {
            name: newName.trim(),
            type: newType.trim() || null,
            phone: newPhone.trim() || null,
            notes: newNotes.trim() || null,
            metadata: {
              preferred_language: newPreferredLanguage,
            },
          },
        },
        reason: "Create helper",
      },
    });
    setCreateHelperBusy(false);

    if (!res.ok) {
      const msg = "error" in res ? res.error : t("common.create_failed");
      setCreateHelperError(msg);
      showSnack("error", msg);
      return;
    }

    setDialogOpen(false);
    setCreateHelperError("");
    setNewName("");
    setNewType("");
    setNewPhone("");
    setNewNotes("");
    setNewPreferredLanguage("en");

    const { data, error } = await supabase
      .from("helpers")
      .select("id,household_id,name,type,phone,notes,daily_capacity_minutes,metadata,created_at")
      .eq("household_id", hid)
      .order("created_at", { ascending: false });
    if (error) {
      showSnack("error", error.message);
      return;
    }
    setHelpers((data ?? []) as HelperRow[]);
    showSnack("success", t("helpers.helper_created"));
  };

  const openTimeOff = async (helper: HelperRow) => {
    const hid = householdId.trim();
    if (!hid) return;
    setTimeOffHelper(helper);
    setTimeOffOpen(true);
    setTimeOffStart("");
    setTimeOffEnd("");
    setTimeOffReason("");
    setTimeOffRows([]);
    setTimeOffBusy(true);
    const { data, error } = await supabase
      .from("member_time_off")
      .select("id,household_id,member_kind,helper_id,start_at,end_at,reason,created_at")
      .eq("household_id", hid)
      .eq("member_kind", "helper")
      .eq("helper_id", helper.id)
      .order("start_at", { ascending: false })
      .limit(20);
    setTimeOffBusy(false);
    if (error) {
      showSnack("error", error.message);
      return;
    }
    setTimeOffRows((data ?? []) as HelperTimeOffRow[]);
  };

  const createTimeOff = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const helper = timeOffHelper;
    if (!token || !hid || !helper) return;

    const startIso = normalizeDatetimeLocal(timeOffStart);
    const endIso = normalizeDatetimeLocal(timeOffEnd);
    if (!startIso || !endIso) {
      showSnack("error", t("helpers.start_end_required"));
      return;
    }

    setTimeOffBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `time_off_create_${helper.id}_${Date.now()}`,
        tool: "db.insert",
        args: {
          table: "member_time_off",
          record: {
            member_kind: "helper",
            helper_id: helper.id,
            start_at: startIso,
            end_at: endIso,
            reason: timeOffReason.trim() || null,
          },
        },
        reason: "Add helper time off",
      },
    });
    setTimeOffBusy(false);
    if (!res.ok) {
      showSnack("error", "error" in res ? res.error : t("common.create_failed"));
      return;
    }

    await openTimeOff(helper);
    showSnack("success", t("helpers.time_off_added"));
  };

  const deleteTimeOff = async (rowId: string) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const helper = timeOffHelper;
    if (!token || !hid || !helper || !rowId.trim()) return;
    setTimeOffBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: { id: `time_off_delete_${rowId}_${Date.now()}`, tool: "db.delete", args: { table: "member_time_off", id: rowId }, reason: "Delete helper time off" },
    });
    setTimeOffBusy(false);
    if (!res.ok) {
      showSnack("error", "error" in res ? res.error : t("common.delete_failed"));
      return;
    }
    await openTimeOff(helper);
  };

  const openHelperMenu = (e: MouseEvent<HTMLElement>, helper: HelperRow) => {
    setHelperMenuAnchor(e.currentTarget);
    setHelperMenuHelper(helper);
  };

  const closeHelperMenu = () => {
    setHelperMenuAnchor(null);
    setHelperMenuHelper(null);
  };

  const openDeleteHelper = (helper: HelperRow) => {
    closeHelperMenu();
    setDeleteHelperRow(helper);
    setDeleteOpen(true);
  };

  const confirmDeleteHelper = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    const helper = deleteHelperRow;
    if (!token || !hid || !helper) return;

    setDeleteBusy(true);
    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helpers_delete_${helper.id}_${Date.now()}`,
        tool: "db.delete",
        args: { table: "helpers", id: helper.id },
        reason: "Delete helper",
      },
    });
    setDeleteBusy(false);
    if (!res.ok) {
      showSnack("error", "error" in res ? res.error : t("common.delete_failed"));
      return;
    }

    setHelpers((prev) => prev.filter((h) => h.id !== helper.id));
    setDeleteOpen(false);
    setDeleteHelperRow(null);
    showSnack("success", t("helpers.helper_deleted"));
  };

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 1200, mx: "auto" }}>
      {/* ── Page header ─────────────────────────────────────────────── */}
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight={700}>
            {t("helpers.title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("helpers.subtitle")}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" startIcon={<Add />} onClick={() => setOnboardingOpen(true)}>
            {t("helpers.add_helper")}
          </Button>
        </Stack>
      </Stack>

      {/* ── Workload summary ────────────────────────────────────────── */}
      <Box mb={3}>
        <HelperWorkloadCard />
      </Box>

      {/* ── Helper menu ─────────────────────────────────────────────── */}
      <Menu
        anchorEl={helperMenuAnchor}
        open={Boolean(helperMenuAnchor)}
        onClose={closeHelperMenu}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem onClick={() => { if (helperMenuHelper) openLanguageDialog(helperMenuHelper); }}>
          {t("helpers.set_language")}
        </MenuItem>
        <MenuItem onClick={() => { if (helperMenuHelper) openDeleteHelper(helperMenuHelper); }}>
          <Delete fontSize="small" style={{ marginRight: 8 }} />
          {t("helpers.delete_helper")}
        </MenuItem>
      </Menu>

      {/* ── Language dialog ──────────────────────────────────────────── */}
      <Dialog open={languageOpen} onClose={() => (languageBusy ? null : setLanguageOpen(false))} maxWidth="xs" fullWidth>
        <DialogTitle>{t("helpers.set_language_title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="subtitle2">{languageHelper?.name ?? ""}</Typography>
            <FormControl fullWidth size="small">
              <InputLabel>{t("helpers.language")}</InputLabel>
              <Select label={t("helpers.language")} value={languageValue} onChange={(e) => setLanguageValue(String(e.target.value) as HelperPreferredLanguage)}>
                <MenuItem value="en">{t("helpers.lang.en")}</MenuItem>
                <MenuItem value="hi">{t("helpers.lang.hi")}</MenuItem>
                <MenuItem value="kn">{t("helpers.lang.kn")}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLanguageOpen(false)} disabled={languageBusy}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={() => void savePreferredLanguage()} disabled={languageBusy || !languageHelper}>{t("common.save")}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={rewardsOpen} onClose={() => (rewardsBusy ? null : setRewardsOpen(false))} maxWidth="sm" fullWidth>
        <DialogTitle>{t("helpers.rewards")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="subtitle2">{rewardsHelper?.name ?? ""}</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField
                label={t("helpers.quarter")}
                fullWidth
                size="small"
                value={rewardQuarter}
                onChange={(e) => setRewardQuarter(e.target.value)}
              />
              <TextField
                label={t("helpers.reward_type")}
                fullWidth
                size="small"
                value={rewardType}
                onChange={(e) => setRewardType(e.target.value)}
              />
            </Stack>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField
                label={t("helpers.amount_optional")}
                fullWidth
                size="small"
                value={rewardAmount}
                onChange={(e) => setRewardAmount(e.target.value)}
              />
              <TextField
                label={t("helpers.currency_optional")}
                fullWidth
                size="small"
                value={rewardCurrency}
                onChange={(e) => setRewardCurrency(e.target.value)}
              />
            </Stack>
            <TextField
              label={t("helpers.reward_reason_optional")}
              fullWidth
              size="small"
              value={rewardReason}
              onChange={(e) => setRewardReason(e.target.value)}
            />

            <Button variant="contained" disabled={rewardsBusy} onClick={() => void submitReward()} sx={{ alignSelf: "flex-start" }}>
              {t("helpers.submit_reward")}
            </Button>

            <Divider />
            <Typography variant="subtitle2">{t("helpers.recent_rewards")}</Typography>
            {rewardsBusy && rewardRows.length === 0 ? (
              <Box display="flex" justifyContent="center" py={2}>
                <CircularProgress size={20} />
              </Box>
            ) : null}
            {rewardRows.map((r) => (
              <Box key={r.id}>
                <Typography variant="body2">
                  {r.quarter} · {r.reward_type}
                  {r.amount !== null && r.amount !== undefined && String(r.amount).trim() !== ""
                    ? ` · ${String(r.amount)}${r.currency ? ` ${r.currency}` : ""}`
                    : ""}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {localDateTimeLabel(r.created_at)}{r.reason ? ` · ${r.reason}` : ""}
                </Typography>
              </Box>
            ))}
            {!rewardsBusy && rewardRows.length === 0 ? (
              <Typography variant="body2" color="text.secondary">{t("helpers.no_rewards")}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRewardsOpen(false)}>{t("common.close")}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={feedbackOpen} onClose={() => (feedbackBusy ? null : setFeedbackOpen(false))} maxWidth="sm" fullWidth>
        <DialogTitle>{t("helpers.feedback")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="subtitle2">{feedbackHelper?.name ?? ""}</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <FormControl fullWidth size="small">
                <InputLabel>{t("helpers.rating")}</InputLabel>
                <Select
                  label={t("helpers.rating")}
                  value={feedbackRating}
                  onChange={(e) => setFeedbackRating(String(e.target.value))}
                >
                  <MenuItem value="5">5</MenuItem>
                  <MenuItem value="4">4</MenuItem>
                  <MenuItem value="3">3</MenuItem>
                  <MenuItem value="2">2</MenuItem>
                  <MenuItem value="1">1</MenuItem>
                </Select>
              </FormControl>
              <TextField
                label={t("helpers.comment_optional")}
                fullWidth
                size="small"
                value={feedbackComment}
                onChange={(e) => setFeedbackComment(e.target.value)}
              />
            </Stack>

            <Button variant="contained" disabled={feedbackBusy} onClick={() => void submitFeedback()} sx={{ alignSelf: "flex-start" }}>
              {t("helpers.submit_feedback")}
            </Button>

            <Divider />
            <Typography variant="subtitle2">{t("helpers.recent_feedback")}</Typography>
            {feedbackBusy && feedbackRows.length === 0 ? (
              <Box display="flex" justifyContent="center" py={2}>
                <CircularProgress size={20} />
              </Box>
            ) : null}
            {feedbackRows.map((r) => (
              <Box key={r.id}>
                <Typography variant="body2">
                  {r.rating}/5 · {localDateTimeLabel(r.occurred_at || r.created_at)}
                </Typography>
                {r.comment ? <Typography variant="caption" color="text.secondary">{r.comment}</Typography> : null}
              </Box>
            ))}
            {!feedbackBusy && feedbackRows.length === 0 ? (
              <Typography variant="body2" color="text.secondary">{t("helpers.no_feedback")}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFeedbackOpen(false)}>{t("common.close")}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={deleteOpen} onClose={() => (deleteBusy ? null : setDeleteOpen(false))} maxWidth="xs" fullWidth>
        <DialogTitle>{t("helpers.delete_helper_title")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mt={1}>
            {t("helpers.delete_helper_confirm")}
          </Typography>
          <Typography variant="subtitle2" mt={2}>
            {deleteHelperRow?.name ?? ""}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => void confirmDeleteHelper()}
            disabled={deleteBusy || !deleteHelperRow}
          >
            {t("common.delete")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Helper grid ──────────────────────────────────────────────── */}
      {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}

      {busy && helpers.length === 0 ? (
        <Box display="flex" justifyContent="center" py={6}>
          <CircularProgress />
        </Box>
      ) : helpers.length === 0 ? (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: "center", py: 6 }}>
            <Typography variant="h6" color="text.secondary" gutterBottom>
              {t("helpers.empty_title")}
            </Typography>
            <Typography variant="body2" color="text.secondary" mb={2}>
              {t("helpers.empty_subtitle")}
            </Typography>
            <Button variant="contained" startIcon={<Add />} onClick={() => setOnboardingOpen(true)}>
              {t("helpers.add_helper")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(320px, 1fr))" gap={2}>
          {helpers.map((helper) => (
            <HelperCard
              key={helper.id}
              helper={helper}
              scheduleSummary={scheduleSummary(helper)}
              onMenuOpen={(e) => openHelperMenu(e, helper)}
              onCapacity={() => openCapacity(helper)}
              onSchedule={() => openSchedule(helper)}
              onTimeOff={() => void openTimeOff(helper)}
              onFeedback={() => void openFeedback(helper)}
              onRewards={() => void openRewards(helper)}
            />
          ))}
        </Box>
      )}

      <HelperOnboardingFlow
        open={onboardingOpen}
        onClose={() => setOnboardingOpen(false)}
        onSuccess={() => {
          // Refresh the helpers list so the new helper appears.
          // Mirrors the inline refresh pattern used by the legacy
          // createHelper() path above.
          void (async () => {
            const hid = householdId.trim();
            if (!hid) return;
            const { data, error } = await supabase
              .from("helpers")
              .select("id,household_id,name,type,phone,notes,daily_capacity_minutes,metadata,created_at")
              .eq("household_id", hid)
              .order("created_at", { ascending: false });
            if (error) {
              showSnack("error", error.message);
              return;
            }
            setHelpers((data ?? []) as HelperRow[]);
            showSnack("success", t("helpers.helper_created"));
          })();
        }}
      />

      <Dialog open={scheduleOpen} onClose={() => setScheduleOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("helpers.helper_schedule")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="subtitle2">{scheduleHelper?.name ?? ""}</Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {([
                ["mon", t("weekday.mon")],
                ["tue", t("weekday.tue")],
                ["wed", t("weekday.wed")],
                ["thu", t("weekday.thu")],
                ["fri", t("weekday.fri")],
                ["sat", t("weekday.sat")],
                ["sun", t("weekday.sun")],
              ] as const).map(([key, label]) => (
                <Chip
                  key={key}
                  label={label}
                  variant={scheduleDays[key] ? "filled" : "outlined"}
                  color={scheduleDays[key] ? "primary" : "default"}
                  onClick={() => setScheduleDays((prev) => ({ ...prev, [key]: !prev[key] }))}
                  sx={{ mb: 1 }}
                />
              ))}
            </Stack>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField label={t("common.start")} type="time" fullWidth size="small" value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} InputLabelProps={{ shrink: true }} />
              <TextField label={t("common.end")} type="time" fullWidth size="small" value={scheduleEnd} onChange={(e) => setScheduleEnd(e.target.value)} InputLabelProps={{ shrink: true }} />
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setScheduleOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="contained" disabled={scheduleBusy} onClick={() => void saveSchedule()}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={capacityOpen} onClose={() => setCapacityOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("helpers.helper_capacity")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="subtitle2">{capacityHelper?.name ?? ""}</Typography>
            <TextField label={t("helpers.hours_per_day")} fullWidth size="small" value={capacityHours} onChange={(e) => setCapacityHours(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCapacityOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="contained" disabled={capacityBusy} onClick={() => void saveCapacity()}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={timeOffOpen} onClose={() => setTimeOffOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t("helpers.helper_time_off")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="subtitle2">{timeOffHelper?.name ?? ""}</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField label={t("common.start")} type="datetime-local" fullWidth size="small" value={timeOffStart} onChange={(e) => setTimeOffStart(e.target.value)} InputLabelProps={{ shrink: true }} />
              <TextField label={t("common.end")} type="datetime-local" fullWidth size="small" value={timeOffEnd} onChange={(e) => setTimeOffEnd(e.target.value)} InputLabelProps={{ shrink: true }} />
            </Stack>
            <TextField label={t("helpers.reason")} fullWidth size="small" value={timeOffReason} onChange={(e) => setTimeOffReason(e.target.value)} />

            <Button variant="contained" disabled={timeOffBusy} onClick={() => void createTimeOff()} sx={{ alignSelf: "flex-start" }}>
              {t("helpers.add_time_off")}
            </Button>

            <Divider />
            <Typography variant="subtitle2">{t("helpers.recent_time_off")}</Typography>
            {timeOffBusy && timeOffRows.length === 0 ? (
              <Box display="flex" justifyContent="center" py={2}>
                <CircularProgress size={20} />
              </Box>
            ) : null}
            {timeOffRows.map((r) => (
              <Box key={r.id} display="flex" alignItems="flex-start" justifyContent="space-between" gap={2}>
                <Box>
                  <Typography variant="body2">
                    {localDateTimeLabel(r.start_at)} → {localDateTimeLabel(r.end_at)}
                  </Typography>
                  {r.reason ? (
                    <Typography variant="caption" color="text.secondary">
                      {r.reason}
                    </Typography>
                  ) : null}
                </Box>
                <IconButton size="small" disabled={timeOffBusy} onClick={() => void deleteTimeOff(r.id)}>
                  <Delete fontSize="small" />
                </IconButton>
              </Box>
            ))}
            {!timeOffBusy && timeOffRows.length === 0 ? (
              <Typography variant="body2" color="text.secondary">{t("helpers.no_time_off")}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTimeOffOpen(false)}>{t("common.close")}</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackOpen}
        autoHideDuration={3000}
        onClose={() => setSnackOpen(false)}
      >
        <Alert onClose={() => setSnackOpen(false)} severity={snackSeverity} variant="filled" sx={{ width: "100%" }}>
          {snackMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
}
