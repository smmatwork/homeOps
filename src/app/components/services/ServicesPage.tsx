import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  MenuItem,
  Rating,
  Slider,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  Add,
  Assessment,
  CheckCircle,
  Delete,
  Edit,
  Inventory,
  Phone,
  Refresh,
  Shield,
  Star,
  StorefrontOutlined,
  Warning,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { supabase } from "../../services/supabaseClient";
import {
  fetchServiceCatalog,
  fetchHomeFeatures,
  filterServicesForHome,
  fetchPreferredVendors,
  fetchVendors,
  createVendor,
  updateVendor,
  deleteVendor,
  setPreferredVendor,
  fetchVendorPerformance,
  fetchConsumables,
  upsertConsumable,
  restockConsumable,
  fetchReorderAlerts,
  fetchWarrantyAlerts,
  type ServiceCatalogEntry,
  type Vendor,
  type PreferredVendor,
  type VendorPerformance,
  type ConsumableItem,
  type ReorderAlert,
  type WarrantyAlert,
} from "../../services/maintenanceApi";

const SERVICE_CATEGORIES = [
  "plumbing", "electrical", "pest_control", "hvac", "deep_cleaning",
  "carpentry", "exterior", "garden", "pool", "safety", "appliance", "utilities",
];
const SUPPLY_CATEGORIES = ["grocery", "cleaning", "household", "maintenance", "hardware"];
const LANGUAGES = ["en", "hi", "kn"];

const emptyVendorForm = {
  name: "", vendorType: "service" as string,
  phone: "", whatsapp: "", email: "", upiId: "",
  serviceCategories: [] as string[], supplyCategories: [] as string[],
  languages: [] as string[], paymentTerms: "", rating: null as number | null, notes: "",
};

