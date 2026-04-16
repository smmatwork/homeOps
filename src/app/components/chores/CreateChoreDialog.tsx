import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useI18n } from "../../i18n";

interface CreateChoreDialogProps {
  open: boolean;
  onClose: () => void;
  helpers: Array<{ id: string; name: string; type: string | null }>;
  busy: boolean;
  onSave: (data: {
    title: string;
    description: string;
    helperId: string;
    cadence: string;
    dueAt: string;
  }) => void;
}

import { cadenceLabel } from "../../services/choreRecommendationEngine";

const CADENCE_OPTIONS = [
  "daily", "alternate_days", "every_3_days", "every_4_days",
  "weekly_mon", "weekly_tue", "weekly_wed", "weekly_thu", "weekly_fri", "weekly_sat", "weekly_sun",
  "biweekly_mon", "biweekly_sat", "monthly",
] as const;

const EMPTY_FORM = {
  title: "",
  description: "",
  helperId: "",
  cadence: "weekly_sat",
  dueAt: "",
};

export function CreateChoreDialog({
  open,
  onClose,
  helpers,
  busy,
  onSave,
}: CreateChoreDialogProps) {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
  }, [open]);

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSave = () => {
    if (!form.title.trim()) return;
    onSave(form);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("chores.create_new")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <TextField
            size="small"
            label={t("chores.chore_title")}
            required
            value={form.title}
            onChange={set("title")}
            autoFocus
          />
          <TextField
            size="small"
            label={t("chores.description")}
            value={form.description}
            onChange={set("description")}
            multiline
            rows={2}
          />
          <TextField
            size="small"
            select
            label={t("chores.assign_to")}
            value={form.helperId}
            onChange={set("helperId")}
          >
            <MenuItem value="">
              <em>{t("chores.unassigned")}</em>
            </MenuItem>
            {helpers.map((h) => (
              <MenuItem key={h.id} value={h.id}>
                {h.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label={t("chat.frequency")}
            value={form.cadence}
            onChange={set("cadence")}
          >
            {CADENCE_OPTIONS.map((c) => (
              <MenuItem key={c} value={c}>
                {cadenceLabel(c)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label={t("chores.due_date")}
            type="datetime-local"
            value={form.dueAt}
            onChange={set("dueAt")}
            InputLabelProps={{ shrink: true }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={busy || !form.title.trim()}
        >
          {t("chores.create_chore")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
