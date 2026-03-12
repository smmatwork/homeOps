-- Home profile + people + availability + pantry + recipes + supply mapping

create table if not exists public.home_profiles (
  household_id uuid primary key references public.households(id) on delete cascade,
  home_type text not null default 'apartment' check (home_type in ('apartment','villa')),
  bhk smallint not null default 2,
  has_balcony boolean not null default false,
  has_pets boolean not null default false,
  has_kids boolean not null default false,
  flooring_type text null,
  num_bathrooms smallint null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger handle_updated_at_home_profiles
  before update on public.home_profiles
  for each row
  execute function public.handle_updated_at();

create table if not exists public.household_people (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  display_name text not null,
  person_type text not null default 'adult' check (person_type in ('adult','kid')),
  linked_user_id uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists household_people_household_id_idx
  on public.household_people (household_id);

create index if not exists household_people_linked_user_id_idx
  on public.household_people (linked_user_id);

create trigger handle_updated_at_household_people
  before update on public.household_people
  for each row
  execute function public.handle_updated_at();

create table if not exists public.person_preferences (
  household_id uuid not null references public.households(id) on delete cascade,
  person_id uuid not null references public.household_people(id) on delete cascade,
  dietary_constraints text[] not null default '{}'::text[],
  avoid_ingredients text[] not null default '{}'::text[],
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, person_id)
);

create index if not exists person_preferences_household_id_idx
  on public.person_preferences (household_id);

create trigger handle_updated_at_person_preferences
  before update on public.person_preferences
  for each row
  execute function public.handle_updated_at();

create table if not exists public.member_availability (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  member_kind text not null check (member_kind in ('person','helper')),
  person_id uuid null references public.household_people(id) on delete cascade,
  helper_id uuid null references public.helpers(id) on delete cascade,
  days_of_week smallint[] not null default '{}'::smallint[],
  time_windows jsonb not null default '[]'::jsonb,
  max_weekly_load integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_availability_member_ref_check check (
    (member_kind = 'person' and person_id is not null and helper_id is null)
    or
    (member_kind = 'helper' and helper_id is not null and person_id is null)
  )
);

create index if not exists member_availability_household_id_idx
  on public.member_availability (household_id);

create index if not exists member_availability_person_id_idx
  on public.member_availability (person_id);

create index if not exists member_availability_helper_id_idx
  on public.member_availability (helper_id);

create trigger handle_updated_at_member_availability
  before update on public.member_availability
  for each row
  execute function public.handle_updated_at();

create table if not exists public.pantry_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  quantity integer not null default 0,
  low_stock_threshold integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pantry_items_household_id_idx
  on public.pantry_items (household_id);

create unique index if not exists pantry_items_household_lower_name_uniq
  on public.pantry_items (household_id, lower(name));

create trigger handle_updated_at_pantry_items
  before update on public.pantry_items
  for each row
  execute function public.handle_updated_at();

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_url text null,
  metadata jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recipes_title_idx
  on public.recipes (title);

create trigger handle_updated_at_recipes
  before update on public.recipes
  for each row
  execute function public.handle_updated_at();

create table if not exists public.recipe_ratings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  rater_person_id uuid not null references public.household_people(id) on delete cascade,
  rating smallint not null check (rating >= 1 and rating <= 5),
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recipe_ratings_household_id_idx
  on public.recipe_ratings (household_id);

create index if not exists recipe_ratings_recipe_id_idx
  on public.recipe_ratings (recipe_id);

create unique index if not exists recipe_ratings_uniq
  on public.recipe_ratings (household_id, recipe_id, rater_person_id);

create trigger handle_updated_at_recipe_ratings
  before update on public.recipe_ratings
  for each row
  execute function public.handle_updated_at();

create table if not exists public.task_supply_map (
  id uuid primary key default gen_random_uuid(),
  task_type text not null,
  supply_item_name text not null,
  default_quantity integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists task_supply_map_uniq
  on public.task_supply_map (task_type, lower(supply_item_name));

create trigger handle_updated_at_task_supply_map
  before update on public.task_supply_map
  for each row
  execute function public.handle_updated_at();

alter table public.chores
  add column if not exists task_type text null;

-- RLS
alter table public.home_profiles enable row level security;
alter table public.household_people enable row level security;
alter table public.person_preferences enable row level security;
alter table public.member_availability enable row level security;
alter table public.pantry_items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ratings enable row level security;
alter table public.task_supply_map enable row level security;

-- home_profiles: read by household members, write by admins
create policy "home_profiles_select_household_access" on public.home_profiles
  for select
  using (public.can_access_household(household_id));

create policy "home_profiles_insert_admin" on public.home_profiles
  for insert
  with check (public.is_household_admin(household_id));

create policy "home_profiles_update_admin" on public.home_profiles
  for update
  using (public.is_household_admin(household_id))
  with check (public.is_household_admin(household_id));

create policy "home_profiles_delete_admin" on public.home_profiles
  for delete
  using (public.is_household_admin(household_id));

-- household_people: read by household members, write by admins
create policy "household_people_select_household_access" on public.household_people
  for select
  using (public.can_access_household(household_id));

create policy "household_people_insert_admin" on public.household_people
  for insert
  with check (public.is_household_admin(household_id));

create policy "household_people_update_admin" on public.household_people
  for update
  using (public.is_household_admin(household_id))
  with check (public.is_household_admin(household_id));

create policy "household_people_delete_admin" on public.household_people
  for delete
  using (public.is_household_admin(household_id));

-- person_preferences: read by household members, write by admins
create policy "person_preferences_select_household_access" on public.person_preferences
  for select
  using (public.can_access_household(household_id));

create policy "person_preferences_insert_admin" on public.person_preferences
  for insert
  with check (public.is_household_admin(household_id));

create policy "person_preferences_update_admin" on public.person_preferences
  for update
  using (public.is_household_admin(household_id))
  with check (public.is_household_admin(household_id));

create policy "person_preferences_delete_admin" on public.person_preferences
  for delete
  using (public.is_household_admin(household_id));

-- member_availability: read by household members, write by admins
create policy "member_availability_select_household_access" on public.member_availability
  for select
  using (public.can_access_household(household_id));

create policy "member_availability_insert_admin" on public.member_availability
  for insert
  with check (public.is_household_admin(household_id));

create policy "member_availability_update_admin" on public.member_availability
  for update
  using (public.is_household_admin(household_id))
  with check (public.is_household_admin(household_id));

create policy "member_availability_delete_admin" on public.member_availability
  for delete
  using (public.is_household_admin(household_id));

-- pantry_items: editable by any household member
create policy "pantry_items_select_household_access" on public.pantry_items
  for select
  using (public.can_access_household(household_id));

create policy "pantry_items_insert_household_access" on public.pantry_items
  for insert
  with check (public.can_access_household(household_id));

create policy "pantry_items_update_household_access" on public.pantry_items
  for update
  using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));

