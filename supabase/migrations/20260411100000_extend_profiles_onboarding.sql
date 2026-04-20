-- Extend profiles table for onboarding and enhanced user preferences

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS household_role text NULL
    CHECK (household_role IS NULL OR household_role IN ('primary_manager','shared_responsibility','contributor','observer')),
  ADD COLUMN IF NOT EXISTS goals text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS preferred_language text NULL
    CHECK (preferred_language IS NULL OR preferred_language IN ('en','hi','kn')),
  ADD COLUMN IF NOT EXISTS work_schedule jsonb NULL,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz NULL;

-- Backfill existing users so they skip the onboarding flow
UPDATE public.profiles
SET onboarding_completed_at = created_at
WHERE onboarding_completed_at IS NULL;
