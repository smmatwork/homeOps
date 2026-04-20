import { ToggleButton, ToggleButtonGroup } from "@mui/material";
import { useI18n, type UiLanguage } from "../i18n";

const LABELS: Record<UiLanguage, string> = {
  en: "EN",
  hi: "हिं",
  kn: "ಕನ್",
};

export function LanguageSwitcher(props: { size?: "small" | "medium"; compact?: boolean } = {}) {
  const { lang, setLang } = useI18n();
  const size = props.size ?? "small";

  return (
    <ToggleButtonGroup
      value={lang}
      exclusive
      onChange={(_, v: UiLanguage | null) => {
        if (!v) return;
        setLang(v);
      }}
      size={size}
      aria-label="UI language"
      sx={{ height: size === "small" ? 32 : 40 }}
    >
      {(Object.keys(LABELS) as UiLanguage[]).map((l) => (
        <ToggleButton
          key={l}
          value={l}
          aria-label={l}
          sx={{ px: 1.5, fontSize: "0.72rem", fontWeight: 700, lineHeight: 1, textTransform: "none" }}
        >
          {LABELS[l]}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
