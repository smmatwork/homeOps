-- ═══════════════════════════════════════════════════════════════════
-- Seed: service catalog + maintenance templates for Indian households
-- ═══════════════════════════════════════════════════════════════════

-- ─── Universal services (every home) ─────────────────────────────

insert into public.service_catalog (category, service_key, title, description, typical_cadence, typical_cost_min, typical_cost_max, requires_features, requires_home_types) values
  -- Plumbing
  ('plumbing', 'plumbing_general', 'General Plumbing', 'Tap repair, pipe fixing, leak detection', 'on_demand', 300, 1500, null, null),
  ('plumbing', 'water_tank_cleaning', 'Water Tank Cleaning', 'Overhead and underground tank cleaning and disinfection', 'semi_annual', 800, 2500, null, null),
  ('plumbing', 'drainage_cleaning', 'Drainage / Sewage Cleaning', 'Drain unblocking, sewage line clearing', 'on_demand', 500, 3000, null, null),

  -- Electrical
  ('electrical', 'electrical_general', 'General Electrical', 'Switch repair, wiring, MCB/ELCB check', 'on_demand', 200, 1000, null, null),
  ('electrical', 'electrical_safety_audit', 'Electrical Safety Audit', 'Full home wiring inspection, earth check, load balance', 'annual', 1000, 3000, null, null),

  -- Pest control
  ('pest_control', 'pest_control_general', 'General Pest Control', 'Cockroach, ant, mosquito treatment', 'quarterly', 800, 2000, null, null),
  ('pest_control', 'termite_treatment', 'Termite Treatment', 'Anti-termite treatment for wood and walls', 'annual', 3000, 10000, '{"wood_flooring"}', null),

  -- Deep cleaning
  ('deep_cleaning', 'kitchen_deep_clean', 'Kitchen Deep Clean', 'Chimney, hob, cabinets, tiles, grout cleaning', 'semi_annual', 1500, 4000, null, null),
  ('deep_cleaning', 'bathroom_deep_clean', 'Bathroom Deep Clean', 'Tile scrubbing, grout cleaning, fixture polishing', 'semi_annual', 800, 2000, null, null),
  ('deep_cleaning', 'full_home_deep_clean', 'Full Home Deep Clean', 'All rooms, fans, windows, cabinets, balcony', 'semi_annual', 3000, 10000, null, null),
  ('deep_cleaning', 'sofa_carpet_shampoo', 'Sofa / Carpet Shampooing', 'Upholstery and carpet deep cleaning', 'annual', 1500, 5000, null, null),

  -- Carpentry
  ('carpentry', 'carpentry_general', 'General Carpentry', 'Furniture repair, door alignment, kitchen cabinets', 'on_demand', 500, 3000, null, null),

  -- Safety
  ('safety', 'fire_extinguisher', 'Fire Extinguisher Check', 'Inspection and refill of fire extinguishers', 'annual', 500, 1500, null, null),

  -- Utilities
  ('utilities', 'lpg_cylinder', 'LPG Cylinder Booking', 'Cooking gas cylinder refill/booking', 'on_demand', 800, 1000, null, null),
  ('utilities', 'water_tanker', 'Water Tanker', 'Emergency or regular water tanker delivery', 'on_demand', 500, 2000, null, null),

  -- Groceries & supplies (vendor categories, not maintenance)
  ('grocery', 'provision_store', 'Provision Store', 'Monthly groceries — rice, dal, oil, spices, etc.', 'on_demand', null, null, null, null),
  ('grocery', 'vegetable_vendor', 'Vegetable / Fruit Vendor', 'Fresh vegetables and fruits', 'on_demand', null, null, null, null),
  ('grocery', 'milk_delivery', 'Milk Delivery', 'Daily milk subscription', 'on_demand', null, null, null, null),
  ('grocery', 'meat_fish_vendor', 'Meat / Fish Vendor', 'Fresh meat and seafood', 'on_demand', null, null, null, null),
  ('household_supply', 'cleaning_supplies', 'Cleaning Supplies', 'Floor cleaner, dishwash, detergent, garbage bags', 'on_demand', null, null, null, null),
  ('household_supply', 'toiletries', 'Toiletries', 'Soap, shampoo, toothpaste, tissue', 'on_demand', null, null, null, null)

