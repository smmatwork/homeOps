/**
 * Household People — manage who lives in the home.
 * Separate from helpers (who work in the home) and household_members (app logins).
 */

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Add, Delete, Edit, People } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { supabase } from "../../services/supabaseClient";

interface Person {
  id: string;
  displayName: string;
  personType: string;
  linkedUserId: string | null;
}

const TYPE_COLORS: Record<string, "primary" | "secondary" | "default"> = {
  adult: "primary",
  kid: "secondary",
};

export function HouseholdPeople() {
  const { householdId } = useAuth();
  const { t } = useI18n();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", type: "adult" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!householdId) { setLoading(false); return; }
    setLoading(true);
    const { data, error: err } = await supabase
      .from("household_people")
      .select("id, display_name, person_type, linked_user_id")
      .eq("household_id", householdId)
      .order("created_at");
    setLoading(false);
    if (err) { setError(err.message); return; }
    setPeople((data ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id),
      displayName: String(r.display_name),
      personType: String(r.person_type ?? "adult"),
      linkedUserId: r.linked_user_id ? String(r.linked_user_id) : null,
    })));
  }, [householdId]);

  useEffect(() => { void load(); }, [load]);

  const openAdd = () => {
    setForm({ name: "", type: "adult" });
    setEditingId(null);
    setDialogOpen(true);
  };

  const openEdit = (p: Person) => {
    setForm({ name: p.displayName, type: p.personType });
    setEditingId(p.id);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!householdId || !form.name.trim()) return;
    setBusy(true);
    setError(null);

    if (editingId) {
      const { error: err } = await supabase
        .from("household_people")
        .update({ display_name: form.name.trim(), person_type: form.type })
        .eq("id", editingId);
      if (err) setError(err.message);
    } else {
      const { error: err } = await supabase
        .from("household_people")
        .insert({
          household_id: householdId,
          display_name: form.name.trim(),
          person_type: form.type,
        });
      if (err) setError(err.message);
    }

    setBusy(false);
    setDialogOpen(false);
    await load();
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    const { error: err } = await supabase.from("household_people").delete().eq("id", id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    await load();
  };

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 800, mx: "auto" }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight={700}>{t("members.title")}</Typography>
          <Typography variant="body2" color="text.secondary">{t("members.subtitle")}</Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={openAdd}>
          {t("members.add")}
        </Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box display="flex" justifyContent="center" py={4}><CircularProgress /></Box>
      ) : people.length === 0 ? (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: "center", py: 6 }}>
            <People sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
            <Typography color="text.secondary">{t("members.empty")}</Typography>
            <Typography variant="body2" color="text.secondary" mt={1}>
              {t("members.empty_hint")}
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {people.map((p) => (
            <Card key={p.id} variant="outlined">
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Typography variant="subtitle1" fontWeight={600}>{p.displayName}</Typography>
                    <Chip
                      size="small"
                      label={t(`members.type_${p.personType}`)}
                      color={TYPE_COLORS[p.personType] ?? "default"}
                      variant="outlined"
                    />
                    {p.linkedUserId && (
                      <Chip size="small" label={t("members.app_user")} color="success" variant="outlined" sx={{ fontSize: 11 }} />
                    )}
                  </Stack>
                  <Stack direction="row" spacing={0.5}>
                    <IconButton size="small" onClick={() => openEdit(p)}><Edit fontSize="small" /></IconButton>
                    <IconButton size="small" onClick={() => void handleDelete(p.id)} disabled={busy}>
                      <Delete fontSize="small" />
                    </IconButton>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{editingId ? t("members.edit") : t("members.add")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              size="small" label={t("members.name")} fullWidth required autoFocus
              value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <TextField
              size="small" select label={t("members.type")} fullWidth
              value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            >
              <MenuItem value="adult">{t("members.type_adult")}</MenuItem>
              <MenuItem value="kid">{t("members.type_kid")}</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={handleSave} disabled={busy || !form.name.trim()}>{t("common.save")}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
