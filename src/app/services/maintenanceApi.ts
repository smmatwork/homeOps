/**
 * API layer for maintenance, services, vendors, and procurement.
 */

import { supabase } from "./supabaseClient";

// ─── Types ───────────────────────────────────────────────────────

export interface HomeFeature {
  featureKey: string;
  quantity: number;
  brand: string | null;
  model: string | null;
  installDate: string | null;
  warrantyUntil: string | null;
  notes: string | null;
}

export interface ServiceCatalogEntry {
  id: string;
  category: string;
  serviceKey: string;
  title: string;
  description: string | null;
  typicalCadence: string | null;
  typicalCostMin: number | null;
  typicalCostMax: number | null;
  currency: string;
  requiresFeatures: string[] | null;
  requiresHomeTypes: string[] | null;
}

export interface MaintenanceTemplate {
  id: string;
  serviceKey: string | null;
  title: string;
  description: string | null;
  cadence: string;
  seasonAffinity: string | null;
  doerType: string;
  estimatedDurationMinutes: number | null;
  estimatedCostMin: number | null;
  estimatedCostMax: number | null;
  procurementItems: Array<{ name: string; est_cost?: number }> | null;
}

export interface Vendor {
  id: string;
  householdId: string;
  name: string;
  vendorType: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  upiId: string | null;
  address: string | null;
  serviceCategories: string[];
  supplyCategories: string[];
  languages: string[];
  paymentTerms: string | null;
  availabilityNotes: string | null;
  rating: number | null;
  notes: string | null;
  isActive: boolean;
}

export interface PreferredVendor {
  serviceKey: string;
  vendorId: string;
  vendor?: Vendor;
  priority: number;
  amcActive: boolean;
  amcExpiresAt: string | null;
  lastServiceDate: string | null;
  lastServiceCost: number | null;
}

export interface MaintenancePlanEntry {
  id: string;
  householdId: string;
  templateId: string | null;
  vendorId: string | null;
  title: string;
  status: string;
  targetMonth: number | null;
  targetYear: number | null;
  scheduledDate: string | null;
  completedDate: string | null;
  actualCost: number | null;
  notes: string | null;
  template?: MaintenanceTemplate;
  vendor?: Vendor;
}

// ─── Home Features ───────────────────────────────────────────────

export async function fetchHomeFeatures(householdId: string): Promise<{
  features: HomeFeature[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("home_features")
    .select("*")
    .eq("household_id", householdId);

  if (error) return { features: [], error: error.message };

  const features: HomeFeature[] = (data ?? []).map((r: Record<string, unknown>) => ({
    featureKey: String(r.feature_key),
    quantity: Number(r.quantity ?? 1),
    brand: r.brand ? String(r.brand) : null,
    model: r.model ? String(r.model) : null,
    installDate: r.install_date ? String(r.install_date) : null,
    warrantyUntil: r.warranty_until ? String(r.warranty_until) : null,
    notes: r.notes ? String(r.notes) : null,
  }));

  return { features, error: null };
}

export async function saveHomeFeatures(
  householdId: string,
  features: Array<{ featureKey: string; quantity?: number }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Delete existing, then insert fresh
  const { error: delErr } = await supabase
    .from("home_features")
    .delete()
    .eq("household_id", householdId);

  if (delErr) return { ok: false, error: delErr.message };

  if (features.length === 0) return { ok: true };

  const rows = features.map((f) => ({
    household_id: householdId,
    feature_key: f.featureKey,
    quantity: f.quantity ?? 1,
  }));

  const { error: insErr } = await supabase
    .from("home_features")
    .insert(rows);

  if (insErr) return { ok: false, error: insErr.message };
  return { ok: true };
}

// ─── Service Catalog ─────────────────────────────────────────────

export async function fetchServiceCatalog(): Promise<{
  services: ServiceCatalogEntry[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("service_catalog")
    .select("*")
    .eq("is_active", true)
    .order("category")
    .order("title");

  if (error) return { services: [], error: error.message };

  const services: ServiceCatalogEntry[] = (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    category: String(r.category),
    serviceKey: String(r.service_key),
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    typicalCadence: r.typical_cadence ? String(r.typical_cadence) : null,
    typicalCostMin: typeof r.typical_cost_min === "number" ? r.typical_cost_min : null,
    typicalCostMax: typeof r.typical_cost_max === "number" ? r.typical_cost_max : null,
    currency: String(r.currency ?? "INR"),
    requiresFeatures: Array.isArray(r.requires_features) ? r.requires_features as string[] : null,
    requiresHomeTypes: Array.isArray(r.requires_home_types) ? r.requires_home_types as string[] : null,
  }));

  return { services, error: null };
}