on conflict (service_key) do nothing;

-- ─── Feature-specific services ───────────────────────────────────

insert into public.service_catalog (category, service_key, title, description, typical_cadence, typical_cost_min, typical_cost_max, requires_features, requires_home_types) values
  -- AC
  ('hvac', 'ac_servicing', 'AC Servicing', 'Filter cleaning, gas check, compressor inspection', 'semi_annual', 500, 1500, '{"ac_split","ac_window"}', null),
  ('hvac', 'ac_deep_clean', 'AC Deep Clean', 'Full disassembly, coil wash, drain line flush', 'annual', 1200, 2500, '{"ac_split","ac_window"}', null),

  -- Geyser
  ('hvac', 'geyser_maintenance', 'Geyser Maintenance', 'Heating element check, anode rod, thermostat', 'annual', 500, 1500, '{"geyser_electric","geyser_gas","geyser_solar"}', null),

  -- Water purifier
  ('appliance', 'ro_filter_replacement', 'RO Filter Replacement', 'Replace sediment, carbon, and RO membrane filters', 'semi_annual', 1000, 3000, '{"water_purifier_ro"}', null),
  ('appliance', 'ro_amc', 'RO Annual Maintenance', 'Comprehensive water purifier servicing and parts', 'annual', 2000, 4500, '{"water_purifier_ro","water_purifier_uv"}', null),

  -- Solar
  ('electrical', 'solar_panel_cleaning', 'Solar Panel Cleaning', 'Panel surface cleaning to maintain efficiency', 'quarterly', 500, 2000, '{"solar_panels"}', null),
  ('electrical', 'solar_inverter_check', 'Solar Inverter Check', 'Inverter diagnostics, connection check, firmware update', 'annual', 1000, 3000, '{"solar_panels"}', null),

  -- Inverter / UPS
  ('electrical', 'inverter_battery', 'Inverter Battery Check', 'Battery water top-up, terminal cleaning, load test', 'semi_annual', 200, 500, '{"inverter_ups"}', null),

  -- Chimney
  ('appliance', 'chimney_servicing', 'Chimney Servicing', 'Filter cleaning, motor check, duct cleaning', 'semi_annual', 400, 1200, '{"kitchen_chimney"}', null),

  -- Washing machine
  ('appliance', 'washing_machine_service', 'Washing Machine Servicing', 'Drum cleaning, drain pump, inlet filter', 'annual', 500, 1500, '{"washing_machine"}', null),

  -- Refrigerator
  ('appliance', 'refrigerator_service', 'Refrigerator Servicing', 'Condenser cleaning, thermostat check, gas top-up', 'annual', 500, 2000, '{"refrigerator"}', null),

  -- CCTV
  ('safety', 'cctv_maintenance', 'CCTV Maintenance', 'Camera cleaning, DVR/NVR check, cable inspection', 'semi_annual', 500, 2000, '{"cctv_system"}', null),

  -- Borewell
  ('plumbing', 'borewell_servicing', 'Borewell Motor Servicing', 'Motor inspection, pipe check, water level test', 'annual', 1500, 5000, '{"borewell"}', null)

on conflict (service_key) do nothing;

-- ─── Home-type-specific services ─────────────────────────────────

