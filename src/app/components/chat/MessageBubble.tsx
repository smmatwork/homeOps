import { Box, Avatar, Typography, Stack } from "@mui/material";
import { SmartToy, Person } from "@mui/icons-material";
import { keyframes } from "@emotion/react";
import { useMemo } from "react";

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
    // Strip any stray think tags (including unclosed ones) without truncating content.
    withoutThink = withoutThink
      .replace(/<\/?think>/gi, "")
      .replace(/^\s*think>\s*/gim, "");

    // Hide technical summaries; we show the friendly DB-backed summary separately
    withoutThink = withoutThink
      .split("\n")
      .filter((line) => !/^\s*No rows found in\s+[a-z_]+\.?\s*$/i.test(line))
      .join("\n");

    withoutThink = withoutThink.trim();

    const hasJsonStart = /```json\b/i.test(withoutThink);

    const re = /```json\s*[\s\S]*?\s*```/gi;
    const hasJsonBlock = re.test(withoutThink) || hasJsonStart;
    const hasToolCalls = hasJsonBlock && /\"tool_calls\"\s*:/i.test(withoutThink);

    // Remove closed JSON blocks
    let withoutJson = withoutThink.replace(re, "");
    // If there's a JSON start marker without a closing block, drop everything from the start marker
    if (hasJsonStart) {
      const idx = withoutJson.toLowerCase().indexOf("```json");
      if (idx >= 0) withoutJson = withoutJson.slice(0, idx);
    }
    withoutJson = withoutJson.trim();

    return { hasToolCalls, hasJsonBlock, without: withoutJson };
  }, [content]);

  // Hide tool-call messages entirely. We'll show the real DB-backed summary that gets appended after execution.
  if (!isUser && (parsed.hasToolCalls || parsed.hasJsonBlock)) return null;

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
