import type { AgentTable } from "./agentActions";

const baseUrl = () =>
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "http://127.0.0.1:54321";

export async function agentCreate(params: {
  accessToken: string;
  table: AgentTable;
  record: Record<string, unknown>;
  reason?: string;
}): Promise<{ ok: true; created: unknown } | { ok: false; error: string; status?: number }> {
  const { accessToken, table, record, reason } = params;

  try {
    const res = await fetch(`${baseUrl()}/functions/v1/server/agent/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ table, record, reason }),
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

    if (json && typeof json === "object" && (json as { ok?: unknown }).ok === true) {
      return { ok: true, created: (json as { created?: unknown }).created };
    }

    return { ok: false, error: "Unexpected response from server" };
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
    const res = await fetch(`${baseUrl()}/functions/v1/server/tools/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, scope, tool_call: toolCall }),
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

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
    return { ok: true, conversationId, summary, messages };
  } catch (e) {
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
    const res = await fetch(`${baseUrl()}/functions/v1/server/chat/append`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ household_id: householdId, scope, messages, summary }),
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

    const conversationId =
      json && typeof json === "object" && typeof (json as { conversation_id?: unknown }).conversation_id === "string"
        ? String((json as { conversation_id?: unknown }).conversation_id)
        : "";
    if (!conversationId) return { ok: false, error: "Missing conversation_id from server" };
    return { ok: true, conversationId };
  } catch (e) {
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
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
    const res = await fetch(`${baseUrl()}/functions/v1/server/settings/youtube`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
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
