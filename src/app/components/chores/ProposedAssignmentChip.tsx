import { useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useAuth } from "../../auth/AuthProvider";
import { useHelpersStore } from "../../stores/helpersStore";
import { useProposalsStore, type ChoreProposal } from "../../stores/proposalsStore";
import { reassignChore } from "../../services/assignmentApi";

interface ProposedAssignmentChipProps {
  choreId: string;
  onAssigned?: (helperId: string) => void;
}

/**
 * Rendered inline on the ChoreCard when a one_tap proposal exists in
 * proposalsStore. Offers Confirm (one-tap approve → assigned) or Change
 * (pick a different helper → recorded as override so the nudge flow can
 * learn).
 */
export function ProposedAssignmentChip({ choreId, onAssigned }: ProposedAssignmentChipProps) {
  const { householdId, user } = useAuth();
  const helpers = useHelpersStore((s) => s.helpers);
  const proposal: ChoreProposal | undefined = useProposalsStore((s) => s.byChoreId[choreId]);
  const clearProposal = useProposalsStore((s) => s.clearProposal);
  const [changing, setChanging] = useState(false);
  const [altHelperId, setAltHelperId] = useState("");
  const [busy, setBusy] = useState(false);

  if (!proposal) return null;

  const confirm = async () => {
    const hid = householdId?.trim();
    const uid = user?.id;
    if (!hid || !uid) return;
    setBusy(true);
    const r = await reassignChore({
      householdId: hid,
      actorUserId: uid,
      choreId,
      newHelperId: proposal.helperId,
      mode: "one_tap",
      proposedHelperId: proposal.helperId,
    });
    setBusy(false);
    if (r.ok === false) return;
    clearProposal(choreId);
    onAssigned?.(proposal.helperId);
  };

  const saveChange = async () => {
    const hid = householdId?.trim();
    const uid = user?.id;
    const chosen = altHelperId.trim();
    if (!hid || !uid || !chosen) return;
    setBusy(true);
    const r = await reassignChore({
      householdId: hid,
      actorUserId: uid,
      choreId,
      newHelperId: chosen,
      mode: "one_tap",
      proposedHelperId: proposal.helperId,
    });
    setBusy(false);
    if (r.ok === false) return;
    clearProposal(choreId);
    onAssigned?.(chosen);
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        px: 1,
        py: 0.75,
        borderRadius: 1,
        borderColor: "primary.light",
        bgcolor: "primary.50",
        my: 0.5,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Typography variant="caption" sx={{ color: "primary.dark" }}>
          Proposed: <b>{proposal.helperName}</b>
        </Typography>
        {!changing && (
          <>
            <Box flexGrow={1} />
            <Button
              size="small"
              variant="contained"
              disabled={busy}
              onClick={() => void confirm()}
              sx={{ minHeight: 24, py: 0.25, fontSize: 11 }}
            >
              {busy ? <CircularProgress size={12} /> : "Confirm"}
            </Button>
            <Button
              size="small"
              variant="text"
              disabled={busy}
              onClick={() => setChanging(true)}
              sx={{ minHeight: 24, py: 0.25, fontSize: 11 }}
            >
              Change
            </Button>
            <Button
              size="small"
              variant="text"
              disabled={busy}
              onClick={() => clearProposal(choreId)}
              sx={{ minHeight: 24, py: 0.25, fontSize: 11, color: "text.secondary" }}
            >
              Dismiss
            </Button>
          </>
        )}
        {changing && (
          <>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select
                displayEmpty
                value={altHelperId}
                onChange={(e) => setAltHelperId(String(e.target.value))}
                sx={{ fontSize: 12 }}
              >
                <MenuItem value="" sx={{ fontSize: 12 }}>
                  <em>Pick a helper</em>
                </MenuItem>
                {helpers
                  .filter((h) => h.id !== proposal.helperId)
                  .map((h) => (
                    <MenuItem key={h.id} value={h.id} sx={{ fontSize: 12 }}>
                      {h.name}
                    </MenuItem>
                  ))}
              </Select>
            </FormControl>
            <Button
              size="small"
              variant="contained"
              disabled={busy || !altHelperId}
              onClick={() => void saveChange()}
              sx={{ minHeight: 24, py: 0.25, fontSize: 11 }}
            >
              {busy ? <CircularProgress size={12} /> : "Save"}
            </Button>
            <Button
              size="small"
              variant="text"
              disabled={busy}
              onClick={() => {
                setChanging(false);
                setAltHelperId("");
              }}
              sx={{ minHeight: 24, py: 0.25, fontSize: 11, color: "text.secondary" }}
            >
              Cancel
            </Button>
          </>
        )}
      </Stack>
    </Paper>
  );
}
