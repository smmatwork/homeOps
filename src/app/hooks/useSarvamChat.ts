import { useEffect, useState, useCallback, useRef } from "react";
import { streamChat, HOMEOPS_SYSTEM_PROMPT, type ChatMessage } from "../services/sarvamApi";
import { appendChatMessages, clearChatState, getChatState, type ChatScope, type ChatRole } from "../services/agentApi";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../services/supabaseClient";

export interface ChatEntry {
  id: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  streaming?: boolean;
}

function isChatUiRole(role: ChatRole): role is "user" | "assistant" {
  return role === "user" || role === "assistant";
}

const getTime = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const INITIAL_MESSAGES: ChatEntry[] = [
  {
    id: 1,
    role: "assistant",
    content:
      "Hi! I can help you set up your home and then manage chores, helpers, reminders, and recipes.\n\nA good first step is to set up your Home Profile (type/BHK/spaces). After that, I can suggest and schedule chores room-by-room.\n\nWhat would you like to do — set up / review your home profile, or jump straight to chores?",
    timestamp: "10:30 AM",
  },
];

function sanitizeForSarvam(messages: ChatMessage[]): ChatMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ ...m, content: m.content.trim() }))
    .filter((m) => m.content);

  const uiLang = (() => {
    try {
      const raw = localStorage.getItem("homeops.ui.lang") ?? "en";
      return raw === "hi" || raw === "kn" ? raw : "en";
    } catch {
      return "en";
    }
  })();

  const out: ChatMessage[] = [];
  let started = false;
  let expected: "user" | "assistant" = "user";

  for (const m of nonSystem) {
    if (!started) {
      if (m.role !== "user") continue;
      started = true;
    }

    if (m.role !== expected) {
      const last = out[out.length - 1];
      if (last && last.role === m.role) {
        last.content = `${last.content}\n\n${m.content}`;
      }
      continue;
    }

    out.push({ role: m.role, content: m.content });
    expected = expected === "user" ? "assistant" : "user";
  }

  const uiLangInstruction: ChatMessage = {
    role: "system",
    content: `UI language: ${uiLang}. Respond in this language for all user-facing text (including labels/names you generate), unless the user explicitly asks for a different language.`,
  };

  const mergedSystemContent = [...system, uiLangInstruction]
    .map((m) => (typeof m.content === "string" ? m.content.trim() : ""))
    .filter(Boolean)
    .join("\n\n");

  // Sarvam requires the system message to appear only once, at the beginning.
  return [{ role: "system", content: mergedSystemContent }, ...out];
}

