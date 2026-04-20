export type AgentTable = "chores" | "helpers" | "home_profiles";

export type ToolName =
  | "db.select"
  | "db.insert"
  | "db.update"
  | "db.delete"
  | "query.rpc"
  // ui.* pseudo tools are dispatched client-side (never hit the edge
  // function). Used by intents that should open a UI surface rather than
  // run a DB operation (e.g., ui.open_elicitation from start_elicitation).
  | `ui.${string}`;

export type ToolTable =
  | "chores"
  | "helpers"
  | "alerts"
  | "automations"
  | "automation_suggestions"
  | "member_time_off"
  | "chore_helper_assignments"
  | "helper_feedback"
  | "helper_rewards"
  | "helper_reward_snapshots"
  | "home_profiles"
  | "households"
  | "household_members"
  | "profiles"
  | "agent_audit_log"
  | "support_audit_log";

export interface ToolCall {
  id: string;
  tool: ToolName;
  args: Record<string, unknown>;
  reason?: string;
}

export interface AgentCreateAction {
  type: "create";
  table: AgentTable;
  record: Record<string, unknown>;
  reason?: string;
}

export interface AutomationSuggestion {
  title: string;
  body?: string;
  suggested_automation: Record<string, unknown>;
  reason?: string;
}

function isToolCallsPayload(obj: unknown): obj is ToolCallsPayload {
  if (!obj || typeof obj !== "object") return false;
  const toolCalls = (obj as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) return false;
  return toolCalls.every((t) => {
    if (!t || typeof t !== "object") return false;
    const id = (t as { id?: unknown }).id;
    const tool = (t as { tool?: unknown }).tool;
    const args = (t as { args?: unknown }).args;
    if (typeof id !== "string" || !id.trim()) return false;
    if (
      tool !== "db.select" &&
      tool !== "db.insert" &&
      tool !== "db.update" &&
      tool !== "db.delete" &&
      tool !== "query.rpc" &&
      !(typeof tool === "string" && tool.startsWith("ui."))
    ) {
      return false;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    return true;
  });
}

function isAutomationSuggestionsPayload(obj: unknown): obj is AutomationSuggestionsPayload {
  if (!obj || typeof obj !== "object") return false;
  const raw =
    (obj as { automation_suggestions?: unknown }).automation_suggestions ??
    (obj as { automationSuggestions?: unknown }).automationSuggestions;
  if (!Array.isArray(raw)) return false;
  return raw.every((s) => {
    if (!s || typeof s !== "object") return false;
    const title = (s as { title?: unknown }).title;
    if (typeof title !== "string" || !title.trim()) return false;
    return true;
  });
}

export interface AgentActionsPayload {
  actions: AgentCreateAction[];
}

export interface ToolCallsPayload {
  tool_calls: ToolCall[];
}

export interface AutomationSuggestionsPayload {
  automation_suggestions: AutomationSuggestion[];
}

export type ClarificationPayload = {
  clarification: {
    kind: string;
    title?: string;
    required?: boolean;
    multi?: boolean;
    options?: string[];
  };
};

function isClarificationPayload(obj: unknown): obj is ClarificationPayload {
  if (!obj || typeof obj !== "object") return false;
  const c = (obj as any).clarification;
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  if (typeof (c as any).kind !== "string" || !(c as any).kind.trim()) return false;
  if ((c as any).options !== undefined) {
    if (!Array.isArray((c as any).options)) return false;
  }
  return true;
}

function tryParseJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```json\s*([\s\S]*?)\s*```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

function extractFencedCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  // Supports ```json, ```JSON, ``` (no language), or any other language.
  const re = /```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

function looksLikeJsonObject(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function extractEmbeddedJsonObject(text: string): string | null {
  const first = text.indexOf("{");
  if (first === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(first, i + 1).trim();
        return candidate || null;
      }
    }
  }
  return null;
}

function isAgentActionsPayload(obj: unknown): obj is AgentActionsPayload {
  if (!obj || typeof obj !== "object") return false;
  const actions = (obj as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return false;
  return actions.every((a) => {
    if (!a || typeof a !== "object") return false;
    const t = (a as { type?: unknown }).type;
    const table = (a as { table?: unknown }).table;
    const record = (a as { record?: unknown }).record;
    if (t !== "create") return false;
    if (table !== "chores" && table !== "helpers" && table !== "home_profiles") return false;
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    return true;
  });
}

export function parseAgentActionsFromAssistantText(text: string): AgentCreateAction[] {
  const blocks = [...extractJsonCodeBlocks(text), ...extractFencedCodeBlocks(text)];
  for (const block of blocks) {
    const parsed = tryParseJsonObject(block);
    if (isAgentActionsPayload(parsed)) return parsed.actions;
  }

  if (looksLikeJsonObject(text)) {
    const parsed = tryParseJsonObject(text);
    if (isAgentActionsPayload(parsed)) return parsed.actions;
  }

  const embedded = extractEmbeddedJsonObject(text);
  if (embedded) {
    const parsed = tryParseJsonObject(embedded);
    if (isAgentActionsPayload(parsed)) return parsed.actions;
  }
  return [];
}

export function parseClarificationFromAssistantText(text: string): ClarificationPayload["clarification"] | null {
  const blocks = [...extractJsonCodeBlocks(text), ...extractFencedCodeBlocks(text)];
  for (const block of blocks) {
    const parsed = tryParseJsonObject(block);
    if (isClarificationPayload(parsed)) return (parsed as ClarificationPayload).clarification;
  }

  if (looksLikeJsonObject(text)) {
    const parsed = tryParseJsonObject(text);
    if (isClarificationPayload(parsed)) return (parsed as ClarificationPayload).clarification;
  }

  const embedded = extractEmbeddedJsonObject(text);
  if (embedded) {
    const parsed = tryParseJsonObject(embedded);
    if (isClarificationPayload(parsed)) return (parsed as ClarificationPayload).clarification;
  }
  return null;
}

export function parseToolCallsFromAssistantText(text: string): ToolCall[] {
  const blocks = [...extractJsonCodeBlocks(text), ...extractFencedCodeBlocks(text)];
  for (const block of blocks) {
    const parsed = tryParseJsonObject(block);
    if (isToolCallsPayload(parsed)) return parsed.tool_calls;
  }

  if (looksLikeJsonObject(text)) {
    const parsed = tryParseJsonObject(text);
    if (isToolCallsPayload(parsed)) return parsed.tool_calls;
  }

  const embedded = extractEmbeddedJsonObject(text);
  if (embedded) {
    const parsed = tryParseJsonObject(embedded);
    if (isToolCallsPayload(parsed)) return parsed.tool_calls;
  }
  return [];
}

export function parseAutomationSuggestionsFromAssistantText(text: string): AutomationSuggestion[] {
  const blocks = [...extractJsonCodeBlocks(text), ...extractFencedCodeBlocks(text)];
  for (const block of blocks) {
    const parsed = tryParseJsonObject(block);
    if (isAutomationSuggestionsPayload(parsed)) {
      const raw =
        (parsed as { automation_suggestions?: AutomationSuggestion[] }).automation_suggestions ??
        (parsed as { automationSuggestions?: AutomationSuggestion[] }).automationSuggestions ??
        [];
      return raw.map((s) => {
        const suggested = (s as { suggested_automation?: unknown }).suggested_automation;
        const suggestedAutomation = suggested && typeof suggested === "object" && !Array.isArray(suggested) ? (suggested as Record<string, unknown>) : {};
        return { ...s, suggested_automation: suggestedAutomation };
      });
    }
  }

  if (looksLikeJsonObject(text)) {
    const parsed = tryParseJsonObject(text);
    if (isAutomationSuggestionsPayload(parsed)) {
      const raw =
        (parsed as { automation_suggestions?: AutomationSuggestion[] }).automation_suggestions ??
        (parsed as { automationSuggestions?: AutomationSuggestion[] }).automationSuggestions ??
        [];
      return raw.map((s) => {
        const suggested = (s as { suggested_automation?: unknown }).suggested_automation;
        const suggestedAutomation = suggested && typeof suggested === "object" && !Array.isArray(suggested) ? (suggested as Record<string, unknown>) : {};
        return { ...s, suggested_automation: suggestedAutomation };
      });
    }
  }

  const embedded = extractEmbeddedJsonObject(text);
  if (embedded) {
    const parsed = tryParseJsonObject(embedded);
    if (isAutomationSuggestionsPayload(parsed)) {
      const raw =
        (parsed as { automation_suggestions?: AutomationSuggestion[] }).automation_suggestions ??
        (parsed as { automationSuggestions?: AutomationSuggestion[] }).automationSuggestions ??
        [];
      return raw.map((s) => {
        const suggested = (s as { suggested_automation?: unknown }).suggested_automation;
        const suggestedAutomation = suggested && typeof suggested === "object" && !Array.isArray(suggested) ? (suggested as Record<string, unknown>) : {};
        return { ...s, suggested_automation: suggestedAutomation };
      });
    }
  }
  return [];
}

// ── Inline forms (agent-driven onboarding) ────────────────────

export type InlineFormType =
  | "home_type_picker"
  | "room_editor"
  | "feature_selector"
  | "household_details"
  | "chore_recommendations"
  | "helper_form";

export interface InlineFormPayload {
  inline_form: InlineFormType;
  context?: Record<string, unknown>;
}

function isInlineFormPayload(v: unknown): v is InlineFormPayload {
  return (
    typeof v === "object" && v !== null &&
    "inline_form" in v &&
    typeof (v as Record<string, unknown>).inline_form === "string"
  );
}

export function parseInlineFormFromAssistantText(text: string): InlineFormPayload | null {
  const blocks = [...extractJsonCodeBlocks(text), ...extractFencedCodeBlocks(text)];
  for (const block of blocks) {
    const parsed = tryParseJsonObject(block);
    if (isInlineFormPayload(parsed)) return parsed;
  }

  if (looksLikeJsonObject(text)) {
    const parsed = tryParseJsonObject(text);
    if (isInlineFormPayload(parsed)) return parsed;
  }

  const embedded = extractEmbeddedJsonObject(text);
  if (embedded) {
    const parsed = tryParseJsonObject(embedded);
    if (isInlineFormPayload(parsed)) return parsed;
  }
  return null;
}