export function ServicesPage() {
  const { householdId } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);

  // ── Services Needed state ──────────────────────────────────────
  const [services, setServices] = useState<ServiceCatalogEntry[]>([]);
  const [preferred, setPreferred] = useState<PreferredVendor[]>([]);
  const [allVendors, setAllVendors] = useState<Vendor[]>([]);
  const [loadingServices, setLoadingServices] = useState(true);
  const [pickServiceKey, setPickServiceKey] = useState<string | null>(null);
  const [pickVendorId, setPickVendorId] = useState("");

  // ── Vendor Directory state ─────────────────────────────────────
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loadingVendors, setLoadingVendors] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyVendorForm);
  const [busy, setBusy] = useState(false);

  // ── Vendor Performance state ────────────────────────────────────
  const [vendorMetrics, setVendorMetrics] = useState<VendorPerformance[]>([]);
  const [loadingMetrics, setLoadingMetrics] = useState(false);

  // ── Consumables state ─────────────────────────────────────────
  const [consumables, setConsumables] = useState<ConsumableItem[]>([]);
  const [reorderAlerts, setReorderAlerts] = useState<ReorderAlert[]>([]);
  const [loadingConsumables, setLoadingConsumables] = useState(false);
  const [consumableDialog, setConsumableDialog] = useState(false);
  const [editingConsumable, setEditingConsumable] = useState<ConsumableItem | null>(null);
  const [consumableForm, setConsumableForm] = useState({
    name: "", category: "cleaning", currentLevel: 100, lowStockThreshold: 20,
    unit: "", avgConsumptionDays: null as number | null, notes: "",
  });

  // ── Warranty state ────────────────────────────────────────────
  const [warrantyAlerts, setWarrantyAlerts] = useState<WarrantyAlert[]>([]);
  const [loadingWarranty, setLoadingWarranty] = useState(false);

  // ── Load services tab data ─────────────────────────────────────
  const loadServices = useCallback(async () => {
    if (!householdId) { setLoadingServices(false); return; }
    setLoadingServices(true);
    setError(null);
    try {
      const [catalogRes, featRes, profileRes, prefRes, vendRes] = await Promise.all([
        fetchServiceCatalog(),
        fetchHomeFeatures(householdId),
        supabase.from("home_profiles").select("home_type").eq("household_id", householdId).maybeSingle(),
        fetchPreferredVendors(householdId),
        fetchVendors(householdId),
      ]);
      const homeType = (profileRes.data?.home_type as string) ?? "apartment";
      const featureKeys = new Set(featRes.features.map((f) => f.featureKey));
      const filtered = filterServicesForHome(catalogRes.services, homeType, featureKeys);
      setServices(filtered);
      setPreferred(prefRes.preferred);
      setAllVendors(vendRes.vendors);
    } catch {
      setError("Failed to load services");
    } finally {
      setLoadingServices(false);
    }
  }, [householdId]);

  // ── Load vendors tab data ──────────────────────────────────────
  const loadVendors = useCallback(async () => {
    if (!householdId) { setLoadingVendors(false); return; }
    setLoadingVendors(true);
    setError(null);
    const res = await fetchVendors(householdId);
    setLoadingVendors(false);
    if (res.error) { setError(res.error); return; }
    setVendors(res.vendors);
  }, [householdId]);

  useEffect(() => { void loadServices(); }, [loadServices]);
  useEffect(() => { void loadVendors(); }, [loadVendors]);

  // ── Load vendor performance ────────────────────────────────────
  const loadMetrics = useCallback(async () => {
    if (!householdId) return;
    setLoadingMetrics(true);
    const res = await fetchVendorPerformance(householdId);
    setLoadingMetrics(false);
    if (!res.error) setVendorMetrics(res.metrics);
  }, [householdId]);

  // ── Load consumables + reorder alerts ──────────────────────────
  const loadConsumables = useCallback(async () => {
    if (!householdId) return;
    setLoadingConsumables(true);
    const [itemsRes, alertsRes] = await Promise.all([
      fetchConsumables(householdId),
      fetchReorderAlerts(householdId),
    ]);
    setLoadingConsumables(false);
    if (!itemsRes.error) setConsumables(itemsRes.items);
    if (!alertsRes.error) setReorderAlerts(alertsRes.alerts);
  }, [householdId]);

  // ── Load warranty alerts ───────────────────────────────────────
  const loadWarranty = useCallback(async () => {
    if (!householdId) return;
    setLoadingWarranty(true);
    const res = await fetchWarrantyAlerts(householdId);
    setLoadingWarranty(false);
    if (!res.error) setWarrantyAlerts(res.alerts);
  }, [householdId]);

  useEffect(() => { if (tab === 2) void loadMetrics(); }, [tab, loadMetrics]);
  useEffect(() => { if (tab === 3) void loadConsumables(); }, [tab, loadConsumables]);
  useEffect(() => { if (tab === 4) void loadWarranty(); }, [tab, loadWarranty]);

  // ── Consumable handlers ────────────────────────────────────────
  const openAddConsumable = () => {
    setConsumableForm({ name: "", category: "cleaning", currentLevel: 100, lowStockThreshold: 20, unit: "", avgConsumptionDays: null, notes: "" });
    setEditingConsumable(null);
    setConsumableDialog(true);
  };
  const openEditConsumable = (c: ConsumableItem) => {
    setConsumableForm({
      name: c.name, category: c.category, currentLevel: c.currentLevel,
      lowStockThreshold: c.lowStockThreshold, unit: c.unit ?? "",
      avgConsumptionDays: c.avgConsumptionDays, notes: c.notes ?? "",
    });
    setEditingConsumable(c);
    setConsumableDialog(true);
  };
  const handleSaveConsumable = async () => {
    if (!householdId || !consumableForm.name.trim()) return;
    setBusy(true);
    const res = await upsertConsumable(householdId, {
      ...(editingConsumable ? { id: editingConsumable.id } : {}),
      name: consumableForm.name.trim(),
      category: consumableForm.category,
      currentLevel: consumableForm.currentLevel,
      lowStockThreshold: consumableForm.lowStockThreshold,
      unit: consumableForm.unit || null,
      lastRestockedAt: editingConsumable?.lastRestockedAt ?? null,
      avgConsumptionDays: consumableForm.avgConsumptionDays,
      linkedChoreTypes: editingConsumable?.linkedChoreTypes ?? [],
      notes: consumableForm.notes || null,
    });
    setBusy(false);
    if (res.ok) { setConsumableDialog(false); await loadConsumables(); }
    else setError("error" in res ? res.error : "Failed");
  };
  const handleRestock = async (itemId: string) => {
    setBusy(true);
    const res = await restockConsumable(itemId);
    setBusy(false);
    if (res.ok) { setSnack(t("services.restocked")); await loadConsumables(); }
    else setError("error" in res ? res.error : "Failed");
  };

  // ── Set preferred vendor ───────────────────────────────────────
  const handleSetVendor = async () => {
    if (!householdId || !pickServiceKey || !pickVendorId) return;
    setBusy(true);
    const res = await setPreferredVendor(householdId, pickServiceKey, pickVendorId);
    setBusy(false);
    if (!res.ok) { setError("error" in res ? res.error : "Failed"); return; }
    setPickServiceKey(null);
    setPickVendorId("");
    await loadServices();
  };

  // ── Create / edit vendor ───────────────────────────────────────
  const openCreate = () => { setForm(emptyVendorForm); setEditingId(null); setDialogOpen(true); };
  const openEdit = (v: Vendor) => {
    setForm({
      name: v.name, vendorType: v.vendorType,
      phone: v.phone ?? "", whatsapp: v.whatsapp ?? "", email: v.email ?? "", upiId: v.upiId ?? "",
      serviceCategories: v.serviceCategories, supplyCategories: v.supplyCategories,
      languages: v.languages, paymentTerms: v.paymentTerms ?? "",
      rating: v.rating, notes: v.notes ?? "",
    });
    setEditingId(v.id);
    setDialogOpen(true);
  };

  const handleSaveVendor = async () => {
    if (!householdId || !form.name.trim()) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: form.name.trim(), vendorType: form.vendorType,
      phone: form.phone || null, whatsapp: form.whatsapp || null,
      email: form.email || null, upiId: form.upiId || null,
      address: null, serviceCategories: form.serviceCategories,
      supplyCategories: form.supplyCategories, languages: form.languages,
      paymentTerms: form.paymentTerms || null, availabilityNotes: null,
      rating: form.rating, notes: form.notes || null,
    };
    const res = editingId
      ? await updateVendor(editingId, payload)
      : await createVendor(householdId, payload);
    setBusy(false);
    if (res.ok === false) { setError(res.error); return; }
    setDialogOpen(false);
    await loadVendors();
    await loadServices(); // refresh vendor list for services tab
  };

  const handleDelete = async (id: string) => {
    setError(null);
    const res = await deleteVendor(id);
    if (res.ok === false) { setError(res.error); return; }
    await loadVendors();
  };

  // ── Group services by category ─────────────────────────────────
  const grouped = services.reduce<Record<string, ServiceCatalogEntry[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s);
    return acc;
  }, {});
  const prefMap = new Map(preferred.map((p) => [p.serviceKey, p]));

  // ── Render helpers ─────────────────────────────────────────────
  const vendorTypeBadge = (type: string) => {
    const color = type === "service" ? "primary" : type === "supplier" ? "secondary" : "info";
    return <Chip size="small" label={type} color={color} />;
  };

  const setField = <K extends keyof typeof emptyVendorForm>(k: K, v: typeof emptyVendorForm[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 1200, mx: "auto" }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight={700}>
            {t("services.title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("services.subtitle")}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          {tab === 1 && (
            <Button variant="contained" startIcon={<Add />} onClick={openCreate}>
              {t("services.add_vendor")}
            </Button>
          )}
          {tab === 3 && (
            <Button variant="contained" startIcon={<Add />} onClick={openAddConsumable}>
              {t("services.add_consumable")}
            </Button>
          )}
        </Stack>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }} variant="scrollable" scrollButtons="auto">
        <Tab label={t("services.tab_services")} />
        <Tab label={t("services.tab_vendors")} />
        <Tab icon={<Assessment />} iconPosition="start" label={t("services.tab_performance")} />
        <Tab icon={<Inventory />} iconPosition="start" label={t("services.tab_consumables")} />
        <Tab icon={<Shield />} iconPosition="start" label={t("services.tab_warranty")} />
      </Tabs>

      {/* ── Tab 0: Services Needed ────────────────────────────────── */}
      {tab === 0 && (
        loadingServices ? (
          <Box display="flex" justifyContent="center" py={4}><CircularProgress /></Box>
        ) : services.length === 0 ? (
          <Card variant="outlined">
            <CardContent sx={{ textAlign: "center", py: 6 }}>
              <StorefrontOutlined sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
              <Typography color="text.secondary">
                {t("services.empty_services")}
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <Stack spacing={3}>
            {Object.entries(grouped).map(([category, items]) => (
              <Box key={category}>
                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1, textTransform: "capitalize" }}>
                  {category.replace(/_/g, " ")}
                </Typography>
                <Stack spacing={1}>
                  {items.map((svc) => {
                    const pref = prefMap.get(svc.serviceKey);
                    return (
                      <Card key={svc.id} variant="outlined">
                        <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            <Stack spacing={0.25} flex={1}>
                              <Typography variant="body1" fontWeight={500}>{svc.title}</Typography>
                              <Stack direction="row" spacing={2} alignItems="center">
                                {svc.typicalCadence && (
                                  <Typography variant="caption" color="text.secondary">
                                    {svc.typicalCadence.replace(/_/g, " ")}
                                  </Typography>
                                )}
                                {svc.typicalCostMin != null && svc.typicalCostMax != null && (
                                  <Typography variant="caption" color="text.secondary">
                                    {svc.currency} {svc.typicalCostMin}--{svc.typicalCostMax}
                                  </Typography>
                                )}
                                {pref?.vendor ? (
                                  <Chip size="small" label={pref.vendor.name} color="success" variant="outlined" />
                                ) : (
                                  <Chip size="small" icon={<Warning />} label="No vendor assigned" color="warning" variant="outlined" />
                                )}
                              </Stack>
                            </Stack>
                            <Button size="small" onClick={() => { setPickServiceKey(svc.serviceKey); setPickVendorId(pref?.vendorId ?? ""); }}>
                              {t("services.set_vendor")}
                            </Button>
                          </Stack>
                        </CardContent>
                      </Card>
                    );
                  })}
                </Stack>
              </Box>
            ))}
          </Stack>
        )
      )}

      {/* ── Tab 1: Vendor Directory ───────────────────────────────── */}
      {tab === 1 && (
        loadingVendors ? (
          <Box display="flex" justifyContent="center" py={4}><CircularProgress /></Box>
        ) : vendors.length === 0 ? (
          <Card variant="outlined">
            <CardContent sx={{ textAlign: "center", py: 6 }}>
              <StorefrontOutlined sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
              <Typography color="text.secondary">
                {t("services.empty_vendors")}
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(320px, 1fr))" gap={2}>
            {vendors.map((v) => (
                <Card variant="outlined" sx={{ height: "100%" }}>
                  <CardContent>
                    <Stack spacing={1}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography variant="subtitle1" fontWeight={600}>{v.name}</Typography>
                        {vendorTypeBadge(v.vendorType)}
                      </Stack>
                      {v.phone && (
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Phone sx={{ fontSize: 16, color: "text.secondary" }} />
                          <Typography variant="body2">{v.phone}</Typography>
                        </Stack>
                      )}
                      {v.whatsapp && (
                        <Typography variant="body2" color="text.secondary">WA: {v.whatsapp}</Typography>
                      )}
                      {v.upiId && (
                        <Typography variant="body2" color="text.secondary">UPI: {v.upiId}</Typography>
                      )}
                      {v.serviceCategories.length > 0 && (
                        <Stack direction="row" flexWrap="wrap" gap={0.5}>
                          {v.serviceCategories.map((c) => (
                            <Chip key={c} label={c.replace(/_/g, " ")} size="small" variant="outlined" />
                          ))}
                        </Stack>
                      )}
                      {v.supplyCategories.length > 0 && (
                        <Stack direction="row" flexWrap="wrap" gap={0.5}>
                          {v.supplyCategories.map((c) => (
                            <Chip key={c} label={c} size="small" color="secondary" variant="outlined" />
                          ))}
                        </Stack>
                      )}
                      {v.rating != null && (
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Rating value={v.rating} readOnly size="small" icon={<Star fontSize="inherit" />} emptyIcon={<Star fontSize="inherit" />} />
                        </Stack>
                      )}
                      {v.paymentTerms && (
                        <Typography variant="caption" color="text.secondary">{v.paymentTerms}</Typography>
                      )}
                    </Stack>
                  </CardContent>
                  <CardActions>
                    <IconButton size="small" onClick={() => openEdit(v)}><Edit fontSize="small" /></IconButton>
                    <IconButton size="small" onClick={() => void handleDelete(v.id)}><Delete fontSize="small" /></IconButton>
                  </CardActions>
                </Card>
            ))}
          </Box>
        )
      )}

      {/* ── Tab 2: Vendor Performance ─────────────────────────────── */}
      {tab === 2 && (
        loadingMetrics ? (
          <Box display="flex" justifyContent="center" py={4}><CircularProgress /></Box>
        ) : vendorMetrics.length === 0 ? (
          <Card variant="outlined">
            <CardContent sx={{ textAlign: "center", py: 6 }}>
              <Assessment sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
              <Typography color="text.secondary">{t("services.no_performance_data")}</Typography>
            </CardContent>
          </Card>
        ) : (
          <Stack spacing={2}>
            {vendorMetrics.map((vm) => (
              <Card key={vm.vendorId} variant="outlined">
                <CardContent>
                  <Stack spacing={1}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="subtitle1" fontWeight={600}>{vm.vendorName}</Typography>
                      <Chip size="small" label={`${vm.completionRate}% ${t("services.completion")}`}
                        color={vm.completionRate >= 80 ? "success" : vm.completionRate >= 50 ? "warning" : "error"} />
                    </Stack>
                    <Stack direction="row" spacing={3} flexWrap="wrap">
                      <Typography variant="body2" color="text.secondary">
                        {vm.completedJobs}/{vm.totalJobs} {t("services.jobs_completed")}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {t("services.total_spent")}: ₹{vm.totalSpent.toLocaleString()}
                      </Typography>
                      {vm.avgCostVsEstimate != null && (
                        <Typography variant="body2" color={vm.avgCostVsEstimate <= 1 ? "success.main" : "warning.main"}>
                          {t("services.cost_ratio")}: {vm.avgCostVsEstimate}x
                        </Typography>
                      )}
                    </Stack>
                    <LinearProgress
                      variant="determinate"
                      value={vm.completionRate}
                      color={vm.completionRate >= 80 ? "success" : vm.completionRate >= 50 ? "warning" : "error"}
                      sx={{ height: 6, borderRadius: 3 }}
                    />
                    {vm.categories.length > 0 && (
                      <Stack direction="row" gap={0.5} flexWrap="wrap">
                        {vm.categories.map((c) => (
                          <Chip key={c} size="small" label={c.replace(/_/g, " ")} variant="outlined" />
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        )
      )}

      {/* ── Tab 3: Consumables ────────────────────────────────────── */}
      {tab === 3 && (
        loadingConsumables ? (
          <Box display="flex" justifyContent="center" py={4}><CircularProgress /></Box>
        ) : (
          <Stack spacing={3}>
            {/* Reorder alerts */}
            {reorderAlerts.length > 0 && (
              <Alert severity="warning" icon={<Warning />}>
                <Typography variant="body2" fontWeight={600}>{t("services.low_stock_alert")}</Typography>
                {reorderAlerts.map((a) => (
                  <Typography key={a.itemId} variant="body2">
                    {a.itemName}: {a.currentLevel}% {t("services.remaining")}
                    {a.estimatedDaysLeft != null && ` (~${a.estimatedDaysLeft} ${t("services.days_left")})`}
                  </Typography>
                ))}
              </Alert>
            )}

            {consumables.length === 0 ? (
              <Card variant="outlined">
                <CardContent sx={{ textAlign: "center", py: 6 }}>
                  <Inventory sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
                  <Typography color="text.secondary">{t("services.no_consumables")}</Typography>
                </CardContent>
              </Card>
            ) : (
              <Stack spacing={1}>
                {consumables.map((c) => (
                  <Card key={c.id} variant="outlined">
                    <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Stack spacing={0.5} flex={1}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="body1" fontWeight={500}>{c.name}</Typography>
                            <Chip size="small" label={c.category} variant="outlined" />
                            {c.unit && <Typography variant="caption" color="text.secondary">({c.unit})</Typography>}
                          </Stack>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <LinearProgress
                              variant="determinate"
                              value={c.currentLevel}
                              color={c.currentLevel <= c.lowStockThreshold ? "error" : c.currentLevel <= 50 ? "warning" : "primary"}
                              sx={{ flex: 1, height: 8, borderRadius: 4 }}
                            />
                            <Typography variant="caption" fontWeight={600} sx={{ minWidth: 40 }}>
                              {c.currentLevel}%
                            </Typography>
                          </Stack>
                        </Stack>
                        <Stack direction="row" spacing={0.5}>
                          <IconButton size="small" onClick={() => void handleRestock(c.id)} title={t("services.restock")}>
                            <Refresh fontSize="small" />
                          </IconButton>
                          <IconButton size="small" onClick={() => openEditConsumable(c)}>
                            <Edit fontSize="small" />
                          </IconButton>
                        </Stack>
                      </Stack>
                    </CardContent>
                  </Card>
                ))}
              </Stack>
            )}
          </Stack>
        )
      )}

      {/* ── Tab 4: Warranty Alerts ────────────────────────────────── */}
      {tab === 4 && (
        loadingWarranty ? (
          <Box display="flex" justifyContent="center" py={4}><CircularProgress /></Box>
        ) : warrantyAlerts.length === 0 ? (
          <Card variant="outlined">
            <CardContent sx={{ textAlign: "center", py: 6 }}>
              <CheckCircle sx={{ fontSize: 64, color: "success.main", mb: 2 }} />
              <Typography color="text.secondary">{t("services.no_warranty_alerts")}</Typography>
            </CardContent>
          </Card>
        ) : (
          <Stack spacing={1}>
            {warrantyAlerts.map((wa) => (
              <Card key={wa.featureKey} variant="outlined">
                <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Stack spacing={0.25}>
                      <Typography variant="body1" fontWeight={500} sx={{ textTransform: "capitalize" }}>
                        {wa.featureLabel}
                      </Typography>
                      <Stack direction="row" spacing={2}>
                        {wa.brand && <Typography variant="caption" color="text.secondary">{wa.brand}</Typography>}
                        {wa.model && <Typography variant="caption" color="text.secondary">{wa.model}</Typography>}
                        <Typography variant="caption" color="text.secondary">
                          {t("services.expires")}: {wa.warrantyUntil}
                        </Typography>
                      </Stack>
                    </Stack>
                    <Chip
                      size="small"
                      label={wa.daysRemaining <= 0
                        ? t("services.expired")
                        : `${wa.daysRemaining} ${t("services.days_left")}`}
                      color={wa.daysRemaining <= 0 ? "error" : wa.daysRemaining <= 30 ? "warning" : "info"}
                    />
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        )
      )}

      {/* ── Pick Vendor dialog (services tab) ─────────────────────── */}
      <Dialog open={!!pickServiceKey} onClose={() => setPickServiceKey(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{t("services.pick_vendor_title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              select label={t("services.vendor")} size="small" fullWidth
              value={pickVendorId} onChange={(e) => setPickVendorId(e.target.value)}
            >
              {allVendors.map((v) => (
                <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPickServiceKey(null)} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={handleSetVendor} disabled={busy || !pickVendorId}>{t("common.save")}</Button>
        </DialogActions>
      </Dialog>

      {/* ── Add / Edit Vendor dialog ──────────────────────────────── */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? t("services.edit_vendor") : t("services.add_vendor")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="Name" size="small" fullWidth required
              value={form.name} onChange={(e) => setField("name", e.target.value)} />
            <TextField select label="Type" size="small" fullWidth
              value={form.vendorType} onChange={(e) => setField("vendorType", e.target.value)}>
              <MenuItem value="service">Service</MenuItem>
              <MenuItem value="supplier">Supplier</MenuItem>
              <MenuItem value="both">Both</MenuItem>
            </TextField>
            <TextField label="Phone" size="small" fullWidth
              value={form.phone} onChange={(e) => setField("phone", e.target.value)} />
            <TextField label="WhatsApp" size="small" fullWidth
              value={form.whatsapp} onChange={(e) => setField("whatsapp", e.target.value)} />
            <TextField label="Email" size="small" fullWidth
              value={form.email} onChange={(e) => setField("email", e.target.value)} />
            <TextField label="UPI ID" size="small" fullWidth
              value={form.upiId} onChange={(e) => setField("upiId", e.target.value)} />

            {/* Service categories multi-select */}
            <TextField select label="Service Categories" size="small" fullWidth
              SelectProps={{ multiple: true, renderValue: (sel) => (sel as string[]).map((s) => s.replace(/_/g, " ")).join(", ") }}
              value={form.serviceCategories} onChange={(e) => setField("serviceCategories", e.target.value as unknown as string[])}>
              {SERVICE_CATEGORIES.map((c) => (
                <MenuItem key={c} value={c}>{c.replace(/_/g, " ")}</MenuItem>
              ))}
            </TextField>

            {/* Supply categories multi-select */}
            <TextField select label="Supply Categories" size="small" fullWidth
              SelectProps={{ multiple: true, renderValue: (sel) => (sel as string[]).join(", ") }}
              value={form.supplyCategories} onChange={(e) => setField("supplyCategories", e.target.value as unknown as string[])}>
              {SUPPLY_CATEGORIES.map((c) => (
                <MenuItem key={c} value={c}>{c}</MenuItem>
              ))}
            </TextField>

            {/* Languages multi-select */}
            <TextField select label="Languages" size="small" fullWidth
              SelectProps={{ multiple: true, renderValue: (sel) => (sel as string[]).join(", ") }}
              value={form.languages} onChange={(e) => setField("languages", e.target.value as unknown as string[])}>
              {LANGUAGES.map((l) => (
                <MenuItem key={l} value={l}>{l}</MenuItem>
              ))}
            </TextField>

            <TextField label="Payment Terms" size="small" fullWidth
              value={form.paymentTerms} onChange={(e) => setField("paymentTerms", e.target.value)} />
            <TextField select label="Rating" size="small" fullWidth
              value={form.rating ?? ""} onChange={(e) => setField("rating", e.target.value ? Number(e.target.value) : null)}>
              <MenuItem value="">None</MenuItem>
              {[1, 2, 3, 4, 5].map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
            </TextField>
            <TextField label="Notes" size="small" fullWidth multiline minRows={2}
              value={form.notes} onChange={(e) => setField("notes", e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={handleSaveVendor} disabled={busy || !form.name.trim()}>{t("common.save")}</Button>
        </DialogActions>
      </Dialog>

      {/* ── Add / Edit Consumable dialog ─────────────────────────── */}
      <Dialog open={consumableDialog} onClose={() => setConsumableDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingConsumable ? t("services.edit_consumable") : t("services.add_consumable")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label={t("services.consumable_name")} size="small" fullWidth required
              value={consumableForm.name} onChange={(e) => setConsumableForm((p) => ({ ...p, name: e.target.value }))} />
            <TextField select label={t("services.category")} size="small" fullWidth
              value={consumableForm.category} onChange={(e) => setConsumableForm((p) => ({ ...p, category: e.target.value }))}>
              <MenuItem value="cleaning">{t("services.cat_cleaning")}</MenuItem>
              <MenuItem value="maintenance">{t("services.cat_maintenance")}</MenuItem>
              <MenuItem value="household">{t("services.cat_household")}</MenuItem>
            </TextField>
            <TextField label={t("services.unit")} size="small" fullWidth
              value={consumableForm.unit} onChange={(e) => setConsumableForm((p) => ({ ...p, unit: e.target.value }))} />
            <Box>
              <Typography variant="body2" gutterBottom>{t("services.current_level")}: {consumableForm.currentLevel}%</Typography>
              <Slider
                value={consumableForm.currentLevel}
                onChange={(_, v) => setConsumableForm((p) => ({ ...p, currentLevel: v as number }))}
                min={0} max={100} step={5}
                color={consumableForm.currentLevel <= consumableForm.lowStockThreshold ? "error" : "primary"}
              />
            </Box>
            <TextField
              label={t("services.low_stock_threshold")} size="small" fullWidth type="number"
              value={consumableForm.lowStockThreshold}
              onChange={(e) => setConsumableForm((p) => ({ ...p, lowStockThreshold: Number(e.target.value) }))} />
            <TextField
              label={t("services.avg_consumption_days")} size="small" fullWidth type="number"
              value={consumableForm.avgConsumptionDays ?? ""}
              onChange={(e) => setConsumableForm((p) => ({ ...p, avgConsumptionDays: e.target.value ? Number(e.target.value) : null }))} />
            <TextField label={t("services.notes")} size="small" fullWidth multiline minRows={2}
              value={consumableForm.notes} onChange={(e) => setConsumableForm((p) => ({ ...p, notes: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConsumableDialog(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={handleSaveConsumable} disabled={busy || !consumableForm.name.trim()}>{t("common.save")}</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snack} autoHideDuration={4000} onClose={() => setSnack(null)} message={snack} />
    </Box>
  );
}
