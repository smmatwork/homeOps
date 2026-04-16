import {
  Card,
  CardContent,
  Checkbox,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Edit,
  Delete,
  RestoreFromTrash,
  ReportProblem,
} from "@mui/icons-material";
import { useI18n } from "../../i18n";

/* ── shared types & helpers ── */

export type ChoreRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  completed_at: string | null;
  helper_id: string | null;
  metadata: Record<string, unknown> | null;
  deleted_at?: string | null;
  created_at: string;
};

export function getMetaStrings(chore: ChoreRow): { space: string; subspace: string; cadence: string; category: string } {
  const meta =
    chore.metadata && typeof chore.metadata === "object" && !Array.isArray(chore.metadata)
      ? (chore.metadata as Record<string, unknown>)
      : {};
  return {
    space: typeof meta.space === "string" ? meta.space.trim() : "",
    subspace: typeof meta.subspace === "string" ? meta.subspace.trim() : "",
    cadence: typeof meta.cadence === "string" ? meta.cadence.trim() : "",
    category: typeof meta.category === "string" ? meta.category.trim() : "",
  };
}

export function formatDueDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/* ── status / priority chips ── */

function statusColor(s: string): "success" | "warning" | "default" {
  if (s === "completed") return "success";
  if (s === "in-progress") return "warning";
  return "default";
}

function priorityColor(p: number): "error" | "warning" | "info" {
  if (p >= 3) return "error";
  if (p === 2) return "warning";
  return "info";
}

/* ── component ── */

interface ChoreCardProps {
  chore: ChoreRow;
  helperName: string;
  isOnLeave: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: (checked: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onReportNotDone: () => void;
}

export function ChoreCard({
  chore,
  helperName,
  isOnLeave,
  selected,
  disabled,
  onSelect,
  onEdit,
  onDelete,
  onRestore,
  onReportNotDone,
}: ChoreCardProps) {
  const { t } = useI18n();
  const { space, cadence } = getMetaStrings(chore);
  const isSoftDeleted = !!chore.deleted_at;
  const due = formatDueDate(chore.due_at);

  return (
    <Card variant="outlined" sx={{ opacity: isSoftDeleted ? 0.55 : 1 }}>
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
          {/* checkbox */}
          <Checkbox
            size="small"
            checked={selected}
            disabled={disabled}
            onChange={(_e, checked) => onSelect(checked)}
            sx={{ p: 0.5 }}
          />

          {/* title + chips */}
          <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="subtitle2" noWrap sx={{ maxWidth: 260 }}>
                {chore.title}
              </Typography>
              <Chip label={chore.status} size="small" color={statusColor(chore.status)} />
              <Chip label={`P${chore.priority}`} size="small" color={priorityColor(chore.priority)} variant="outlined" />
            </Stack>

            {/* meta row */}
            <Stack direction="row" spacing={2} flexWrap="wrap" sx={{ color: "text.secondary" }}>
              {space && (
                <Typography variant="caption">
                  {t("chores.space")}: {space}
                </Typography>
              )}
              {cadence && (
                <Typography variant="caption">
                  {t("chores.cadence")}: {cadence}
                </Typography>
              )}
              {helperName && (
                <Typography variant="caption" sx={{ color: isOnLeave ? "warning.main" : undefined }}>
                  {t("chores.helper")}: {helperName}
                </Typography>
              )}
              {due && (
                <Typography variant="caption">
                  {t("chores.due")}: {due}
                </Typography>
              )}
            </Stack>
          </Stack>

          {/* actions */}
          <Stack direction="row" spacing={0.5} flexShrink={0}>
            {isSoftDeleted ? (
              <Tooltip title={t("common.restore") || "Restore"}>
                <IconButton size="small" onClick={onRestore}>
                  <RestoreFromTrash fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : (
              <>
                <Tooltip title={t("common.edit")}>
                  <IconButton size="small" onClick={onEdit}>
                    <Edit fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t("common.delete")}>
                  <IconButton size="small" onClick={onDelete}>
                    <Delete fontSize="small" />
                  </IconButton>
                </Tooltip>
                {chore.status === "completed" && (
                  <Tooltip title={t("chores.report_not_done")}>
                    <IconButton size="small" color="warning" onClick={onReportNotDone}>
                      <ReportProblem fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
