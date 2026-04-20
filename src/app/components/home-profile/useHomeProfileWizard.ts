import { useState, useCallback, useEffect, useRef } from "react";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import type { ChatScope } from "../../services/agentApi";
import type { ToolCall } from "../../services/agentActions";
import { normalizeSpacesToRooms, type RoomEntry } from "../../config/homeProfileTemplates";
import type { AgentCreateAction } from "../../services/agentActions";

export type HomeProfileDraft = {
  id: string;
  action: AgentCreateAction;
};

// ---------------------------------------------------------------------------
// Draft persistence — keep unsaved edits in localStorage so the user doesn't
// lose work if they close the dialog, refresh the page, or hit a save error.
// ---------------------------------------------------------------------------

interface PersistedDraft {
  draft: HomeProfileDraft;
  step: number;
  mode: "view" | "edit";
  savedAt: string;
}

function draftStorageKey(householdId: string): string {
  return `homeops.home_profile.draft.v1.${householdId || "anon"}`;
}

function loadPersistedDraft(householdId: string): PersistedDraft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(householdId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraft;
    if (!parsed?.draft?.action?.record) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersistedDraft(householdId: string, persisted: PersistedDraft): void {
  try {
    localStorage.setItem(draftStorageKey(householdId), JSON.stringify(persisted));
  } catch {
    // ignore quota / permission errors
  }
}

function clearPersistedDraft(householdId: string): void {
  try {
    localStorage.removeItem(draftStorageKey(householdId));
  } catch {
    // ignore
  }
}

export function hasPersistedDraft(householdId: string): boolean {
  return loadPersistedDraft(householdId) !== null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export const HOME_PROFILE_TOTAL_STEPS = 4; // 0=template, 1=rooms, 2=household, 3=review

interface UseHomeProfileWizardParams {
  getAgentSetup: () => { token: string; householdId: string };
  memoryScope: ChatScope;
  appendAssistantMessage: (text: string) => void;
  setToolBusy: (busy: boolean) => void;
  setToolError: (error: string | null) => void;
  setToolSuccess: (success: string | null) => void;
}

export function useHomeProfileWizard(params: UseHomeProfileWizardParams) {
  const { getAgentSetup, memoryScope, appendAssistantMessage, setToolBusy, setToolError, setToolSuccess } = params;

  const [homeProfileDraft, setHomeProfileDraft] = useState<HomeProfileDraft | null>(null);
  const [homeProfileBusy, setHomeProfileBusy] = useState(false);
  const [homeProfileError, setHomeProfileError] = useState<string | null>(null);
  const [homeProfileWizardOpen, setHomeProfileWizardOpen] = useState(false);
  const [homeProfileWizardStep, setHomeProfileWizardStep] = useState(0);
  const [homeProfileNewSpace, setHomeProfileNewSpace] = useState("");
  const [homeProfileMode, setHomeProfileMode] = useState<"view" | "edit">("edit");
  const [homeProfileExists, setHomeProfileExists] = useState(false);

  // ── Draft persistence ────────────────────────────────────────────────────
  // Auto-save the draft to localStorage on every change so the user doesn't
  // lose work if the dialog closes, the page refreshes, or save fails.
  // Cleared after a successful save.
  const skipNextPersistRef = useRef(true);
  useEffect(() => {
    // Skip the very first render so we don't immediately persist the
    // initial-null state and clobber any existing saved draft.
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    const { householdId } = getAgentSetup();
    if (!householdId) return;
    if (!homeProfileDraft) return;
    // Only persist edit-mode drafts (view mode is just rendering saved data).
    if (homeProfileMode !== "edit") return;
    savePersistedDraft(householdId, {
      draft: homeProfileDraft,
      step: homeProfileWizardStep,
      mode: homeProfileMode,
      savedAt: new Date().toISOString(),
    });
  }, [homeProfileDraft, homeProfileWizardStep, homeProfileMode, getAgentSetup]);

  /** Restore a previously saved draft (if any) into the wizard state. */
  const restorePersistedDraft = useCallback((): boolean => {
    const { householdId } = getAgentSetup();
    if (!householdId) return false;
    const persisted = loadPersistedDraft(householdId);
    if (!persisted) return false;
    setHomeProfileDraft(persisted.draft);
    setHomeProfileWizardStep(persisted.step);
    setHomeProfileMode(persisted.mode);
    setHomeProfileWizardOpen(true);
    setHomeProfileError(null);
    return true;
  }, [getAgentSetup]);

  /** Discard any persisted draft from localStorage. */
  const discardPersistedDraft = useCallback(() => {
    const { householdId } = getAgentSetup();
    if (!householdId) return;
    clearPersistedDraft(householdId);
  }, [getAgentSetup]);

  const reviewHomeProfile = useCallback(async () => {
    setHomeProfileError(null);
    const { householdId } = getAgentSetup();
    if (!householdId) {
      setHomeProfileError("Missing household_id. Click Agent Setup to confirm your home is linked.");
      return;
    }

    setHomeProfileBusy(true);
    let { data, error } = await supabase
      .from("home_profiles")
      .select("home_type, bhk, square_feet, floors, spaces, space_counts, has_balcony, has_pets, has_kids, flooring_type, num_bathrooms")
      .eq("household_id", householdId)
      .maybeSingle();

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

    const normalizedRooms = normalizeSpacesToRooms((data as any)?.spaces);

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
          spaces: normalizedRooms,
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

    if (error) return;
    setHomeProfileExists(Array.isArray(data) && data.length > 0);
  }, [getAgentSetup]);

  function withHouseholdId(tc: ToolCall, householdId: string): ToolCall {
    const args = (tc.args ?? {}) as Record<string, unknown>;
    return { ...tc, args: { ...args, household_id: householdId } };
  }

  const saveHomeProfileDraft = useCallback(async (): Promise<boolean> => {
    if (!homeProfileDraft) return false;
    setToolError(null);
    setToolSuccess(null);
    setHomeProfileError(null);
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      const msg = "Missing access_token or household_id. Click Agent Setup to confirm your session token + household id.";
      setToolError(msg);
      setHomeProfileError(msg);
      return false;
    }

    setToolBusy(true);

    const rawRecord = homeProfileDraft.action.record as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { __template_key: _dropped, ...cleanRecord } = rawRecord;
    const rooms = normalizeSpacesToRooms(rawRecord.spaces);
    const savedRecord = { ...cleanRecord, spaces: rooms };

    const tc: ToolCall = {
      id: `hp_${Date.now()}`,
      tool: "db.insert",
      args: {
        table: "home_profiles",
        record: savedRecord,
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
      const errMsg = "error" in res ? res.error : "Couldn't save the home profile";
      setToolError(errMsg);
      setHomeProfileError(errMsg);
      return false;
    }

    setToolSuccess(res.summary);
    appendAssistantMessage(res.summary);
    // Clear the persisted draft now that the changes are safely on the server.
    clearPersistedDraft(householdId);
    setHomeProfileDraft(null);
    setHomeProfileExists(true);
    return true;
  }, [homeProfileDraft, memoryScope, appendAssistantMessage, getAgentSetup, setToolBusy, setToolError, setToolSuccess]);

  const openHomeProfileWizard = useCallback(() => {
    // Clear any stale "no profile yet" error from a previous load attempt.
    setHomeProfileError(null);
    if (homeProfileExists) {
      void reviewHomeProfile();
      return;
    }
    setHomeProfileDraft(null);
    setHomeProfileMode("edit");
    setHomeProfileWizardStep(0);
    setHomeProfileWizardOpen(true);
  }, [homeProfileExists, reviewHomeProfile]);

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
    setHomeProfileWizardStep((s) => Math.min(HOME_PROFILE_TOTAL_STEPS - 1, s + 1));
  }, []);

  const goBackHomeProfileStep = useCallback(() => {
    setHomeProfileWizardStep((s) => Math.max(0, s - 1));
  }, []);

  return {
    // State
    homeProfileDraft,
    setHomeProfileDraft,
    homeProfileBusy,
    homeProfileError,
    homeProfileWizardOpen,
    setHomeProfileWizardOpen,
    homeProfileWizardStep,
    setHomeProfileWizardStep,
    homeProfileNewSpace,
    setHomeProfileNewSpace,
    homeProfileMode,
    setHomeProfileMode,
    homeProfileExists,
    // Actions
    reviewHomeProfile,
    refreshHomeProfileExists,
    saveHomeProfileDraft,
    openHomeProfileWizard,
    closeHomeProfileWizard,
    updateHomeProfileRecord,
    goNextHomeProfileStep,
    goBackHomeProfileStep,
    // Draft persistence
    restorePersistedDraft,
    discardPersistedDraft,
  };
}

export { asNumberOrNull };
export type { RoomEntry };
