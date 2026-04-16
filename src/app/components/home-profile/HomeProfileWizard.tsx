import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { Delete } from "@mui/icons-material";
import { useI18n } from "../../i18n";
import {
  HOME_PROFILE_TEMPLATES,
  localizeTemplate,
  getRoomSuggestions,
  groupRoomsByFloor,
  normalizeSpacesToRooms,
  floorLabel,
  type RoomEntry,
} from "../../config/homeProfileTemplates";
import { HOME_PROFILE_TOTAL_STEPS, asNumberOrNull, type HomeProfileDraft } from "./useHomeProfileWizard";

interface HomeProfileWizardProps {
  open: boolean;
  onClose: () => void;
  draft: HomeProfileDraft | null;
  setDraft: (d: HomeProfileDraft | null) => void;
  mode: "view" | "edit";
  setMode: (m: "view" | "edit") => void;
  step: number;
  setStep: (s: number) => void;
  newSpace: string;
  setNewSpace: (s: string) => void;
  busy: boolean;
  error: string | null;
  toolBusy: boolean;
  updateRecord: (patch: Record<string, unknown>) => void;
  goNext: () => void;
  goBack: () => void;
  /** Persist the draft. Should return `true` if the save succeeded so the dialog can close. */
  onSave: () => Promise<boolean>;
  /** When true, renders content inline without a Dialog wrapper. */
  embedded?: boolean;
}

