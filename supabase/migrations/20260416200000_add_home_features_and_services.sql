-- ═══════════════════════════════════════════════════════════════════
-- Home Features, Service Catalog, Vendors, Maintenance infrastructure
-- ═══════════════════════════════════════════════════════════════════

-- ─── P1a: Home features / asset inventory ────────────────────────
create table if not exists public.home_features (
  household_id uuid not null references public.households(id) on delete cascade,
  feature_key text not null,
  quantity int not null default 1,
  brand text,
  model text,
  install_date date,
  warranty_until date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, feature_key)
);

create trigger handle_updated_at_home_features
  before update on public.home_features
  for each row execute function public.handle_updated_at();

alter table public.home_features enable row level security;

create policy "home_features_select" on public.home_features
  for select using (public.can_access_household(household_id));
create policy "home_features_insert" on public.home_features
  for insert with check (public.can_access_household(household_id));
create policy "home_features_update" on public.home_features
  for update using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));
create policy "home_features_delete" on public.home_features
  for delete using (public.can_access_household(household_id));

-- ─── P1b: Extend pantry_items ────────────────────────────────────
alter table public.pantry_items
  add column if not exists category text not null default 'grocery'
    check (category in ('grocery','cleaning','household','maintenance','other')),
  add column if not exists unit text,
  add column if not exists last_restocked_at timestamptz,
  add column if not exists avg_consumption_days int;

-- ─── P2a: Service catalog (global) ──────────────────────────────
create table if not exists public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  service_key text not null unique,
  title text not null,
  description text,
  typical_cadence text,
  typical_cost_min numeric,
  typical_cost_max numeric,
  currency text not null default 'INR',
  requires_features text[],
  requires_home_types text[],
  procurement_items jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.service_catalog enable row level security;

create policy "service_catalog_select" on public.service_catalog
  for select to authenticated using (true);
create policy "service_catalog_insert" on public.service_catalog
  for insert to authenticated with check (public.is_support_user());
create policy "service_catalog_update" on public.service_catalog
  for update to authenticated
  using (public.is_support_user()) with check (public.is_support_user());

-- ─── Maintenance templates (global) ─────────────────────────────
create table if not exists public.maintenance_templates (
  id uuid primary key default gen_random_uuid(),
  service_key text references public.service_catalog(service_key) on delete set null,
  title text not null,
  description text,
  cadence text not null
    check (cadence in ('monthly','quarterly','semi_annual','annual',
                       'biennial','seasonal','on_demand')),
  season_affinity text
    check (season_affinity is null or season_affinity in (
      'pre_monsoon','monsoon','post_monsoon','summer','winter','any')),
  doer_type text not null default 'vendor'
    check (doer_type in ('helper','vendor','self')),
  estimated_duration_minutes int,
  estimated_cost_min numeric,
  estimated_cost_max numeric,
  procurement_items jsonb,
  checklist jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.maintenance_templates enable row level security;

create policy "maintenance_templates_select" on public.maintenance_templates
  for select to authenticated using (true);
create policy "maintenance_templates_insert" on public.maintenance_templates
  for insert to authenticated with check (public.is_support_user());

-- ─── P2b: Vendor / supplier directory (household-scoped) ────────
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  vendor_type text not null default 'service'
    check (vendor_type in ('service','supplier','both')),
  phone text,
  whatsapp text,
  email text,
  upi_id text,
  address text,
  service_categories text[] not null default '{}',
  supply_categories text[] not null default '{}',
  languages text[] not null default '{en}',
  payment_terms text,
  availability_notes text,
  rating numeric check (rating is null or (rating >= 1 and rating <= 5)),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendors_household_id_idx
  on public.vendors (household_id);

create trigger handle_updated_at_vendors
  before update on public.vendors
  for each row execute function public.handle_updated_at();

alter table public.vendors enable row level security;

create policy "vendors_select" on public.vendors
  for select using (public.can_access_household(household_id));
create policy "vendors_insert" on public.vendors
  for insert with check (public.can_access_household(household_id));
create policy "vendors_update" on public.vendors
  for update using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));
create policy "vendors_delete" on public.vendors
  for delete using (public.can_access_household(household_id));

