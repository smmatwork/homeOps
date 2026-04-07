import { Box, Avatar, Typography, Stack } from "@mui/material";
import { SmartToy, Person } from "@mui/icons-material";
import { keyframes } from "@emotion/react";
import { useMemo } from "react";
import {
  parseAgentActionsFromAssistantText,
  parseAutomationSuggestionsFromAssistantText,
  parseToolCallsFromAssistantText,
} from "../../services/agentActions";

const blinkCursor = keyframes`
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
`;

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  streaming?: boolean;
}

export function MessageBubble({ role, content, timestamp, streaming }: MessageBubbleProps) {
  const isUser = role === "user";

  const parsed = useMemo(() => {
    let withoutThink = content;

    // Remove well-formed think blocks
    withoutThink = withoutThink.replace(/<think>[\s\S]*?<\/think>/gi, "");
    // Remove well-formed analysis blocks
    withoutThink = withoutThink.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "");
    // Strip any stray think tags (including unclosed ones) without truncating content.
    withoutThink = withoutThink
      .replace(/<\/?think>/gi, "")
      .replace(/<\/?analysis>/gi, "")
      .replace(/^\s*think>\s*/gim, "");

    // Drop leading chain-of-thought style headers if the model emits them
    withoutThink = withoutThink
      .replace(/^\s*(thought|thinking|reasoning|analysis)\s*:\s*/gim, "")
      .replace(/^\s*(thought|thinking|reasoning|analysis)\s*\n+/gim, "");

    // If the assistant leaks meta-reasoning paragraphs (e.g. "Okay, let's...", "Wait..."),
    // strip those paragraphs while keeping any user-facing content.
    // IMPORTANT: do not apply this aggressively while streaming; it can hide all visible output
    // and make the UI look like it's stuck on "…".
    if (!streaming) {
      const metaMarkers = [
        "okay, let's",
        "wait,",
        "let me",
        "alternatively",
        "the task is",
        "the user provided",
        "convert this",
        "tool call",
        "tool_calls",
      ];
      const paras = withoutThink.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const hasMeta = paras.some((p) => {
        const lower = p.toLowerCase();
        return metaMarkers.some((m) => lower.includes(m));
      });
      if (hasMeta) {
        const cleaned = paras
          .filter((p) => {
            const lower = p.toLowerCase();
            const looksMeta = metaMarkers.some((m) => lower.includes(m));
            // Only remove if it looks like internal narration rather than a user-facing instruction.
            if (!looksMeta) return true;
            if (lower.includes("please") || lower.includes("next") || lower.includes("you can")) return true;
            return false;
          })
          .join("\n\n");
        withoutThink = cleaned;
      }
    }

    // Hide technical summaries; we show the friendly DB-backed summary separately
    withoutThink = withoutThink
      .split("\n")
      .filter((line) => !/^\s*No rows found in\s+[a-z_]+\.?\s*$/i.test(line))
      .join("\n");

    withoutThink = withoutThink.trim();

    const hasJsonStart = /```json\b/i.test(withoutThink);

    const re = /```json\s*[\s\S]*?\s*```/gi;
    const hasJsonBlock = re.test(withoutThink) || hasJsonStart;

    // Only treat as a tool/action payload if it is actually parsable.
    // This prevents the UI from showing “Proposed actions are ready below” when
    // the model produced malformed / incomplete JSON fences.
    const toolCalls = parseToolCallsFromAssistantText(withoutThink);
    const writeToolCalls = toolCalls.filter((tc) => tc.tool !== "db.select");
    const actions = parseAgentActionsFromAssistantText(withoutThink);
    const automationSuggestions = parseAutomationSuggestionsFromAssistantText(withoutThink);
    const hasToolCalls = writeToolCalls.length > 0;
    const hasActions = actions.length > 0;
    const hasAutomationSuggestions = automationSuggestions.length > 0;

    // Remove closed JSON blocks
    let withoutJson = withoutThink.replace(re, "");
    // If there's a JSON start marker without a closing block, drop everything from the start marker
    if (hasJsonStart) {
      const idx = withoutJson.toLowerCase().indexOf("```json");
      if (idx >= 0) withoutJson = withoutJson.slice(0, idx);
    }
    // If the assistant emitted a raw JSON payload (not fenced), hide it from the bubble.
    // The proposals UI (tool calls/actions panel) will still pick it up via the parsers.
    if ((hasToolCalls || hasActions || hasAutomationSuggestions) && withoutJson.trim().startsWith("{")) {
      withoutJson = "";
    }
    withoutJson = withoutJson.trim();

    return {
      hasToolCalls,
      hasActions,
      hasAutomationSuggestions,
      hasJsonBlock,
      without: withoutJson,
    };
  }, [content, streaming]);

  // Hide tool-call / JSON-only messages entirely. If there's user-facing text outside the JSON block, render that.
  // We'll show the DB-backed summary after tool execution.
  if (!isUser && (parsed.hasToolCalls || parsed.hasActions || parsed.hasAutomationSuggestions) && !parsed.without) {
    if (streaming) {
      return (
        <Stack
          direction={isUser ? "row-reverse" : "row"}
          spacing={1.5}
          alignItems="flex-end"
          sx={{ mb: 2 }}
        >
          <Avatar
            sx={{
              width: 32,
              height: 32,
              bgcolor: isUser ? "grey.400" : "primary.main",
              flexShrink: 0,
            }}
          >
            <SmartToy sx={{ fontSize: 18 }} />
          </Avatar>
          <Box
            sx={{
              maxWidth: "72%",
              bgcolor: "secondary.main",
              color: "text.primary",
              borderRadius: "18px",
              borderTopLeftRadius: "4px",
              px: 2,
              py: 1.5,
            }}
          >
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", lineHeight: 1.65, wordBreak: "break-word" }}>
              Preparing actions…
              <Box
                component="span"
                sx={{
                  display: "inline-block",
                  width: "2px",
                  height: "1em",
                  bgcolor: "text.primary",
                  ml: "2px",
                  verticalAlign: "text-bottom",
                  animation: `${blinkCursor} 0.8s step-start infinite`,
                }}
              />
            </Typography>
          </Box>
        </Stack>
      );
    }
    return (
      <Stack direction={isUser ? "row-reverse" : "row"} spacing={1.5} alignItems="flex-end" sx={{ mb: 2 }}>
        <Avatar
          sx={{
            width: 32,
            height: 32,
            bgcolor: isUser ? "grey.400" : "primary.main",
            flexShrink: 0,
          }}
        >
          <SmartToy sx={{ fontSize: 18 }} />
        </Avatar>
        <Box
          sx={{
            maxWidth: "72%",
            bgcolor: "secondary.main",
            color: "text.primary",
            borderRadius: "18px",
            borderTopLeftRadius: "4px",
            px: 2,
            py: 1.5,
          }}
        >
          <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", lineHeight: 1.65, wordBreak: "break-word" }}>
            Proposed actions are ready below.
          </Typography>
          <Typography
            variant="caption"
            sx={{
              display: "block",
              textAlign: "right",
              mt: 0.5,
              opacity: 0.55,
              fontSize: "0.68rem",
            }}
          >
            {timestamp}
          </Typography>
        </Box>
      </Stack>
    );
  }

  return (
    <Stack
      direction={isUser ? "row-reverse" : "row"}
      spacing={1.5}
      alignItems="flex-end"
      sx={{ mb: 2 }}
    >
      <Avatar
        sx={{
          width: 32,
          height: 32,
          bgcolor: isUser ? "grey.400" : "primary.main",
          flexShrink: 0,
        }}
      >
        {isUser ? (
          <Person sx={{ fontSize: 18 }} />
        ) : (
          <SmartToy sx={{ fontSize: 18 }} />
        )}
      </Avatar>

      <Box
        sx={{
          maxWidth: "72%",
          bgcolor: isUser ? "primary.main" : "secondary.main",
          color: isUser ? "primary.contrastText" : "text.primary",
          borderRadius: "18px",
          borderTopRightRadius: isUser ? "4px" : "18px",
          borderTopLeftRadius: isUser ? "18px" : "4px",
          px: 2,
          py: 1.5,
        }}
      >
        <Typography
          variant="body2"
          sx={{ whiteSpace: "pre-wrap", lineHeight: 1.65, wordBreak: "break-word" }}
        >
          {parsed.without || "…"}
          {/* Blinking cursor during streaming */}
          {streaming && (
            <Box
              component="span"
              sx={{
                display: "inline-block",
                width: "2px",
                height: "1em",
                bgcolor: "text.primary",
                ml: "2px",
                verticalAlign: "text-bottom",
                animation: `${blinkCursor} 0.8s step-start infinite`,
              }}
            />
          )}
        </Typography>
        {!streaming && (
          <Typography
            variant="caption"
            sx={{
              display: "block",
              textAlign: "right",
              mt: 0.5,
              opacity: 0.55,
              fontSize: "0.68rem",
            }}
          >
            {timestamp}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
