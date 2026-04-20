ALTER TABLE public.automations
  DROP CONSTRAINT IF EXISTS automations_cadence_check;

ALTER TABLE public.automations
  ADD CONSTRAINT automations_cadence_check
  CHECK (
    cadence = ANY (
      ARRAY[
        'daily'::text,
        'weekly'::text,
        'monthly'::text,
        'weekdays'::text,
        'hourly'::text,
        'every_2_hours'::text,
        'every_5_minutes'::text
      ]
    )
  );