-- ─── Preferred vendor per service ────────────────────────────────
create table if not exists public.preferred_vendors (
  household_id uuid not null references public.households(id) on delete cascade,
  service_key text not null,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  priority int not null default 1,
  amc_active boolean not null default false,
  amc_expires_at date,
  last_service_date date,
  last_service_cost numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, service_key, vendor_id)
);

create trigger handle_updated_at_preferred_vendors
  before update on public.preferred_vendors
  for each row execute function public.handle_updated_at();

alter table public.preferred_vendors enable row level security;

create policy "preferred_vendors_select" on public.preferred_vendors
  for select using (public.can_access_household(household_id));
create policy "preferred_vendors_insert" on public.preferred_vendors
  for insert with check (public.can_access_household(household_id));
create policy "preferred_vendors_update" on public.preferred_vendors
  for update using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));
create policy "preferred_vendors_delete" on public.preferred_vendors
  for delete using (public.can_access_household(household_id));

-- ─── Household maintenance plan ──────────────────────────────────
create table if not exists public.maintenance_plan (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  template_id uuid references public.maintenance_templates(id) on delete set null,
  vendor_id uuid references public.vendors(id) on delete set null,
  title text not null,
  status text not null default 'upcoming'
    check (status in ('upcoming','scheduled','in_progress',
                      'done','skipped','overdue')),
  target_month int check (target_month is null or (target_month >= 1 and target_month <= 12)),
  target_year int,
  scheduled_date date,
  completed_date date,
  actual_cost numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists maintenance_plan_household_idx
  on public.maintenance_plan (household_id, target_year, target_month);

create trigger handle_updated_at_maintenance_plan
  before update on public.maintenance_plan
  for each row execute function public.handle_updated_at();

alter table public.maintenance_plan enable row level security;

create policy "maintenance_plan_select" on public.maintenance_plan
  for select using (public.can_access_household(household_id));
create policy "maintenance_plan_insert" on public.maintenance_plan
  for insert with check (public.can_access_household(household_id));
create policy "maintenance_plan_update" on public.maintenance_plan
  for update using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));
create policy "maintenance_plan_delete" on public.maintenance_plan
  for delete using (public.can_access_household(household_id));

-- ─── Procurement lists ───────────────────────────────────────────
create table if not exists public.procurement_lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  list_type text not null default 'mixed'
    check (list_type in ('grocery','household','maintenance','mixed')),
  status text not null default 'draft'
    check (status in ('draft','active','completed','cancelled')),
  target_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists procurement_lists_household_idx
  on public.procurement_lists (household_id, status);

create trigger handle_updated_at_procurement_lists
  before update on public.procurement_lists
  for each row execute function public.handle_updated_at();

alter table public.procurement_lists enable row level security;

create policy "procurement_lists_select" on public.procurement_lists
  for select using (public.can_access_household(household_id));
create policy "procurement_lists_insert" on public.procurement_lists
  for insert with check (public.can_access_household(household_id));
create policy "procurement_lists_update" on public.procurement_lists
  for update using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));
create policy "procurement_lists_delete" on public.procurement_lists
  for delete using (public.can_access_household(household_id));

-- ─── Procurement items ───────────────────────────────────────────
create table if not exists public.procurement_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.procurement_lists(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  item_name text not null,
  category text not null default 'grocery'
    check (category in ('grocery','cleaning','household','maintenance','service','other')),
  quantity text,
  estimated_cost numeric,
  source_type text
    check (source_type is null or source_type in (
      'meal_plan','low_stock','maintenance','chore_supply','manual')),
  source_id text,
  vendor_id uuid references public.vendors(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','purchased','skipped')),
  actual_cost numeric,
  purchased_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists procurement_items_list_idx
  on public.procurement_items (list_id);

alter table public.procurement_items enable row level security;

create policy "procurement_items_select" on public.procurement_items
  for select using (public.can_access_household(household_id));
create policy "procurement_items_insert" on public.procurement_items
  for insert with check (public.can_access_household(household_id));
create policy "procurement_items_update" on public.procurement_items
  for update using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));
create policy "procurement_items_delete" on public.procurement_items
  for delete using (public.can_access_household(household_id));
