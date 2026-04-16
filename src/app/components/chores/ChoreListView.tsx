import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { ChecklistRtl, Close, DeleteOutline } from "@mui/icons-material";
import { useI18n } from "../../i18n";
import { ChoreCard, type ChoreRow, getMetaStrings } from "./ChoreCard";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface ChoreListViewProps {
  chores: ChoreRow[];
  helpers: Array<{ id: string; name: string; type: string | null }>;
  busy: boolean;
  spaceFilter: string | null;
  cadenceFilter: string | null;
  onClearFilters: () => void;
  onEdit: (chore: ChoreRow) => void;
  onDelete: (chore: ChoreRow) => void;
  onRestore: (chore: ChoreRow) => void;
  onReportNotDone: (chore: ChoreRow) => void;
  onBulkDelete: (ids: string[]) => void;
  helperOnLeave: (helperId: string | null, dueAt: string | null) => boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const STATUS_TABS = ["all", "pending", "in_progress", "completed"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

function matchesTab(status: string, tab: StatusTab) {
  if (tab === "all") return true;
  return status === tab;
}

function groupByHelper(
  chores: ChoreRow[],
  helpers: Array<{ id: string; name: string }>,
) {
  const unassigned = chores.filter((c) => !c.helper_id);
  const byId = new Map<string, ChoreRow[]>();
  for (const c of chores) {
    if (!c.helper_id) continue;
    const arr = byId.get(c.helper_id) ?? [];
    arr.push(c);
    byId.set(c.helper_id, arr);
  }
  const sorted = [...helpers].sort((a, b) => a.name.localeCompare(b.name));
  const byHelper = sorted
    .map((h) => ({ helper: h, chores: byId.get(h.id) ?? [] }))
    .filter((x) => x.chores.length > 0);
  return { unassigned, byHelper };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ChoreListView(props: ChoreListViewProps) {
  const {
    chores, helpers, busy, spaceFilter, cadenceFilter,
    onClearFilters, onEdit, onDelete, onRestore, onReportNotDone, onBulkDelete, helperOnLeave,
  } = props;
  const { t } = useI18n();

  const [tab, setTab] = useState<StatusTab>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /* ---------- derived data ---------- */

  const filtered = useMemo(() => {
    let rows = chores;
    if (spaceFilter) rows = rows.filter((c) => getMetaStrings(c).space === spaceFilter);
    if (cadenceFilter) rows = rows.filter((c) => getMetaStrings(c).cadence === cadenceFilter);
    return rows;
  }, [chores, spaceFilter, cadenceFilter, t]);

  const counts = useMemo(() => {
    const m: Record<StatusTab, number> = { all: filtered.length, pending: 0, in_progress: 0, completed: 0 };
    for (const c of filtered) {
      if (c.status === "pending") m.pending++;
      else if (c.status === "in_progress") m.in_progress++;
      else if (c.status === "completed") m.completed++;
    }
    return m;
  }, [filtered]);

  const visible = useMemo(() => filtered.filter((c) => matchesTab(c.status, tab)), [filtered, tab]);
  const { unassigned, byHelper } = useMemo(() => groupByHelper(visible, helpers), [visible, helpers]);
  const allIds = useMemo(() => visible.map((c) => c.id), [visible]);

  /* ---------- selection ---------- */

  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allIds));
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  /* ---------- render helpers ---------- */

  const hasFilters = !!(spaceFilter || cadenceFilter);

  const renderGroup = (label: string, rows: ChoreRow[]) =>
    rows.length > 0 && (
      <Box key={label}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          {label}
        </Typography>
        <Stack spacing={1.5}>
          {rows.map((chore) => {
            const helper = helpers.find((h) => h.id === chore.helper_id);
            return (
              <ChoreCard
                key={chore.id}
                chore={chore}
                helperName={helper?.name ?? ""}
                isOnLeave={helperOnLeave(chore.helper_id, chore.due_at)}
                selected={selected.has(chore.id)}
                disabled={busy}
                onSelect={() => toggle(chore.id)}
                onEdit={() => onEdit(chore)}
                onDelete={() => onDelete(chore)}
                onRestore={() => onRestore(chore)}
                onReportNotDone={() => onReportNotDone(chore)}
              />
            );
          })}
        </Stack>
      </Box>
    );

  /* ---------- main render ---------- */

  return (
    <Box>
      {/* Status tabs */}
      <Tabs value={tab} onChange={(_, v) => { setTab(v); setSelected(new Set()); }} sx={{ mb: 2 }}>
        {STATUS_TABS.map((t_key) => (
          <Tab key={t_key} value={t_key} label={`${t(`chores.tab_${t_key}`)} (${counts[t_key]})`} />
        ))}
      </Tabs>

      {/* Active filters */}
      {hasFilters && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          {spaceFilter && <Chip size="small" label={spaceFilter} onDelete={onClearFilters} deleteIcon={<Close />} />}
          {cadenceFilter && <Chip size="small" label={cadenceFilter} onDelete={onClearFilters} deleteIcon={<Close />} />}
          <Button size="small" onClick={onClearFilters}>{t("chores.clear_filters")}</Button>
        </Stack>
      )}

      {/* Bulk controls */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} />
        <Typography variant="body2" color="text.secondary">
          {selected.size > 0 ? `${selected.size} selected` : t("chores.select_all")}
        </Typography>
        {selected.size > 0 && (
          <Button
            size="small"
            color="error"
            startIcon={<DeleteOutline />}
            onClick={() => { onBulkDelete([...selected]); setSelected(new Set()); }}
          >
            {t("chores.delete_selected")}
          </Button>
        )}
      </Stack>

      {/* Content */}
      {busy ? (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress />
        </Box>
      ) : visible.length === 0 ? (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: "center", py: 6 }}>
            <ChecklistRtl sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
            <Typography color="text.secondary">
              {hasFilters ? t("chores.empty_filtered") : t("chores.empty")}
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={3}>
          {renderGroup(t("chores.unassigned"), unassigned)}
          {byHelper.map(({ helper, chores: hc }) => renderGroup(helper.name, hc))}
        </Stack>
      )}
    </Box>
  );
}

export default ChoreListView;
