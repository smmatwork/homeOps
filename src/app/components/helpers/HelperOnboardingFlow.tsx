/**
 * Helper Onboarding — Stage 1 wizard (owner-driven).
 *
 * Phase 1.1a of the helper module plan. Mirrors the Stepper pattern
 * from OnboardingFlow.tsx but scoped to adding one new helper. On
 * successful submit, it:
 *
 *   1. Creates the helpers row via createHelperForOnboarding()
 *   2. Creates a helper_invites row with a client-generated 256-bit
 *      token (the Stage 2 magic link)
 *   3. Writes the first helper_compensation_ledger entry (salary_set)
 *
 * Stage 2 (the magic-link web page + real channel delivery) lands in
 * P1.1b; until then the Web adapter's magic-link URL is returned to
 * the owner in the success dialog so they can share it out-of-band.
 */

import { useCallback, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import { useI18n } from "../../i18n";
import { useAuth } from "../../auth/AuthProvider";
import {
  addCompensationLedgerEntry,
  createHelperForOnboarding,
  createHelperInvite,
} from "../../services/helpersApi";
import { ChannelChainStep, DEFAULT_CHANNEL_CHAIN } from "./ChannelChainStep";

// ── Form data model ────────────────────────────────────────────────

export type HelperOnboardingFormData = {
  // Step 1: Basics
  name: string;
  phone: string;
  type: string; // "cook" | "cleaner" | "gardener" | "driver" | "security" | "other"

  // Step 2: Schedule
  dailyCapacityMinutes: string; // string so the TextField is controlled
  scopeNotes: string;

  // Step 3: Channel chain
  channelPreferences: string[];
  preferredLanguage: string;
  callWindowDays: string[]; // ["mon","tue",...]
  callWindowStart: string; // "HH:MM"
  callWindowEnd: string;

  // Step 4: Salary
  initialSalary: string;
  salaryCurrency: string;
  salaryEffectiveDate: string; // YYYY-MM-DD
};

export const INITIAL_FORM: HelperOnboardingFormData = {
  name: "",
  phone: "",
  type: "",
  dailyCapacityMinutes: "",
  scopeNotes: "",
  channelPreferences: [...DEFAULT_CHANNEL_CHAIN],
  preferredLanguage: "",
  callWindowDays: [],
  callWindowStart: "",
  callWindowEnd: "",
  initialSalary: "",
  salaryCurrency: "INR",
  salaryEffectiveDate: new Date().toISOString().slice(0, 10),
};

// ── Step labels ────────────────────────────────────────────────────

const STEP_KEYS = [
  "welcome",
  "basics",
  "schedule",
  "channel",
  "salary",
] as const;

// ── Step validation ────────────────────────────────────────────────

/**
 * Returns true if the given step's required fields are filled.
 * Kept pure + exported so tests can exercise it directly without
 * rendering the component.
 */
export function isStepValid(step: number, form: HelperOnboardingFormData): boolean {
  switch (step) {
    case 0: // Welcome
      return true;
    case 1: // Basics
      return form.name.trim().length > 0 && form.phone.trim().length >= 6;
    case 2: // Schedule
      // Optional. Always valid.
      return true;
    case 3: // Channel chain
      return form.channelPreferences.length > 0;
    case 4: // Salary
      // Salary is optional — owner can skip it and add via Helpers.tsx
      // later. If provided, it must parse as a positive number.
      if (!form.initialSalary.trim()) return true;
      const n = Number(form.initialSalary);
      return Number.isFinite(n) && n >= 0;
    default:
      return false;
  }
}

/**
 * Build the preferred_call_window jsonb payload from the form. Returns
 * null when there's nothing to record, so the server default applies.
 */
export function buildPreferredCallWindow(
  form: HelperOnboardingFormData,
): Record<string, unknown> | null {
  const hasAny =
    form.callWindowDays.length > 0 ||
    form.callWindowStart.trim() ||
    form.callWindowEnd.trim();
  if (!hasAny) return null;
  return {
    days: form.callWindowDays,
    start: form.callWindowStart.trim() || null,
    end: form.callWindowEnd.trim() || null,
  };
}

// ── Component ──────────────────────────────────────────────────────

export type HelperOnboardingFlowProps = {
  open: boolean;
  onClose: () => void;
  onSuccess?: (result: {
    helperId: string;
    inviteToken: string;
    magicLinkUrl: string;
  }) => void;
};

export function HelperOnboardingFlow({
  open,
  onClose,
  onSuccess,
}: HelperOnboardingFlowProps) {
  const { t } = useI18n();
  const { accessToken, householdId } = useAuth();

  const [activeStep, setActiveStep] = useState(0);
  const [form, setForm] = useState<HelperOnboardingFormData>(INITIAL_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    helperId: string;
    inviteToken: string;
    magicLinkUrl: string;
    warning?: string;
  } | null>(null);

  const handleReset = useCallback(() => {
    setActiveStep(0);
    setForm(INITIAL_FORM);
    setError(null);
    setResult(null);
  }, []);

  const handleClose = useCallback(() => {
    if (busy) return;
    handleReset();
    onClose();
  }, [busy, handleReset, onClose]);

  const handleNext = useCallback(() => {
    if (!isStepValid(activeStep, form)) return;
    setActiveStep((s) => Math.min(STEP_KEYS.length - 1, s + 1));
  }, [activeStep, form]);

  const handleBack = useCallback(() => {
    setActiveStep((s) => Math.max(0, s - 1));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!accessToken || !householdId) {
      setError(
        t("common.missing_session") ||
          "Missing session — please sign in again.",
      );
      return;
    }
    setBusy(true);
    setError(null);

    // 1. Create the helper row.
    const callWindow = buildPreferredCallWindow(form);
    const createRes = await createHelperForOnboarding({
      accessToken,
      householdId,
      name: form.name,
      phone: form.phone,
      type: form.type,
      dailyCapacityMinutes: form.dailyCapacityMinutes.trim()
        ? Number(form.dailyCapacityMinutes)
        : null,
      channelPreferences: form.channelPreferences,
      preferredLanguage: form.preferredLanguage.trim() || null,
      preferredCallWindow: callWindow,
      notes: form.scopeNotes || null,
    });
    if (createRes.ok === false) {
      setBusy(false);
      setError(`Could not create helper: ${createRes.error}`);
      return;
    }

    const helperId = createRes.helperId;

    // 2. Create the Stage 2 invite.
    const inviteRes = await createHelperInvite({
      accessToken,
      householdId,
      helperId,
      channelChain: form.channelPreferences,
    });
    if (inviteRes.ok === false) {
      setBusy(false);
      setResult({
        helperId,
        inviteToken: "",
        magicLinkUrl: "",
        warning: `Helper created but Stage 2 invite failed: ${inviteRes.error}. You can resend the invite from the helpers list.`,
      });
      return;
    }

    // 3. Write the first salary ledger entry (optional).
    let warning: string | undefined;
    const salaryRaw = form.initialSalary.trim();
    if (salaryRaw) {
      const salaryAmount = Number(salaryRaw);
      if (Number.isFinite(salaryAmount) && salaryAmount >= 0) {
        const ledgerRes = await addCompensationLedgerEntry({
          accessToken,
          householdId,
          helperId,
          entryType: "salary_set",
          amount: salaryAmount,
          effectiveDate: form.salaryEffectiveDate,
          currency: form.salaryCurrency || "INR",
          recordedByRole: "owner",
          note: "Initial salary from onboarding wizard",
        });
        if (ledgerRes.ok === false) {
          warning = `Helper + invite created, but the initial salary entry failed: ${ledgerRes.error}. You can add it manually from the helpers list.`;
        }
      }
    }

    // 4. Dispatch the magic link via channel dispatcher (best-effort, non-blocking)
    try {
      const agentUrl = (import.meta.env.VITE_AGENT_SERVICE_URL as string | undefined) ?? "http://localhost:8000";
      void fetch(`${agentUrl}/v1/helpers/dispatch-invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agent-service-key": (import.meta.env.VITE_AGENT_SERVICE_KEY as string | undefined) ?? "",
        },
        body: JSON.stringify({
          helper_id: helperId,
          helper_name: form.name,
          helper_phone: form.phone || null,
          channel_chain: form.channelPreferences,
          magic_link_url: inviteRes.magicLinkUrl,
          household_id: householdId,
        }),
      });
    } catch {
      // Best-effort — the invite is already created, manual sharing still works
    }

    setBusy(false);
    setResult({
      helperId,
      inviteToken: inviteRes.token,
      magicLinkUrl: inviteRes.magicLinkUrl,
      warning,
    });

    onSuccess?.({
      helperId,
      inviteToken: inviteRes.token,
      magicLinkUrl: inviteRes.magicLinkUrl,
    });
  }, [accessToken, householdId, form, onSuccess, t]);

  // ── Rendering ─────────────────────────────────────────────────────

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="md">
      <DialogTitle>
        {result ? "Helper added" : "Add a new helper"}
      </DialogTitle>
      <DialogContent dividers>
        {result ? (
          <SuccessPanel result={result} />
        ) : (
          <>
            <Stepper activeStep={activeStep} sx={{ mb: 3 }}>
              {STEP_KEYS.map((key) => (
                <Step key={key}>
                  <StepLabel>{stepLabel(key)}</StepLabel>
                </Step>
              ))}
            </Stepper>

            {activeStep === 0 && <WelcomePanel />}
            {activeStep === 1 && <BasicsPanel form={form} setForm={setForm} />}
            {activeStep === 2 && <SchedulePanel form={form} setForm={setForm} />}
            {activeStep === 3 && (
              <ChannelChainStep form={form} setForm={setForm} />
            )}
            {activeStep === 4 && <SalaryPanel form={form} setForm={setForm} />}

            {error && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {error}
              </Alert>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        {result ? (
          <Button onClick={handleClose} variant="contained">
            Done
          </Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={busy}>
              Cancel
            </Button>
            {activeStep > 0 && (
              <Button onClick={handleBack} disabled={busy}>
                Back
              </Button>
            )}
            {activeStep < STEP_KEYS.length - 1 && (
              <Button
                onClick={handleNext}
                variant="contained"
                disabled={!isStepValid(activeStep, form)}
              >
                Next
              </Button>
            )}
            {activeStep === STEP_KEYS.length - 1 && (
              <Button
                onClick={handleSubmit}
                variant="contained"
                disabled={busy || !isStepValid(activeStep, form)}
              >
                {busy ? "Adding…" : "Add helper"}
              </Button>
            )}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

// ── Step labels (i18n-friendly wrappers) ───────────────────────────

function stepLabel(key: typeof STEP_KEYS[number]): string {
  switch (key) {
    case "welcome":
      return "Welcome";
    case "basics":
      return "Basics";
    case "schedule":
      return "Schedule";
    case "channel":
      return "Communication";
    case "salary":
      return "Salary";
  }
}

// ── Individual step panels ─────────────────────────────────────────

function WelcomePanel() {
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Add a new helper to your household</Typography>
      <Typography variant="body2" color="text.secondary">
        This is a two-stage flow:
      </Typography>
      <Box component="ol" sx={{ pl: 3, m: 0 }}>
        <li>
          <Typography variant="body2">
            <strong>You</strong> fill in the basics — name, phone, role, schedule, and initial salary.
          </Typography>
        </li>
        <li>
          <Typography variant="body2">
            <strong>Your helper</strong> receives an invite on their preferred channel (voice call, WhatsApp, or SMS) and completes their own consent fields — preferred language, photo, privacy choices.
          </Typography>
        </li>
      </Box>
      <Typography variant="body2" color="text.secondary">
        The helper can be fully onboarded even if they don't complete their stage — the system will use sensible default privacy settings.
      </Typography>
    </Stack>
  );
}

type PanelProps = {
  form: HelperOnboardingFormData;
  setForm: React.Dispatch<React.SetStateAction<HelperOnboardingFormData>>;
};

function BasicsPanel({ form, setForm }: PanelProps) {
  return (
    <Stack spacing={2}>
      <TextField
        label="Name"
        required
        fullWidth
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        autoFocus
      />
      <TextField
        label="Phone"
        required
        fullWidth
        value={form.phone}
        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
        placeholder="+91 98XXX XXXXX"
        helperText="Used to send the Stage 2 invite"
      />
      <FormControl fullWidth>
        <InputLabel id="helper-type-label">Role</InputLabel>
        <Select
          labelId="helper-type-label"
          label="Role"
          value={form.type}
          onChange={(e) => setForm((f) => ({ ...f, type: String(e.target.value) }))}
        >
          <MenuItem value="">Not specified</MenuItem>
          <MenuItem value="cook">Cook</MenuItem>
          <MenuItem value="cleaner">Cleaner / Maid</MenuItem>
          <MenuItem value="gardener">Gardener</MenuItem>
          <MenuItem value="driver">Driver</MenuItem>
          <MenuItem value="security">Security</MenuItem>
          <MenuItem value="nanny">Nanny / Childcare</MenuItem>
          <MenuItem value="other">Other</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  );
}

function SchedulePanel({ form, setForm }: PanelProps) {
  return (
    <Stack spacing={2}>
      <TextField
        label="Daily capacity (minutes)"
        type="number"
        fullWidth
        value={form.dailyCapacityMinutes}
        onChange={(e) =>
          setForm((f) => ({ ...f, dailyCapacityMinutes: e.target.value }))
        }
        helperText="Approximate minutes per day this helper works. Used by the assignment engine to avoid overloading them."
        inputProps={{ min: 0, max: 1440 }}
      />
      <TextField
        label="Scope of work"
        multiline
        rows={3}
        fullWidth
        value={form.scopeNotes}
        onChange={(e) => setForm((f) => ({ ...f, scopeNotes: e.target.value }))}
        placeholder="e.g. mopping, dishwashing, laundry; weekdays 8am–11am"
        helperText="Notes visible to you and other household admins. Not shared with the helper directly."
      />
    </Stack>
  );
}

function SalaryPanel({ form, setForm }: PanelProps) {
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        HomeOps keeps a tracking-only compensation ledger — it never moves money. Both you and the helper can see the same view.
      </Typography>
      <Stack direction="row" spacing={2}>
        <TextField
          label="Initial salary"
          type="number"
          value={form.initialSalary}
          onChange={(e) => setForm((f) => ({ ...f, initialSalary: e.target.value }))}
          sx={{ flex: 1 }}
          inputProps={{ min: 0, step: 100 }}
          helperText="Optional — you can add this later"
        />
        <FormControl sx={{ minWidth: 100 }}>
          <InputLabel id="salary-currency-label">Currency</InputLabel>
          <Select
            labelId="salary-currency-label"
            label="Currency"
            value={form.salaryCurrency}
            onChange={(e) =>
              setForm((f) => ({ ...f, salaryCurrency: String(e.target.value) }))
            }
          >
            <MenuItem value="INR">INR</MenuItem>
            <MenuItem value="USD">USD</MenuItem>
            <MenuItem value="EUR">EUR</MenuItem>
            <MenuItem value="GBP">GBP</MenuItem>
          </Select>
        </FormControl>
      </Stack>
      <TextField
        label="Effective from"
        type="date"
        value={form.salaryEffectiveDate}
        onChange={(e) =>
          setForm((f) => ({ ...f, salaryEffectiveDate: e.target.value }))
        }
        InputLabelProps={{ shrink: true }}
      />
    </Stack>
  );
}

function SuccessPanel({
  result,
}: {
  result: {
    helperId: string;
    inviteToken: string;
    magicLinkUrl: string;
    warning?: string;
  };
}) {
  return (
    <Stack spacing={2}>
      <Alert severity="success">
        Helper added successfully. Share the magic link with them or wait for the Stage 2 invite to arrive via their preferred channel.
      </Alert>
      {result.warning && <Alert severity="warning">{result.warning}</Alert>}
      {result.magicLinkUrl && (
        <Box>
          <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
            Stage 2 magic link (valid for 30 days)
          </Typography>
          <TextField
            fullWidth
            value={result.magicLinkUrl}
            InputProps={{ readOnly: true }}
            onFocus={(e) => e.target.select()}
          />
        </Box>
      )}
    </Stack>
  );
}
