CREATE TABLE IF NOT EXISTS public.household_recipe_settings (
  household_id uuid PRIMARY KEY REFERENCES public.households (id) ON DELETE CASCADE,
  allowed_sources text[] NOT NULL DEFAULT ARRAY[
    'allrecipes.com',
    'food.com',
    'bbcgoodfood.com',
    'recipes.timesofindia.com',
    'sanjeevkapoor.com'
  ],
  min_rating numeric NOT NULL DEFAULT 4.0,
  min_reviews integer NOT NULL DEFAULT 200,
  lenient_missing_reviews boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_household_recipe_settings_updated_at ON public.household_recipe_settings;
CREATE TRIGGER set_household_recipe_settings_updated_at
BEFORE UPDATE ON public.household_recipe_settings
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.household_recipe_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS household_recipe_settings_select_household_access ON public.household_recipe_settings;
CREATE POLICY household_recipe_settings_select_household_access
ON public.household_recipe_settings
FOR SELECT
USING (public.can_access_household(household_id));

DROP POLICY IF EXISTS household_recipe_settings_insert_admin ON public.household_recipe_settings;
CREATE POLICY household_recipe_settings_insert_admin
ON public.household_recipe_settings
FOR INSERT
WITH CHECK (public.is_household_admin(household_id));

DROP POLICY IF EXISTS household_recipe_settings_update_admin ON public.household_recipe_settings;
CREATE POLICY household_recipe_settings_update_admin
ON public.household_recipe_settings
FOR UPDATE
USING (public.is_household_admin(household_id))
WITH CHECK (public.is_household_admin(household_id));
