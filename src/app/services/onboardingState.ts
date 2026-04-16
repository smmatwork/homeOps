/**
 * Detects the current onboarding state by querying the household's
 * actual data. Used to inject context into the agent conversation
 * so it can resume from where the user left off.
 */

import { supabase } from "./supabaseClient";

export interface OnboardingState {
  /** User's display name (from profiles table). */
  userName: string | null;
  /** Whether a home profile row exists. */
  homeProfileExists: boolean;
  /** Home type if set (apartment, villa, etc.). */
  homeType: string | null;
  /** Number of rooms/spaces in the home profile. */
  roomCount: number;
  /** List of room display names (for context). */
  roomNames: string[];
  /** Whether any home features have been set. */
  hasFeatures: boolean;
  /** Number of home features set. */
  featureCount: number;
  /** Number of chores created. */
  choreCount: number;
  /** Number of helpers added. */
  helperCount: number;
  /** Helper names for context. */
  helperNames: string[];
  /** Whether onboarding is already marked complete. */
  isComplete: boolean;
}

export async function detectOnboardingState(
  householdId: string,
  userId: string,
): Promise<OnboardingState> {
  const state: OnboardingState = {
    userName: null,
    homeProfileExists: false,
    homeType: null,
    roomCount: 0,
    roomNames: [],
    hasFeatures: false,
    featureCount: 0,
    choreCount: 0,
    helperCount: 0,
    helperNames: [],
    isComplete: false,
  };

  if (!householdId || !userId) return state;

  // Run all queries in parallel
  const [profileRes, homeRes, featuresRes, choresRes, helpersRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, onboarding_complete")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("home_profiles")
      .select("home_type, bhk, spaces")
      .eq("household_id", householdId)
      .maybeSingle(),
    supabase
      .from("home_features")
      .select("feature_key")
      .eq("household_id", householdId),
    supabase
      .from("chores")
      .select("id", { count: "exact", head: true })
      .eq("household_id", householdId)
      .is("deleted_at", null),
    supabase
      .from("helpers")
      .select("name")
      .eq("household_id", householdId),
  ]);

  // Profile
  if (profileRes.data) {
    state.userName = typeof profileRes.data.full_name === "string" ? profileRes.data.full_name : null;
    state.isComplete = profileRes.data.onboarding_complete === true;
  }

  // Home profile
  if (homeRes.data) {
    state.homeProfileExists = true;
    state.homeType = typeof homeRes.data.home_type === "string" ? homeRes.data.home_type : null;

    // Parse rooms from spaces
    let spaces = homeRes.data.spaces;
    if (typeof spaces === "string") {
      try { spaces = JSON.parse(spaces); } catch { spaces = []; }
    }
    if (Array.isArray(spaces)) {
      state.roomCount = spaces.length;
      state.roomNames = spaces
        .slice(0, 15)
        .map((s: unknown) => {
          if (typeof s === "string") return s;
          if (s && typeof s === "object" && "display_name" in s) return String((s as Record<string, unknown>).display_name ?? "");
          return "";
        })
        .filter(Boolean);
    }
  }

  // Features
  if (featuresRes.data) {
    state.featureCount = featuresRes.data.length;
    state.hasFeatures = featuresRes.data.length > 0;
  }

  // Chores
  state.choreCount = choresRes.count ?? 0;

  // Helpers
  if (helpersRes.data) {
    state.helperCount = helpersRes.data.length;
    state.helperNames = helpersRes.data
      .slice(0, 10)
      .map((h: Record<string, unknown>) => String(h.name ?? ""))
      .filter(Boolean);
  }

  return state;
}

/**
 * Build a context string for the agent describing what's already set up
 * and what remains to be done.
 */
export function buildOnboardingContext(state: OnboardingState): string {
  const done: string[] = [];
  const remaining: string[] = [];

  if (state.userName) {
    done.push(`User name: ${state.userName}`);
  }

  if (state.homeProfileExists) {
    done.push(`Home profile: ${state.homeType ?? "unknown type"}, ${state.roomCount} rooms (${state.roomNames.slice(0, 8).join(", ")})`);
  } else {
    remaining.push("Set up home profile (home type, rooms, spaces)");
  }

  if (state.hasFeatures) {
    done.push(`Home features: ${state.featureCount} features configured`);
  } else if (state.homeProfileExists) {
    remaining.push("Configure home features (AC, water purifier, solar, etc.)");
  }

  if (state.choreCount > 0) {
    done.push(`Chores: ${state.choreCount} chores created`);
  } else if (state.homeProfileExists) {
    remaining.push("Generate initial chores based on home profile");
  }

  if (state.helperCount > 0) {
    done.push(`Helpers: ${state.helperCount} (${state.helperNames.join(", ")})`);
  } else {
    remaining.push("Add household helpers (maid, cook, gardener, etc.)");
  }

  const parts: string[] = [];

  if (done.length > 0) {
    parts.push("ALREADY COMPLETED:\n" + done.map((d) => `  ✓ ${d}`).join("\n"));
  }

  if (remaining.length > 0) {
    parts.push("REMAINING STEPS:\n" + remaining.map((r) => `  → ${r}`).join("\n"));
  } else {
    parts.push("All onboarding steps are complete! Ask if there's anything else to set up.");
  }

  return `ONBOARDING STATE (resume from here — do NOT repeat completed steps):\n${parts.join("\n\n")}`;
}
