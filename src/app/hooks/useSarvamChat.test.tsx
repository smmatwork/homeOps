import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock AuthProvider
vi.mock("../auth/AuthProvider", () => {
  return {
    useAuth: () => ({ accessToken: "token", householdId: "hid" }),
  };
});

// Mock Supabase client
vi.mock("../services/supabaseClient", () => {
  return {
    supabase: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: { access_token: "token" } } })),
        refreshSession: vi.fn(async () => ({ data: { session: { access_token: "token" } } })),
      },
    },
  };
});

const appendChatMessages = vi.fn(async (_arg: any) => ({ ok: true, conversationId: "c1" }));
const getChatState = vi.fn(async (_arg: any) => ({
  ok: true,
  conversationId: "c1",
  summary: "",
  messages: [],
}));

vi.mock("../services/agentApi", async () => {
  const actual: any = await vi.importActual("../services/agentApi");
  return {
    ...actual,
    appendChatMessages: (arg: any) => appendChatMessages(arg),
    getChatState: (arg: any) => getChatState(arg),
    clearChatState: vi.fn(async () => ({ ok: true, conversationId: "c1" })),
  };
});

import { useSarvamChat } from "./useSarvamChat";

beforeEach(() => {
  appendChatMessages.mockClear();
  getChatState.mockClear();
});

describe("useSarvamChat", () => {
  it("persists user and assistant messages via appendChatMessages", async () => {
    const { result } = renderHook(() => useSarvamChat());

    act(() => {
      result.current.appendUserMessage("hello");
      result.current.appendAssistantMessage("world");
    });

    // appendToMemory runs async
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(appendChatMessages).toHaveBeenCalled();
    const calls = appendChatMessages.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    expect(calls.some((c: any[]) => c[0]?.messages?.[0]?.role === "user" && c[0]?.messages?.[0]?.content === "hello")).toBe(true);
    expect(calls.some((c: any[]) => c[0]?.messages?.[0]?.role === "assistant" && c[0]?.messages?.[0]?.content === "world")).toBe(true);
  });

  it("does not clobber local UI when server returns fewer messages", async () => {
    const { result } = renderHook(() => useSarvamChat());

    act(() => {
      result.current.appendUserMessage("u1");
      result.current.appendAssistantMessage("a1");
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const before = result.current.messages.map((m) => `${m.role}:${m.content}`).join("|");

    // Server returns empty history
    getChatState.mockResolvedValueOnce({ ok: true, conversationId: "c1", summary: "", messages: [] });

    await act(async () => {
      // Trigger sync event -> loadMemory
      window.dispatchEvent(new CustomEvent("homeops:chat-sync", { detail: { ts: Date.now(), source: "other" } }));
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 300));
    });

    const after = result.current.messages.map((m) => `${m.role}:${m.content}`).join("|");
    expect(after).toBe(before);
  });
});
