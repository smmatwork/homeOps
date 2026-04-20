-- Expand chore_templates.cadence to support interval-based frequencies.

ALTER TABLE public.chore_templates
  DROP CONSTRAINT IF EXISTS chore_templates_cadence_check;

ALTER TABLE public.chore_templates
  ADD CONSTRAINT chore_templates_cadence_check
  CHECK (cadence IN (
    'daily',
    'every_2_days',
    'every_3_days',
    'every_4_days',
    'every_5_days',
    'weekly',
    'biweekly',
    'monthly'
  ));
