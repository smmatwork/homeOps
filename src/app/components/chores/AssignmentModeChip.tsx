import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Chip, CircularProgress, Menu, MenuItem, Tooltip } from "@mui/material";
import { AutoMode, TouchApp, DragIndicator } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import {
  fetchAssignmentMode,
  fetchChorePredicateHash,
  setAssignmentModeRpc,
  type OperatingMode,
} from "../../services/assignmentApi";

/**
 * Shows the current operating mode for a (chore predicate, helper) pair.
 * - silent_auto: system assigns silently after 5 clean confirmations
 * - one_tap:     system proposes, owner confirms with one tap
 * - manual:      owner picks the helper every time
 *
 * Clicking opens a menu so the owner can manually demote ("back to manual").
 * Promotions happen automatically via maybe_graduate_or_demote — the chip
 * also listens for `homeops:assignment-mode-changed` to refresh.
 */

interface AssignmentModeChipProps {
  choreId: string;
  helperId: string | null;
  /** Disable the click-to-change menu (read-only display). */
  readOnly?: boolean;
}

const MODE_META: Record<OperatingMode, { label: string; color: "default" | "primary" | "success"; icon: ReactElement; tooltip: string }> = {
  silent_auto: {
    label: "Auto",
    color: "success",
    icon: <AutoMode sx={{ fontSize: 14 }} />,
    tooltip: "Auto-assigned silently — graduated after 5 clean confirmations. Click to demote.",
  },
  one_tap: {
    label: "1-tap",
    color: "primary",
    icon: <TouchApp sx={{ fontSize: 14 }} />,
    tooltip: "System proposes, you confirm with one tap. Click to demote.",
  },
  manual: {
    label: "Manual",
    color: "default",
    icon: <DragIndicator sx={{ fontSize: 14 }} />,
    tooltip: "Pick the helper every time.",
  },
};

export const ASSIGNMENT_MODE_CHANGED_EVENT = "homeops:assignment-mode-changed";

export function AssignmentModeChip({ choreId, helperId, readOnly }: AssignmentModeChipProps) {
  const { householdId, user } = useAuth();
  const [mode, setMode] = useState<OperatingMode | null>(null);
  const [predicateHash, setPredicateHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const hid = householdId?.trim();
    const uid = user?.id;
    if (!hid || !uid || !helperId || !choreId) {
      setMode(null);
      setPredicateHash(null);
      return;
    }
    setLoading(true);
    const hash = await fetchChorePredicateHash(choreId);
    if (!hash) {
      setLoading(false);
      setMode(null);
      return;
    }
    const m = await fetchAssignmentMode({
      householdId: hid,
      actorUserId: uid,
      chorePredicateHash: hash,
      helperId,
    });
    setPredicateHash(hash);
    setMode(m);
    setLoading(false);
  }, [householdId, user?.id, choreId, helperId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { choreId?: string; helperId?: string }
        | undefined;
      // Refresh if this chip matches the event's chore/helper, or if the
      // event carries no identifying detail (broad invalidation).
      if (!detail || (detail.choreId === choreId && detail.helperId === helperId)) {
        void load();
      }
    };
    window.addEventListener(ASSIGNMENT_MODE_CHANGED_EVENT, handler);
    return () => window.removeEventListener(ASSIGNMENT_MODE_CHANGED_EVENT, handler);
  }, [load, choreId, helperId]);

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => {
    if (readOnly) return;
    e.stopPropagation();
    setAnchorEl(e.currentTarget);
  };

  const handleMenuClose = () => setAnchorEl(null);

  const changeMode = async (next: OperatingMode) => {
    const hid = householdId?.trim();
    const uid = user?.id;
    if (!hid || !uid || !helperId || !predicateHash) return;
    setBusy(true);
    handleMenuClose();
    const r = await setAssignmentModeRpc({
      householdId: hid,
      actorUserId: uid,
      chorePredicateHash: predicateHash,
      helperId,
      mode: next,
    });
    setBusy(false);
    if (r.ok === true) {
      setMode(r.mode);
      try {
        window.dispatchEvent(
          new CustomEvent(ASSIGNMENT_MODE_CHANGED_EVENT, {
            detail: { choreId, helperId, mode: r.mode },
          }),
        );
      } catch {
        // non-browser
      }
    }
  };

  if (!helperId) return null;
  if (loading || !mode) {
    return <CircularProgress size={12} sx={{ ml: 1 }} />;
  }

  const meta = MODE_META[mode];
  return (
    <>
      <Tooltip title={meta.tooltip} arrow>
        <Chip
          size="small"
          label={meta.label}
          color={meta.color}
          icon={meta.icon}
          variant={mode === "manual" ? "outlined" : "filled"}
          onClick={readOnly ? undefined : handleMenuOpen}
          disabled={busy}
          sx={{
            height: 20,
            fontSize: "0.7rem",
            cursor: readOnly ? "default" : "pointer",
            "& .MuiChip-icon": { ml: 0.5 },
          }}
        />
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleMenuClose}
        MenuListProps={{ dense: true }}
      >
        {mode !== "manual" && <MenuItem onClick={() => void changeMode("manual")}>Back to manual</MenuItem>}
        {mode === "silent_auto" && <MenuItem onClick={() => void changeMode("one_tap")}>Switch to 1-tap</MenuItem>}
        {mode === "one_tap" && <MenuItem disabled>Auto-promotes after 5 clean confirmations</MenuItem>}
        {mode === "manual" && <MenuItem disabled>Assign chores to start building confidence</MenuItem>}
      </Menu>
    </>
  );
}