/**
 * Filter the global catalog to services relevant to this household,
 * based on home type and active features.
 */
export function filterServicesForHome(
  services: ServiceCatalogEntry[],
  homeType: string,
  featureKeys: Set<string>,
): ServiceCatalogEntry[] {
  return services.filter((s) => {
    // Home type filter
    if (s.requiresHomeTypes && s.requiresHomeTypes.length > 0) {
      if (!s.requiresHomeTypes.includes(homeType)) return false;
    }
    // Feature filter: needs at least one of the required features
    if (s.requiresFeatures && s.requiresFeatures.length > 0) {
      if (!s.requiresFeatures.some((f) => featureKeys.has(f))) return false;
    }
    return true;
  });
}

// ─── Vendors ─────────────────────────────────────────────────────

export async function fetchVendors(householdId: string): Promise<{
  vendors: Vendor[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("vendors")
    .select("*")
    .eq("household_id", householdId)
    .eq("is_active", true)
    .order("name");

  if (error) return { vendors: [], error: error.message };

  const vendors: Vendor[] = (data ?? []).map(mapVendorRow);
  return { vendors, error: null };
}

export async function createVendor(
  householdId: string,
  vendor: Omit<Vendor, "id" | "householdId" | "isActive">,
): Promise<{ ok: true; vendor: Vendor } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("vendors")
    .insert({
      household_id: householdId,
      name: vendor.name,
      vendor_type: vendor.vendorType,
      phone: vendor.phone,
      whatsapp: vendor.whatsapp,
      email: vendor.email,
      upi_id: vendor.upiId,
      address: vendor.address,
      service_categories: vendor.serviceCategories,
      supply_categories: vendor.supplyCategories,
      languages: vendor.languages,
      payment_terms: vendor.paymentTerms,
      availability_notes: vendor.availabilityNotes,
      rating: vendor.rating,
      notes: vendor.notes,
    })
    .select()
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, vendor: mapVendorRow(data) };
}

