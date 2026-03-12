ALTER TABLE public.chores
ADD COLUMN IF NOT EXISTS helper_id uuid;

ALTER TABLE public.chores
ADD CONSTRAINT chores_helper_id_fkey
FOREIGN KEY (helper_id) REFERENCES public.helpers(id)
ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS chores_helper_id_idx ON public.chores(helper_id);