create policy "pantry_items_delete_household_access" on public.pantry_items
  for delete
  using (public.can_access_household(household_id));

-- recipes: global read for authenticated users, write for support users
create policy "recipes_select_authenticated" on public.recipes
  for select
  to authenticated
  using (true);

create policy "recipes_insert_support" on public.recipes
  for insert
  to authenticated
  with check (public.is_support_user());

create policy "recipes_update_support" on public.recipes
  for update
  to authenticated
  using (public.is_support_user())
  with check (public.is_support_user());

create policy "recipes_delete_support" on public.recipes
  for delete
  to authenticated
  using (public.is_support_user());

-- recipe_ratings: household scoped
create policy "recipe_ratings_select_household_access" on public.recipe_ratings
  for select
  using (public.can_access_household(household_id));

create policy "recipe_ratings_insert_household_access" on public.recipe_ratings
  for insert
  with check (public.can_access_household(household_id));

create policy "recipe_ratings_update_household_access" on public.recipe_ratings
  for update
  using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));

create policy "recipe_ratings_delete_household_access" on public.recipe_ratings
  for delete
  using (public.can_access_household(household_id));

-- task_supply_map: global read for authenticated users, write for support users
create policy "task_supply_map_select_authenticated" on public.task_supply_map
  for select
  to authenticated
  using (true);

create policy "task_supply_map_insert_support" on public.task_supply_map
  for insert
  to authenticated
  with check (public.is_support_user());

create policy "task_supply_map_update_support" on public.task_supply_map
  for update
  to authenticated
  using (public.is_support_user())
  with check (public.is_support_user());

create policy "task_supply_map_delete_support" on public.task_supply_map
  for delete
  to authenticated
  using (public.is_support_user());
