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
  MenuItem,
  Rating,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  Add,
  Delete,
  Edit,
  Phone,
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
  type ServiceCatalogEntry,
  type Vendor,
  type PreferredVendor,
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
  const { t: _t } = useI18n(); // eslint-disable-line @typescript-eslint/no-unused-vars
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string | null>(null);

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

  // ── Load services tab data ─────────────────────────────────────
  const loadServices = useCallback(async () => {
    if (!householdId) return;
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
    if (!householdId) return;
    setLoadingVendors(true);
    setError(null);
    const res = await fetchVendors(householdId);
    setLoadingVendors(false);
    if (res.error) { setError(res.error); return; }
    setVendors(res.vendors);
  }, [householdId]);

  useEffect(() => { void loadServices(); }, [loadServices]);
  useEffect(() => { void loadVendors(); }, [loadVendors]);

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
            {/* TODO: t("services.title") */}Services & Vendors
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {/* TODO: t("services.subtitle") */}Manage service needs and your vendor directory
          </Typography>
        </Box>
        {tab === 1 && (
          <Button variant="contained" startIcon={<Add />} onClick={openCreate}>
            {/* TODO: t("services.add_vendor") */}Add Vendor
          </Button>
        )}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
        <Tab label={/* TODO: t("services.tab_services") */ "Services Needed"} />
        <Tab label={/* TODO: t("services.tab_vendors") */ "Vendor Directory"} />
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
                {/* TODO: t("services.empty_services") */}No services found for your home profile.
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
                              {/* TODO: t("services.set_vendor") */}Set Vendor
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
                {/* TODO: t("services.empty_vendors") */}No vendors yet. Add your first vendor to get started.
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

      {/* ── Pick Vendor dialog (services tab) ─────────────────────── */}
      <Dialog open={!!pickServiceKey} onClose={() => setPickServiceKey(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{/* TODO: t("services.pick_vendor_title") */}Assign Vendor</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              select label={/* TODO: t("services.vendor") */ "Vendor"} size="small" fullWidth
              value={pickVendorId} onChange={(e) => setPickVendorId(e.target.value)}
            >
              {allVendors.map((v) => (
                <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPickServiceKey(null)} disabled={busy}>{/* TODO: t("common.cancel") */}Cancel</Button>
          <Button variant="contained" onClick={handleSetVendor} disabled={busy || !pickVendorId}>{/* TODO: t("common.save") */}Save</Button>
        </DialogActions>
      </Dialog>

      {/* ── Add / Edit Vendor dialog ──────────────────────────────── */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? /* TODO: t("services.edit_vendor") */ "Edit Vendor" : /* TODO: t("services.add_vendor") */ "Add Vendor"}</DialogTitle>
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
          <Button onClick={() => setDialogOpen(false)} disabled={busy}>{/* TODO: t("common.cancel") */}Cancel</Button>
          <Button variant="contained" onClick={handleSaveVendor} disabled={busy || !form.name.trim()}>{/* TODO: t("common.save") */}Save</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
