-- Allow households to create their own recipes alongside the global catalog.
-- Add meal_plans table for weekly meal planning.

-- 1. Add household_id to recipes (nullable — null = global catalog entry)
alter table public.recipes
  add column if not exists household_id uuid null references public.households(id) on delete cascade;

create index if not exists recipes_household_id_idx
  on public.recipes (household_id);

-- 2. Update RLS: allow household members to manage their own recipes
drop policy if exists "recipes_insert_support" on public.recipes;
create policy "recipes_insert_authenticated" on public.recipes
  for insert
  to authenticated
  with check (
    household_id is null and public.is_support_user()
    or household_id is not null and public.can_access_household(household_id)
  );

drop policy if exists "recipes_update_support" on public.recipes;
create policy "recipes_update_authenticated" on public.recipes
  for update
  to authenticated
  using (
    household_id is null and public.is_support_user()
    or household_id is not null and public.can_access_household(household_id)
  )
  with check (
    household_id is null and public.is_support_user()
    or household_id is not null and public.can_access_household(household_id)
  );

drop policy if exists "recipes_delete_support" on public.recipes;
create policy "recipes_delete_authenticated" on public.recipes
  for delete
  to authenticated
  using (
    household_id is null and public.is_support_user()
    or household_id is not null and public.can_access_household(household_id)
  );

-- 3. Meal plans table
create table if not exists public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  plan_date date not null,
  meal_type text not null check (meal_type in ('breakfast','lunch','snack','dinner')),
  recipe_id uuid null references public.recipes(id) on delete set null,
  custom_meal text null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meal_plans_has_content check (recipe_id is not null or custom_meal is not null)
);

create index if not exists meal_plans_household_date_idx
  on public.meal_plans (household_id, plan_date);

create unique index if not exists meal_plans_uniq
  on public.meal_plans (household_id, plan_date, meal_type);

create trigger handle_updated_at_meal_plans
  before update on public.meal_plans
  for each row
  execute function public.handle_updated_at();

-- RLS for meal_plans
alter table public.meal_plans enable row level security;

create policy "meal_plans_select_household_access" on public.meal_plans
  for select using (public.can_access_household(household_id));

create policy "meal_plans_insert_household_access" on public.meal_plans
  for insert with check (public.can_access_household(household_id));

create policy "meal_plans_update_household_access" on public.meal_plans
  for update
  using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));

create policy "meal_plans_delete_household_access" on public.meal_plans
  for delete using (public.can_access_household(household_id));
