ALTER TABLE public.chores
ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS chores_household_deleted_at_idx
ON public.chores (household_id, deleted_at);
