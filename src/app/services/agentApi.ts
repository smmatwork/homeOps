import type { AgentTable } from "./agentActions";

const baseUrl = () =>
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "http://127.0.0.1:54321";

const anonKey = () => {
  const k = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return typeof k === "string" ? k.trim() : "";
};

const makeRequestId = (): string => {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const getClientConversationId = (): string => {
  try {
    const k = "homeops.chat.client_conversation_id";
    const v = sessionStorage.getItem(k);
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
};

const setClientConversationId = (conversationId: string): void => {
  const cid = String(conversationId || "").trim();
  if (!cid) return;
  try {
    sessionStorage.setItem("homeops.chat.client_conversation_id", cid);
  } catch {
    // ignore
  }
};

const correlationHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { "x-request-id": makeRequestId() };
  const cid = getClientConversationId();
  if (cid) headers["x-conversation-id"] = cid;
  return headers;
};

const applyIndianChoreLocalization = (text: unknown): unknown => {
  if (typeof text !== "string") return text;
  const s = text;
  const rules: Array<[RegExp, string]> = [
    [/\bvacuuming\b/gi, "sweeping and mopping"],
    [/\bvacuumed\b/gi, "swept and mopped"],
    [/\bvacuum\b/gi, "sweep and mop"],
  ];
  return rules.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
};

const normalizeChorePriority = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return Math.min(3, Math.max(1, rounded));
  }

  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return undefined;
    if (v === "low") return 1;
    if (v === "medium") return 2;
    if (v === "high") return 3;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.min(3, Math.max(1, Math.round(n)));
  }

  return undefined;
};

export const localizeChoreRecordIndianContext = (record: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...record };
  next.title = applyIndianChoreLocalization(next.title);
  next.description = applyIndianChoreLocalization(next.description);
  const normPriority = normalizeChorePriority(next.priority);
  if (typeof normPriority === "number") next.priority = normPriority;
  return next;
};

