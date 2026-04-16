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
import type { ChoreRow } from "./ChoreCard";

interface EditChoreDialogProps {
  open: boolean;
  chore: ChoreRow | null;
  onClose: () => void;
  helpers: Array<{ id: string; name: string }>;
  busy: boolean;
  helperOnLeave?: (helperId: string, dueAt: string) => boolean;
  onSave: (data: {
    choreId: string;
    title: string;
    description: string;
    status: string;
    priority: number;
    dueAt: string;
    helperId: string;
    space: string;
    cadence: string;
    category: string;
  }) => void;
}

const STATUS_OPTIONS = ["pending", "in-progress", "completed"] as const;
const PRIORITY_OPTIONS = [1, 2, 3] as const;
const CADENCE_OPTIONS = ["daily", "weekly", "biweekly", "monthly"] as const;

function datetimeLocalFromIso(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY_FORM = {
  title: "",
  description: "",
  status: "pending",
  priority: 2,
  dueAt: "",
  helperId: "",
  space: "",
  cadence: "weekly",
  category: "",
};

export function EditChoreDialog({
  open,
  chore,
  onClose,
  helpers,
  busy,
  helperOnLeave,
  onSave,
}: EditChoreDialogProps) {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (!chore) return;
    const meta = chore.metadata ?? {};
    setForm({
      title: chore.title,
      description: chore.description ?? "",
      status: chore.status,
      priority: chore.priority,
      dueAt: datetimeLocalFromIso(chore.due_at),
      helperId: chore.helper_id ?? "",
      space: (meta.space as string) ?? "",
      cadence: (meta.cadence as string) ?? "weekly",
      category: (meta.category as string) ?? "",
    });
  }, [chore]);

  const set = (field: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: field === "priority" ? Number(e.target.value) : e.target.value }));

  const handleSave = () => {
    if (!chore || !form.title.trim()) return;
    onSave({ choreId: chore.id, ...form });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("common.edit")}</DialogTitle>
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
          <TextField size="small" select label={t("chores.status")} value={form.status} onChange={set("status")}>
            {STATUS_OPTIONS.map((s) => (
              <MenuItem key={s} value={s}>{t(`chores.status_${s.replace("-", "_")}`)}</MenuItem>
            ))}
          </TextField>
          <TextField size="small" select label={t("chores.priority")} value={form.priority} onChange={set("priority")}>
            <MenuItem value="1">{t("chores.priority_low")}</MenuItem>
            <MenuItem value="2">{t("chores.priority_medium")}</MenuItem>
            <MenuItem value="3">{t("chores.priority_high")}</MenuItem>
          </TextField>
          <TextField
            size="small"
            label={t("chores.due_date")}
            type="datetime-local"
            value={form.dueAt}
            onChange={set("dueAt")}
            InputLabelProps={{ shrink: true }}
          />
          <TextField size="small" select label={t("chores.assign_to")} value={form.helperId} onChange={set("helperId")}>
            <MenuItem value=""><em>{t("chores.unassigned")}</em></MenuItem>
            {helpers.map((h) => (
              <MenuItem key={h.id} value={h.id}>{h.name}</MenuItem>
            ))}
          </TextField>
          <TextField size="small" label={t("chores.space")} value={form.space} onChange={set("space")} />
          <TextField size="small" select label={t("chat.frequency")} value={form.cadence} onChange={set("cadence")}>
            {CADENCE_OPTIONS.map((c) => (
              <MenuItem key={c} value={c}>{t(`chat.frequency_${c}`)}</MenuItem>
            ))}
          </TextField>
          <TextField size="small" label={t("chores.category")} value={form.category} onChange={set("category")} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
        <Button variant="contained" onClick={handleSave} disabled={busy || !form.title.trim()}>
          {t("common.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
