export type AgentTable = "chores" | "helpers" | "home_profiles";

export type ToolName = "db.select" | "db.insert" | "db.update" | "db.delete";

export type ToolTable =
  | "chores"
  | "helpers"
  | "alerts"
  | "member_time_off"
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
    if (tool !== "db.select" && tool !== "db.insert" && tool !== "db.update" && tool !== "db.delete") return false;
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    return true;
  });
}

export interface AgentActionsPayload {
  actions: AgentCreateAction[];
}

export interface ToolCallsPayload {
  tool_calls: ToolCall[];
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
  const blocks = extractJsonCodeBlocks(text);
  for (const block of blocks) {
    const parsed = tryParseJsonObject(block);
    if (isAgentActionsPayload(parsed)) return parsed.actions;
  }
  return [];
}

export function parseToolCallsFromAssistantText(text: string): ToolCall[] {
  const blocks = extractJsonCodeBlocks(text);
  for (const block of blocks) {
    const parsed = tryParseJsonObject(block);
    if (isToolCallsPayload(parsed)) return parsed.tool_calls;
  }
  return [];
}
