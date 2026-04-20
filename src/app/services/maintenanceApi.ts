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

// ─── Maintenance → Chore Bridge ─────────────────────────────────

/**
 * Convert scheduled maintenance plan entries into chore-compatible objects
 * so they appear in daily/weekly views alongside regular chores.
 */
export interface MaintenanceChore {
  planEntryId: string;
  title: string;
  dueAt: string;
  estimatedMinutes: number;
  vendorName: string | null;
  category: string;
  status: string;
  costEstimate: { min: number | null; max: number | null };
}

export async function fetchMaintenanceChoreDue(
  householdId: string,
  fromDate: string,
  toDate: string,
): Promise<{ chores: MaintenanceChore[]; error: string | null }> {
  const { data, error } = await supabase
    .from("maintenance_plan")
    .select("*, maintenance_templates(*), vendors(*)")
    .eq("household_id", householdId)
    .in("status", ["scheduled", "in_progress", "overdue"])
    .gte("scheduled_date", fromDate)
    .lte("scheduled_date", toDate)
    .order("scheduled_date");

  if (error) return { chores: [], error: error.message };

  const chores: MaintenanceChore[] = (data ?? []).map((r: Record<string, unknown>) => {
    const tpl = r.maintenance_templates as Record<string, unknown> | null;
    const vendor = r.vendors as Record<string, unknown> | null;
    return {
      planEntryId: String(r.id),
      title: String(r.title),
      dueAt: String(r.scheduled_date),
      estimatedMinutes: typeof tpl?.estimated_duration_minutes === "number" ? tpl.estimated_duration_minutes : 60,
      vendorName: vendor?.name ? String(vendor.name) : null,
      category: tpl?.service_key ? String(tpl.service_key) : "maintenance",
      status: String(r.status),
      costEstimate: {
        min: typeof tpl?.estimated_cost_min === "number" ? tpl.estimated_cost_min : null,
        max: typeof tpl?.estimated_cost_max === "number" ? tpl.estimated_cost_max : null,
      },
    };
  });

  return { chores, error: null };
}

// ─── Maintenance Cost Tracking ──────────────────────────────────

export interface CostSummary {
  totalEstimatedMin: number;
  totalEstimatedMax: number;
  totalActual: number;
  byCategory: Record<string, { estimatedMin: number; estimatedMax: number; actual: number; count: number }>;
  byVendor: Record<string, { vendorName: string; actual: number; count: number }>;
  byMonth: Record<number, { estimated: number; actual: number; count: number }>;
}

export async function fetchMaintenanceCostSummary(
  householdId: string,
  year: number,
): Promise<{ summary: CostSummary; error: string | null }> {
  const { data, error } = await supabase
    .from("maintenance_plan")
    .select("*, maintenance_templates(estimated_cost_min, estimated_cost_max, service_catalog(category)), vendors(name)")
    .eq("household_id", householdId)
    .eq("target_year", year);

  if (error) return { summary: emptyCostSummary(), error: error.message };

  const summary = emptyCostSummary();

  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const tpl = r.maintenance_templates as Record<string, unknown> | null;
    const catalog = tpl?.service_catalog as Record<string, unknown> | null;
    const vendor = r.vendors as Record<string, unknown> | null;
    const category = catalog?.category ? String(catalog.category) : "other";
    const costMin = typeof tpl?.estimated_cost_min === "number" ? tpl.estimated_cost_min : 0;
    const costMax = typeof tpl?.estimated_cost_max === "number" ? tpl.estimated_cost_max : 0;
    const actual = typeof r.actual_cost === "number" ? r.actual_cost : 0;
    const month = typeof r.target_month === "number" ? r.target_month : 0;

    summary.totalEstimatedMin += costMin;
    summary.totalEstimatedMax += costMax;
    summary.totalActual += actual;

    if (!summary.byCategory[category]) {
      summary.byCategory[category] = { estimatedMin: 0, estimatedMax: 0, actual: 0, count: 0 };
    }
    summary.byCategory[category].estimatedMin += costMin;
    summary.byCategory[category].estimatedMax += costMax;
    summary.byCategory[category].actual += actual;
    summary.byCategory[category].count += 1;

    if (vendor?.name) {
      const vName = String(vendor.name);
      if (!summary.byVendor[vName]) {
        summary.byVendor[vName] = { vendorName: vName, actual: 0, count: 0 };
      }
      summary.byVendor[vName].actual += actual;
      summary.byVendor[vName].count += 1;
    }

    if (month > 0) {
      if (!summary.byMonth[month]) {
        summary.byMonth[month] = { estimated: 0, actual: 0, count: 0 };
      }
      summary.byMonth[month].estimated += (costMin + costMax) / 2;
      summary.byMonth[month].actual += actual;
      summary.byMonth[month].count += 1;
    }
  }

  return { summary, error: null };
}