export function useSarvamChat() {
  const { accessToken: authedAccessToken, householdId: authedHouseholdId } = useAuth();
  const [messages, setMessages] = useState<ChatEntry[]>(INITIAL_MESSAGES);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string>("");

  const [memoryReady, setMemoryReady] = useState(false);

  const [memoryScope, setMemoryScope] = useState<ChatScope>(() => {
    try {
      const raw = localStorage.getItem("homeops.chat.scope") ?? "user";
      return raw === "household" ? "household" : "user";
    } catch {
      return "user";
    }
  });

  // Keep a ref to the full conversation for the API (includes system prompt)
  const historyRef = useRef<ChatMessage[]>([
    { role: "system", content: HOMEOPS_SYSTEM_PROMPT },
  ]);

  const memorySummaryRef = useRef<string>("");
  const memoryScopeRef = useRef<ChatScope>(memoryScope);
  const conversationIdRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const messageIdRef = useRef(0);

  const instanceIdRef = useRef<string>("");
  if (!instanceIdRef.current) instanceIdRef.current = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

  const chatSyncChannelName = "homeops:chat-sync";
  const chatSyncChannelRef = useRef<BroadcastChannel | null>(null);
  const chatSyncStorageKey = "homeops.chat.last_sync";

  const broadcastChatSync = useCallback(() => {
    try {
      window.dispatchEvent(new CustomEvent("homeops:chat-sync", { detail: { ts: Date.now() } }));
    } catch {
      // ignore
    }

    try {
      chatSyncChannelRef.current?.postMessage({ source: instanceIdRef.current, ts: Date.now() });
    } catch {
      // ignore
    }

    try {
      localStorage.setItem(chatSyncStorageKey, JSON.stringify({ source: instanceIdRef.current, ts: Date.now() }));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      chatSyncChannelRef.current = new BroadcastChannel(chatSyncChannelName);
      return () => {
        try {
          chatSyncChannelRef.current?.close();
        } catch {
          // ignore
        }
        chatSyncChannelRef.current = null;
      };
    } catch {
      // ignore
      return;
    }
  }, []);

  const nextMessageId = useCallback(() => {
    // Date.now() alone can collide when multiple messages are appended in the same millisecond
    // (e.g., approving a tool call while other state updates are occurring).
    messageIdRef.current += 1;
    return Date.now() * 1000 + (messageIdRef.current % 1000);
  }, []);

  const MAX_CONTEXT_MESSAGES = 24;
  const SUMMARIZE_TRIGGER_MESSAGES = 48;

  useEffect(() => {
    memoryScopeRef.current = memoryScope;
    try {
      localStorage.setItem("homeops.chat.scope", memoryScope);
    } catch {
      // ignore
    }
  }, [memoryScope]);

  // Keep scope synced across multiple chat instances.
  useEffect(() => {
    const handler = (ev: StorageEvent) => {
      if (ev.key !== "homeops.chat.scope") return;
      const raw = (ev.newValue ?? "").trim();
      const next: ChatScope = raw === "household" ? "household" : "user";
      setMemoryScope((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const getAgentSetup = () => {
    const token = authedAccessToken.trim();
    const householdId = authedHouseholdId.trim();

    if (token && householdId) return { accessToken: token, householdId };

    try {
      const fallbackToken = token || (localStorage.getItem("homeops.agent.access_token") ?? "").trim();
      const fallbackHouseholdId = householdId || (localStorage.getItem("homeops.agent.household_id") ?? "").trim();
      return { accessToken: fallbackToken, householdId: fallbackHouseholdId };
    } catch {
      return { accessToken: token, householdId };
    }
  };

  const appendAssistantMessage = useCallback((content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (import.meta.env.DEV) console.debug("[useSarvamChat] appendAssistantMessage", { len: trimmed.length });
    const entry: ChatEntry = {
      id: nextMessageId(),
      role: "assistant",
      content: trimmed,
      timestamp: getTime(),
      streaming: false,
    };
    setMessages((prev) => [...prev, entry]);
    historyRef.current = [...historyRef.current, { role: "assistant", content: trimmed }];
    void appendToMemory([{ role: "assistant", content: trimmed }]);
  }, [nextMessageId, broadcastChatSync]);

  const appendUserMessage = useCallback((content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    setError(null);
    if (import.meta.env.DEV) console.debug("[useSarvamChat] appendUserMessage", { len: trimmed.length });

    const userEntry: ChatEntry = {
      id: nextMessageId(),
      role: "user",
      content: trimmed,
      timestamp: getTime(),
    };
    setMessages((prev) => [...prev, userEntry]);

    historyRef.current = sanitizeForSarvam([...historyRef.current, { role: "user", content: trimmed }]);
    void appendToMemory([{ role: "user", content: trimmed }]);
  }, [nextMessageId, broadcastChatSync]);

  const appendToMemory = async (items: Array<{ role: ChatRole; content: string }>) => {
    try {
      if (import.meta.env.DEV) console.debug("[useSarvamChat] appendToMemory", { n: items.length, scope: memoryScopeRef.current });

      let { accessToken, householdId } = getAgentSetup();
      if (!accessToken || !householdId) {
        // Try to hydrate from the current Supabase session (covers cases where useAuth is stale)
        // and from localStorage (covers Agent Setup fallback).
        try {
          const { data } = await supabase.auth.getSession();
          const sessionToken = data.session?.access_token ? String(data.session.access_token).trim() : "";
          if (!accessToken && sessionToken) accessToken = sessionToken;
        } catch {
          // ignore
        }

        if (!accessToken) {
          try {
            const refresh = await supabase.auth.refreshSession();
            const nextToken = refresh.data.session?.access_token ? String(refresh.data.session.access_token).trim() : "";
            if (nextToken) accessToken = nextToken;
          } catch {
            // ignore
          }
        }

        if (!householdId) {
          try {
            householdId = (localStorage.getItem("homeops.agent.household_id") ?? "").trim() || householdId;
          } catch {
            // ignore
          }
        }

        if (!accessToken || !householdId) {
          if (import.meta.env.DEV) console.debug("[useSarvamChat] appendToMemory skipped (missing token/household)", { accessToken: !!accessToken, householdId: !!householdId });
          setError(
            "Chat history isn't saving because access token or household id is missing. Open Agent Setup and confirm you're logged in + linked to a home.",
          );
          return;
        }
      }

      const res = await appendChatMessages({
        accessToken,
        householdId,
        scope: memoryScopeRef.current,
        messages: items,
        summary: memorySummaryRef.current,
      });

      if (res.ok === false) {
        const msg = `Chat history couldn't be saved. (${res.error}${typeof res.status === "number" ? `, status=${res.status}` : ""})`;
        console.error("appendChatMessages failed", res);
        setError(msg);
        return;
      }

      // Broadcast only after the server memory is updated so other chat instances
      // don't reload before the new messages are actually persisted.
      broadcastChatSync();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error saving chat history";
      console.error("appendToMemory crashed", e);
      setError(`Chat history couldn't be saved. (${msg})`);
    }
  };

  const loadMemory = useCallback(async (scope: ChatScope) => {
    setMemoryReady(false);
    setError(null);
    let { accessToken, householdId } = getAgentSetup();
    if (!accessToken || !householdId) {
      // Try to hydrate from the Supabase session and localStorage before giving up.
      try {
        const { data } = await supabase.auth.getSession();
        const sessionToken = data.session?.access_token ? String(data.session.access_token).trim() : "";
        if (!accessToken && sessionToken) accessToken = sessionToken;
      } catch {
        // ignore
      }

      if (!accessToken) {
        try {
          const refresh = await supabase.auth.refreshSession();
          const nextToken = refresh.data.session?.access_token ? String(refresh.data.session.access_token).trim() : "";
          if (nextToken) accessToken = nextToken;
        } catch {
          // ignore
        }
      }

      if (!householdId) {
        try {
          householdId = (localStorage.getItem("homeops.agent.household_id") ?? "").trim() || householdId;
        } catch {
          // ignore
        }
      }

      if (!accessToken || !householdId) {
        historyRef.current = [{ role: "system", content: HOMEOPS_SYSTEM_PROMPT }];
        setMessages((prev) => (prev.length > 0 ? prev : INITIAL_MESSAGES));
        if (!accessToken) {
          setError("Chat history isn't loading because you're not logged in (missing access token). Please log in again.");
        } else {
          setError(
            "Chat history isn't loading because your account isn't linked to a home yet (missing household id). Open Agent Setup and click 'Set up my home' / 'Refresh my home link'.",
          );
        }
        setMemoryReady(true);
        return;
      }
    }

    // Proactively refresh session if Supabase thinks it needs it.
    try {
      const { data } = await supabase.auth.getSession();
      const sessionToken = data.session?.access_token ? String(data.session.access_token).trim() : "";
      if (sessionToken) accessToken = sessionToken;
    } catch {
      // ignore
    }

    let res = await getChatState({
      accessToken,
      householdId,
      scope,
      limit: 50,
    });

    // If user JWT expired, refresh once and retry.
    if (res.ok === false) {
      const errRes = res as { ok: false; error: string; status?: number };
      if (errRes.status === 401) {
        try {
          const refresh = await supabase.auth.refreshSession();
          const nextToken = refresh.data.session?.access_token ? String(refresh.data.session.access_token).trim() : "";
          if (nextToken) {
            accessToken = nextToken;
            res = await getChatState({
              accessToken,
              householdId,
              scope,
              limit: 50,
            });
          }
        } catch {
          // ignore
        }
      }
    }

    if (res.ok === false) {
      const errRes = res as { ok: false; error: string; status?: number };
      const base = "Chat history couldn't be loaded.";
      const hint =
        typeof errRes.status === "number" && errRes.status === 401
          ? " Your login may have expired — please log out and log in again."
          : typeof errRes.status === "number" && errRes.status === 404
            ? " The server endpoint wasn't found — ensure Supabase Edge Functions are running locally."
            : "";
      setError(`${base}${hint}${errRes.error ? ` (${errRes.error})` : ""}`);
      setMessages((prev) => (prev.length > 0 ? prev : INITIAL_MESSAGES));
      setMemoryReady(true);
      return;
    }

    conversationIdRef.current = res.conversationId;
    setConversationId(res.conversationId);
    memorySummaryRef.current = res.summary || "";

    const loadedEntries: ChatEntry[] = res.messages
      .filter((m): m is typeof m & { role: "user" | "assistant" } => isChatUiRole(m.role))
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: getTime(),
        streaming: false,
      }));

    // Update messages from server when history has advanced.
    // Never clobber local UI with a shorter server history — that can happen
    // briefly right after the user sends a message (race with persistence).
    setMessages((prev) => {
      if (loadedEntries.length === 0) return prev.length > 0 ? prev : INITIAL_MESSAGES;
      if (loadedEntries.length >= prev.length) return loadedEntries;
      return prev;
    });

    const memoryBlock = memorySummaryRef.current.trim()
      ? `Long-term memory summary (authoritative):\n${memorySummaryRef.current.trim()}`
      : "";

    const ctx: ChatMessage[] = [{ role: "system", content: HOMEOPS_SYSTEM_PROMPT }];
    if (memoryBlock) ctx.push({ role: "system", content: memoryBlock });
    for (const m of res.messages.slice(-MAX_CONTEXT_MESSAGES)) {
      if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") continue;
      ctx.push({ role: m.role, content: m.content });
    }
    historyRef.current = sanitizeForSarvam(ctx);

    setError(null);
    setMemoryReady(true);
  }, []);

  useEffect(() => {
    let last = 0;
    let timer: any = null;

    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      // Small delay to avoid racing with persistence and to coalesce bursts.
      timer = setTimeout(() => {
        if (isStreaming) return;
        void loadMemory(memoryScopeRef.current);
      }, 250);
    };

    const applyIncoming = (detail: any) => {
      const source = typeof detail?.source === "string" ? detail.source : "";
      const ts = typeof detail?.ts === "number" ? detail.ts : Date.now();
      if (source && source === instanceIdRef.current) return;
      if (ts <= last) return;
      last = ts;
      scheduleReload();
    };

    const handler = (ev: Event) => {
      const ce = ev as CustomEvent;
      applyIncoming((ce as any)?.detail);
    };

    const bc = chatSyncChannelRef.current;
    const bcHandler = (ev: MessageEvent) => applyIncoming(ev?.data);

    const storageHandler = (ev: StorageEvent) => {
      if (ev.key !== chatSyncStorageKey) return;
      if (!ev.newValue) return;
      try {
        const parsed = JSON.parse(ev.newValue);
        applyIncoming(parsed);
      } catch {
        // ignore
      }
    };

    window.addEventListener("homeops:chat-sync", handler as EventListener);
    window.addEventListener("storage", storageHandler);
    try {
      bc?.addEventListener("message", bcHandler);
    } catch {
      // ignore
    }
    return () => {
      window.removeEventListener("homeops:chat-sync", handler as EventListener);
      window.removeEventListener("storage", storageHandler);
      try {
        bc?.removeEventListener("message", bcHandler);
      } catch {
        // ignore
      }
      if (timer) clearTimeout(timer);
    };
  }, [loadMemory, isStreaming]);

  // Load long-term memory when agent setup exists and when scope changes
  useEffect(() => {
    (async () => {
      await loadMemory(memoryScope);
    })();
  }, [loadMemory, memoryScope]);

  const maybeSummarizeAndTrim = useCallback(async () => {
    const nonSystem = historyRef.current.filter((m) => m.role === "user" || m.role === "assistant");
    if (nonSystem.length < SUMMARIZE_TRIGGER_MESSAGES) return;

    const keep = nonSystem.slice(-MAX_CONTEXT_MESSAGES);
    const toSummarize = nonSystem.slice(0, Math.max(0, nonSystem.length - MAX_CONTEXT_MESSAGES));
    if (toSummarize.length === 0) return;

    const summaryPrompt: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a summarization engine. Produce a concise memory summary of the conversation so far. " +
          "Focus on durable facts, preferences, household entities (helpers), chores created/assigned, and decisions. " +
          "Output plain text only (no markdown).",
      },
    ];

    if (memorySummaryRef.current.trim()) {
      summaryPrompt.push({
        role: "system",
        content: `Existing memory summary:\n${memorySummaryRef.current.trim()}`,
      });
    }

    summaryPrompt.push({
      role: "user",
      content:
        "Summarize and update the memory based on these messages:\n" +
        toSummarize.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    });

    let newSummary = "";
    try {
      for await (const chunk of streamChat(summaryPrompt)) {
        newSummary += chunk;
      }
    } catch {
      return;
    }

    const trimmedSummary = newSummary.trim();
    if (!trimmedSummary) return;
    memorySummaryRef.current = trimmedSummary;

    const memoryBlock = `Long-term memory summary (authoritative):\n${trimmedSummary}`;
    historyRef.current = [{ role: "system", content: HOMEOPS_SYSTEM_PROMPT }, { role: "system", content: memoryBlock }, ...keep];

    // Persist updated summary
    const { accessToken, householdId } = getAgentSetup();
    if (accessToken && householdId) {
      await appendChatMessages({
        accessToken,
        householdId,
        scope: memoryScopeRef.current,
        messages: [],
        summary: memorySummaryRef.current,
      });
    }
  }, []);

  const sendMessage = useCallback(async (text: string, opts?: { silent?: boolean; allowWhileStreaming?: boolean }) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const allowWhileStreaming = Boolean(opts?.allowWhileStreaming);
    if (isStreaming && !allowWhileStreaming) return;

    const silent = Boolean(opts?.silent);

    setError(null);

    // Clarification/control replies may need to be sent while the assistant is still streaming.
    // Abort any in-flight stream so we can send the user's response deterministically.
    if (allowWhileStreaming && isStreaming) {
      abortRef.current?.abort();
      abortRef.current = null;
      setIsStreaming(false);
    }

    // Add user message to UI unless it's an internal control message.
    if (!silent) {
      const userEntry: ChatEntry = {
        id: nextMessageId(),
        role: "user",
        content: trimmed,
        timestamp: getTime(),
      };
      setMessages((prev) => [...prev, userEntry]);
    }

    // Append to API history
    historyRef.current = sanitizeForSarvam([...historyRef.current, { role: "user", content: trimmed }]);
    if (!silent) {
      void appendToMemory([{ role: "user", content: trimmed }]);
    }

    // Placeholder assistant message (streaming)
    const assistantId = nextMessageId();
    const assistantEntry: ChatEntry = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: getTime(),
      streaming: true,
    };
    setMessages((prev) => [...prev, assistantEntry]);
    setIsStreaming(true);

    // Abort any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const watchdog = window.setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }, 25000);

    let fullResponse = "";
    try {
      const outbound = sanitizeForSarvam(historyRef.current);
      for await (const chunk of streamChat(outbound, controller.signal)) {
        fullResponse += chunk;
        // Update the streaming message in-place
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: fullResponse } : m,
          ),
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        const errMsg = "Request was cancelled or timed out. Please try again.";
        setError(errMsg);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `⚠️ ${errMsg}`, streaming: false }
              : m,
          ),
        );
        return;
      }
      const errMsg =
        err instanceof Error ? err.message : "Unknown error from Sarvam AI";
      setError(errMsg);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `⚠️ ${errMsg}`, streaming: false }
            : m,
        ),
      );
      return;
    } finally {
      window.clearTimeout(watchdog);
      setIsStreaming(false);
      // Safety net: always clear the placeholder streaming flag so the UI never gets stuck
      // showing the blinking cursor if the stream returns early or the message update path is skipped.
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
    }

    // Mark streaming done & append to history
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? { ...m, content: fullResponse, streaming: false }
          : m,
      ),
    );
    historyRef.current = [
      ...historyRef.current,
      { role: "assistant", content: fullResponse },
    ];
    historyRef.current = sanitizeForSarvam(historyRef.current);

    void appendToMemory([{ role: "assistant", content: fullResponse }]);

    broadcastChatSync();

    void maybeSummarizeAndTrim();
  }, [isStreaming, broadcastChatSync]);

  const clearHistory = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages(INITIAL_MESSAGES);
    historyRef.current = [{ role: "system", content: HOMEOPS_SYSTEM_PROMPT }];
    memorySummaryRef.current = "";
    conversationIdRef.current = "";
    setConversationId("");
    setError(null);
    setIsStreaming(false);

    const { accessToken, householdId } = getAgentSetup();
    if (accessToken && householdId) {
      void clearChatState({ accessToken, householdId, scope: memoryScopeRef.current });
    }
  }, []);

  return { messages, sendMessage, appendUserMessage, isStreaming, error, clearHistory, memoryReady, memoryScope, setMemoryScope, appendAssistantMessage, conversationId };
}
