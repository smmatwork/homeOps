import { useEffect, useState, useCallback, useRef } from "react";
import { streamChat, HOMEOPS_SYSTEM_PROMPT, type ChatMessage } from "../services/sarvamApi";
import { appendChatMessages, getChatState, type ChatScope, type ChatRole } from "../services/agentApi";
import { useAuth } from "../auth/AuthProvider";

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
      "Hello! I can help manage your home — add chores, find recipes, schedule helpers, and more. What would you like to do?",
    timestamp: "10:30 AM",
  },
];

function sanitizeForSarvam(messages: ChatMessage[]): ChatMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ ...m, content: m.content.trim() }))
    .filter((m) => m.content);

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

  return [...system, ...out];
}

export function useSarvamChat() {
  const { accessToken: authedAccessToken, householdId: authedHouseholdId } = useAuth();
  const [messages, setMessages] = useState<ChatEntry[]>(INITIAL_MESSAGES);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const getAgentSetup = () => {
    const token = authedAccessToken.trim();
    const householdId = authedHouseholdId.trim();
    if (token && householdId) return { accessToken: token, householdId };
    try {
      const accessToken = localStorage.getItem("homeops.agent.access_token") ?? "";
      const householdId = localStorage.getItem("homeops.agent.household_id") ?? "";
      return { accessToken: accessToken.trim(), householdId: householdId.trim() };
    } catch {
      return { accessToken: "", householdId: "" };
    }
  };

  const appendAssistantMessage = useCallback((content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const entry: ChatEntry = {
      id: Date.now(),
      role: "assistant",
      content: trimmed,
      timestamp: getTime(),
      streaming: false,
    };
    setMessages((prev) => [...prev, entry]);
    historyRef.current = [...historyRef.current, { role: "assistant", content: trimmed }];
    void appendToMemory([{ role: "assistant", content: trimmed }]);
  }, []);

  const appendToMemory = async (items: Array<{ role: ChatRole; content: string }>) => {
    const { accessToken, householdId } = getAgentSetup();
    if (!accessToken || !householdId) return;

    await appendChatMessages({
      accessToken,
      householdId,
      scope: memoryScopeRef.current,
      messages: items,
      summary: memorySummaryRef.current,
    });
  };

  const loadMemory = useCallback(async (scope: ChatScope) => {
    setMemoryReady(false);
    const { accessToken, householdId } = getAgentSetup();
    if (!accessToken || !householdId) {
      historyRef.current = [{ role: "system", content: HOMEOPS_SYSTEM_PROMPT }];
      setMessages(INITIAL_MESSAGES);
      setMemoryReady(true);
      return;
    }

    const res = await getChatState({
      accessToken,
      householdId,
      scope,
      limit: 50,
    });
    if (!res.ok) {
      setMemoryReady(true);
      return;
    }

    conversationIdRef.current = res.conversationId;
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

    if (loadedEntries.length > 0) {
      setMessages(loadedEntries);
    } else {
      setMessages(INITIAL_MESSAGES);
    }

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

    setMemoryReady(true);
  }, []);

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

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    setError(null);

    // Add user message to UI
    const userEntry: ChatEntry = {
      id: Date.now(),
      role: "user",
      content: trimmed,
      timestamp: getTime(),
    };
    setMessages((prev) => [...prev, userEntry]);

    // Append to API history
    historyRef.current = sanitizeForSarvam([...historyRef.current, { role: "user", content: trimmed }]);
    void appendToMemory([{ role: "user", content: trimmed }]);

    // Placeholder assistant message (streaming)
    const assistantId = Date.now() + 1;
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
      if (err instanceof Error && err.name === "AbortError") return;
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
      setIsStreaming(false);
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

    void maybeSummarizeAndTrim();
  }, [isStreaming]);

  const clearHistory = useCallback(() => {
    setMessages(INITIAL_MESSAGES);
    historyRef.current = [{ role: "system", content: HOMEOPS_SYSTEM_PROMPT }];
    setError(null);
  }, []);

  return { messages, sendMessage, isStreaming, error, clearHistory, memoryReady, memoryScope, setMemoryScope, appendAssistantMessage };
}
