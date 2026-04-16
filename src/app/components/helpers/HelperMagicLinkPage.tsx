/**
 * HelperMagicLinkPage — Stage 2 of the helper onboarding split flow
 * (Phase 1.1b).
 *
 * Unauthenticated page rendered at /h/:token. The token in the URL
 * is the only auth — there's no Supabase JWT involved. This page:
 *
 *   1. Calls fetchHelperInvite(token) to resolve the invite.
 *   2. If active, renders a consent-capture form for the helper.
 *   3. On submit, calls completeHelperInvite(token, payload), which
 *      writes helper_consents rows with source='helper_web' via the
 *      complete_helper_stage2 RPC.
 *
 * All defaults favor the helper:
 * - Vision capture: OFF (helper opts in)
 * - Multi-household coordination: OFF (helper opts in)
 * - ID verification: OFF (optional)
 * - Call recording: OFF (helper opts in)
 * - Marketing outreach: OFF (helper opts in)
 *
 * The helper can skip any optional field entirely — the system
 * operates with default privacy settings if they do.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useParams } from "react-router";
import {
  completeHelperInvite,
  fetchHelperInvite,
  type CompleteStage2Payload,
  type HelperConsentPayload,
  type HelperInviteInfo,
  type HelperInviteStatus,
} from "../../services/helpersApi";

// ── Local state model ──────────────────────────────────────────────

type PageState =
  | { kind: "loading" }
  | { kind: "invalid"; status: HelperInviteStatus; error: string }
  | { kind: "form"; invite: HelperInviteInfo }
  | { kind: "submitting"; invite: HelperInviteInfo }
  | { kind: "submit_error"; invite: HelperInviteInfo; status: string; error: string }
  | { kind: "success" };

export type HelperFormAnswers = {
  preferredLanguage: string;
  preferredChannel: string;
  idVerification: boolean;
  visionCapture: boolean;
  multiHouseholdCoord: boolean;
  callRecording: boolean;
  marketingOutreach: boolean;
};

export const INITIAL_ANSWERS: HelperFormAnswers = {
  preferredLanguage: "",
  preferredChannel: "",
  idVerification: false,
  visionCapture: false,
  multiHouseholdCoord: false,
  callRecording: false,
  marketingOutreach: false,
};

/** Pure helper — build the Stage 2 submit payload from the form state. */
export function buildStage2Payload(
  answers: HelperFormAnswers,
): CompleteStage2Payload {
  const consents: HelperConsentPayload = {
    id_verification: answers.idVerification,
    vision_capture: answers.visionCapture,
    multi_household_coord: answers.multiHouseholdCoord,
    call_recording: answers.callRecording,
    marketing_outreach: answers.marketingOutreach,
  };
  const payload: CompleteStage2Payload = { consents };
  if (answers.preferredLanguage) {
    payload.preferredLanguage = answers.preferredLanguage;
  }
  if (answers.preferredChannel) {
    payload.preferredChannel = answers.preferredChannel;
  }
  return payload;
}

/** Pure helper — map an invite status to a user-facing headline. */
export function statusHeadline(status: HelperInviteStatus | "invalid_payload"): string {
  switch (status) {
    case "active":
      return "Welcome";
    case "expired":
      return "This invite has expired";
    case "revoked":
      return "This invite has been cancelled";
    case "already_completed":
      return "All done";
    case "invalid_payload":
      return "Something went wrong";
    case "not_found":
    default:
      return "Invite not found";
  }
}

// ── Component ──────────────────────────────────────────────────────

