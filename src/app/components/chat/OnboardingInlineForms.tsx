/**
 * Inline forms rendered inside the chat during agent-driven onboarding.
 * Each form collects structured data and sends it back to the agent
 * as a JSON message so the conversation continues naturally.
 */

import { useState } from "react";
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { Add } from "@mui/icons-material";
import { useI18n } from "../../i18n";
import type { InlineFormType } from "../../services/agentActions";
import {
  HOME_PROFILE_TEMPLATES,
  localizeTemplate,
  getRoomSuggestions,
  floorLabel,
  type RoomEntry,
} from "../../config/homeProfileTemplates";
import {
  HOME_FEATURES,
  FEATURE_GROUPS,
  featuresForHomeType,
  featureLabel,
  groupLabel,
  type FeatureGroup,
} from "../../config/homeFeatures";

interface InlineFormProps {
  formType: InlineFormType;
  context?: Record<string, unknown>;
  onSubmit: (data: Record<string, unknown>) => void;
  disabled?: boolean;
}

export function OnboardingInlineForm({ formType, context, onSubmit, disabled }: InlineFormProps) {
  switch (formType) {
    case "home_type_picker":
      return <HomeTypePicker onSubmit={onSubmit} disabled={disabled} />;
    case "room_editor":
      return <RoomEditorForm context={context} onSubmit={onSubmit} disabled={disabled} />;
    case "feature_selector":
      return <FeatureSelectorForm context={context} onSubmit={onSubmit} disabled={disabled} />;
    case "household_details":
      return <HouseholdDetailsForm onSubmit={onSubmit} disabled={disabled} />;
    case "chore_recommendations":
      return <ChoreRecommendationsForm context={context} onSubmit={onSubmit} disabled={disabled} />;
    case "helper_form":
      return <HelperFormInline onSubmit={onSubmit} disabled={disabled} />;
    default:
      return null;
  }
}

// ── Home Type Picker ─────────────────────────────────────────────

function HomeTypePicker({ onSubmit, disabled }: { onSubmit: (d: Record<string, unknown>) => void; disabled?: boolean }) {
  const { t, lang } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: "background.paper" }}>
      <Typography variant="subtitle2" fontWeight={600} mb={1.5}>
        {t("home_profile.pick_type")}
      </Typography>
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(130px, 1fr))" gap={1} mb={2}>
        {HOME_PROFILE_TEMPLATES.map((tmplRaw) => {
          const tmpl = localizeTemplate(tmplRaw, lang as "en" | "hi" | "kn");
          const isSel = selected === tmpl.key;
          return (
            <Paper
              key={tmpl.key}
              variant="outlined"
              onClick={() => setSelected(tmpl.key)}
              sx={{
                p: 1.5,
                cursor: "pointer",
                borderColor: isSel ? "primary.main" : undefined,
                borderWidth: isSel ? 2 : 1,
                bgcolor: isSel ? "primary.50" : undefined,
                "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" fontWeight={600} lineHeight={1.2}>{tmpl.label}</Typography>
              <Typography variant="caption" color="text.secondary" display="block" mt={0.25}>{tmpl.subtitle}</Typography>
            </Paper>
          );
        })}
      </Box>
      <Button
        variant="contained"
        size="small"
        disabled={!selected || disabled}
        onClick={() => {
          const tmpl = HOME_PROFILE_TEMPLATES.find((t) => t.key === selected);
          if (!tmpl) return;
          onSubmit({
            form_type: "home_type_picker",
            home_type: tmpl.home_type,
            bhk: tmpl.bhk,
            template_key: tmpl.key,
            rooms: tmpl.rooms,
            floors: tmpl.floors_default,
          });
        }}
      >
        {t("onboarding.confirm_selection")}
      </Button>
    </Paper>
  );
}

// ── Room Editor ──────────────────────────────────────────────────

