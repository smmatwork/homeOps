export function normalizeSpaceName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function inferSpaceFromText(options: string[], text: string): string | null {
  const t = normalizeSpaceName(String(text || "").replace(/[^a-z0-9\s]/gi, " "));
  if (!t) return null;

  const opts = (Array.isArray(options) ? options : [])
    .map((o) => ({ raw: String(o), norm: normalizeSpaceName(String(o)) }))
    .filter((o) => o.norm);
  if (opts.length === 0) return null;

  const direct = opts.filter((o) => t.includes(o.norm)).map((o) => o.raw);
  if (direct.length === 1) return direct[0];

  const aliasMatches = (label: string, keys: string[]) => {
    if (!keys.some((k) => t.includes(k))) return null;
    const matches = opts.filter((o) => o.norm.includes(label)).map((o) => o.raw);
    return matches.length === 1 ? matches[0] : null;
  };

  return (
    aliasMatches("master", ["master", "primary", "main"]) ||
    aliasMatches("common", ["common", "shared", "hall"]) ||
    aliasMatches("guest", ["guest"]) ||
    aliasMatches("attached", ["attached", "ensuite", "en suite"]) ||
    null
  );
}

export function normalizeChoreTextFromUserUtterance(text: string): { title: string; description: string } {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const cleaned = raw
    .replace(/^please\s+/i, "")
    .replace(/^(add|create|make|set up)\s+(a\s+)?chore\s+((to|for)\s+)?/i, "")
    .replace(/^add\s+chore\s+(to\s+)?/i, "")
    .trim();

  const finalText0 = cleaned || raw || "Chore";
  const gerundMatch = finalText0.match(/^([A-Za-z]+ing)\s+(.*)$/);
  const finalText = (() => {
    if (!gerundMatch) return finalText0;
    const verbIng = gerundMatch[1];
    const rest = gerundMatch[2];
    if (!verbIng || !rest) return finalText0;

    const lower = verbIng.toLowerCase();
    const irregular: Record<string, string> = {
      making: "make",
      taking: "take",
      having: "have",
      doing: "do",
      lying: "lie",
      dying: "die",
      tying: "tie",
    };
    if (lower in irregular) {
      return `${irregular[lower]} ${rest}`.trim();
    }

    let stem = verbIng.slice(0, -3);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      stem = stem.slice(0, -1);
    }
    if (!stem) return finalText0;
    return `${stem} ${rest}`.trim();
  })();

  const titleRaw = finalText.replace(/[.?!]+\s*$/, "").trim();
  const title = titleRaw ? titleRaw.charAt(0).toUpperCase() + titleRaw.slice(1) : "Chore";

  return {
    title: title.slice(0, 120) || "Chore",
    description: finalText,
  };
}