function emptyCostSummary(): CostSummary {
  return { totalEstimatedMin: 0, totalEstimatedMax: 0, totalActual: 0, byCategory: {}, byVendor: {}, byMonth: {} };
}

// ─── Service History Log ────────────────────────────────────────

export interface ServiceHistoryEntry {
  id: string;
  title: string;
  completedDate: string;
  actualCost: number | null;
  vendorName: string | null;
  category: string;
  notes: string | null;
}

export async function fetchServiceHistory(
  householdId: string,
  filters?: { vendorId?: string; category?: string; limit?: number },
): Promise<{ history: ServiceHistoryEntry[]; error: string | null }> {
  let query = supabase
    .from("maintenance_plan")
    .select("*, maintenance_templates(*, service_catalog(category)), vendors(name)")
    .eq("household_id", householdId)
    .eq("status", "done")
    .order("completed_date", { ascending: false });

  if (filters?.vendorId) query = query.eq("vendor_id", filters.vendorId);
  if (filters?.limit) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) return { history: [], error: error.message };

  const history: ServiceHistoryEntry[] = (data ?? [])
    .filter((r: Record<string, unknown>) => {
      if (!filters?.category) return true;
      const cat = (r.maintenance_templates as Record<string, unknown> | null)
        ?.service_catalog as Record<string, unknown> | null;
      return cat?.category === filters.category;
    })
    .map((r: Record<string, unknown>) => {
      const tpl = r.maintenance_templates as Record<string, unknown> | null;
      const catalog = tpl?.service_catalog as Record<string, unknown> | null;
      const vendor = r.vendors as Record<string, unknown> | null;
      return {
        id: String(r.id),
        title: String(r.title),
        completedDate: r.completed_date ? String(r.completed_date) : "",
        actualCost: typeof r.actual_cost === "number" ? r.actual_cost : null,
        vendorName: vendor?.name ? String(vendor.name) : null,
        category: catalog?.category ? String(catalog.category) : "other",
        notes: r.notes ? String(r.notes) : null,
      };
    });

  return { history, error: null };
}

// ─── Vendor Performance Metrics ─────────────────────────────────

export interface VendorPerformance {
  vendorId: string;
  vendorName: string;
  totalJobs: number;
  completedJobs: number;
  completionRate: number;
  avgCostVsEstimate: number | null;
  totalSpent: number;
  categories: string[];
}