export function HelperMagicLinkPage() {
  const { token: rawToken } = useParams<{ token: string }>();
  const token = (rawToken || "").trim();

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [answers, setAnswers] = useState<HelperFormAnswers>(INITIAL_ANSWERS);

  // Load the invite on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        if (!cancelled) {
          setState({ kind: "invalid", status: "not_found", error: "Missing token" });
        }
        return;
      }
      const result = await fetchHelperInvite(token);
      if (cancelled) return;
      if (result.ok === false) {
        setState({ kind: "invalid", status: result.status, error: result.error });
        return;
      }
      // Pre-fill the language picker with whatever the owner guessed.
      setAnswers((a) => ({
        ...a,
        preferredLanguage: result.invite.preferredLanguage || "",
        preferredChannel: result.invite.channelChain[0] || "",
      }));
      setState({ kind: "form", invite: result.invite });
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = useCallback(async () => {
    if (state.kind !== "form") return;
    setState({ kind: "submitting", invite: state.invite });
    const payload = buildStage2Payload(answers);
    const result = await completeHelperInvite(token, payload);
    if (result.ok === true) {
      setState({ kind: "success" });
      return;
    }
    // result.ok === false here — TS narrows after the explicit check.
    setState({
      kind: "submit_error",
      invite: state.invite,
      status: result.status,
      error: result.error,
    });
  }, [state, answers, token]);

  // ── Rendering ─────────────────────────────────────────────────────

  if (state.kind === "loading") {
    return (
      <CenteredLayout>
        <Stack alignItems="center" spacing={2}>
          <CircularProgress />
          <Typography variant="body2" color="text.secondary">
            Loading your invite…
          </Typography>
        </Stack>
      </CenteredLayout>
    );
  }

  if (state.kind === "invalid") {
    return (
      <CenteredLayout>
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h5" gutterBottom>
              {statusHeadline(state.status)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {state.status === "expired" &&
                "This invite is older than 30 days. Please ask the household to send you a new one."}
              {state.status === "revoked" &&
                "This invite was cancelled by the household. Please reach out to them directly."}
              {state.status === "already_completed" &&
                "You've already completed onboarding. Your household can see the same information you submitted."}
              {state.status === "not_found" &&
                "We couldn't find this invite. Double-check the link or ask the household to resend it."}
            </Typography>
          </CardContent>
        </Card>
      </CenteredLayout>
    );
  }

  if (state.kind === "success") {
    return (
      <CenteredLayout>
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h5" gutterBottom>
              Thanks, you're all set.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Your household has been notified. You can close this page now.
            </Typography>
          </CardContent>
        </Card>
      </CenteredLayout>
    );
  }

  // state.kind === 'form' | 'submitting' | 'submit_error'
  const invite = state.invite;
  const busy = state.kind === "submitting";

  return (
    <CenteredLayout>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={3}>
            <Box>
              <Typography variant="h5" gutterBottom>
                Welcome, {invite.helperName || "there"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Your household has added you to HomeOps. Please answer a few
                quick questions — none of them are required, and all default
                to the most private option.
              </Typography>
            </Box>

            <Divider />

            <FormControl fullWidth>
              <InputLabel id="helper-lang-label">Preferred language</InputLabel>
              <Select
                labelId="helper-lang-label"
                label="Preferred language"
                value={answers.preferredLanguage}
                onChange={(e) =>
                  setAnswers((a) => ({
                    ...a,
                    preferredLanguage: String(e.target.value),
                  }))
                }
              >
                <MenuItem value="">No preference</MenuItem>
                <MenuItem value="en">English</MenuItem>
                <MenuItem value="hi">हिन्दी (Hindi)</MenuItem>
                <MenuItem value="kn">ಕನ್ನಡ (Kannada)</MenuItem>
                <MenuItem value="ta">தமிழ் (Tamil)</MenuItem>
                <MenuItem value="te">తెలుగు (Telugu)</MenuItem>
                <MenuItem value="ml">മലയാളം (Malayalam)</MenuItem>
                <MenuItem value="bn">বাংলা (Bengali)</MenuItem>
              </Select>
            </FormControl>

            <FormControl fullWidth>
              <InputLabel id="helper-channel-label">How should the household contact you?</InputLabel>
              <Select
                labelId="helper-channel-label"
                label="How should the household contact you?"
                value={answers.preferredChannel}
                onChange={(e) =>
                  setAnswers((a) => ({
                    ...a,
                    preferredChannel: String(e.target.value),
                  }))
                }
              >
                <MenuItem value="">Use the household's default</MenuItem>
                <MenuItem value="voice">Phone call</MenuItem>
                <MenuItem value="whatsapp_voice">WhatsApp voice note</MenuItem>
                <MenuItem value="whatsapp_tap">WhatsApp message</MenuItem>
                <MenuItem value="sms">Text message (SMS)</MenuItem>
              </Select>
            </FormControl>

            <Divider />

            <Box>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                Privacy choices
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                You decide. All of these default to the most private option —
                you only opt in if you want to.
              </Typography>
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={answers.callRecording}
                      onChange={(e) =>
                        setAnswers((a) => ({ ...a, callRecording: e.target.checked }))
                      }
                    />
                  }
                  label="Allow call recording (helps the household review instructions later)"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={answers.visionCapture}
                      onChange={(e) =>
                        setAnswers((a) => ({ ...a, visionCapture: e.target.checked }))
                      }
                    />
                  }
                  label="Allow cameras in the home to capture me during work (off by default — the household's cameras will skip frames with you in them unless you opt in)"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={answers.multiHouseholdCoord}
                      onChange={(e) =>
                        setAnswers((a) => ({ ...a, multiHouseholdCoord: e.target.checked }))
                      }
                    />
                  }
                  label="Coordinate my schedule across other households I work for on HomeOps (off by default)"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={answers.idVerification}
                      onChange={(e) =>
                        setAnswers((a) => ({ ...a, idVerification: e.target.checked }))
                      }
                    />
                  }
                  label="Verify my ID (optional — can help build trust if you work for multiple households)"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={answers.marketingOutreach}
                      onChange={(e) =>
                        setAnswers((a) => ({ ...a, marketingOutreach: e.target.checked }))
                      }
                    />
                  }
                  label="Send me occasional tips and updates from HomeOps"
                />
              </FormGroup>
            </Box>

            {state.kind === "submit_error" && (
              <Alert severity="error">
                {state.error}
                {state.status === "expired" && " — the invite expired while you were completing it. Please ask for a new one."}
                {state.status === "already_completed" && " — looks like the invite was already completed."}
              </Alert>
            )}

            <Button
              variant="contained"
              size="large"
              onClick={() => void handleSubmit()}
              disabled={busy}
            >
              {busy ? "Submitting…" : "Submit"}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}

// ── Layout helper ──────────────────────────────────────────────────

function CenteredLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "background.default",
        p: 2,
      }}
    >
      <Container maxWidth="sm">{children}</Container>
    </Box>
  );
}
