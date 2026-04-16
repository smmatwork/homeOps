import {
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
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

export function formatDueTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/* ── status / priority chips ── */

function statusColor(s: string): "success" | "warning" | "default" {
  if (s === "completed" || s === "done") return "success";
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
  /** Helper display name (empty string if unassigned). */
  helperName?: string;
  isOnLeave?: boolean;
  /** Bulk-selection mode: checkbox selects the row. */
  selected?: boolean;
  disabled?: boolean;
  onSelect?: (checked: boolean) => void;
  /** Completion-toggle mode: checkbox toggles done/pending. */
  onToggleComplete?: () => void;
  completeBusy?: boolean;
  /** Action callbacks — omit to hide the action buttons. */
  onEdit?: () => void;
  onDelete?: () => void;
  onRestore?: () => void;
  onReportNotDone?: () => void;
  /** If true, show estimated minutes from metadata. */
  showEstimate?: boolean;
  /** If true, show the due time only (not full date). Used in daily view. */
  showTimeOnly?: boolean;
}

export function ChoreCard({
  chore,
  helperName,
  isOnLeave,
  selected,
  disabled,
  onSelect,
  onToggleComplete,
  completeBusy,
  onEdit,
  onDelete,
  onRestore,
  onReportNotDone,
  showEstimate,
  showTimeOnly,
}: ChoreCardProps) {
  const { t } = useI18n();
  const { space, cadence } = getMetaStrings(chore);
  const isSoftDeleted = !!chore.deleted_at;
  const isDone = chore.status === "completed" || chore.status === "done";
  const meta = (chore.metadata ?? {}) as Record<string, unknown>;
  const minutes = typeof meta.estimated_minutes === "number" ? meta.estimated_minutes : null;
  const due = showTimeOnly ? formatDueTime(chore.due_at) : formatDueDate(chore.due_at);
  const hasActions = onEdit || onDelete || onRestore;

  return (
    <Card variant="outlined" sx={{ opacity: isSoftDeleted ? 0.55 : isDone ? 0.7 : 1 }}>
      <CardContent sx={{ py: 1, px: 1.5, "&:last-child": { pb: 1 } }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
          {/* Checkbox: completion toggle OR bulk select */}
          {onToggleComplete ? (
            <Checkbox
              size="small"
              checked={isDone}
              disabled={completeBusy}
              onChange={onToggleComplete}
              sx={{ p: 0.5 }}
            />
          ) : onSelect ? (
            <Checkbox
              size="small"
              checked={selected ?? false}
              disabled={disabled}
              onChange={(_e, checked) => onSelect(checked)}
              sx={{ p: 0.5 }}
            />
          ) : null}

          {/* Title + chips */}
          <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography
                variant="subtitle2"
                noWrap
                sx={{
                  maxWidth: { xs: 220, sm: 300 },
                  textDecoration: isDone ? "line-through" : "none",
                  color: isDone ? "text.disabled" : "text.primary",
                }}
              >
                {chore.title}
              </Typography>
              <Chip label={t(`chores.status_${chore.status.replace("-", "_")}`)} size="small" color={statusColor(chore.status)} />
              <Chip label={`P${chore.priority}`} size="small" color={priorityColor(chore.priority)} variant="outlined" />
            </Stack>

            {/* Meta row */}
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
              {showEstimate && minutes != null && minutes > 0 && (
                <Typography variant="caption">~{minutes}m</Typography>
              )}
            </Stack>
          </Stack>

          {/* Actions */}
          <Stack direction="row" spacing={0.5} flexShrink={0} alignItems="center">
            {completeBusy && <CircularProgress size={14} />}
            {hasActions && !isSoftDeleted && (
              <>
                {onEdit && (
                  <Tooltip title={t("common.edit")}>
                    <IconButton size="small" onClick={onEdit}><Edit fontSize="small" /></IconButton>
                  </Tooltip>
                )}
                {onDelete && (
                  <Tooltip title={t("common.delete")}>
                    <IconButton size="small" onClick={onDelete}><Delete fontSize="small" /></IconButton>
                  </Tooltip>
                )}
                {onReportNotDone && chore.status === "completed" && (
                  <Tooltip title={t("chores.report_not_done")}>
                    <IconButton size="small" color="warning" onClick={onReportNotDone}>
                      <ReportProblem fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </>
            )}
            {isSoftDeleted && onRestore && (
              <Tooltip title={t("common.restore") || "Restore"}>
                <IconButton size="small" onClick={onRestore}><RestoreFromTrash fontSize="small" /></IconButton>
              </Tooltip>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
