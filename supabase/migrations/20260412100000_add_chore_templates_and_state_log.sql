-- Chore State Machine: templates, template linkage, and state transition log.

-- 1. Chore templates — formalizes the recurring baseline from the coverage planner.
--    Each row is a "type of chore" (e.g. "Kitchen jhadu pocha · daily"). The scheduler
--    materializes concrete chore instances from these templates.
CREATE TABLE IF NOT EXISTS public.chore_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  title text NOT NULL,
  space text,
  cadence text NOT NULL CHECK (cadence IN ('daily','weekly','biweekly','monthly')),
  priority smallint NOT NULL DEFAULT 1,
  estimated_minutes int,
  default_helper_id uuid REFERENCES public.helpers(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chore_templates_household_idx
  ON public.chore_templates (household_id);

CREATE TRIGGER handle_updated_at_chore_templates
  BEFORE UPDATE ON public.chore_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.chore_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chore_templates_select_household_access" ON public.chore_templates
  FOR SELECT USING (public.can_access_household(household_id));

CREATE POLICY "chore_templates_insert_admin" ON public.chore_templates
  FOR INSERT WITH CHECK (public.is_household_admin(household_id));

CREATE POLICY "chore_templates_update_admin" ON public.chore_templates
  FOR UPDATE USING (public.is_household_admin(household_id))
  WITH CHECK (public.is_household_admin(household_id));

CREATE POLICY "chore_templates_delete_admin" ON public.chore_templates
  FOR DELETE USING (public.is_household_admin(household_id));

-- 2. Link chores to their source template for idempotent scheduling.
ALTER TABLE public.chores
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.chore_templates(id) ON DELETE SET NULL;

-- 3. Append-only state transition log for auditability.
CREATE TABLE IF NOT EXISTS public.chore_state_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chore_id uuid NOT NULL REFERENCES public.chores(id) ON DELETE CASCADE,
  from_state text NOT NULL,
  to_state text NOT NULL,
  triggered_by text NOT NULL,  -- 'scheduler', 'reactor', 'user', 'agent'
  reason text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chore_state_log_chore_idx
  ON public.chore_state_log (chore_id, created_at DESC);

ALTER TABLE public.chore_state_log ENABLE ROW LEVEL SECURITY;

-- State log is readable by household members (via the chore's household_id)
-- and writable by admins (same pattern as chores).
CREATE POLICY "chore_state_log_select" ON public.chore_state_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.chores c
      WHERE c.id = chore_state_log.chore_id
        AND public.can_access_household(c.household_id)
    )
  );

CREATE POLICY "chore_state_log_insert" ON public.chore_state_log
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.chores c
      WHERE c.id = chore_state_log.chore_id
        AND public.is_household_admin(c.household_id)
    )
  );