insert into public.service_catalog (category, service_key, title, description, typical_cadence, typical_cost_min, typical_cost_max, requires_features, requires_home_types) values
  -- Villa / independent house
  ('exterior', 'exterior_painting', 'Exterior Painting', 'Full exterior repaint including primer', 'biennial', 50000, 200000, null, '{"villa","independent_house","penthouse"}'),
  ('exterior', 'terrace_waterproofing', 'Terrace Waterproofing', 'Waterproof coating application on terrace/roof', 'biennial', 15000, 50000, null, '{"villa","independent_house","penthouse"}'),
  ('exterior', 'gate_fence_maintenance', 'Gate / Fence Maintenance', 'Rust treatment, painting, hinge oiling', 'annual', 2000, 8000, null, '{"villa","independent_house"}'),

  -- Garden
  ('garden', 'garden_maintenance', 'Garden Maintenance', 'Lawn mowing, hedge trimming, weeding, fertilizing', 'monthly', 500, 3000, '{"garden"}', null),
  ('garden', 'tree_trimming', 'Tree Trimming', 'Major branch cutting, crown shaping, dead wood removal', 'annual', 1000, 5000, '{"garden"}', null),
  ('garden', 'irrigation_check', 'Irrigation System Check', 'Sprinkler/drip system inspection, timer reset', 'semi_annual', 500, 2000, '{"garden_irrigation"}', null),

  -- Swimming pool
  ('pool', 'pool_pump_servicing', 'Pool Pump Servicing', 'Filter cleaning, pump motor check, valve inspection', 'semi_annual', 2000, 5000, '{"swimming_pool"}', null),
  ('pool', 'pool_water_treatment', 'Pool Water Treatment', 'Chemical balancing, algae treatment, pH adjustment', 'monthly', 500, 1500, '{"swimming_pool"}', null),

  -- Elevator
  ('safety', 'elevator_servicing', 'Elevator Servicing', 'Safety inspection, lubrication, electrical check', 'quarterly', 2000, 5000, '{"elevator"}', null)

on conflict (service_key) do nothing;

-- ─── Maintenance templates linked to services ────────────────────

