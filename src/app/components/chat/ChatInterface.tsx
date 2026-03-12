import { useState, useRef, useEffect, useCallback } from "react";
import {
  Box,
  Stack,
  Paper,
  Typography,
  Chip,
  Avatar,
  ToggleButtonGroup,
  ToggleButton,
  Alert,
  Collapse,
  Tooltip,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from "@mui/material";
import { SmartToy, GraphicEq } from "@mui/icons-material";
import { keyframes } from "@emotion/react";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { QuickActionsPanel } from "./QuickActionsPanel";
import { useSarvamChat } from "../../hooks/useSarvamChat";
import { useSarvamSTT, type SpeechLang } from "../../hooks/useSarvamSTT";
import { parseAgentActionsFromAssistantText, parseToolCallsFromAssistantText, type AgentCreateAction, type ToolCall } from "../../services/agentActions";
import { agentCreate, agentListHelpers, executeToolCall } from "../../services/agentApi";
import { useAuth } from "../../auth/AuthProvider";

type HelperOption = { id: string; name: string; type: string | null; phone: string | null };

type ChoreDraft = {
  id: string;
  action: AgentCreateAction;
};

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalizeDatetimeLocal(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Keep as-is (datetime-local) and let Postgres parse if possible
  return trimmed;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function shouldOverrideHouseholdId(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const v = value.trim();
  if (!v) return true;
  if (v === "YOUR_HOUSEHOLD_ID") return true;
  if (v === "<HOUSEHOLD_ID>") return true;
  if (!isUuidLike(v)) return true;
  return false;
}

// ─── Animations ────────────────────────────────────────────────────────────────
const bounceTyping = keyframes`
  0%, 60%, 100% { transform: translateY(0);    opacity: 1;   }
  30%            { transform: translateY(-6px); opacity: 0.7; }
`;

// ─── Constants ─────────────────────────────────────────────────────────────────
const LANG_LABELS: Record<SpeechLang, string> = {
  "en-IN": "EN",
  "hi-IN": "हिं",
  "kn-IN": "ಕನ್",
};
const TYPING_DOT_DELAYS = [0, 0.18, 0.36];

const hasKey =
  !!import.meta.env.VITE_SARVAM_API_KEY &&
  import.meta.env.VITE_SARVAM_API_KEY !== "your_sarvam_api_key_here";

// ─── Typing Indicator ──────────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-end" sx={{ mb: 2 }}>
      <Avatar sx={{ width: 32, height: 32, bgcolor: "primary.main", flexShrink: 0 }}>
        <SmartToy sx={{ fontSize: 18 }} />
      </Avatar>
      <Box
        sx={{
          px: 2,
          py: 1.5,
          bgcolor: "secondary.main",
          borderRadius: "18px",
          borderTopLeftRadius: "4px",
          display: "flex",
          alignItems: "center",
          gap: 0.5,
        }}
      >
        {TYPING_DOT_DELAYS.map((delay, i) => (
          <Box
            key={i}
            sx={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              bgcolor: "text.disabled",
              animation: `${bounceTyping} 1.1s ${delay}s ease-in-out infinite`,
            }}
          />
        ))}
      </Box>
    </Stack>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────
export function ChatInterface() {
  const [input, setInput] = useState("");
  const [lang, setLang] = useState<SpeechLang>("en-IN");
  const [sttError, setSttError] = useState<string | null>(null);

  const {
    accessToken: authedAccessToken,
    householdId: authedHouseholdId,
    lastError: authedLastError,
    refreshHouseholdId,
    bootstrapHousehold,
    user: authedUser,
    signOut,
  } = useAuth();

  const [agentAccessToken, setAgentAccessToken] = useState("");
  const [agentHouseholdId, setAgentHouseholdId] = useState("");
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentSuccess, setAgentSuccess] = useState<string | null>(null);

  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapSuccess, setBootstrapSuccess] = useState<string | null>(null);

  const [helpers, setHelpers] = useState<HelperOption[]>([]);
  const [helperLoadError, setHelperLoadError] = useState<string | null>(null);

  const [choreDrafts, setChoreDrafts] = useState<ChoreDraft[]>([]);

  function getAgentSetup() {
    const token = authedAccessToken.trim() || agentAccessToken.trim();
    const householdId = authedHouseholdId.trim() || agentHouseholdId.trim();
    return { token, householdId };
  }

  function withHouseholdId(tc: ToolCall, householdId: string): ToolCall {
    const args = (tc.args ?? {}) as Record<string, unknown>;
    return { ...tc, args: { ...args, household_id: householdId } };
  }


  const { messages, sendMessage, isStreaming, error: chatError, memoryReady, memoryScope, setMemoryScope, appendAssistantMessage } = useSarvamChat();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  // Load saved agent setup
  useEffect(() => {
    try {
      const savedToken = localStorage.getItem("homeops.agent.access_token") ?? "";
      const savedHousehold = localStorage.getItem("homeops.agent.household_id") ?? "";
      if (savedToken) setAgentAccessToken(savedToken);
      if (savedHousehold) setAgentHouseholdId(savedHousehold);
    } catch {
      // ignore
    }
  }, []);

  // Prefer the authenticated session token/household over the legacy Agent Setup values.
  useEffect(() => {
    if (authedAccessToken.trim()) setAgentAccessToken(authedAccessToken.trim());
    if (authedHouseholdId.trim()) setAgentHouseholdId(authedHouseholdId.trim());
    if (authedAccessToken.trim() && !authedHouseholdId.trim()) {
      void refreshHouseholdId();
    }
  }, [authedAccessToken, authedHouseholdId, refreshHouseholdId]);

  // Persist agent setup
  useEffect(() => {
    try {
      if (agentAccessToken.trim()) localStorage.setItem("homeops.agent.access_token", agentAccessToken.trim());
      if (agentHouseholdId.trim()) localStorage.setItem("homeops.agent.household_id", agentHouseholdId.trim());
    } catch {
      // ignore
    }
  }, [agentAccessToken, agentHouseholdId]);

  // Voice transcript appends to input
  const handleTranscript = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  const {
    isListening,
    isTranscribing,
    toggle: toggleMic,
    supported: voiceSupported,
    sttMode,
  } = useSarvamSTT(lang, handleTranscript, setSttError);

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return;

    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();
    const isHelpersQuery = /\bhelpers?\b/.test(lower) && /\b(list|show|get|what)\b/.test(lower);
    const isChoresQuery = /\bchores?\b/.test(lower) && /\b(list|show|get|what|pending|overdue)\b/.test(lower);
    const isAlertsQuery = /\balerts?\b/.test(lower) && /\b(list|show|get|what)\b/.test(lower);

    const directTable = isHelpersQuery ? "helpers" : isChoresQuery ? "chores" : isAlertsQuery ? "alerts" : null;

    if (directTable) {
      // Add the user message to the chat UI/history
      sendMessage(trimmed);
      setInput("");

      const { token, householdId } = getAgentSetup();
      if (!token || !householdId) return;

      const tc: ToolCall = {
        id: `direct_${directTable}_${Date.now()}`,
        tool: "db.select",
        args: {
          table: directTable,
          limit: 50,
        },
        reason: `Fetch ${directTable} from the database`,
      };

      void (async () => {
        setToolError(null);
        const res = await executeToolCall({
          accessToken: token,
          householdId,
          scope: memoryScope,
          toolCall: withHouseholdId(tc, householdId),
        });
        if (!res.ok) {
          setToolError("error" in res ? res.error : "Couldn’t fetch the information");
          return;
        }
        appendAssistantMessage(res.summary);
      })();

      return;
    }

    sendMessage(trimmed);
    setInput("");
  }, [input, isStreaming, sendMessage, memoryScope, appendAssistantMessage]);

  const handleQuickAction = useCallback((prompt: string) => {
    setInput(prompt);
  }, []);

  const handleLangChange = (_: React.MouseEvent, value: SpeechLang | null) => {
    if (value) setLang(value);
  };

  // Determine if a "thinking" placeholder should show (streaming started but no content yet)
  const lastMsg = messages[messages.length - 1];
  const showTypingDots =
    isStreaming && lastMsg?.role === "assistant" && lastMsg.content === "";

  const latestAssistantText = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant" && !m.streaming) return m.content;
    }
    return "";
  })();

  const proposedActions = parseAgentActionsFromAssistantText(latestAssistantText);
  const proposedToolCalls = parseToolCallsFromAssistantText(latestAssistantText);
  const proposedWriteToolCalls = proposedToolCalls.filter((tc) => tc.tool !== "db.select");

  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolSuccess, setToolSuccess] = useState<string | null>(null);

  const [autoExecutedToolCallIds, setAutoExecutedToolCallIds] = useState<Record<string, boolean>>({});

  const toolCallKey = useCallback((tc: ToolCall) => {
    const args = tc.args ?? {};
    let argsKey = "";
    try {
      argsKey = JSON.stringify(args);
    } catch {
      argsKey = String(args);
    }
    return `${tc.tool}:${argsKey}`;
  }, []);

  // Convert incoming chore create actions into editable drafts
  useEffect(() => {
    if (isStreaming) return;
    const incoming = proposedActions.filter((a) => a.type === "create" && a.table === "chores");
    if (incoming.length === 0) return;

    setChoreDrafts(
      incoming.map((a, idx) => ({
        id: `${Date.now()}_${idx}`,
        action: {
          ...a,
          record: { ...a.record },
        },
      })),
    );
  }, [latestAssistantText, isStreaming]);

  // Load helpers list for household
  useEffect(() => {
    const token = agentAccessToken.trim();
    const householdId = agentHouseholdId.trim();
    if (!token || !householdId) return;

    let cancelled = false;
    (async () => {
      setHelperLoadError(null);
      const res = await agentListHelpers({ accessToken: token, householdId });
      if (cancelled) return;
      if (!res.ok) {
        setHelperLoadError("error" in res ? res.error : "Failed to load helpers");
        setHelpers([]);
        return;
      }
      setHelpers(res.helpers);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentAccessToken, agentHouseholdId]);

  const applyAction = useCallback(async (action: AgentCreateAction) => {
    setAgentError(null);
    setAgentSuccess(null);

    const token = agentAccessToken.trim();
    if (!token) {
      setAgentError("Missing access token. Click Agent Setup and paste your JWT.");
      return;
    }

    const householdId = agentHouseholdId.trim();
    if (!householdId) {
      setAgentError("Missing household_id. Click Agent Setup and paste your household UUID.");
      return;
    }

    const record = { ...action.record, household_id: (action.record.household_id ?? householdId) };

    setAgentBusy(true);
    const res = await agentCreate({
      accessToken: token,
      table: action.table,
      record: record as Record<string, unknown>,
      reason: action.reason,
    });
    setAgentBusy(false);

    if (!res.ok) {
      setAgentError("error" in res ? res.error : "Create failed");
      return;
    }

    setAgentSuccess(`Created 1 ${action.table} item.`);
  }, [agentAccessToken, agentHouseholdId]);

  const submitChoreDrafts = useCallback(async () => {
    setAgentError(null);
    setAgentSuccess(null);

    const token = agentAccessToken.trim();
    if (!token) {
      setAgentError("Missing access token. Click Agent Setup and paste your JWT.");
      return;
    }
    const householdId = agentHouseholdId.trim();
    if (!householdId) {
      setAgentError("Missing household_id. Click Agent Setup and paste your household UUID.");
      return;
    }
    if (choreDrafts.length === 0) return;

    setAgentBusy(true);
    let okCount = 0;
    for (const d of choreDrafts) {
      const record = { ...d.action.record, household_id: householdId };
      const res = await agentCreate({
        accessToken: token,
        table: "chores",
        record: record as Record<string, unknown>,
        reason: d.action.reason,
      });
      if (!res.ok) {
        setAgentBusy(false);
        setAgentError("error" in res ? res.error : "Create failed");
        return;
      }
      okCount += 1;
    }
    setAgentBusy(false);
    setAgentSuccess(`Created ${okCount} chores.`);
    setChoreDrafts([]);
  }, [agentAccessToken, agentHouseholdId, choreDrafts]);

  const approveToolCall = useCallback(async (tc: ToolCall) => {
    setToolError(null);
    setToolSuccess(null);
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) {
      setToolError("Missing access_token or household_id. Click Agent Setup to confirm your session token + household id.");
      return;
    }
    setToolBusy(true);
    const tcWithHousehold = withHouseholdId(tc, householdId);
    let res = await executeToolCall({
      accessToken: token,
      householdId,
      scope: memoryScope,
      toolCall: tcWithHousehold,
    });

    if (!res.ok && res.status === 403 && authedAccessToken.trim()) {
      try {
        await refreshHouseholdId();
      } catch {
        // ignore
      }
      const next = getAgentSetup();
      if (next.token && next.householdId && next.householdId !== householdId) {
        const retryTc = withHouseholdId(tc, next.householdId);
        res = await executeToolCall({
          accessToken: next.token,
          householdId: next.householdId,
          scope: memoryScope,
          toolCall: retryTc,
        });
      }
    }
    setToolBusy(false);
    if (!res.ok) {
      setToolError("error" in res ? res.error : "Tool execution failed");
      return;
    }
    setToolSuccess(`Executed ${tc.tool}.`);
    appendAssistantMessage(res.summary);
  }, [memoryScope, appendAssistantMessage, refreshHouseholdId, authedAccessToken]);

  const executeReadOnlyToolCall = useCallback(async (tc: ToolCall) => {
    if (tc.tool !== "db.select") return;
    const key = toolCallKey(tc);
    if (autoExecutedToolCallIds[key]) return;

    setToolError(null);
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) return;

    setAutoExecutedToolCallIds((prev) => ({ ...prev, [key]: true }));

    const tcWithHousehold = withHouseholdId(tc, householdId);
    const res = await executeToolCall({
      accessToken: token,
      householdId,
      scope: memoryScope,
      toolCall: tcWithHousehold,
    });

    if (!res.ok) {
      setToolError("error" in res ? res.error : "Couldn’t fetch the information");
      setAutoExecutedToolCallIds((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }

    appendAssistantMessage(res.summary);
  }, [autoExecutedToolCallIds, memoryScope, appendAssistantMessage, toolCallKey]);

  useEffect(() => {
    if (isStreaming) return;
    if (proposedToolCalls.length === 0) return;
    // New tool call set from assistant — allow selects to run again even if Sarvam reuses ids like tc_1.
    setAutoExecutedToolCallIds({});
  }, [isStreaming, latestAssistantText]);

  useEffect(() => {
    if (isStreaming) return;
    if (proposedToolCalls.length === 0) return;
    const { token, householdId } = getAgentSetup();
    if (!token || !householdId) return;
    for (const tc of proposedToolCalls) {
      if (tc.tool === "db.select") {
        void executeReadOnlyToolCall(tc);
      }
    }
  }, [isStreaming, proposedToolCalls, executeReadOnlyToolCall, authedAccessToken, authedHouseholdId, agentAccessToken, agentHouseholdId]);

  return (
    <Stack sx={{ height: "100%", overflow: "hidden" }}>
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="flex-end"
        sx={{ mb: 2.5, flexShrink: 0 }}
      >
        <Box>
          <Typography variant="h5" fontWeight={700} lineHeight={1.2}>
            Chat Assistant
          </Typography>
          <Typography variant="body2" color="text.secondary" mt={0.25}>
            Use natural language to manage your household
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} alignItems="center">
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>Memory</InputLabel>
            <Select
              value={memoryScope}
              label="Memory"
              onChange={(e) => setMemoryScope(e.target.value === "household" ? "household" : "user")}
            >
              <MenuItem value="user">Personal</MenuItem>
              <MenuItem value="household">Household</MenuItem>
            </Select>
          </FormControl>

          {/* Language / STT picker */}
          <ToggleButtonGroup
            value={lang}
            exclusive
            onChange={handleLangChange}
            size="small"
            aria-label="Speech recognition language"
            sx={{ height: 32 }}
          >
            {(Object.keys(LANG_LABELS) as SpeechLang[]).map((l) => (
              <ToggleButton
                key={l}
                value={l}
                aria-label={l}
                sx={{ px: 1.5, fontSize: "0.72rem", fontWeight: 600, lineHeight: 1 }}
              >
                {LANG_LABELS[l]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Stack>
      </Stack>

      {/* ── API key / error banners ───────────────────────────────────────── */}
      <Collapse in={!hasKey}>
        <Alert severity="info" sx={{ mb: 1.5, fontSize: "0.8rem" }}>
          Demo mode — add <strong>VITE_SARVAM_API_KEY</strong> to your{" "}
          <code>.env</code> file to enable full AI responses.
        </Alert>
      </Collapse>
      <Collapse in={!memoryReady}>
        <Alert severity="info" sx={{ mb: 1.5, fontSize: "0.8rem" }}>
          Loading long-term memory…
        </Alert>
      </Collapse>
      <Collapse in={!!chatError}>
        <Alert severity="error" sx={{ mb: 1.5, fontSize: "0.8rem" }}>
          {chatError}
        </Alert>
      </Collapse>
      <Collapse in={!!sttError}>
        <Alert severity="warning" onClose={() => setSttError(null)} sx={{ mb: 1.5, fontSize: "0.8rem" }}>
          {sttError}
        </Alert>
      </Collapse>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <Stack
        direction="row"
        spacing={2}
        sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      >
        {/* Chat panel */}
        <Paper
          variant="outlined"
          sx={{
            flex: 2,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRadius: "12px",
          }}
        >
          {/* Chat header */}
          <Stack
            direction="row"
            alignItems="center"
            spacing={1.5}
            sx={{
              px: 2,
              py: 1.5,
              borderBottom: "1px solid",
              borderColor: "divider",
              flexShrink: 0,
            }}
          >
            <Avatar sx={{ width: 34, height: 34, bgcolor: "primary.main" }}>
              <SmartToy sx={{ fontSize: 19 }} />
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle1" fontWeight={600} lineHeight={1.2}>
                Home Assistant
              </Typography>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  Powered by Sarvam AI
                </Typography>
                {sttMode === "sarvam" && voiceSupported && (
                  <Tooltip title="Using Sarvam Saaras v3 for voice transcription">
                    <GraphicEq sx={{ fontSize: 13, color: "primary.main" }} />
                  </Tooltip>
                )}
              </Stack>
            </Box>
            <Chip
              label={hasKey ? "AI Connected" : "Demo Mode"}
              size="small"
              color={hasKey ? "success" : "default"}
              variant="outlined"
              sx={{ fontSize: "0.7rem", height: 22 }}
            />
          </Stack>

          {/* Messages area */}
          <Box
            sx={{
              flex: 1,
              overflowY: "auto",
              px: 2,
              py: 2,
              minHeight: 0,
              "&::-webkit-scrollbar": { width: 4 },
              "&::-webkit-scrollbar-track": { bgcolor: "transparent" },
              "&::-webkit-scrollbar-thumb": {
                bgcolor: "grey.300",
                borderRadius: "4px",
              },
            }}
          >
            {messages.map((msg) => (
              <MessageBubble key={msg.id} {...msg} />
            ))}

            {/* Proposed agent actions (from latest assistant message) */}
            {!isStreaming && (proposedActions.length > 0 || proposedWriteToolCalls.length > 0) && (
              <Box sx={{ mt: 1.5, mb: 2 }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1 }}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    Proposed actions
                  </Typography>
                  <Button size="small" variant="outlined" onClick={() => setAgentDialogOpen(true)}>
                    Agent Setup
                  </Button>
                </Box>

                {agentError && (
                  <Alert severity="error" sx={{ mb: 1 }}>
                    {agentError}
                  </Alert>
                )}
                {agentSuccess && (
                  <Alert severity="success" sx={{ mb: 1 }}>
                    {agentSuccess}
                  </Alert>
                )}

                {toolError && (
                  <Alert severity="error" sx={{ mb: 1 }}>
                    {toolError}
                  </Alert>
                )}
                {toolSuccess && (
                  <Alert severity="success" sx={{ mb: 1 }}>
                    {toolSuccess}
                  </Alert>
                )}

                {helperLoadError && (
                  <Alert severity="warning" sx={{ mb: 1 }}>
                    {helperLoadError}
                  </Alert>
                )}

                {choreDrafts.length > 0 && (
                  <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 1.5 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2} sx={{ mb: 1 }}>
                      <Box>
                        <Typography variant="body2" fontWeight={700}>
                          Chore suggestions (review & edit)
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Edit chores and assignments, then submit to save to the database.
                        </Typography>
                      </Box>
                      <Button
                        size="small"
                        variant="contained"
                        disabled={agentBusy}
                        onClick={submitChoreDrafts}
                      >
                        Submit
                      </Button>
                    </Stack>

                    <Stack spacing={1.25}>
                      {choreDrafts.map((d) => {
                        const r = d.action.record as Record<string, unknown>;
                        const title = typeof r.title === "string" ? r.title : "";
                        const description = typeof r.description === "string" ? r.description : "";
                        const dueAt = typeof r.due_at === "string" ? r.due_at : "";
                        const priority = asNumberOrNull(r.priority) ?? 1;
                        const helperId = typeof r.helper_id === "string" ? r.helper_id : "";

                        return (
                          <Paper key={d.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                            <Stack spacing={1.25}>
                              <TextField
                                label="Title"
                                value={title}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setChoreDrafts((prev) =>
                                    prev.map((x) =>
                                      x.id === d.id
                                        ? { ...x, action: { ...x.action, record: { ...x.action.record, title: v } } }
                                        : x,
                                    ),
                                  );
                                }}
                                fullWidth
                                size="small"
                              />

                              <TextField
                                label="Description"
                                value={description}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setChoreDrafts((prev) =>
                                    prev.map((x) =>
                                      x.id === d.id
                                        ? { ...x, action: { ...x.action, record: { ...x.action.record, description: v } } }
                                        : x,
                                    ),
                                  );
                                }}
                                fullWidth
                                size="small"
                                multiline
                                minRows={2}
                              />

                              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                                <TextField
                                  label="Due"
                                  type="datetime-local"
                                  value={dueAt}
                                  onChange={(e) => {
                                    const v = normalizeDatetimeLocal(e.target.value);
                                    setChoreDrafts((prev) =>
                                      prev.map((x) =>
                                        x.id === d.id
                                          ? {
                                              ...x,
                                              action: {
                                                ...x.action,
                                                record: { ...x.action.record, due_at: v ?? null },
                                              },
                                            }
                                          : x,
                                      ),
                                    );
                                  }}
                                  fullWidth
                                  size="small"
                                  InputLabelProps={{ shrink: true }}
                                />

                                <TextField
                                  label="Priority (1-3)"
                                  type="number"
                                  value={priority}
                                  onChange={(e) => {
                                    const v = asNumberOrNull(e.target.value) ?? 1;
                                    setChoreDrafts((prev) =>
                                      prev.map((x) =>
                                        x.id === d.id
                                          ? { ...x, action: { ...x.action, record: { ...x.action.record, priority: v } } }
                                          : x,
                                      ),
                                    );
                                  }}
                                  fullWidth
                                  size="small"
                                  inputProps={{ min: 1, max: 3 }}
                                />

                                <FormControl fullWidth size="small">
                                  <InputLabel>Helper</InputLabel>
                                  <Select
                                    value={helperId}
                                    label="Helper"
                                    onChange={(e) => {
                                      const v = String(e.target.value);
                                      setChoreDrafts((prev) =>
                                        prev.map((x) =>
                                          x.id === d.id
                                            ? {
                                                ...x,
                                                action: {
                                                  ...x.action,
                                                  record: { ...x.action.record, helper_id: v || null },
                                                },
                                              }
                                            : x,
                                        ),
                                      );
                                    }}
                                  >
                                    <MenuItem value="">
                                      <em>Unassigned</em>
                                    </MenuItem>
                                    {helpers.map((h) => (
                                      <MenuItem key={h.id} value={h.id}>
                                        {h.name}{h.type ? ` (${h.type})` : ""}
                                      </MenuItem>
                                    ))}
                                  </Select>
                                </FormControl>
                              </Stack>

                              <Stack direction="row" justifyContent="flex-end">
                                <Button
                                  size="small"
                                  color="error"
                                  onClick={() => setChoreDrafts((prev) => prev.filter((x) => x.id !== d.id))}
                                >
                                  Remove
                                </Button>
                              </Stack>
                            </Stack>
                          </Paper>
                        );
                      })}
                    </Stack>
                  </Paper>
                )}

                <Stack spacing={1}>
                  {proposedWriteToolCalls.map((tc) => (
                    <Paper key={tc.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                      <Stack spacing={1}>
                        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                          <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={600}>
                            {tc.tool}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: "block", wordBreak: "break-word" }}>
                            {tc.reason ? tc.reason : "(no reason provided)"}
                          </Typography>

                          </Box>

                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Button
                              size="small"
                              variant="contained"
                              disabled={toolBusy}
                              onClick={() => approveToolCall(tc)}
                            >
                              Approve
                            </Button>
                          </Stack>
                        </Stack>
                      </Stack>
                    </Paper>
                  ))}

                  {proposedActions.filter((a) => a.table !== "chores").map((a, idx) => (
                    <Paper key={idx} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={600}>
                            Create {a.table}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: "block", wordBreak: "break-word" }}>
                            {a.table === "helpers"
                              ? String((a.record as Record<string, unknown>).name ?? "(missing name)")
                              : String((a.record as Record<string, unknown>).title ?? "(missing title)")}
                          </Typography>
                        </Box>
                        <Button
                          size="small"
                          variant="contained"
                          disabled={agentBusy}
                          onClick={() => applyAction(a)}
                        >
                          Apply
                        </Button>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              </Box>
            )}

            {showTypingDots && <TypingIndicator />}

            <div ref={messagesEndRef} />
          </Box>

          {/* Input */}
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            isListening={isListening}
            isTranscribing={isTranscribing}
            onMicToggle={toggleMic}
            voiceSupported={voiceSupported}
            lang={lang}
            disabled={isStreaming}
          />
        </Paper>

        {/* Sidebar */}
        <Box
          sx={{
            flex: 1,
            minWidth: 240,
            maxWidth: 300,
            overflowY: "auto",
            flexShrink: 0,
            "&::-webkit-scrollbar": { width: 4 },
            "&::-webkit-scrollbar-thumb": { bgcolor: "grey.300", borderRadius: "4px" },
          }}
        >
          <QuickActionsPanel onQuickAction={handleQuickAction} alertCount={3} />
        </Box>
      </Stack>

      <Dialog open={agentDialogOpen} onClose={() => setAgentDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Setup & Connection</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Alert severity="info">
              This app needs to know <strong>who you are</strong> (login) and <strong>which home</strong> you belong to.
              <br />
              Normally this is filled automatically after you sign up / log in.
            </Alert>
            <Alert severity="success">
              Your login status:
              <br />
              Logged in: {authedAccessToken.trim() ? "Yes" : "No"}
              <br />
              Signed in as: {authedUser?.email ? String(authedUser.email) : "(unknown)"}
              <br />
              Home linked: {authedHouseholdId.trim() ? "Yes" : "No"}
            </Alert>
            {authedLastError.trim() ? <Alert severity="warning">{authedLastError.trim()}</Alert> : null}

            {bootstrapError ? <Alert severity="error">{bootstrapError}</Alert> : null}
            {bootstrapSuccess ? <Alert severity="success">{bootstrapSuccess}</Alert> : null}

            {authedAccessToken.trim() ? (
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={bootstrapBusy}
                  onClick={async () => {
                    setBootstrapError(null);
                    setBootstrapSuccess(null);
                    setBootstrapBusy(true);
                    try {
                      await refreshHouseholdId();
                      setBootstrapSuccess("Checked your account and refreshed your home link.");
                    } catch (e) {
                      setBootstrapError(e instanceof Error ? e.message : "Couldn't refresh your home link");
                    } finally {
                      setBootstrapBusy(false);
                    }
                  }}
                >
                  Refresh my home link
                </Button>

                {!authedHouseholdId.trim() ? (
                  <Button
                    variant="contained"
                    size="small"
                    disabled={bootstrapBusy}
                    onClick={async () => {
                      setBootstrapError(null);
                      setBootstrapSuccess(null);
                      setBootstrapBusy(true);
                      try {
                        const res = await bootstrapHousehold();
                        if (!res.ok) {
                          setBootstrapError(res.error);
                        } else {
                          setBootstrapSuccess("Your home is now set up and linked to your account.");
                        }
                      } finally {
                        setBootstrapBusy(false);
                      }
                    }}
                  >
                    Set up my home
                  </Button>
                ) : null}

                <Button
                  variant="text"
                  size="small"
                  disabled={bootstrapBusy}
                  onClick={async () => {
                    setBootstrapError(null);
                    setBootstrapSuccess(null);
                    await signOut();
                    setBootstrapSuccess("You have been signed out. Please log in with the correct email.");
                  }}
                >
                  Sign out
                </Button>
              </Stack>
            ) : null}

            <TextField
              label="Advanced: Login token"
              value={agentAccessToken}
              onChange={(e) => setAgentAccessToken(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={3}
            />
            <TextField
              label="Advanced: Home ID"
              value={agentHouseholdId}
              onChange={(e) => setAgentHouseholdId(e.target.value)}
              fullWidth
              size="small"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAgentDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