export async function updateVendor(
  vendorId: string,
  patch: Partial<Omit<Vendor, "id" | "householdId">>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.vendorType !== undefined) row.vendor_type = patch.vendorType;
  if (patch.phone !== undefined) row.phone = patch.phone;
  if (patch.whatsapp !== undefined) row.whatsapp = patch.whatsapp;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.upiId !== undefined) row.upi_id = patch.upiId;
  if (patch.address !== undefined) row.address = patch.address;
  if (patch.serviceCategories !== undefined) row.service_categories = patch.serviceCategories;
  if (patch.supplyCategories !== undefined) row.supply_categories = patch.supplyCategories;
  if (patch.languages !== undefined) row.languages = patch.languages;
  if (patch.paymentTerms !== undefined) row.payment_terms = patch.paymentTerms;
  if (patch.rating !== undefined) row.rating = patch.rating;
  if (patch.notes !== undefined) row.notes = patch.notes;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { error } = await supabase.from("vendors").update(row).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteVendor(
  vendorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("vendors").delete().eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ─── Preferred Vendors ───────────────────────────────────────────

export async function fetchPreferredVendors(householdId: string): Promise<{
  preferred: PreferredVendor[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("preferred_vendors")
    .select("*, vendors(*)")
    .eq("household_id", householdId)
    .order("priority");

  if (error) return { preferred: [], error: error.message };

  const preferred: PreferredVendor[] = (data ?? []).map((r: Record<string, unknown>) => ({
    serviceKey: String(r.service_key),
    vendorId: String(r.vendor_id),
    vendor: r.vendors ? mapVendorRow(r.vendors as Record<string, unknown>) : undefined,
    priority: Number(r.priority ?? 1),
    amcActive: !!r.amc_active,
    amcExpiresAt: r.amc_expires_at ? String(r.amc_expires_at) : null,
    lastServiceDate: r.last_service_date ? String(r.last_service_date) : null,
    lastServiceCost: typeof r.last_service_cost === "number" ? r.last_service_cost : null,
  }));

  return { preferred, error: null };
}

export async function setPreferredVendor(
  householdId: string,
  serviceKey: string,
  vendorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from("preferred_vendors")
    .upsert({
      household_id: householdId,
      service_key: serviceKey,
      vendor_id: vendorId,
      priority: 1,
    }, { onConflict: "household_id,service_key,vendor_id" });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ─── Maintenance Plan ────────────────────────────────────────────

export async function fetchMaintenancePlan(
  householdId: string,
  year?: number,
): Promise<{ plan: MaintenancePlanEntry[]; error: string | null }> {
  let query = supabase
    .from("maintenance_plan")
    .select("*, maintenance_templates(*), vendors(*)")
    .eq("household_id", householdId)
    .order("target_year")
    .order("target_month");

  if (year) query = query.eq("target_year", year);

  const { data, error } = await query;
  if (error) return { plan: [], error: error.message };

  const plan: MaintenancePlanEntry[] = (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    householdId: String(r.household_id),
    templateId: r.template_id ? String(r.template_id) : null,
    vendorId: r.vendor_id ? String(r.vendor_id) : null,
    title: String(r.title),
    status: String(r.status),
    targetMonth: typeof r.target_month === "number" ? r.target_month : null,
    targetYear: typeof r.target_year === "number" ? r.target_year : null,
    scheduledDate: r.scheduled_date ? String(r.scheduled_date) : null,
    completedDate: r.completed_date ? String(r.completed_date) : null,
    actualCost: typeof r.actual_cost === "number" ? r.actual_cost : null,
    notes: r.notes ? String(r.notes) : null,
    template: r.maintenance_templates ? mapTemplateRow(r.maintenance_templates as Record<string, unknown>) : undefined,
    vendor: r.vendors ? mapVendorRow(r.vendors as Record<string, unknown>) : undefined,
  }));

  return { plan, error: null };
}

export async function generateMaintenancePlan(
  householdId: string,
  year: number,
  homeType: string,
  featureKeys: Set<string>,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  // Fetch templates
  const { data: templates, error: tplErr } = await supabase
    .from("maintenance_templates")
    .select("*, service_catalog!inner(requires_features, requires_home_types)")
    .eq("is_active", true);

  if (tplErr) return { ok: false, error: tplErr.message };

  // Check existing plan items for this year
  const { data: existing, error: existErr } = await supabase
    .from("maintenance_plan")
    .select("template_id")
    .eq("household_id", householdId)
    .eq("target_year", year);

  if (existErr) return { ok: false, error: existErr.message };
  const existingTemplateIds = new Set((existing ?? []).map((r: Record<string, unknown>) => String(r.template_id)));

  const SEASON_MONTHS: Record<string, number[]> = {
    pre_monsoon: [3, 4, 5],
    monsoon: [6, 7, 8, 9],
    post_monsoon: [10, 11],
    summer: [3, 4, 5],
    winter: [11, 12, 1, 2],
    any: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  };

  const CADENCE_MONTHS: Record<string, number[]> = {
    monthly: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    quarterly: [1, 4, 7, 10],
    semi_annual: [4, 10],
    annual: [4],
    biennial: [4],
    seasonal: [],
  };

  const rows: Array<Record<string, unknown>> = [];

  for (const tpl of (templates ?? []) as Array<Record<string, unknown>>) {
    const catalog = tpl.service_catalog as Record<string, unknown> | null;
    const reqFeatures = Array.isArray(catalog?.requires_features) ? catalog.requires_features as string[] : null;
    const reqHomeTypes = Array.isArray(catalog?.requires_home_types) ? catalog.requires_home_types as string[] : null;

    // Check applicability
    if (reqHomeTypes && reqHomeTypes.length > 0 && !reqHomeTypes.includes(homeType)) continue;
    if (reqFeatures && reqFeatures.length > 0 && !reqFeatures.some((f) => featureKeys.has(f))) continue;

    if (existingTemplateIds.has(String(tpl.id))) continue;

    const cadence = String(tpl.cadence ?? "annual");
    const season = String(tpl.season_affinity ?? "any");

    let months = CADENCE_MONTHS[cadence] ?? [4];
    if (cadence === "seasonal" || (season !== "any" && SEASON_MONTHS[season])) {
      const seasonMonths = SEASON_MONTHS[season] ?? [4];
      months = months.length > 0
        ? months.filter((m) => seasonMonths.includes(m))
        : [seasonMonths[0]];
      if (months.length === 0) months = [seasonMonths[0]];
    }

    for (const month of months) {
      rows.push({
        household_id: householdId,
        template_id: String(tpl.id),
        title: String(tpl.title),
        status: "upcoming",
        target_month: month,
        target_year: year,
      });
    }
  }

  if (rows.length === 0) return { ok: true, count: 0 };

  const { error: insErr } = await supabase.from("maintenance_plan").insert(rows);
  if (insErr) return { ok: false, error: insErr.message };
  return { ok: true, count: rows.length };
}

// ─── Helpers ─────────────────────────────────────────────────────

function mapVendorRow(r: Record<string, unknown>): Vendor {
  return {
    id: String(r.id),
    householdId: String(r.household_id),
    name: String(r.name),
    vendorType: String(r.vendor_type ?? "service"),
    phone: r.phone ? String(r.phone) : null,
    whatsapp: r.whatsapp ? String(r.whatsapp) : null,
    email: r.email ? String(r.email) : null,
    upiId: r.upi_id ? String(r.upi_id) : null,
    address: r.address ? String(r.address) : null,
    serviceCategories: Array.isArray(r.service_categories) ? r.service_categories as string[] : [],
    supplyCategories: Array.isArray(r.supply_categories) ? r.supply_categories as string[] : [],
    languages: Array.isArray(r.languages) ? r.languages as string[] : ["en"],
    paymentTerms: r.payment_terms ? String(r.payment_terms) : null,
    availabilityNotes: r.availability_notes ? String(r.availability_notes) : null,
    rating: typeof r.rating === "number" ? r.rating : null,
    notes: r.notes ? String(r.notes) : null,
    isActive: r.is_active !== false,
  };
}

function mapTemplateRow(r: Record<string, unknown>): MaintenanceTemplate {
  return {
    id: String(r.id),
    serviceKey: r.service_key ? String(r.service_key) : null,
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    cadence: String(r.cadence),
    seasonAffinity: r.season_affinity ? String(r.season_affinity) : null,
    doerType: String(r.doer_type ?? "vendor"),
    estimatedDurationMinutes: typeof r.estimated_duration_minutes === "number" ? r.estimated_duration_minutes : null,
    estimatedCostMin: typeof r.estimated_cost_min === "number" ? r.estimated_cost_min : null,
    estimatedCostMax: typeof r.estimated_cost_max === "number" ? r.estimated_cost_max : null,
    procurementItems: Array.isArray(r.procurement_items) ? r.procurement_items as Array<{ name: string; est_cost?: number }> : null,
  };
}
