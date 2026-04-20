import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useI18n } from "../../i18n";
import type { ChoreRow } from "./ChoreCard";
import { cadenceLabel } from "../../services/choreRecommendationEngine";

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
  /** Called when user splits a chore into sub-tasks */
  onSplit?: (original: ChoreRow, subTasks: Array<{ title: string; space: string; cadence: string; category: string }>) => void;
}

const STATUS_OPTIONS = ["pending", "in-progress", "completed"] as const;
const PRIORITY_OPTIONS = [1, 2, 3] as const;
const CATEGORY_OPTIONS = [
  { value: "cleaning", label: "Cleaning (sweep, mop, dust)" },
  { value: "kitchen", label: "Kitchen & cooking" },
  { value: "bathroom", label: "Bathroom cleaning" },
  { value: "laundry", label: "Laundry & ironing" },
  { value: "outdoor", label: "Outdoor & garden" },
  { value: "organizing", label: "Organizing & declutter" },
  { value: "maintenance", label: "Maintenance & repairs" },
  { value: "childcare", label: "Childcare" },
  { value: "pet_care", label: "Pet care" },
  { value: "errands", label: "Errands & shopping" },
  { value: "other", label: "Other" },
] as const;
const CADENCE_OPTIONS = [
  "daily", "alternate_days", "every_3_days", "every_4_days",
  "weekly_mon", "weekly_tue", "weekly_wed", "weekly_thu", "weekly_fri", "weekly_sat", "weekly_sun",
  "biweekly_mon", "biweekly_sat", "monthly",
] as const;

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
  onSplit,
}: EditChoreDialogProps) {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY_FORM);
  const [splitMode, setSplitMode] = useState(false);
  const [splitTasks, setSplitTasks] = useState<Array<{ title: string }>>([{ title: "" }, { title: "" }]);

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
            <MenuItem value=""><em>—</em></MenuItem>
            {CADENCE_OPTIONS.map((c) => (
              <MenuItem key={c} value={c}>{cadenceLabel(c)}</MenuItem>
            ))}
          </TextField>
          <TextField size="small" select label={t("chores.category")} value={form.category} onChange={set("category")}>
            <MenuItem value=""><em>—</em></MenuItem>
            {CATEGORY_OPTIONS.map((c) => (
              <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>
            ))}
          </TextField>

          {/* Split into sub-tasks */}
          {onSplit && !splitMode && (
            <Button size="small" variant="text" onClick={() => setSplitMode(true)} sx={{ alignSelf: "flex-start" }}>
              Split into sub-tasks
            </Button>
          )}
          {splitMode && (
            <Box sx={{ p: 1.5, bgcolor: "action.hover", borderRadius: 1 }}>
              <Typography variant="caption" fontWeight={600} mb={1} display="block">
                Break "{form.title}" into sub-tasks:
              </Typography>
              <Stack spacing={0.75}>
                {splitTasks.map((st, i) => (
                  <Stack key={i} direction="row" spacing={0.5} alignItems="center">
                    <TextField
                      size="small" fullWidth variant="standard"
                      placeholder={`Sub-task ${i + 1}`}
                      value={st.title}
                      onChange={(e) => setSplitTasks((prev) => prev.map((s, j) => j === i ? { title: e.target.value } : s))}
                      InputProps={{ sx: { fontSize: 13 } }}
                    />
                    {splitTasks.length > 2 && (
                      <Button size="small" sx={{ minWidth: 0, p: 0 }} onClick={() => setSplitTasks((prev) => prev.filter((_, j) => j !== i))}>✕</Button>
                    )}
                  </Stack>
                ))}
              </Stack>
              <Stack direction="row" spacing={1} mt={1}>
                <Button size="small" onClick={() => setSplitTasks((prev) => [...prev, { title: "" }])}>+ Add</Button>
                <Button size="small" variant="text" onClick={() => setSplitMode(false)}>Cancel split</Button>
              </Stack>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
        {splitMode && onSplit && chore ? (
          <Button
            variant="contained" color="secondary"
            disabled={busy || splitTasks.filter((s) => s.title.trim()).length < 2}
            onClick={() => {
              const subs = splitTasks.filter((s) => s.title.trim()).map((s) => ({
                title: s.title.trim(),
                space: form.space,
                cadence: form.cadence,
                category: form.category,
              }));
              onSplit(chore, subs);
              setSplitMode(false);
              onClose();
            }}
          >
            Split into {splitTasks.filter((s) => s.title.trim()).length} tasks
          </Button>
        ) : (
          <Button variant="contained" onClick={handleSave} disabled={busy || !form.title.trim()}>
            {t("common.save")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