export async function fetchVendorPerformance(
  householdId: string,
): Promise<{ metrics: VendorPerformance[]; error: string | null }> {
  const { data, error } = await supabase
    .from("maintenance_plan")
    .select("*, maintenance_templates(estimated_cost_min, estimated_cost_max, service_catalog(category)), vendors(id, name)")
    .eq("household_id", householdId)
    .not("vendor_id", "is", null);

  if (error) return { metrics: [], error: error.message };

  const byVendor = new Map<string, {
    vendorName: string; total: number; completed: number;
    costRatios: number[]; totalSpent: number; categories: Set<string>;
  }>();

  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const vendor = r.vendors as Record<string, unknown> | null;
    if (!vendor?.id) continue;
    const vid = String(vendor.id);
    const vname = String(vendor.name ?? "");

    if (!byVendor.has(vid)) {
      byVendor.set(vid, { vendorName: vname, total: 0, completed: 0, costRatios: [], totalSpent: 0, categories: new Set() });
    }
    const v = byVendor.get(vid)!;
    v.total += 1;

    const tpl = r.maintenance_templates as Record<string, unknown> | null;
    const catalog = tpl?.service_catalog as Record<string, unknown> | null;
    if (catalog?.category) v.categories.add(String(catalog.category));

    if (String(r.status) === "done") {
      v.completed += 1;
      const actual = typeof r.actual_cost === "number" ? r.actual_cost : 0;
      v.totalSpent += actual;
      const estMin = typeof tpl?.estimated_cost_min === "number" ? tpl.estimated_cost_min : 0;
      const estMax = typeof tpl?.estimated_cost_max === "number" ? tpl.estimated_cost_max : 0;
      const estMid = (estMin + estMax) / 2;
      if (estMid > 0 && actual > 0) {
        v.costRatios.push(actual / estMid);
      }
    }
  }

  const metrics: VendorPerformance[] = [];
  for (const [vendorId, v] of byVendor) {
    metrics.push({
      vendorId,
      vendorName: v.vendorName,
      totalJobs: v.total,
      completedJobs: v.completed,
      completionRate: v.total > 0 ? Math.round((v.completed / v.total) * 100) : 0,
      avgCostVsEstimate: v.costRatios.length > 0
        ? Math.round((v.costRatios.reduce((a, b) => a + b, 0) / v.costRatios.length) * 100) / 100
        : null,
      totalSpent: v.totalSpent,
      categories: [...v.categories],
    });
  }

  return { metrics, error: null };
}

// ─── Procurement Integration ────────────────────────────────────

export async function createProcurementFromMaintenance(
  householdId: string,
  planEntryId: string,
): Promise<{ ok: true; itemCount: number } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("maintenance_plan")
    .select("*, maintenance_templates(procurement_items, title)")
    .eq("id", planEntryId)
    .eq("household_id", householdId)
    .single();

  if (error) return { ok: false, error: error.message };
  const tpl = data.maintenance_templates as Record<string, unknown> | null;
  const items = Array.isArray(tpl?.procurement_items)
    ? tpl.procurement_items as Array<{ name: string; est_cost?: number }>
    : [];

  if (items.length === 0) return { ok: true, itemCount: 0 };

  const { data: list, error: listErr } = await supabase
    .from("procurement_lists")
    .insert({
      household_id: householdId,
      title: `Supplies for: ${String(tpl?.title ?? data.title)}`,
      list_type: "maintenance",
      status: "active",
    })
    .select()
    .single();

  if (listErr) return { ok: false, error: listErr.message };

  const rows = items.map((item) => ({
    list_id: list.id,
    household_id: householdId,
    item_name: item.name,
    category: "maintenance",
    quantity: 1,
    estimated_cost: item.est_cost ?? null,
    source_type: "maintenance",
    source_id: planEntryId,
    status: "pending",
  }));

  const { error: insErr } = await supabase.from("procurement_items").insert(rows);
  if (insErr) return { ok: false, error: insErr.message };

  return { ok: true, itemCount: rows.length };
}

// ─── Consumable Tracking ────────────────────────────────────────

export interface ConsumableItem {
  id: string;
  name: string;
  category: string;
  currentLevel: number;
  lowStockThreshold: number;
  unit: string | null;
  lastRestockedAt: string | null;
  avgConsumptionDays: number | null;
  linkedChoreTypes: string[];
  notes: string | null;
}