export async function agentCreate(params: {
  accessToken: string;
  table: AgentTable;
  record: Record<string, unknown>;
  reason?: string;
}): Promise<{ ok: true; created: unknown } | { ok: false; error: string; status?: number }> {
  const { accessToken, table, record, reason } = params;

  const nextRecord = table === "chores" ? localizeChoreRecordIndianContext(record) : record;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const anon = anonKey();
    const res = await fetch(`${baseUrl()}/functions/v1/server/agent/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
        ...correlationHeaders(),
      },
      body: JSON.stringify({ table, record: nextRecord, reason }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    if (json && typeof json === "object" && (json as { ok?: unknown }).ok === true) {
      return { ok: true, created: (json as { created?: unknown }).created };
    }

    return { ok: false, error: "Unexpected response from server" };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function semanticReindex(params: {
  accessToken: string;
  householdId: string;
  entityTypes?: string[];
}): Promise<
  | { ok: true; indexed: number; batches: number }
  | { ok: false; error: string; status?: number }
> {
  const { accessToken, householdId, entityTypes } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(`${baseUrl()}/functions/v1/server/semantic/reindex`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, entity_types: entityTypes }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    if (json && typeof json === "object" && (json as any).ok === true) {
      const indexed = typeof (json as any).indexed === "number" ? (json as any).indexed : 0;
      const batches = typeof (json as any).batches === "number" ? (json as any).batches : 0;
      return { ok: true, indexed, batches };
    }
    return { ok: false, error: "Unexpected response from server" };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (60s). Are Supabase + agent-service running?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export type SemanticMatch = {
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  similarity: number;
};

export async function semanticSearch(params: {
  accessToken: string;
  householdId: string;
  query: string;
  entityTypes?: string[];
  matchCount?: number;
  minSimilarity?: number;
}): Promise<
  | { ok: true; matches: SemanticMatch[] }
  | { ok: false; error: string; status?: number }
> {
  const { accessToken, householdId, query, entityTypes, matchCount, minSimilarity } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(`${baseUrl()}/functions/v1/server/semantic/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        household_id: householdId,
        query,
        entity_types: entityTypes,
        match_count: matchCount,
        min_similarity: minSimilarity,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    if (json && typeof json === "object" && (json as any).ok === true) {
      const matches = Array.isArray((json as any).matches) ? ((json as any).matches as any[]) : [];
      return { ok: true, matches: matches as SemanticMatch[] };
    }
    return { ok: false, error: "Unexpected response from server" };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (30s)." };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function rateRecipe(params: {
  accessToken: string;
  householdId: string;
  recipeId?: string;
  sourceUrl?: string;
  rating: number;
  notes?: string;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, recipeId, sourceUrl, rating, notes } = params;
  try {
    const anon = anonKey();
    const res = await fetch(`${baseUrl()}/functions/v1/server/recipes/rate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        household_id: householdId,
        recipe_id: recipeId,
        source_url: sourceUrl,
        rating,
        notes: typeof notes === "string" ? notes : undefined,
      }),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export type ChatScope = "user" | "household";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatStateMessage {
  id: number;
  role: ChatRole;
  content: string;
  created_at: string;
}

export async function executeToolCall(params: {
  accessToken: string;
  householdId: string;
  scope: ChatScope;
  toolCall: { id: string; tool: string; args: Record<string, unknown>; reason?: string };
}): Promise<
  | { ok: true; summary: string; toolCallId: string }
  | { ok: false; error: string; status?: number }
> {
  const { accessToken, householdId, scope, toolCall } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${baseUrl()}/functions/v1/server/tools/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
        ...correlationHeaders(),
      },
      body: JSON.stringify({ household_id: householdId, scope, tool_call: toolCall }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const summary =
      json && typeof json === "object" && typeof (json as { summary?: unknown }).summary === "string"
        ? String((json as { summary?: unknown }).summary)
        : "";
    const toolCallId =
      json && typeof json === "object" && typeof (json as { tool_call_id?: unknown }).tool_call_id === "string"
        ? String((json as { tool_call_id?: unknown }).tool_call_id)
        : toolCall.id;
    return { ok: true, summary: summary || "(no summary)", toolCallId };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function getChatState(params: {
  accessToken: string;
  householdId: string;
  scope: ChatScope;
  limit?: number;
}): Promise<
  | { ok: true; conversationId: string; summary: string; messages: ChatStateMessage[] }
  | { ok: false; error: string; status?: number }
> {
  const { accessToken, householdId, scope, limit } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/chat/state`);
    url.searchParams.set("household_id", householdId);
    url.searchParams.set("scope", scope);
    if (typeof limit === "number") url.searchParams.set("limit", String(limit));

    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const conversationId =
      json && typeof json === "object" && typeof (json as { conversation_id?: unknown }).conversation_id === "string"
        ? String((json as { conversation_id?: unknown }).conversation_id)
        : "";
    const summary =
      json && typeof json === "object" && typeof (json as { summary?: unknown }).summary === "string"
        ? String((json as { summary?: unknown }).summary)
        : "";
    const messages =
      json && typeof json === "object" && Array.isArray((json as { messages?: unknown }).messages)
        ? ((json as { messages: any[] }).messages as ChatStateMessage[])
        : [];

    if (!conversationId) return { ok: false, error: "Missing conversation_id from server" };
    setClientConversationId(conversationId);
    return { ok: true, conversationId, summary, messages };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function appendChatMessages(params: {
  accessToken: string;
  householdId: string;
  scope: ChatScope;
  messages: Array<{ role: ChatRole; content: string }>;
  summary?: string;
}): Promise<{ ok: true; conversationId: string } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, scope, messages, summary } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${baseUrl()}/functions/v1/server/chat/append`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
        ...correlationHeaders(),
      },
      body: JSON.stringify({ household_id: householdId, scope, messages, summary }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const conversationId =
      json && typeof json === "object" && typeof (json as { conversation_id?: unknown }).conversation_id === "string"
        ? String((json as { conversation_id?: unknown }).conversation_id)
        : "";
    if (!conversationId) return { ok: false, error: "Missing conversation_id from server" };
    setClientConversationId(conversationId);
    return { ok: true, conversationId };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function clearChatState(params: {
  accessToken: string;
  householdId: string;
  scope: ChatScope;
}): Promise<{ ok: true; conversationId: string } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, scope } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${baseUrl()}/functions/v1/server/chat/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
        ...correlationHeaders(),
      },
      body: JSON.stringify({ household_id: householdId, scope }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const conversationId =
      json && typeof json === "object" && typeof (json as { conversation_id?: unknown }).conversation_id === "string"
        ? String((json as { conversation_id?: unknown }).conversation_id)
        : "";
    if (!conversationId) return { ok: false, error: "Missing conversation_id from server" };
    return { ok: true, conversationId };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export type AutomationStatus = "active" | "paused" | "disabled";
export type AutomationCadence = "daily" | "weekly" | "monthly" | "weekdays" | "hourly" | "every_2_hours" | "every_5_minutes";

export type AutomationRow = {
  id: string;
  household_id: string;
  title: string;
  description: string | null;
  status: AutomationStatus;
  cadence: AutomationCadence;
  timezone: string | null;
  at_time: string | null;
  day_of_week: number | null;
  day_of_month: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentRegistryRow = {
  id: string;
  household_id: string;
  key: string;
  display_name: string;
  enabled: boolean;
  model: string | null;
  system_prompt: string;
  tool_allowlist: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function getAgentRegistry(params: {
  accessToken: string;
  householdId: string;
}): Promise<{ ok: true; agents: AgentRegistryRow[] } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/settings/agents`);
    url.searchParams.set("household_id", householdId);

    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const agents =
      json && typeof json === "object" && Array.isArray((json as { agents?: unknown }).agents)
        ? ((json as { agents: any[] }).agents as AgentRegistryRow[])
        : [];
    return { ok: true, agents };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function updateAgentRegistryAgent(params: {
  accessToken: string;
  householdId: string;
  key: string;
  patch: Partial<Pick<AgentRegistryRow, "display_name" | "enabled" | "model" | "system_prompt" | "tool_allowlist">>;
}): Promise<{ ok: true; agent: AgentRegistryRow } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, key, patch } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${baseUrl()}/functions/v1/server/settings/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, key, patch }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const agent =
      json && typeof json === "object" && (json as { agent?: unknown }).agent && typeof (json as any).agent === "object"
        ? ((json as any).agent as AgentRegistryRow)
        : null;
    if (!agent) return { ok: false, error: "Unexpected response from server" };
    return { ok: true, agent };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function listAutomations(params: {
  accessToken: string;
  householdId: string;
}): Promise<{ ok: true; automations: AutomationRow[] } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/automations`);
    url.searchParams.set("household_id", householdId);

    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const automations =
      json && typeof json === "object" && Array.isArray((json as { automations?: unknown }).automations)
        ? ((json as { automations: any[] }).automations as AutomationRow[])
        : [];
    return { ok: true, automations };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function updateAutomation(params: {
  accessToken: string;
  householdId: string;
  id: string;
  patch: Partial<Pick<AutomationRow, "title" | "description" | "status" | "cadence" | "timezone" | "at_time" | "day_of_week" | "day_of_month">>;
}): Promise<{ ok: true; automation: AutomationRow } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, id, patch } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${baseUrl()}/functions/v1/server/automations/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, id, patch }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const automation =
      json && typeof json === "object" && (json as { automation?: unknown }).automation && typeof (json as any).automation === "object"
        ? ((json as any).automation as AutomationRow)
        : null;
    if (!automation) return { ok: false, error: "Unexpected response from server" };
    return { ok: true, automation };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function disableAutomation(params: {
  accessToken: string;
  householdId: string;
  id: string;
}): Promise<{ ok: true; automation: AutomationRow } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, id } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${baseUrl()}/functions/v1/server/automations/disable`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, id }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const automation =
      json && typeof json === "object" && (json as { automation?: unknown }).automation && typeof (json as any).automation === "object"
        ? ((json as any).automation as AutomationRow)
        : null;
    if (!automation) return { ok: false, error: "Unexpected response from server" };
    return { ok: true, automation };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function runAutomationNow(params: {
  accessToken: string;
  householdId: string;
  id: string;
}): Promise<{ ok: true; automation: AutomationRow } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, id } = params;
  try {
    const anon = anonKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${baseUrl()}/functions/v1/server/automations/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, id }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const automation =
      json && typeof json === "object" && (json as { automation?: unknown }).automation && typeof (json as any).automation === "object"
        ? ((json as any).automation as AutomationRow)
        : null;
    if (!automation) return { ok: false, error: "Unexpected response from server" };
    return { ok: true, automation };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out contacting the server (15s). Is Supabase running locally?" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function agentListHelpers(params: {
  accessToken: string;
  householdId: string;
}): Promise<
  | { ok: true; helpers: Array<{ id: string; name: string; type: string | null; phone: string | null }> }
  | { ok: false; error: string; status?: number }