export function HomeProfileWizard(props: HomeProfileWizardProps) {
  const {
    open,
    onClose,
    draft,
    setDraft,
    mode,
    setMode,
    step,
    setStep,
    newSpace,
    setNewSpace,
    busy,
    error,
    toolBusy,
    updateRecord,
    goNext,
    goBack,
    onSave,
    embedded = false,
  } = props;

  const { t, lang: uiLang } = useI18n();

  const content = (
    <Stack spacing={2} mt={embedded ? 0 : 1}>
      {error && (
        <Typography variant="body2" color="error">
          {error}
        </Typography>
      )}

      {/* Stepper — shown in edit mode */}
      {mode === "edit" && (
        <Stepper activeStep={step} alternativeLabel>
          <Step><StepLabel>{t("home_profile.step_home_type")}</StepLabel></Step>
          <Step><StepLabel>{t("home_profile.step_rooms")}</StepLabel></Step>
          <Step><StepLabel>{t("home_profile.step_household")}</StepLabel></Step>
          <Step><StepLabel>{t("home_profile.step_review")}</StepLabel></Step>
        </Stepper>
      )}

      {/* VIEW MODE */}
      {mode === "view" && draft && <ViewMode draft={draft} uiLang={uiLang} t={t} />}

      {/* STEP 0: Template picker */}
      {mode === "edit" && step === 0 && (
        <TemplatePicker
          draft={draft}
          setDraft={setDraft}
          updateRecord={updateRecord}
          uiLang={uiLang}
          t={t}
        />
      )}

      {/* STEP 1: Room editor */}
      {mode === "edit" && step === 1 && draft && (
        <RoomEditor
          draft={draft}
          updateRecord={updateRecord}
          newSpace={newSpace}
          setNewSpace={setNewSpace}
          uiLang={uiLang}
          t={t}
        />
      )}

      {/* STEP 2: Household details */}
      {mode === "edit" && step === 2 && draft && (
        <HouseholdDetails draft={draft} updateRecord={updateRecord} t={t} />
      )}

      {/* STEP 3: Review */}
      {mode === "edit" && step === 3 && draft && (
        <ReviewStep draft={draft} uiLang={uiLang} t={t} />
      )}
    </Stack>
  );

  const actions = (
    <>
      {mode === "view" ? (
        <>
          <Button variant="outlined" disabled={toolBusy || busy} onClick={onClose}>{t("home_profile.close")}</Button>
          <Button
            variant="contained"
            disabled={toolBusy || busy || !draft}
            onClick={() => { setMode("edit"); setStep(1); }}
          >
            {t("home_profile.edit")}
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="outlined"
            disabled={toolBusy || busy}
            onClick={() => { setDraft(null); onClose(); }}
          >
            {t("home_profile.discard")}
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="text"
            disabled={step === 0 || toolBusy || busy}
            onClick={goBack}
          >
            {t("home_profile.back")}
          </Button>
          {step < HOME_PROFILE_TOTAL_STEPS - 1 ? (
            <Button
              variant="contained"
              disabled={toolBusy || busy || (step === 0 && !draft)}
              onClick={goNext}
            >
              {t("home_profile.next")}
            </Button>
          ) : (
            <Button
              variant="contained"
              disabled={toolBusy || busy || !draft}
              onClick={async () => {
                const ok = await onSave();
                if (ok) onClose();
              }}
            >
              {t("home_profile.save")}
            </Button>
          )}
        </>
      )}
    </>
  );

  if (embedded) {
    return (
      <Box>
        {content}
        <Stack direction="row" spacing={1} justifyContent="flex-end" mt={2}>
          {actions}
        </Stack>
      </Box>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("home_profile.dialog_title")}</DialogTitle>
      <DialogContent>{content}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ViewMode({ draft, uiLang, t }: { draft: HomeProfileDraft; uiLang: string; t: (k: string) => string }) {
  const rec = draft.action.record as Record<string, unknown>;
  const rooms = normalizeSpacesToRooms(rec.spaces);
  const grouped = groupRoomsByFloor(rooms);
  const homeType = typeof rec.home_type === "string" ? rec.home_type : "apartment";
  const bhk = asNumberOrNull(rec.bhk);
  const squareFeet = asNumberOrNull(rec.square_feet);
  const floors = asNumberOrNull(rec.floors);
  const hasPets = rec.has_pets === true;
  const hasKids = rec.has_kids === true;
  const numBathrooms = asNumberOrNull(rec.num_bathrooms);
  const flooringType = typeof rec.flooring_type === "string" ? rec.flooring_type.trim() : "";

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">{t("home_profile.view_saved")}</Typography>
      <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
        <Stack spacing={0.5}>
          <Typography variant="body2"><strong>{t("home_profile.label_type")}:</strong> {homeType}{bhk ? ` · ${bhk} ${t("home_profile.label_bhk")}` : ""}</Typography>
          {squareFeet && <Typography variant="body2"><strong>{t("home_profile.label_area")}:</strong> {squareFeet.toLocaleString()} {t("home_profile.label_sq_ft")}</Typography>}
          {floors && <Typography variant="body2"><strong>{t("home_profile.label_floors")}:</strong> {floors}</Typography>}
          {numBathrooms && <Typography variant="body2"><strong>{t("home_profile.label_bathrooms")}:</strong> {numBathrooms}</Typography>}
          <Typography variant="body2"><strong>{t("home_profile.label_pets")}:</strong> {hasPets ? t("home_profile.label_yes") : t("home_profile.label_no")} · <strong>{t("home_profile.label_kids")}:</strong> {hasKids ? t("home_profile.label_yes") : t("home_profile.label_no")}</Typography>
          {flooringType && <Typography variant="body2"><strong>{t("home_profile.label_flooring")}:</strong> {flooringType}</Typography>}
        </Stack>
      </Paper>
      {grouped.map(({ floor, rooms: fRooms }) => (
        <Box key={String(floor)}>
          <Typography variant="caption" color="text.secondary" display="block" mb={0.5} sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
            {floorLabel(floor, uiLang as any)}
          </Typography>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
            {fRooms.map((rm) => (
              <Chip
                key={rm.id}
                size="small"
                label={rm.display_name !== rm.template_name ? `${rm.display_name} (${rm.template_name})` : rm.display_name}
                variant="outlined"
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

function TemplatePicker({
  draft,
  setDraft,
  updateRecord,
  uiLang,
  t,
}: {
  draft: HomeProfileDraft | null;
  setDraft: (d: HomeProfileDraft | null) => void;
  updateRecord: (patch: Record<string, unknown>) => void;
  uiLang: string;
  t: (k: string) => string;
}) {
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {t("home_profile.pick_type")}
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 1,
        }}
      >
        {HOME_PROFILE_TEMPLATES.map((tmplRaw) => {
          const tmpl = localizeTemplate(tmplRaw, uiLang as any);
          const selected = draft?.action.record &&
            (draft.action.record as any).__template_key === tmpl.key;
          return (
            <Paper
              key={tmpl.key}
              variant="outlined"
              onClick={() => {
                const record = {
                  __template_key: tmpl.key,
                  home_type: tmpl.home_type,
                  bhk: tmpl.bhk,
                  square_feet: tmpl.square_feet_min ?? null,
                  floors: tmpl.floors_default,
                  spaces: tmpl.rooms,
                  space_counts: {},
                  has_balcony: tmpl.rooms.some((rm) => rm.template_name.toLowerCase().includes("balcony")),
                  has_pets: false,
                  has_kids: false,
                  flooring_type: null,
                  num_bathrooms: tmpl.rooms.filter((rm) => rm.template_name.toLowerCase().includes("bathroom")).length || null,
                };
                if (draft) {
                  updateRecord(record);
                } else {
                  setDraft({
                    id: `${Date.now()}`,
                    action: {
                      type: "create",
                      table: "home_profiles",
                      record,
                      reason: "Create home profile",
                    },
                  });
                }
              }}
              sx={{
                p: 1.5,
                cursor: "pointer",
                borderColor: selected ? "primary.main" : undefined,
                borderWidth: selected ? 2 : 1,
                bgcolor: selected ? "primary.50" : undefined,
                transition: "border-color 0.15s, background 0.15s",
                "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" fontWeight={600} lineHeight={1.2}>{tmpl.label}</Typography>
              <Typography variant="caption" color="text.secondary" display="block" mt={0.25}>{tmpl.subtitle}</Typography>
              {(tmplRaw.square_feet_min || tmplRaw.square_feet_max) && (
                <Typography variant="caption" color="text.disabled" display="block" mt={0.25}>
                  {tmplRaw.square_feet_min && !tmplRaw.square_feet_max
                    ? t("home_profile.sq_ft_from").replace("{min}", tmplRaw.square_feet_min.toLocaleString())
                    : !tmplRaw.square_feet_min && tmplRaw.square_feet_max
                    ? t("home_profile.sq_ft_up_to").replace("{max}", tmplRaw.square_feet_max.toLocaleString())
                    : t("home_profile.sq_ft_range").replace("{min}", tmplRaw.square_feet_min!.toLocaleString()).replace("{max}", tmplRaw.square_feet_max!.toLocaleString())}
                </Typography>
              )}
              <Typography variant="caption" color="text.disabled" display="block" mt={0.5}>
                {(tmplRaw.floors_default !== 1 ? t("home_profile.rooms_count_plural") : t("home_profile.rooms_count"))
                  .replace("{n}", String(tmplRaw.rooms.length))
                  .replace("{floors}", String(tmplRaw.floors_default))}
              </Typography>
            </Paper>
          );
        })}
      </Box>
    </Stack>
  );
}

function RoomEditor({
  draft,
  updateRecord,
  newSpace,
  setNewSpace,
  uiLang,
  t,
}: {
  draft: HomeProfileDraft;
  updateRecord: (patch: Record<string, unknown>) => void;
  newSpace: string;
  setNewSpace: (s: string) => void;
  uiLang: string;
  t: (k: string) => string;
}) {
  const rec = draft.action.record as Record<string, unknown>;
  const rooms = normalizeSpacesToRooms(rec.spaces);
  const squareFeet = asNumberOrNull(rec.square_feet);
  const floors = asNumberOrNull(rec.floors);

  const setRooms = (next: RoomEntry[]) => {
    const hasBalcony = next.some((rm) => rm.display_name.toLowerCase().includes("balcony") || rm.template_name.toLowerCase().includes("balcony"));
    updateRecord({ spaces: next, has_balcony: hasBalcony });
  };

  const updateRoom = (idx: number, patch: Partial<RoomEntry>) => {
    const next = rooms.map((rm, i) => i === idx ? { ...rm, ...patch } : rm);
    setRooms(next);
  };

  const removeRoom = (idx: number) => setRooms(rooms.filter((_, i) => i !== idx));

  const addRoom = (name: string) => {
    if (!name.trim()) return;
    const id = `custom_${Date.now()}`;
    setRooms([...rooms, { id, template_name: name.trim(), display_name: name.trim(), floor: null }]);
  };

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
        <TextField
          label={t("home_profile.field_area")}
          type="number"
          size="small"
          fullWidth
          value={typeof squareFeet === "number" ? squareFeet : ""}
          onChange={(e) => updateRecord({ square_feet: asNumberOrNull(e.target.value) })}
          inputProps={{ min: 0, max: 200000 }}
        />
        <TextField
          label={t("home_profile.field_floors")}
          type="number"
          size="small"
          fullWidth
          value={typeof floors === "number" ? floors : ""}
          onChange={(e) => updateRecord({ floors: asNumberOrNull(e.target.value) })}
          inputProps={{ min: 1, max: 50 }}
        />
      </Stack>

      <Typography variant="body2" color="text.secondary">
        {t("home_profile.rooms_hint")}
      </Typography>

      <Stack spacing={0.75}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ width: 80, flexShrink: 0 }}>{t("home_profile.field_floor")}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{t("home_profile.field_display_name")}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{t("home_profile.field_template_name")}</Typography>
          <Box sx={{ width: 32 }} />
        </Stack>
        {rooms.map((rm, idx) => (
          <Stack key={rm.id} direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              type="number"
              placeholder="Floor"
              value={typeof rm.floor === "number" ? rm.floor : ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                updateRoom(idx, { floor: v === "" ? null : (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : null) });
              }}
              inputProps={{ min: 0, max: 50, style: { textAlign: "center" } }}
              sx={{ width: 80, flexShrink: 0 }}
            />
            <TextField
              size="small"
              fullWidth
              value={rm.display_name}
              onChange={(e) => updateRoom(idx, { display_name: e.target.value })}
              placeholder="Display name"
            />
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={rm.template_name}
            >
              {rm.display_name !== rm.template_name ? rm.template_name : ""}
            </Typography>
            <IconButton size="small" onClick={() => removeRoom(idx)} sx={{ width: 32, flexShrink: 0 }}>
              <Delete fontSize="inherit" />
            </IconButton>
          </Stack>
        ))}
      </Stack>

      <Autocomplete
        freeSolo
        options={getRoomSuggestions(uiLang as any).filter((s) => !rooms.some((rm) => rm.display_name.toLowerCase() === s.toLowerCase()))}
        value={newSpace}
        onInputChange={(_, v) => setNewSpace(v)}
        onChange={(_, v) => {
          if (typeof v === "string" && v.trim()) {
            addRoom(v.trim());
            setNewSpace("");
          }
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            label={t("home_profile.add_room")}
            placeholder={t("home_profile.add_room_placeholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newSpace.trim()) {
                addRoom(newSpace.trim());
                setNewSpace("");
                e.preventDefault();
              }
            }}
          />
        )}
      />
    </Stack>
  );
}

function HouseholdDetails({ draft, updateRecord, t }: { draft: HomeProfileDraft; updateRecord: (patch: Record<string, unknown>) => void; t: (k: string) => string }) {
  const rec = draft.action.record as Record<string, unknown>;
  const hasPets = rec.has_pets === true;
  const hasKids = rec.has_kids === true;
  const numBathrooms = asNumberOrNull(rec.num_bathrooms);
  const flooringType = typeof rec.flooring_type === "string" ? rec.flooring_type : "";

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t("home_profile.household_hint")}
      </Typography>
      <Stack direction="row" spacing={2}>
        <FormControlLabel
          control={<Switch checked={hasPets} onChange={(e) => updateRecord({ has_pets: e.target.checked })} />}
          label={t("home_profile.pets_label")}
        />
        <FormControlLabel
          control={<Switch checked={hasKids} onChange={(e) => updateRecord({ has_kids: e.target.checked })} />}
          label={t("home_profile.kids_label")}
        />
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
        <TextField
          label={t("home_profile.field_bathrooms")}
          type="number"
          size="small"
          fullWidth
          value={typeof numBathrooms === "number" ? numBathrooms : ""}
          onChange={(e) => updateRecord({ num_bathrooms: asNumberOrNull(e.target.value) })}
          inputProps={{ min: 0, max: 20 }}
        />
        <TextField
          label={t("home_profile.field_flooring")}
          size="small"
          fullWidth
          value={flooringType}
          onChange={(e) => updateRecord({ flooring_type: e.target.value || null })}
          placeholder={t("home_profile.field_flooring_placeholder")}
        />
      </Stack>
    </Stack>
  );
}

function ReviewStep({ draft, uiLang, t }: { draft: HomeProfileDraft; uiLang: string; t: (k: string) => string }) {
  const rec = draft.action.record as Record<string, unknown>;
  const rooms = normalizeSpacesToRooms(rec.spaces);
  const grouped = groupRoomsByFloor(rooms);
  const homeType = typeof rec.home_type === "string" ? rec.home_type : "apartment";
  const bhk = asNumberOrNull(rec.bhk);
  const squareFeet = asNumberOrNull(rec.square_feet);
  const floors = asNumberOrNull(rec.floors);
  const hasPets = rec.has_pets === true;
  const hasKids = rec.has_kids === true;
  const numBathrooms = asNumberOrNull(rec.num_bathrooms);
  const flooringType = typeof rec.flooring_type === "string" ? rec.flooring_type.trim() : "";

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">{t("home_profile.review_hint")}</Typography>
      <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
        <Stack spacing={0.5}>
          <Typography variant="body2"><strong>{t("home_profile.label_type")}:</strong> {homeType}{bhk ? ` · ${bhk} ${t("home_profile.label_bhk")}` : ""}</Typography>
          {squareFeet && <Typography variant="body2"><strong>{t("home_profile.label_area")}:</strong> {squareFeet.toLocaleString()} {t("home_profile.label_sq_ft")}</Typography>}
          {floors && <Typography variant="body2"><strong>{t("home_profile.label_floors")}:</strong> {floors}</Typography>}
          {numBathrooms && <Typography variant="body2"><strong>{t("home_profile.label_bathrooms")}:</strong> {numBathrooms}</Typography>}
          <Typography variant="body2"><strong>{t("home_profile.label_pets")}:</strong> {hasPets ? t("home_profile.label_yes") : t("home_profile.label_no")} · <strong>{t("home_profile.label_kids")}:</strong> {hasKids ? t("home_profile.label_yes") : t("home_profile.label_no")}</Typography>
          {flooringType && <Typography variant="body2"><strong>{t("home_profile.label_flooring")}:</strong> {flooringType}</Typography>}
        </Stack>
      </Paper>
      {grouped.map(({ floor, rooms: fRooms }) => (
        <Box key={String(floor)}>
          <Typography variant="caption" color="text.secondary" display="block" mb={0.5} sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
            {floorLabel(floor, uiLang as any)}
          </Typography>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
            {fRooms.map((rm) => (
              <Chip
                key={rm.id}
                size="small"
                label={rm.display_name !== rm.template_name ? `${rm.display_name}` : rm.display_name}
                variant="outlined"
                title={rm.display_name !== rm.template_name ? `Template: ${rm.template_name}` : undefined}
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
