/**
 * ChannelChainStep — Step 3 of the HelperOnboardingFlow wizard.
 *
 * Lets the owner configure how HomeOps will reach this helper.
 * Presents the channel chain as an ordered list the owner can enable,
 * disable, and reorder. Also captures preferred language and, when
 * voice or whatsapp_voice is enabled, a preferred call window.
 *
 * v1 uses up/down buttons for reordering rather than HTML5 drag and
 * drop — it's simpler to test, accessible to keyboard and screen
 * readers, and matches the existing CRUD dialog patterns in this
 * codebase. A future iteration can upgrade to drag-and-drop if usage
 * data shows users want it.
 */

import { useCallback } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { ArrowUpward, ArrowDownward, Add, Remove } from "@mui/icons-material";
import type { HelperOnboardingFormData } from "./HelperOnboardingFlow";

// ── Channel registry (mirrors the backend ToolTable values) ────────

export const DEFAULT_CHANNEL_CHAIN = ["voice", "whatsapp_tap", "sms"] as const;

export const ALL_CHANNELS = [
  "voice",
  "whatsapp_voice",
  "whatsapp_tap",
  "whatsapp_form",
  "web",
  "sms",
] as const;

type ChannelId = typeof ALL_CHANNELS[number];

const CHANNEL_LABELS: Record<ChannelId, string> = {
  voice: "Voice call",
  whatsapp_voice: "WhatsApp voice note",
  whatsapp_tap: "WhatsApp one-tap",
  whatsapp_form: "WhatsApp form link",
  web: "Web magic link",
  sms: "SMS",
};

const CHANNEL_DESCRIPTIONS: Record<ChannelId, string> = {
  voice:
    "HomeOps calls the helper and walks them through a voice conversation. Default primary channel.",
  whatsapp_voice:
    "A pre-recorded voice note is sent via WhatsApp. Good for low-literacy helpers who prefer audio.",
  whatsapp_tap:
    "A one-tap accept button via WhatsApp. Fastest way for a tech-comfortable helper to say yes with default privacy settings.",
  whatsapp_form:
    "A WhatsApp message with a link to the Stage 2 web form for full consent capture.",
  web:
    "Owner shares the magic-link URL out-of-band (email, physical note). Backup path.",
  sms:
    "Plain text SMS with a callback number. Lowest-bandwidth fallback.",
};

// ── Pure helpers (exported for tests) ──────────────────────────────

export function moveChannelUp(chain: string[], channel: string): string[] {
  const idx = chain.indexOf(channel);
  if (idx <= 0) return chain;
  const next = [...chain];
  const [item] = next.splice(idx, 1);
  next.splice(idx - 1, 0, item);
  return next;
}

export function moveChannelDown(chain: string[], channel: string): string[] {
  const idx = chain.indexOf(channel);
  if (idx === -1 || idx >= chain.length - 1) return chain;
  const next = [...chain];
  const [item] = next.splice(idx, 1);
  next.splice(idx + 1, 0, item);
  return next;
}

export function toggleChannel(chain: string[], channel: string): string[] {
  if (chain.includes(channel)) {
    return chain.filter((c) => c !== channel);
  }
  return [...chain, channel];
}

/**
 * Partition ALL_CHANNELS into [enabled (ordered by chain), disabled].
 * Used to render two sections: the active chain (reorderable) and
 * the pool of channels that can be added.
 */
export function partitionChannels(
  chain: string[],
): { enabled: string[]; disabled: string[] } {
  const enabledSet = new Set(chain);
  const enabled = chain.filter((c) =>
    (ALL_CHANNELS as readonly string[]).includes(c),
  );
  const disabled = ALL_CHANNELS.filter((c) => !enabledSet.has(c));
  return { enabled, disabled: [...disabled] };
}

// ── Component ──────────────────────────────────────────────────────

