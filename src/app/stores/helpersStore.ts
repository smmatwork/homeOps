import { create } from "zustand";
import { supabase } from "../services/supabaseClient";
import { executeToolCall } from "../services/agentApi";

export type HelperRow = {
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

type Status = "idle" | "loading" | "ready" | "error";

const HELPER_COLUMNS =
  "id,household_id,name,type,phone,notes,daily_capacity_minutes,metadata,created_at";

export type DeleteHelperResult =
  | { ok: true; assignedCount: number }
  | { ok: false; error: string; assignedCount: number };

interface HelpersStoreState {
  helpers: HelperRow[];
  loadedHouseholdId: string | null;
  status: Status;
  error: string | null;
  version: number;

  load: (householdId: string, opts?: { force?: boolean }) => Promise<void>;
  invalidate: (householdId: string) => Promise<void>;
  setHelpers: (helpers: HelperRow[]) => void;
  patchHelper: (id: string, patch: Partial<HelperRow>) => void;
  removeHelper: (id: string) => void;
  deleteHelper: (params: {
    helperId: string;
    accessToken: string;
    householdId: string;
  }) => Promise<DeleteHelperResult>;
  reset: () => void;
}

export const useHelpersStore = create<HelpersStoreState>((set, get) => ({
  helpers: [],
  loadedHouseholdId: null,
  status: "idle",
  error: null,
  version: 0,

  load: async (householdId, opts) => {
    const hid = householdId.trim();
    if (!hid) {
      set({ helpers: [], loadedHouseholdId: null, status: "idle", error: null });
      return;
    }

    const state = get();
    const force = opts?.force === true;
    if (!force && state.loadedHouseholdId === hid && state.status === "ready") {
      return;
    }

    set({ status: "loading", error: null });
    const { data, error } = await supabase
      .from("helpers")
      .select(HELPER_COLUMNS)
      .eq("household_id", hid)
      .order("created_at", { ascending: false });

    if (error) {
      set({
        status: "error",
        error: error.message,
        loadedHouseholdId: hid,
        helpers: [],
        version: get().version + 1,
      });
      return;
    }

    set({
      helpers: (data ?? []) as HelperRow[],
      loadedHouseholdId: hid,
      status: "ready",
      error: null,
      version: get().version + 1,
    });
  },

  invalidate: async (householdId) => {
    await get().load(householdId, { force: true });
  },

  setHelpers: (helpers) => {
    set({ helpers, version: get().version + 1 });
  },

  patchHelper: (id, patch) => {
    set({
      helpers: get().helpers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
      version: get().version + 1,
    });
  },

  removeHelper: (id) => {
    set({
      helpers: get().helpers.filter((h) => h.id !== id),
      version: get().version + 1,
    });
  },

  deleteHelper: async ({ helperId, accessToken, householdId }) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid || !helperId) {
      return { ok: false, error: "Missing auth or helper id", assignedCount: 0 };
    }

    const { count } = await supabase
      .from("chores")
      .select("id", { count: "exact", head: true })
      .eq("household_id", hid)
      .eq("helper_id", helperId)
      .is("deleted_at", null);
    const assignedCount = count ?? 0;

    if (assignedCount > 0) {
      await supabase
        .from("chores")
        .update({ helper_id: null })
        .eq("household_id", hid)
        .eq("helper_id", helperId)
        .is("deleted_at", null);
    }

    await Promise.all([
      supabase.from("assignment_rules").delete().eq("household_id", hid).eq("helper_id", helperId),
      supabase.from("member_time_off").delete().eq("household_id", hid).eq("helper_id", helperId),
      supabase.from("helper_checkins").delete().eq("helper_id", helperId),
      supabase.from("helper_feedback").delete().eq("helper_id", helperId),
      supabase.from("helper_outreach_attempts").delete().eq("helper_id", helperId),
      supabase.from("assignment_decisions").delete().eq("helper_id", helperId),
      supabase
        .from("chore_templates")
        .update({ default_helper_id: null })
        .eq("household_id", hid)
        .eq("default_helper_id", helperId),
    ]);

    const res = await executeToolCall({
      accessToken: token,
      householdId: hid,
      scope: "household",
      toolCall: {
        id: `helpers_delete_${helperId}_${Date.now()}`,
        tool: "db.delete",
        args: { table: "helpers", id: helperId },
        reason: "Delete helper",
      },
    });

    if (!res.ok) {
      return {
        ok: false,
        error: "error" in res ? res.error : "Delete failed",
        assignedCount,
      };
    }

    set({
      helpers: get().helpers.filter((h) => h.id !== helperId),
      version: get().version + 1,
    });

    return { ok: true, assignedCount };
  },

  reset: () => {
    set({
      helpers: [],
      loadedHouseholdId: null,
      status: "idle",
      error: null,
      version: get().version + 1,
    });
  },
}));
