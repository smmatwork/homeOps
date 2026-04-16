import { supabase } from "./supabaseClient";

export interface UserProfileData {
  full_name: string | null;
  household_role: string | null;
  goals: string[];
  preferred_language: string | null;
  work_schedule: WorkSchedule | null;
  onboarding_completed_at: string | null;
}

export interface WorkSchedule {
  work_days: string[];
  work_hours: string;
}

export const HOUSEHOLD_ROLES = ["primary_manager", "shared_responsibility", "contributor", "observer"] as const;
export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];

export const USER_GOALS = ["cleanliness", "health_nutrition", "cost_optimization", "time_saving"] as const;
export type UserGoal = (typeof USER_GOALS)[number];

const PROFILE_COLUMNS = "full_name, household_role, goals, preferred_language, work_schedule, onboarding_completed_at";

export async function fetchUserProfile(userId: string): Promise<{ data: UserProfileData | null; error: string | null }> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    return { data: null, error: error.message };
  }

  if (!data) {
    return { data: null, error: null };
  }

  return {
    data: {
      full_name: typeof data.full_name === "string" ? data.full_name : null,
      household_role: typeof (data as any).household_role === "string" ? (data as any).household_role : null,
      goals: Array.isArray((data as any).goals) ? (data as any).goals : [],
      preferred_language: typeof (data as any).preferred_language === "string" ? (data as any).preferred_language : null,
      work_schedule: (data as any).work_schedule && typeof (data as any).work_schedule === "object" ? (data as any).work_schedule : null,
      onboarding_completed_at: typeof (data as any).onboarding_completed_at === "string" ? (data as any).onboarding_completed_at : null,
    },
    error: null,
  };
}

export async function updateUserProfile(
  userId: string,
  patch: Partial<UserProfileData>,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", userId);

  return { error: error ? error.message : null };
}

export async function markOnboardingComplete(userId: string): Promise<{ error: string | null }> {
  return updateUserProfile(userId, { onboarding_completed_at: new Date().toISOString() });
}