insert into public.maintenance_templates (service_key, title, description, cadence, season_affinity, doer_type, estimated_duration_minutes, estimated_cost_min, estimated_cost_max, procurement_items) values
  -- Universal quarterly/semi-annual
  ('pest_control_general', 'Quarterly pest control', 'Schedule professional pest control for cockroach, ants, mosquitoes', 'quarterly', 'any', 'vendor', 120, 800, 2000, null),
  ('water_tank_cleaning', 'Water tank cleaning', 'Clean overhead and underground tanks before and after monsoon', 'semi_annual', 'pre_monsoon', 'vendor', 180, 800, 2500, null),
  ('kitchen_deep_clean', 'Kitchen deep clean', 'Professional chimney, hob, cabinet, and tile cleaning', 'semi_annual', 'any', 'vendor', 240, 1500, 4000, null),
  ('bathroom_deep_clean', 'Bathroom deep clean', 'Professional tile, grout, and fixture cleaning', 'semi_annual', 'any', 'vendor', 120, 800, 2000, null),
  ('full_home_deep_clean', 'Full home deep clean', 'Comprehensive cleaning — fans, windows, cabinets, balconies', 'semi_annual', 'post_monsoon', 'vendor', 480, 3000, 10000, null),

  -- Annual
  ('electrical_safety_audit', 'Annual electrical safety audit', 'Full wiring check, earth testing, MCB/ELCB verification', 'annual', 'any', 'vendor', 120, 1000, 3000, null),
  ('sofa_carpet_shampoo', 'Sofa and carpet cleaning', 'Professional upholstery and carpet shampooing', 'annual', 'post_monsoon', 'vendor', 180, 1500, 5000, null),
  ('fire_extinguisher', 'Fire extinguisher inspection', 'Check expiry, pressure, and refill if needed', 'annual', 'any', 'self', 30, 500, 1500, null),

  -- Feature-specific
  ('ac_servicing', 'Pre-summer AC servicing', 'Gas check, filter clean, compressor check before summer', 'semi_annual', 'pre_monsoon', 'vendor', 60, 500, 1500, '[{"name":"AC filter (spare)","est_cost":300}]'),
  ('ac_deep_clean', 'Annual AC deep clean', 'Full disassembly wash for each AC unit', 'annual', 'pre_monsoon', 'vendor', 90, 1200, 2500, null),
  ('geyser_maintenance', 'Pre-winter geyser check', 'Heating element, anode rod, thermostat check', 'annual', 'winter', 'vendor', 60, 500, 1500, '[{"name":"Anode rod (if corroded)","est_cost":400}]'),
  ('ro_filter_replacement', 'RO filter replacement', 'Replace sediment and carbon filters', 'semi_annual', 'any', 'vendor', 45, 1000, 3000, '[{"name":"Sediment filter","est_cost":200},{"name":"Carbon filter","est_cost":350},{"name":"RO membrane (if due)","est_cost":1500}]'),
  ('solar_panel_cleaning', 'Solar panel cleaning', 'Clean panel surfaces for optimal output', 'quarterly', 'any', 'vendor', 60, 500, 2000, null),
  ('solar_inverter_check', 'Solar inverter annual check', 'Diagnostics, connection tightening, firmware', 'annual', 'any', 'vendor', 60, 1000, 3000, null),
  ('chimney_servicing', 'Kitchen chimney service', 'Filter deep clean, motor check, duct cleaning', 'semi_annual', 'any', 'vendor', 60, 400, 1200, null),
  ('washing_machine_service', 'Washing machine annual service', 'Drum cleaning, pump check, inlet filter', 'annual', 'any', 'vendor', 60, 500, 1500, '[{"name":"Descaling tablets","est_cost":200}]'),
  ('inverter_battery', 'Inverter battery check', 'Water top-up, terminal clean, load test', 'semi_annual', 'any', 'self', 30, 200, 500, '[{"name":"Distilled water","est_cost":50}]'),

  -- Exterior (villa/independent house)
  ('exterior_painting', 'Exterior painting', 'Full exterior repaint — assess, prime, and paint', 'biennial', 'post_monsoon', 'vendor', 2880, 50000, 200000, '[{"name":"Exterior paint","est_cost":15000},{"name":"Primer","est_cost":5000},{"name":"Putty","est_cost":3000}]'),
  ('terrace_waterproofing', 'Terrace waterproofing', 'Apply waterproof coating before monsoon', 'biennial', 'pre_monsoon', 'vendor', 480, 15000, 50000, '[{"name":"Waterproofing compound","est_cost":8000}]'),
  ('gate_fence_maintenance', 'Gate and fence maintenance', 'Rust treatment, painting, hinge oiling', 'annual', 'post_monsoon', 'vendor', 240, 2000, 8000, '[{"name":"Rust converter","est_cost":500},{"name":"Metal paint","est_cost":1000}]'),

  -- Garden
  ('garden_maintenance', 'Monthly garden maintenance', 'Lawn mowing, weeding, hedge trimming, fertilizer', 'monthly', 'any', 'vendor', 120, 500, 3000, '[{"name":"Fertilizer","est_cost":300},{"name":"Pesticide spray","est_cost":200}]'),
  ('tree_trimming', 'Annual tree trimming', 'Major branch cutting and dead wood removal', 'annual', 'winter', 'vendor', 240, 1000, 5000, null),

  -- Pool
  ('pool_pump_servicing', 'Pool pump servicing', 'Filter cleaning, pump motor check', 'semi_annual', 'any', 'vendor', 120, 2000, 5000, null),
  ('pool_water_treatment', 'Monthly pool treatment', 'pH balance, chlorine, algaecide', 'monthly', 'any', 'vendor', 60, 500, 1500, '[{"name":"Chlorine tablets","est_cost":400},{"name":"pH adjuster","est_cost":200},{"name":"Algaecide","est_cost":300}]')
;