export async function fetchConsumables(
  householdId: string,
): Promise<{ items: ConsumableItem[]; error: string | null }> {
  const { data, error } = await supabase
    .from("pantry_items")
    .select("*")
    .eq("household_id", householdId)
    .in("category", ["cleaning", "maintenance", "household"])
    .order("name");

  if (error) return { items: [], error: error.message };

  const items: ConsumableItem[] = (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    name: String(r.name),
    category: String(r.category ?? "household"),
    currentLevel: typeof r.current_level === "number" ? r.current_level : 100,
    lowStockThreshold: typeof r.low_stock_threshold === "number" ? r.low_stock_threshold : 20,
    unit: r.unit ? String(r.unit) : null,
    lastRestockedAt: r.last_restocked_at ? String(r.last_restocked_at) : null,
    avgConsumptionDays: typeof r.avg_consumption_days === "number" ? r.avg_consumption_days : null,
    linkedChoreTypes: Array.isArray(r.linked_chore_types) ? r.linked_chore_types as string[] : [],
    notes: r.notes ? String(r.notes) : null,
  }));

  return { items, error: null };
}

export async function upsertConsumable(
  householdId: string,
  item: Omit<ConsumableItem, "id"> & { id?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row: Record<string, unknown> = {
    household_id: householdId,
    name: item.name,
    category: item.category,
    current_level: item.currentLevel,
    low_stock_threshold: item.lowStockThreshold,
    unit: item.unit,
    last_restocked_at: item.lastRestockedAt,
    avg_consumption_days: item.avgConsumptionDays,
    linked_chore_types: item.linkedChoreTypes,
    notes: item.notes,
  };

  if (item.id) {
    const { error } = await supabase.from("pantry_items").update(row).eq("id", item.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from("pantry_items").insert(row);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function restockConsumable(
  itemId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from("pantry_items")
    .update({ current_level: 100, last_restocked_at: new Date().toISOString() })
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ─── Reorder Reminders ──────────────────────────────────────────

export interface ReorderAlert {
  itemId: string;
  itemName: string;
  category: string;
  currentLevel: number;
  threshold: number;
  estimatedDaysLeft: number | null;
}

export async function fetchReorderAlerts(
  householdId: string,
): Promise<{ alerts: ReorderAlert[]; error: string | null }> {
  const { data, error } = await supabase
    .from("pantry_items")
    .select("*")
    .eq("household_id", householdId)
    .in("category", ["cleaning", "maintenance", "household"]);

  if (error) return { alerts: [], error: error.message };

  const alerts: ReorderAlert[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const level = typeof r.current_level === "number" ? r.current_level : 100;
    const threshold = typeof r.low_stock_threshold === "number" ? r.low_stock_threshold : 20;
    if (level <= threshold) {
      const avgDays = typeof r.avg_consumption_days === "number" ? r.avg_consumption_days : null;
      alerts.push({
        itemId: String(r.id),
        itemName: String(r.name),
        category: String(r.category ?? "household"),
        currentLevel: level,
        threshold,
        estimatedDaysLeft: avgDays && level > 0 ? Math.round((level / 100) * avgDays) : null,
      });
    }
  }

  return { alerts, error: null };
}

// ─── Feature Warranty Tracking ──────────────────────────────────

export interface WarrantyAlert {
  featureKey: string;
  featureLabel: string;
  warrantyUntil: string;
  daysRemaining: number;
  brand: string | null;
  model: string | null;
}

export async function fetchWarrantyAlerts(
  householdId: string,
): Promise<{ alerts: WarrantyAlert[]; error: string | null }> {
  const { data, error } = await supabase
    .from("home_features")
    .select("*")
    .eq("household_id", householdId)
    .not("warranty_until", "is", null);

  if (error) return { alerts: [], error: error.message };

  const now = new Date();
  const alerts: WarrantyAlert[] = [];

  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const warrantyStr = String(r.warranty_until);
    const warrantyDate = new Date(warrantyStr);
    const daysRemaining = Math.ceil((warrantyDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    if (daysRemaining <= 90) {
      alerts.push({
        featureKey: String(r.feature_key),
        featureLabel: String(r.feature_key).replace(/_/g, " "),
        warrantyUntil: warrantyStr,
        daysRemaining,
        brand: r.brand ? String(r.brand) : null,
        model: r.model ? String(r.model) : null,
      });
    }
  }

  alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
  return { alerts, error: null };
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