function RoomEditorForm({ context, onSubmit, disabled }: { context?: Record<string, unknown>; onSubmit: (d: Record<string, unknown>) => void; disabled?: boolean }) {
  const { t, lang } = useI18n();
  const initial = Array.isArray(context?.rooms) ? context.rooms as RoomEntry[] : [];
  const numFloors = typeof context?.floors === "number" ? context.floors : 1;
  const [rooms, setRooms] = useState<RoomEntry[]>(initial);
  const [newName, setNewName] = useState("");
  const [addFloor, setAddFloor] = useState(0);

  const addRoom = () => {
    if (!newName.trim()) return;
    setRooms((prev) => [...prev, { id: `custom_${Date.now()}`, template_name: newName.trim(), display_name: newName.trim(), floor: addFloor }]);
    setNewName("");
  };

  const removeRoom = (id: string) => setRooms((prev) => prev.filter((r) => r.id !== id));

  const floorOptions = Array.from({ length: Math.max(1, numFloors) }, (_, i) => i);

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: "background.paper" }}>
      <Typography variant="subtitle2" fontWeight={600} mb={1}>
        {t("home_profile.step_rooms")}
      </Typography>
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap mb={2}>
        {rooms.map((rm) => (
          <Chip key={rm.id} label={`${rm.display_name} (${floorLabel(rm.floor, lang as "en" | "hi" | "kn")})`} onDelete={() => removeRoom(rm.id)} variant="outlined" />
        ))}
        {rooms.length === 0 && <Typography variant="body2" color="text.secondary">{t("home_profile.no_rooms_yet")}</Typography>}
      </Stack>
      <Stack direction="row" spacing={1} alignItems="flex-start" mb={2}>
        <Autocomplete
          freeSolo
          options={getRoomSuggestions(lang as "en" | "hi" | "kn").filter((s) => !rooms.some((r) => r.display_name.toLowerCase() === s.toLowerCase()))}
          value={newName}
          onInputChange={(_, v) => setNewName(v)}
          onChange={(_, v) => { if (typeof v === "string") setNewName(v); }}
          sx={{ flex: 1 }}
          renderInput={(params) => <TextField {...params} size="small" label={t("home_profile.room_name")} placeholder={t("home_profile.add_room_placeholder")} onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { addRoom(); e.preventDefault(); } }} />}
        />
        <TextField select size="small" label={t("home_profile.field_floor")} value={addFloor} onChange={(e) => setAddFloor(Number(e.target.value))} sx={{ minWidth: 130 }} SelectProps={{ native: true }}>
          {floorOptions.map((f) => <option key={f} value={f}>{floorLabel(f, lang as "en" | "hi" | "kn")}</option>)}
        </TextField>
        <Button variant="outlined" size="small" disabled={!newName.trim()} onClick={addRoom} sx={{ height: 40 }}><Add /></Button>
      </Stack>
      <Button variant="contained" size="small" disabled={rooms.length === 0 || disabled} onClick={() => onSubmit({ form_type: "room_editor", rooms })}>
        {t("onboarding.confirm_rooms")}
      </Button>
    </Paper>
  );
}

// ── Feature Selector ─────────────────────────────────────────────

function FeatureSelectorForm({ context, onSubmit, disabled }: { context?: Record<string, unknown>; onSubmit: (d: Record<string, unknown>) => void; disabled?: boolean }) {
  const { t, lang } = useI18n();
  const homeType = typeof context?.home_type === "string" ? context.home_type : "apartment";
  const features = featuresForHomeType(homeType);
  const [selected, setSelected] = useState<Record<string, number>>({});

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = 1;
      return next;
    });
  };

  const groups = Object.keys(FEATURE_GROUPS) as FeatureGroup[];

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: "background.paper" }}>
      <Typography variant="subtitle2" fontWeight={600} mb={1.5}>
        {t("onboarding.select_features")}
      </Typography>
      {groups.map((g) => {
        const gFeatures = features.filter((f) => f.group === g);
        if (gFeatures.length === 0) return null;
        return (
          <Box key={g} mb={1.5}>
            <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ textTransform: "uppercase", letterSpacing: 0.5 }}>
              {groupLabel(g, lang)}
            </Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap mt={0.5}>
              {gFeatures.map((f) => (
                <Chip
                  key={f.key}
                  label={featureLabel(f, lang)}
                  variant={selected[f.key] ? "filled" : "outlined"}
                  color={selected[f.key] ? "primary" : "default"}
                  onClick={() => toggle(f.key)}
                  sx={{ cursor: "pointer" }}
                />
              ))}
            </Stack>
          </Box>
        );
      })}
      <Button
        variant="contained"
        size="small"
        disabled={disabled}
        onClick={() => onSubmit({ form_type: "feature_selector", features: Object.keys(selected).map((key) => ({ feature_key: key, quantity: selected[key] })) })}
        sx={{ mt: 1 }}
      >
        {t("onboarding.confirm_features")}
      </Button>
    </Paper>
  );
}

// ── Household Details ────────────────────────────────────────────

function HouseholdDetailsForm({ onSubmit, disabled }: { onSubmit: (d: Record<string, unknown>) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [hasPets, setHasPets] = useState(false);
  const [hasKids, setHasKids] = useState(false);
  const [bathrooms, setBathrooms] = useState("");
  const [flooring, setFlooring] = useState("");

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: "background.paper" }}>
      <Typography variant="subtitle2" fontWeight={600} mb={1.5}>
        {t("home_profile.step_household")}
      </Typography>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={2}>
          <FormControlLabel control={<Switch checked={hasPets} onChange={(e) => setHasPets(e.target.checked)} />} label={t("home_profile.pets_label")} />
          <FormControlLabel control={<Switch checked={hasKids} onChange={(e) => setHasKids(e.target.checked)} />} label={t("home_profile.kids_label")} />
        </Stack>
        <Stack direction="row" spacing={1.5}>
          <TextField size="small" type="number" label={t("home_profile.field_bathrooms")} value={bathrooms} onChange={(e) => setBathrooms(e.target.value)} sx={{ width: 120 }} inputProps={{ min: 0, max: 20 }} />
          <TextField size="small" label={t("home_profile.field_flooring")} value={flooring} onChange={(e) => setFlooring(e.target.value)} placeholder={t("home_profile.field_flooring_placeholder")} sx={{ flex: 1 }} />
        </Stack>
        <Button variant="contained" size="small" disabled={disabled} onClick={() => onSubmit({ form_type: "household_details", has_pets: hasPets, has_kids: hasKids, num_bathrooms: bathrooms ? Number(bathrooms) : null, flooring_type: flooring || null })}>
          {t("onboarding.confirm_details")}
        </Button>
      </Stack>
    </Paper>
  );
}

