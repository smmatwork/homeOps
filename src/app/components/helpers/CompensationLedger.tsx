/**
 * Compensation ledger view for a helper — shows salary history,
 * advances, bonuses, and leave balance. Both owner and helper can
 * see the same view (bidirectional ledger as trust mechanism).
 *
 * Per the manifest: "The bidirectional ledger (both sides can record
 * entries; both sides see the same view) is the trust mechanism."
 */

import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Add, AccountBalance } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";
import { addCompensationLedgerEntry, voidCompensationLedgerEntry } from "../../services/helpersApi";

interface CompensationLedgerProps {
  helperId: string;
  helperName: string;
}

interface LedgerEntry {
  id: string;
  entry_type: string;
  amount: number;
  currency: string;
  effective_date: string;
  recorded_by_role: string;
  note: string | null;
  voided_at: string | null;
  voided_reason: string | null;
  created_at: string;
}

const ENTRY_TYPE_LABELS: Record<string, string> = {
  salary_set: "Salary set",
  salary_change: "Salary change",
  advance: "Advance",
  bonus: "Bonus",
  leave_balance: "Leave balance",
  leave_taken: "Leave taken",
  settlement: "Settlement",
  adjustment: "Adjustment",
};

const ENTRY_TYPE_COLORS: Record<string, "success" | "warning" | "info" | "error" | "default"> = {
  salary_set: "info",
  salary_change: "info",
  advance: "warning",
  bonus: "success",
  leave_balance: "default",
  leave_taken: "error",
  settlement: "default",
  adjustment: "default",
};

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function CompensationLedger({ helperId, helperName }: CompensationLedgerProps) {
  const { householdId, accessToken } = useAuth();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);

  // Add form state
  const [entryType, setEntryType] = useState<string>("advance");
  const [amount, setAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().split("T")[0]);
  const [entryNote, setEntryNote] = useState("");

  const loadEntries = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    const { data } = await supabase
      .from("helper_compensation_ledger")
      .select("id,entry_type,amount,currency,effective_date,recorded_by_role,note,voided_at,voided_reason,created_at")
      .eq("household_id", householdId)
      .eq("helper_id", helperId)
      .order("effective_date", { ascending: false })
      .limit(50);
    setEntries((data ?? []) as LedgerEntry[]);
    setLoading(false);
  }, [householdId, helperId]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);

  const handleAdd = async () => {
    if (!householdId || !accessToken || !amount) return;
    setAddBusy(true);
    await addCompensationLedgerEntry({
      accessToken,
      householdId,
      helperId,
      entryType: entryType as any,
      amount: Number(amount),
      effectiveDate,
      note: entryNote.trim() || undefined,
    });
    setAddBusy(false);
    setAddOpen(false);
    setAmount("");
    setEntryNote("");
    void loadEntries();
  };

  const handleVoid = async (entryId: string) => {
    if (!householdId || !accessToken) return;
    const reason = prompt("Reason for voiding this entry:");
    if (!reason) return;
    await voidCompensationLedgerEntry({
      accessToken,
      householdId,
      entryId,
      reason,
    });
    void loadEntries();
  };

  // Compute summary
  const activeEntries = entries.filter((e) => !e.voided_at);
  const currentSalary = activeEntries.find((e) => e.entry_type === "salary_set" || e.entry_type === "salary_change");
  const totalAdvances = activeEntries
    .filter((e) => e.entry_type === "advance")
    .reduce((sum, e) => sum + e.amount, 0);
  const totalBonuses = activeEntries
    .filter((e) => e.entry_type === "bonus")
    .reduce((sum, e) => sum + e.amount, 0);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" py={2}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  return (
    <>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Stack direction="row" spacing={1} alignItems="center">
                <AccountBalance fontSize="small" color="primary" />
                <Typography variant="subtitle2" fontWeight={700}>
                  Compensation — {helperName}
                </Typography>
              </Stack>
              <Button size="small" variant="outlined" startIcon={<Add />} onClick={() => setAddOpen(true)}>
                Add entry
              </Button>
            </Stack>

            {/* Summary */}
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              {currentSalary && (
                <Box>
                  <Typography variant="caption" color="text.secondary">Current salary</Typography>
                  <Typography variant="subtitle2" fontWeight={600}>
                    {formatCurrency(currentSalary.amount, currentSalary.currency)}/month
                  </Typography>
                </Box>
              )}
              {totalAdvances > 0 && (
                <Box>
                  <Typography variant="caption" color="text.secondary">Advances given</Typography>
                  <Typography variant="subtitle2" fontWeight={600} color="warning.main">
                    {formatCurrency(totalAdvances, "INR")}
                  </Typography>
                </Box>
              )}
              {totalBonuses > 0 && (
                <Box>
                  <Typography variant="caption" color="text.secondary">Bonuses</Typography>
                  <Typography variant="subtitle2" fontWeight={600} color="success.main">
                    {formatCurrency(totalBonuses, "INR")}
                  </Typography>
                </Box>
              )}
            </Stack>

            <Divider />

            {/* Ledger entries */}
            <Box sx={{ maxHeight: 300, overflowY: "auto" }}>
              <Stack spacing={0.5}>
                {entries.map((entry) => (
                  <Stack
                    key={entry.id}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={{
                      py: 0.5,
                      px: 1,
                      borderRadius: 1,
                      opacity: entry.voided_at ? 0.4 : 1,
                      textDecoration: entry.voided_at ? "line-through" : "none",
                    }}
                  >
                    <Chip
                      size="small"
                      label={ENTRY_TYPE_LABELS[entry.entry_type] ?? entry.entry_type}
                      color={ENTRY_TYPE_COLORS[entry.entry_type] ?? "default"}
                      variant="outlined"
                      sx={{ fontSize: 10, minWidth: 80 }}
                    />
                    <Typography variant="body2" fontWeight={600} sx={{ minWidth: 80, textAlign: "right" }}>
                      {formatCurrency(entry.amount, entry.currency)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                      {entry.note ?? ""}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 70 }}>
                      {new Date(entry.effective_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </Typography>
                    <Chip
                      size="small"
                      label={entry.recorded_by_role}
                      variant="outlined"
                      sx={{ fontSize: 9, height: 16 }}
                    />
                    {!entry.voided_at && (
                      <Button
                        size="small"
                        color="error"
                        sx={{ fontSize: 10, minWidth: 0, p: 0.25 }}
                        onClick={() => void handleVoid(entry.id)}
                      >
                        Void
                      </Button>
                    )}
                    {entry.voided_at && (
                      <Chip size="small" label="Voided" color="error" variant="outlined" sx={{ fontSize: 9, height: 16 }} />
                    )}
                  </Stack>
                ))}
                {entries.length === 0 && (
                  <Typography variant="body2" color="text.secondary" textAlign="center" py={2}>
                    No compensation entries yet
                  </Typography>
                )}
              </Stack>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      {/* Add entry dialog */}
      <Dialog open={addOpen} onClose={() => !addBusy && setAddOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Add compensation entry</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <FormControl fullWidth size="small">
              <InputLabel>Type</InputLabel>
              <Select label="Type" value={entryType} onChange={(e) => setEntryType(e.target.value)}>
                <MenuItem value="advance">Advance</MenuItem>
                <MenuItem value="bonus">Bonus</MenuItem>
                <MenuItem value="salary_change">Salary change</MenuItem>
                <MenuItem value="leave_balance">Leave balance</MenuItem>
                <MenuItem value="leave_taken">Leave taken</MenuItem>
                <MenuItem value="settlement">Settlement</MenuItem>
                <MenuItem value="adjustment">Adjustment</MenuItem>
              </Select>
            </FormControl>
            <TextField
              label="Amount"
              type="number"
              size="small"
              fullWidth
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              InputProps={{ startAdornment: <Typography variant="caption" sx={{ mr: 0.5 }}>INR</Typography> }}
            />
            <TextField
              label="Effective date"
              type="date"
              size="small"
              fullWidth
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              label="Note (optional)"
              size="small"
              fullWidth
              multiline
              rows={2}
              value={entryNote}
              onChange={(e) => setEntryNote(e.target.value)}
              placeholder="e.g., Diwali bonus, Advance for medical expense"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)} disabled={addBusy}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleAdd()} disabled={addBusy || !amount}>
            {addBusy ? <CircularProgress size={16} /> : "Add"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