type Props = {
  form: HelperOnboardingFormData;
  setForm: React.Dispatch<React.SetStateAction<HelperOnboardingFormData>>;
};

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_LABELS: Record<(typeof WEEKDAYS)[number], string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export function ChannelChainStep({ form, setForm }: Props) {
  const { enabled, disabled } = partitionChannels(form.channelPreferences);
  const showCallWindow =
    enabled.includes("voice") || enabled.includes("whatsapp_voice");

  const handleUp = useCallback(
    (channel: string) => {
      setForm((f) => ({
        ...f,
        channelPreferences: moveChannelUp(f.channelPreferences, channel),
      }));
    },
    [setForm],
  );

  const handleDown = useCallback(
    (channel: string) => {
      setForm((f) => ({
        ...f,
        channelPreferences: moveChannelDown(f.channelPreferences, channel),
      }));
    },
    [setForm],
  );

  const handleToggle = useCallback(
    (channel: string) => {
      setForm((f) => ({
        ...f,
        channelPreferences: toggleChannel(f.channelPreferences, channel),
      }));
    },
    [setForm],
  );

  const handleDayToggle = useCallback(
    (day: string) => {
      setForm((f) => ({
        ...f,
        callWindowDays: f.callWindowDays.includes(day)
          ? f.callWindowDays.filter((d) => d !== day)
          : [...f.callWindowDays, day],
      }));
    },
    [setForm],
  );

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>
          Channel chain
        </Typography>
        <Typography variant="body2" color="text.secondary">
          HomeOps tries these channels in order until one reaches the helper. The default chain is voice first, then WhatsApp one-tap, then SMS — change it based on what you know about the helper.
        </Typography>
      </Box>

      {enabled.length === 0 && (
        <Typography variant="body2" color="error">
          At least one channel must be enabled.
        </Typography>
      )}

      <Stack spacing={1}>
        {enabled.map((channel, idx) => {
          const label = CHANNEL_LABELS[channel as ChannelId] || channel;
          const desc = CHANNEL_DESCRIPTIONS[channel as ChannelId] || "";
          return (
            <Box
              key={channel}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                p: 1,
                borderRadius: 1,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Chip
                size="small"
                label={idx === 0 ? "Primary" : `#${idx + 1}`}
                color={idx === 0 ? "primary" : "default"}
                sx={{ minWidth: 72 }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" fontWeight={600}>
                  {label}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {desc}
                </Typography>
              </Box>
              <Tooltip title="Move up">
                <span>
                  <IconButton
                    size="small"
                    disabled={idx === 0}
                    onClick={() => handleUp(channel)}
                    aria-label={`Move ${label} up`}
                  >
                    <ArrowUpward fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Move down">
                <span>
                  <IconButton
                    size="small"
                    disabled={idx === enabled.length - 1}
                    onClick={() => handleDown(channel)}
                    aria-label={`Move ${label} down`}
                  >
                    <ArrowDownward fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Remove from chain">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => handleToggle(channel)}
                    aria-label={`Remove ${label}`}
                  >
                    <Remove fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          );
        })}
      </Stack>

      {disabled.length > 0 && (
        <Box>
          <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
            Available channels
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {disabled.map((channel) => {
              const label = CHANNEL_LABELS[channel as ChannelId] || channel;
              return (
                <Button
                  key={channel}
                  size="small"
                  variant="outlined"
                  startIcon={<Add fontSize="small" />}
                  onClick={() => handleToggle(channel)}
                >
                  {label}
                </Button>
              );
            })}
          </Stack>
        </Box>
      )}

      <FormControl fullWidth>
        <InputLabel id="preferred-language-label">Preferred language (best guess)</InputLabel>
        <Select
          labelId="preferred-language-label"
          label="Preferred language (best guess)"
          value={form.preferredLanguage}
          onChange={(e) =>
            setForm((f) => ({ ...f, preferredLanguage: String(e.target.value) }))
          }
        >
          <MenuItem value="">Not specified (helper picks in Stage 2)</MenuItem>
          <MenuItem value="en">English</MenuItem>
          <MenuItem value="hi">Hindi</MenuItem>
          <MenuItem value="kn">Kannada</MenuItem>
          <MenuItem value="ta">Tamil</MenuItem>
          <MenuItem value="te">Telugu</MenuItem>
          <MenuItem value="ml">Malayalam</MenuItem>
          <MenuItem value="bn">Bengali</MenuItem>
        </Select>
      </FormControl>

      {showCallWindow && (
        <Box>
          <Typography variant="subtitle2" fontWeight={700} gutterBottom>
            Preferred call window
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            When is the helper most likely to answer? HomeOps will try to place voice calls in this window.
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            {WEEKDAYS.map((day) => (
              <FormControlLabel
                key={day}
                control={
                  <Checkbox
                    size="small"
                    checked={form.callWindowDays.includes(day)}
                    onChange={() => handleDayToggle(day)}
                  />
                }
                label={WEEKDAY_LABELS[day]}
              />
            ))}
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Start time"
              type="time"
              value={form.callWindowStart}
              onChange={(e) =>
                setForm((f) => ({ ...f, callWindowStart: e.target.value }))
              }
              InputLabelProps={{ shrink: true }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="End time"
              type="time"
              value={form.callWindowEnd}
              onChange={(e) =>
                setForm((f) => ({ ...f, callWindowEnd: e.target.value }))
              }
              InputLabelProps={{ shrink: true }}
              sx={{ flex: 1 }}
            />
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
