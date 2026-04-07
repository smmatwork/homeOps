import { Box, Stack, TextField, IconButton, Typography, Tooltip, ToggleButtonGroup, ToggleButton } from "@mui/material";
import { Mic, MicOff, Send } from "@mui/icons-material";
import { keyframes } from "@emotion/react";
import type { SpeechLang } from "../../hooks/useSarvamSTT";
import { useI18n } from "../../i18n";

const pulseRing = keyframes`
  0%   { box-shadow: 0 0 0 0   rgba(211, 47, 47, 0.45); }
  70%  { box-shadow: 0 0 0 8px rgba(211, 47, 47, 0);    }
  100% { box-shadow: 0 0 0 0   rgba(211, 47, 47, 0);    }
`;

const blinkDot = keyframes`
  50% { opacity: 0; }
`;

const PLACEHOLDERS: Record<SpeechLang, string> = {
  "en-IN": "Ask anything about your home…",
  "hi-IN": "कुछ भी पूछें…",
  "kn-IN": "ಏನಾದರೂ ಕೇಳಿ…",
};

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  isListening: boolean;
  isTranscribing?: boolean;
  onMicToggle: () => void;
  voiceSupported: boolean;
  lang: SpeechLang;
  transliterationMode?: "off" | "hi" | "kn";
  onTransliterationModeChange?: (mode: "off" | "hi" | "kn") => void;
  disabled?: boolean;
}

export function ChatInput({
  value,
  onChange,
  onSend,
  isListening,
  isTranscribing = false,
  onMicToggle,
  voiceSupported,
  lang,
  transliterationMode = "off",
  onTransliterationModeChange,
  disabled = false,
}: ChatInputProps) {
  const { t } = useI18n();
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <Box sx={{ px: 2, pb: 2, pt: 1, borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}>
      {/* Listening / transcribing status */}
      {(isListening || isTranscribing) && (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 1 }}>
          <Box
            sx={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              bgcolor: isTranscribing ? "warning.main" : "error.main",
              animation: `${blinkDot} 1s step-start infinite`,
            }}
          />
          <Typography
            variant="caption"
            color={isTranscribing ? "warning.main" : "error.main"}
            fontWeight={500}
          >
            {isTranscribing ? t("chat.transcribing") : t("chat.listening")}
          </Typography>
        </Stack>
      )}

      {/* Input row */}
      <Stack direction="row" spacing={1} alignItems="flex-end">
        <Stack spacing={0.5} sx={{ flex: 1 }}>
          {onTransliterationModeChange && (
            <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={transliterationMode}
                onChange={(_, v) => {
                  if (v === null) return;
                  onTransliterationModeChange(v);
                }}
              >
                <ToggleButton value="off">{t("chat.transliteration_off")}</ToggleButton>
                <ToggleButton value="hi">{t("chat.transliteration_hi")}</ToggleButton>
                <ToggleButton value="kn">{t("chat.transliteration_kn")}</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          )}
        <TextField
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={PLACEHOLDERS[lang]}
          fullWidth
          size="small"
          multiline
          maxRows={4}
          disabled={disabled}
          inputProps={{ lang: transliterationMode === "hi" ? "hi" : transliterationMode === "kn" ? "kn" : "en" }}
          sx={{
            "& .MuiOutlinedInput-root": {
              borderRadius: "24px",
              fontSize: "0.875rem",
            },
          }}
        />
        </Stack>

        {/* Mic button */}
        {voiceSupported && (
          <Tooltip
            title={isTranscribing ? t("chat.transcribing") : isListening ? t("chat.stop_listening") : t("chat.voice_input")}
            placement="top"
          >
            <span>
              <IconButton
                onClick={onMicToggle}
                disabled={isTranscribing}
                size="small"
                sx={{
                  width: 36,
                  height: 36,
                  bgcolor: isListening ? "error.main" : "grey.100",
                  color: isListening ? "white" : "text.secondary",
                  flexShrink: 0,
                  transition: "all 0.2s",
                  animation: isListening ? `${pulseRing} 1.2s ease-out infinite` : "none",
                  "&:hover": {
                    bgcolor: isListening ? "error.dark" : "grey.200",
                  },
                }}
              >
                {isListening ? <MicOff sx={{ fontSize: 18 }} /> : <Mic sx={{ fontSize: 18 }} />}
              </IconButton>
            </span>
          </Tooltip>
        )}

        {/* Send button */}
        <Tooltip title={t("chat.send_message")} placement="top">
          <span>
            <IconButton
              onClick={onSend}
              disabled={!value.trim() || disabled}
              size="small"
              sx={{
                width: 36,
                height: 36,
                bgcolor: "primary.main",
                color: "primary.contrastText",
                flexShrink: 0,
                "&:hover": { bgcolor: "primary.dark" },
                "&.Mui-disabled": {
                  bgcolor: "action.disabledBackground",
                  color: "action.disabled",
                },
              }}
            >
              <Send sx={{ fontSize: 18 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Box>
  );
}