> {
  const { accessToken, householdId } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/agent/helpers`);
    url.searchParams.set("household_id", householdId);
    const anon = anonKey();
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const helpers =
      json && typeof json === "object" && Array.isArray((json as { helpers?: unknown }).helpers)
        ? ((json as { helpers: any[] }).helpers as Array<{ id: string; name: string; type: string | null; phone: string | null }> )
        : [];
    return { ok: true, helpers };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function getYoutubeSettings(params: {
  accessToken: string;
  householdId: string;
}): Promise<{ ok: true; settings: unknown } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/settings/youtube`);
    url.searchParams.set("household_id", householdId);
    const anon = anonKey();
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const settings =
      json && typeof json === "object" ? (json as { settings?: unknown }).settings : null;
    return { ok: true, settings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function setYoutubeSettings(params: {
  accessToken: string;
  householdId: string;
  settings: unknown;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, settings } = params;
  try {
    const anon = anonKey();
    const res = await fetch(`${baseUrl()}/functions/v1/server/settings/youtube`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, settings }),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export type HouseholdSettings = {
  name: string | null;
  address: string | null;
  timezone: string | null;
  language: string | null;
  notifications_enabled?: boolean;
  email_digest?: boolean;
  two_factor_auth?: boolean;
  auto_assign_chores?: boolean;
};

export async function getHouseholdSettings(params: {
  accessToken: string;
  householdId: string;
}): Promise<{ ok: true; settings: HouseholdSettings | null } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/settings/household`);
    url.searchParams.set("household_id", householdId);
    const anon = anonKey();
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const raw = json && typeof json === "object" ? (json as { settings?: unknown }).settings : null;
    if (!raw || typeof raw !== "object") return { ok: true, settings: null };
    const s = raw as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name : null;
    const address = typeof s.address === "string" ? s.address : null;
    const timezone = typeof s.timezone === "string" ? s.timezone : null;
    const language = typeof s.language === "string" ? s.language : null;
    const notifications_enabled = typeof s.notifications_enabled === "boolean" ? s.notifications_enabled : undefined;
    const email_digest = typeof s.email_digest === "boolean" ? s.email_digest : undefined;
    const two_factor_auth = typeof s.two_factor_auth === "boolean" ? s.two_factor_auth : undefined;
    const auto_assign_chores = typeof s.auto_assign_chores === "boolean" ? s.auto_assign_chores : undefined;
    return {
      ok: true,
      settings: { name, address, timezone, language, notifications_enabled, email_digest, two_factor_auth, auto_assign_chores },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function setHouseholdSettings(params: {
  accessToken: string;
  householdId: string;
  settings: HouseholdSettings;
}): Promise<{ ok: true; settings: HouseholdSettings } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, settings } = params;
  try {
    const anon = anonKey();
    const res = await fetch(`${baseUrl()}/functions/v1/server/settings/household`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, settings }),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const raw = json && typeof json === "object" ? (json as { settings?: unknown }).settings : null;
    if (!raw || typeof raw !== "object") return { ok: false, error: "Unexpected response from server" };
    const s = raw as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name : null;
    const address = typeof s.address === "string" ? s.address : null;
    const timezone = typeof s.timezone === "string" ? s.timezone : null;
    const language = typeof s.language === "string" ? s.language : null;
    const notifications_enabled = typeof s.notifications_enabled === "boolean" ? s.notifications_enabled : undefined;
    const email_digest = typeof s.email_digest === "boolean" ? s.email_digest : undefined;
    const two_factor_auth = typeof s.two_factor_auth === "boolean" ? s.two_factor_auth : undefined;
    const auto_assign_chores = typeof s.auto_assign_chores === "boolean" ? s.auto_assign_chores : undefined;
    return {
      ok: true,
      settings: { name, address, timezone, language, notifications_enabled, email_digest, two_factor_auth, auto_assign_chores },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export type HouseholdMemberRow = {
  user_id: string;
  role: string;
  created_at: string;
  full_name: string | null;
  avatar_url: string | null;
};

export async function listHouseholdMembers(params: {
  accessToken: string;
  householdId: string;
}): Promise<{ ok: true; members: HouseholdMemberRow[] } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/household/members`);
    url.searchParams.set("household_id", householdId);
    const anon = anonKey();
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const members =
      json && typeof json === "object" && Array.isArray((json as { members?: unknown }).members)
        ? ((json as { members: any[] }).members as HouseholdMemberRow[])
        : [];
    return { ok: true, members };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export type HouseholdInviteRow = {
  id: string;
  invited_email: string;
  role: string;
  token: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

export async function listHouseholdInvites(params: {
  accessToken: string;
  householdId: string;
}): Promise<{ ok: true; invites: HouseholdInviteRow[] } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/household/invites`);
    url.searchParams.set("household_id", householdId);
    const anon = anonKey();
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const invites =
      json && typeof json === "object" && Array.isArray((json as { invites?: unknown }).invites)
        ? ((json as { invites: any[] }).invites as HouseholdInviteRow[])
        : [];
    return { ok: true, invites };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function createHouseholdInvite(params: {
  accessToken: string;
  householdId: string;
  invitedEmail: string;
  role: "member" | "admin" | "owner";
}): Promise<{ ok: true; invite: HouseholdInviteRow } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, invitedEmail, role } = params;
  try {
    const anon = anonKey();
    const res = await fetch(`${baseUrl()}/functions/v1/server/household/invites/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, invited_email: invitedEmail, role }),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const invite =
      json && typeof json === "object" && (json as { invite?: unknown }).invite && typeof (json as any).invite === "object"
        ? ((json as any).invite as HouseholdInviteRow)
        : null;
    if (!invite) return { ok: false, error: "Unexpected response from server" };
    return { ok: true, invite };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function revokeHouseholdInvite(params: {
  accessToken: string;
  householdId: string;
  inviteId: string;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, inviteId } = params;
  try {
    const anon = anonKey();
    const res = await fetch(`${baseUrl()}/functions/v1/server/household/invites/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, invite_id: inviteId }),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function acceptHouseholdInvite(params: {
  accessToken: string;
  token: string;
}): Promise<{ ok: true; householdId: string } | { ok: false; error: string; status?: number }> {
  const { accessToken, token } = params;
  try {
    const anon = anonKey();
    const res = await fetch(`${baseUrl()}/functions/v1/server/household/invites/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ token }),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const householdId =
      json && typeof json === "object" && typeof (json as { household_id?: unknown }).household_id === "string"
        ? String((json as { household_id: string }).household_id)
        : "";
    if (!householdId) return { ok: false, error: "Unexpected response from server" };
    return { ok: true, householdId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export type RecipeSettings = {
  allowed_sources: string[];
  thresholds: {
    min_rating: number;
    min_reviews: number;
    lenient_missing_reviews: boolean;
  };
};

export type ExternalRecipeSearchResult = {
  source: string;
  url: string;
  title: string;
  image_url?: string | null;
  external_rating_value: number | null;
  external_rating_count: number | null;
  highly_rated: boolean;
  recipe_id?: string | null;
  internal_avg_rating?: number | null;
  internal_rating_count?: number;
  combined_score?: number;
};

export async function searchRecipes(params: {
  accessToken: string;
  householdId: string;
  query: string;
}): Promise<
  | { ok: true; query: string; settings_used: RecipeSettings; results: ExternalRecipeSearchResult[] }
  | { ok: false; error: string; status?: number }
> {
  const { accessToken, householdId, query } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/recipes/search`);
    url.searchParams.set("household_id", householdId);
    url.searchParams.set("q", query);
    const anon = anonKey();
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const parsed = json && typeof json === "object" ? (json as any) : null;
    return {
      ok: true,
      query: typeof parsed?.query === "string" ? parsed.query : query,
      settings_used: (parsed?.settings_used as RecipeSettings) ?? {
        allowed_sources: [],
        thresholds: { min_rating: 4, min_reviews: 200, lenient_missing_reviews: true },
      },
      results: Array.isArray(parsed?.results) ? (parsed.results as ExternalRecipeSearchResult[]) : [],
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function getRecipeSettings(params: {
  accessToken: string;
  householdId: string;
}): Promise<{ ok: true; settings: RecipeSettings | null } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId } = params;
  try {
    const url = new URL(`${baseUrl()}/functions/v1/server/settings/recipes`);
    url.searchParams.set("household_id", householdId);
    const anon = anonKey();
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    const settings =
      json && typeof json === "object" ? ((json as { settings?: unknown }).settings as RecipeSettings | null) : null;
    return { ok: true, settings: settings ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}

export async function setRecipeSettings(params: {
  accessToken: string;
  householdId: string;
  settings: RecipeSettings;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const { accessToken, householdId, settings } = params;
  try {
    const anon = anonKey();
    const res = await fetch(`${baseUrl()}/functions/v1/server/settings/recipes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "x-user-authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, settings }),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || res.statusText;
      return { ok: false, error: msg, status: res.status };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown network error" };
  }
}