// ── Chore Recommendations ────────────────────────────────────────

const CADENCE_OPTIONS = ["daily", "weekly", "biweekly", "monthly"] as const;

function ChoreRecommendationsForm({ context, onSubmit, disabled }: { context?: Record<string, unknown>; onSubmit: (d: Record<string, unknown>) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const initial = Array.isArray(context?.chores) ? context.chores as Array<{ title: string; space?: string; cadence?: string }> : [];
  const [chores, setChores] = useState(initial.map((c, i) => ({ ...c, id: i, selected: true })));

  const toggle = (id: number) => setChores((prev) => prev.map((c) => c.id === id ? { ...c, selected: !c.selected } : c));
  const updateTitle = (id: number, title: string) => setChores((prev) => prev.map((c) => c.id === id ? { ...c, title } : c));
  const updateCadence = (id: number, cadence: string) => setChores((prev) => prev.map((c) => c.id === id ? { ...c, cadence } : c));
  const removeChore = (id: number) => setChores((prev) => prev.filter((c) => c.id !== id));

  const selectedCount = chores.filter((c) => c.selected).length;

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: "background.paper" }}>
      <Typography variant="subtitle2" fontWeight={600} mb={1}>
        {t("onboarding.review_chores")}
      </Typography>
      <Typography variant="caption" color="text.secondary" mb={1.5} display="block">
        {t("onboarding.review_chores_hint")}
      </Typography>
      <Stack spacing={1} mb={2} sx={{ maxHeight: 360, overflowY: "auto" }}>
        {chores.map((c) => (
          <Stack key={c.id} direction="row" spacing={1} alignItems="center" sx={{ opacity: c.selected ? 1 : 0.5 }}>
            <Checkbox size="small" checked={c.selected} onChange={() => toggle(c.id)} />
            <TextField
              size="small"
              value={c.title}
              onChange={(e) => updateTitle(c.id, e.target.value)}
              sx={{ flex: 1 }}
              variant="standard"
              InputProps={{ disableUnderline: !c.selected, sx: { fontSize: 13 } }}
              disabled={!c.selected}
            />
            {c.space && <Chip size="small" label={c.space} variant="outlined" sx={{ fontSize: 11 }} />}
            <TextField
              select
              size="small"
              value={c.cadence ?? "weekly"}
              onChange={(e) => updateCadence(c.id, e.target.value)}
              disabled={!c.selected}
              sx={{ minWidth: 90 }}
              SelectProps={{ native: true, sx: { fontSize: 12 } }}
            >
              {CADENCE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </TextField>
          </Stack>
        ))}
      </Stack>
      <Stack direction="row" spacing={1}>
        <Button variant="contained" size="small" disabled={disabled || selectedCount === 0} onClick={() => {
          const confirmed = chores.filter((c) => c.selected).map(({ title, space, cadence }) => ({ title, space, cadence }));
          onSubmit({ form_type: "chore_recommendations", confirmed_chores: confirmed });
        }}>
          {t("onboarding.create_chores")} ({selectedCount})
        </Button>
        <Button variant="text" size="small" disabled={disabled} onClick={() => onSubmit({ form_type: "chore_recommendations", confirmed_chores: [], skipped: true })}>
          {t("onboarding.skip_chores")}
        </Button>
      </Stack>
    </Paper>
  );
}

// ── Helper Form ──────────────────────────────────────────────────

function HelperFormInline({ onSubmit, disabled }: { onSubmit: (d: Record<string, unknown>) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [phone, setPhone] = useState("");

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: "background.paper" }}>
      <Typography variant="subtitle2" fontWeight={600} mb={1.5}>
        {t("onboarding.add_helper")}
      </Typography>
      <Stack spacing={1.5}>
        <TextField size="small" label={t("helpers.name_business")} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <Stack direction="row" spacing={1.5}>
          <TextField size="small" label={t("helpers.role_service_type")} value={type} onChange={(e) => setType(e.target.value)} sx={{ flex: 1 }} placeholder="e.g. Maid, Cook" />
          <TextField size="small" label={t("helpers.phone")} value={phone} onChange={(e) => setPhone(e.target.value)} sx={{ flex: 1 }} />
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" size="small" disabled={!name.trim() || disabled} onClick={() => { onSubmit({ form_type: "helper_form", name: name.trim(), type: type.trim() || null, phone: phone.trim() || null }); setName(""); setType(""); setPhone(""); }}>
            {t("helpers.add_helper")}
          </Button>
          <Button variant="text" size="small" disabled={disabled} onClick={() => onSubmit({ form_type: "helper_form", skipped: true })}>
            {t("onboarding.skip_helpers")}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
