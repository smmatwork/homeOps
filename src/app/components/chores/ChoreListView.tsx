import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Card,
  CardContent,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { ChecklistRtl, Close, DeleteOutline, ExpandMore, ExpandLess } from "@mui/icons-material";
import { useI18n } from "../../i18n";
import { ChoreCard, type ChoreRow, getMetaStrings } from "./ChoreCard";
import { cadenceLabel } from "../../services/choreRecommendationEngine";

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
  onFlagAsNotDone: (chore: ChoreRow) => void;
  onBulkDelete: (ids: string[]) => void;
  helperOnLeave: (helperId: string | null, dueAt: string | null) => boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STATUS_TABS = ["all", "pending", "in_progress", "completed"] as const;
type StatusTab = (typeof STATUS_TABS)[number];
type GroupBy = "space" | "category" | "helper";

function matchesTab(status: string, tab: StatusTab) {
  if (tab === "all") return true;
  if (tab === "in_progress") return status === "in-progress" || status === "in_progress";
  return status === tab;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ChoreListView(props: ChoreListViewProps) {
  const {
    chores, helpers, busy, spaceFilter, cadenceFilter,
    onClearFilters, onEdit, onDelete, onRestore, onReportNotDone, onFlagAsNotDone, onBulkDelete, helperOnLeave,
  } = props;
  const { t } = useI18n();

  const [tab, setTab] = useState<StatusTab>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupBy>("space");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [filterSpace, setFilterSpace] = useState<string>(spaceFilter ?? "");
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterCadence, setFilterCadence] = useState<string>(cadenceFilter ?? "");

  /* ---------- extract unique values for filter dropdowns ---------- */

  const allSpaces = useMemo(() => {
    const set = new Set<string>();
    for (const c of chores) { const s = getMetaStrings(c).space; if (s) set.add(s); }
    return [...set].sort();
  }, [chores]);

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const c of chores) { const cat = getMetaStrings(c).category; if (cat) set.add(cat); }
    return [...set].sort();
  }, [chores]);

  const allCadences = useMemo(() => {
    const set = new Set<string>();
    for (const c of chores) { const cad = getMetaStrings(c).cadence; if (cad) set.add(cad); }
    return [...set].sort();
  }, [chores]);

  /* ---------- filtered data ---------- */

  const filtered = useMemo(() => {
    let rows = chores;
    if (filterSpace) rows = rows.filter((c) => getMetaStrings(c).space === filterSpace);
    if (filterCategory) rows = rows.filter((c) => getMetaStrings(c).category === filterCategory);
    if (filterCadence) rows = rows.filter((c) => getMetaStrings(c).cadence === filterCadence);
    return rows;
  }, [chores, filterSpace, filterCategory, filterCadence]);

  const counts = useMemo(() => {
    const m: Record<StatusTab, number> = { all: filtered.length, pending: 0, in_progress: 0, completed: 0 };
    for (const c of filtered) {
      if (c.status === "pending") m.pending++;
      else if (c.status === "in-progress" || c.status === "in_progress") m.in_progress++;
      else if (c.status === "completed") m.completed++;
    }
    return m;
  }, [filtered]);

  const visible = useMemo(() => filtered.filter((c) => matchesTab(c.status, tab)), [filtered, tab]);
  const allIds = useMemo(() => visible.map((c) => c.id), [visible]);

  /* ---------- grouping ---------- */

  const groups = useMemo((): Array<{ label: string; chores: ChoreRow[] }> => {
    const map = new Map<string, ChoreRow[]>();
    const ungrouped: ChoreRow[] = [];

    for (const c of visible) {
      let key = "";
      if (groupBy === "space") {
        key = getMetaStrings(c).space || "";
      } else if (groupBy === "category") {
        key = getMetaStrings(c).category || "";
      } else {
        const helper = helpers.find((h) => h.id === c.helper_id);
        key = helper?.name ?? "";
      }
      if (!key) {
        ungrouped.push(c);
      } else {
        const arr = map.get(key) ?? [];
        arr.push(c);
        map.set(key, arr);
      }
    }

    const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const result = sorted.map(([label, chores]) => ({ label, chores }));

    const ungroupedLabel = groupBy === "helper" ? t("chores.unassigned") : t("chores.none");
    if (ungrouped.length > 0) result.push({ label: ungroupedLabel, chores: ungrouped });
    return result;
  }, [visible, groupBy, helpers, t]);

  /* ---------- selection ---------- */

  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allIds));
  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  /* ---------- active filter chips ---------- */

  const hasFilters = !!(filterSpace || filterCategory || filterCadence);
  const clearAllFilters = () => { setFilterSpace(""); setFilterCategory(""); setFilterCadence(""); onClearFilters(); };

  /* ---------- render ---------- */

  const toggleGroup = (label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });
  };

  const renderGroup = (label: string, rows: ChoreRow[]) => {
    if (rows.length === 0) return null;
    const completedCount = rows.filter((c) => c.status === "completed" || c.status === "done").length;
    const progressPct = rows.length > 0 ? Math.round((completedCount / rows.length) * 100) : 0;
    const isCollapsed = collapsedGroups.has(label);

    return (
      <Box key={label}>
        <Stack
          direction="row" justifyContent="space-between" alignItems="center"
          sx={{ mb: isCollapsed ? 0 : 1, px: 0.5, cursor: "pointer", "&:hover": { bgcolor: "action.hover" }, borderRadius: 1, py: 0.5 }}
          onClick={() => toggleGroup(label)}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            {isCollapsed ? <ExpandMore fontSize="small" color="action" /> : <ExpandLess fontSize="small" color="action" />}
            <Typography variant="subtitle1" fontWeight={700}>{label}</Typography>
            <Typography variant="caption" color="text.secondary">{completedCount}/{rows.length}</Typography>
          </Stack>
          <Chip label={`${progressPct}%`} size="small" color={progressPct === 100 ? "success" : progressPct > 50 ? "primary" : "default"} />
        </Stack>
        {!isCollapsed && (
          <Stack spacing={1}>
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
                  onFlagAsNotDone={() => onFlagAsNotDone(chore)}
                />
              );
            })}
          </Stack>
        )}
      </Box>
    );
  };

  return (
    <Box>
      {/* Status tabs */}
      <Tabs value={tab} onChange={(_, v) => { setTab(v); setSelected(new Set()); }} sx={{ mb: 2 }}>
        {STATUS_TABS.map((t_key) => (
          <Tab key={t_key} value={t_key} label={`${t(`chores.tab_${t_key}`)} (${counts[t_key]})`} />
        ))}
      </Tabs>

      {/* Group by + Filters row */}
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <ToggleButtonGroup size="small" value={groupBy} exclusive onChange={(_, v) => { if (v) setGroupBy(v); }}>
          <ToggleButton value="space">{t("chores.space")}</ToggleButton>
          <ToggleButton value="category">{t("chores.category")}</ToggleButton>
          <ToggleButton value="helper">{t("chores.helper")}</ToggleButton>
        </ToggleButtonGroup>

        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>{t("chores.space")}</InputLabel>
          <Select value={filterSpace} label={t("chores.space")} onChange={(e) => setFilterSpace(e.target.value)}>
            <MenuItem value=""><em>{t("recipes.all")}</em></MenuItem>
            {allSpaces.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>{t("chores.category")}</InputLabel>
          <Select value={filterCategory} label={t("chores.category")} onChange={(e) => setFilterCategory(e.target.value)}>
            <MenuItem value=""><em>{t("recipes.all")}</em></MenuItem>
            {allCategories.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>{t("chores.cadence")}</InputLabel>
          <Select value={filterCadence} label={t("chores.cadence")} onChange={(e) => setFilterCadence(e.target.value)}>
            <MenuItem value=""><em>{t("recipes.all")}</em></MenuItem>
            {allCadences.map((c) => <MenuItem key={c} value={c}>{cadenceLabel(c)}</MenuItem>)}
          </Select>
        </FormControl>
      </Stack>

      {/* Active filter chips */}
      {hasFilters && (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          {filterSpace && <Chip size="small" label={filterSpace} onDelete={() => setFilterSpace("")} deleteIcon={<Close />} />}
          {filterCategory && <Chip size="small" label={filterCategory} onDelete={() => setFilterCategory("")} deleteIcon={<Close />} />}
          {filterCadence && <Chip size="small" label={cadenceLabel(filterCadence)} onDelete={() => setFilterCadence("")} deleteIcon={<Close />} />}
          <Button size="small" onClick={clearAllFilters}>{t("chores.clear_filters")}</Button>
        </Stack>
      )}

      {/* Bulk controls */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} />
        <Typography variant="body2" color="text.secondary">
          {selected.size > 0 ? t("chores.n_selected").replace("{count}", String(selected.size)) : t("chores.select_all")}
        </Typography>
        {selected.size > 0 && (
          <Button size="small" color="error" startIcon={<DeleteOutline />}
            onClick={() => { onBulkDelete([...selected]); setSelected(new Set()); }}>
            {t("chores.delete_selected")}
          </Button>
        )}
      </Stack>

      {/* Content */}
      {busy ? (
        <Box display="flex" justifyContent="center" py={4}><CircularProgress /></Box>
      ) : visible.length === 0 ? (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: "center", py: 6 }}>
            <ChecklistRtl sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
            <Typography color="text.secondary">
              {hasFilters ? t("chores.no_chores_found") : t("chores.empty_title")}
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={3}>
          {groups.map(({ label, chores: gc }) => renderGroup(label, gc))}
        </Stack>
      )}
    </Box>
  );
}

export default ChoreListView;
