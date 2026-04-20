import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { supabase } from "../../services/supabaseClient";
import { executeToolCall } from "../../services/agentApi";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";

interface BulkReassignDialogProps {
  open: boolean;
  onClose: () => void;
  sourceHelperId: string;
  sourceHelperName?: string;
  helpers: Array<{ id: string; name: string }>;
  onComplete?: () => void;
}

type ChoreCandidate = {
  id: string;
  title: string;
  due_at: string | null;
  status: string;
};

export function BulkReassignDialog({
  open,
  onClose,
  sourceHelperId,
  sourceHelperName,
  helpers,
  onComplete,
}: BulkReassignDialogProps) {
  const { householdId, accessToken } = useAuth();
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chores, setChores] = useState<ChoreCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [targetHelperId, setTargetHelperId] = useState<string>("");

  useEffect(() => {
    if (!open || !sourceHelperId || !householdId) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from("chores")
        .select("id,title,due_at,status")
        .eq("household_id", householdId)
        .eq("helper_id", sourceHelperId)
        .is("deleted_at", null)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (cancelled) return;
      setLoading(false);

      if (err) {
        setError(err.message);
        return;
      }

      const list = (data ?? []) as ChoreCandidate[];
      setChores(list);
      const initialSelection: Record<string, boolean> = {};
      for (const c of list) initialSelection[c.id] = true;
      setSelectedIds(initialSelection);
    })();

    return () => {
      cancelled = true;
    };
  }, [open, sourceHelperId, householdId]);

  const selectedCount = Object.values(selectedIds).filter(Boolean).length;

  const handleApply = async () => {
    if (!householdId || !accessToken || selectedCount === 0) return;
    setBusy(true);
    setError(null);

    const chosenIds = Object.entries(selectedIds)
      .filter(([, v]) => v)
      .map(([id]) => id);

    let failed = 0;
    for (const choreId of chosenIds) {
      const res = await executeToolCall({
        accessToken,
        householdId,
        scope: "household",
        toolCall: {
          id: `bulk_reassign_${choreId}_${Date.now()}`,
          tool: "db.update",
          args: {
            table: "chores",
            id: choreId,
            patch: {
              helper_id: targetHelperId || null,
            },
          },
          reason: `Bulk reassign chore from ${sourceHelperName ?? "helper"} to ${targetHelperId ? helpers.find((h) => h.id === targetHelperId)?.name ?? "helper" : "unassigned"}`,
        },
      });
      if (!res.ok) failed += 1;
    }

    setBusy(false);

    if (failed > 0) {
      setError(`${failed} of ${chosenIds.length} reassignments failed.`);
      return;
    }

    onComplete?.();
    onClose();
  };

  const targetHelpers = helpers.filter((h) => h.id !== sourceHelperId);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("chores.bulk_reassign_title")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          {error && <Alert severity="error">{error}</Alert>}

          <Typography variant="body2" color="text.secondary">
            {t("chores.bulk_reassign_subtitle").replace("{name}", sourceHelperName ?? "")}
          </Typography>

          <FormControl size="small" fullWidth>
            <InputLabel>{t("chores.reassign_to")}</InputLabel>
            <Select
              value={targetHelperId}
              label={t("chores.reassign_to")}
              onChange={(e) => setTargetHelperId(String(e.target.value))}
            >
              <MenuItem value="">
                <em>{t("chores.unassigned")}</em>
              </MenuItem>
              {targetHelpers.map((h) => (
                <MenuItem key={h.id} value={h.id}>{h.name}</MenuItem>
              ))}
            </Select>
          </FormControl>

          {loading ? (
            <Box display="flex" justifyContent="center" py={2}>
              <CircularProgress size={24} />
            </Box>
          ) : chores.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {t("chores.no_chores_to_reassign")}
            </Typography>
          ) : (
            <Box>
              <Typography variant="caption" color="text.secondary">
                {t("chores.selected_count").replace("{count}", String(selectedCount)).replace("{total}", String(chores.length))}
              </Typography>
              <List dense sx={{ maxHeight: 280, overflowY: "auto" }}>
                {chores.map((chore) => (
                  <ListItem key={chore.id} disablePadding>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={Boolean(selectedIds[chore.id])}
                          onChange={(e) =>
                            setSelectedIds((prev) => ({ ...prev, [chore.id]: e.target.checked }))
                          }
                          size="small"
                        />
                      }
                      label={
                        <ListItemText
                          primary={chore.title}
                          secondary={chore.due_at ? new Date(chore.due_at).toLocaleString() : null}
                          primaryTypographyProps={{ variant: "body2" }}
                          secondaryTypographyProps={{ variant: "caption" }}
                        />
                      }
                      sx={{ width: "100%", m: 0 }}
                    />
                  </ListItem>
                ))}
              </List>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="contained"
          onClick={handleApply}
          disabled={busy || selectedCount === 0 || loading}
        >
          {t("chores.bulk_reassign_apply").replace("{count}", String(selectedCount))}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
