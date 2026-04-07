import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const choresSeed = [
  { id: "c1", title: "Sweep kitchen", status: "pending", due_at: "2020-01-01T00:00:00.000Z" },
  { id: "c2", title: "Mop balcony", status: "pending", due_at: "2020-01-01T00:00:00.000Z" },
];

const executeToolCall = vi.fn(async (_arg?: any) => ({ ok: true, tool_call_id: "t1", summary: "Deleted." }));

vi.mock("../../services/agentApi", async () => {
  const actual: any = await vi.importActual("../../services/agentApi");
  return {
    ...actual,
    executeToolCall: (arg: any) => executeToolCall(arg),
    agentCreate: vi.fn(async () => ({ ok: true })),
    agentListHelpers: vi.fn(async () => ({ ok: true, helpers: [] })),
    semanticReindex: vi.fn(async () => ({ ok: true })),
    semanticSearch: vi.fn(async () => ({ ok: true, results: [] })),
  };
});

vi.mock("../../auth/AuthProvider", () => {
  return {
    useAuth: () => ({
      accessToken: "token",
      householdId: "hid",
      user: null,
      lastError: "",
      signOut: vi.fn(async () => {}),
      refreshHouseholdId: vi.fn(async () => {}),
      bootstrapHousehold: vi.fn(async () => ({ ok: true, householdId: "hid" })),
    }),
  };
});

vi.mock("../../i18n", () => {
  return {
    useI18n: () => ({
      t: (key: string) => {
        if (key === "common.cancel") return "Cancel";
        if (key === "chat.send_message") return "Send";
        if (key === "chat.tool_execution_failed") return "Tool failed";
        if (key === "chat.executed_tool") return "Executed {tool}";
        return key;
      },
      setLang: vi.fn(),
    }),
  };
});

vi.mock("react-router", async () => {
  const actual: any = await vi.importActual("react-router");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("../../hooks/useSarvamSTT", () => {
  return {
    useSarvamSTT: () => ({
      isListening: false,
      isTranscribing: false,
      toggle: vi.fn(),
      supported: false,
      sttMode: "off",
    }),
  };
});

vi.mock("../../services/supabaseClient", () => {
  const apply = (rows: any[], filters: Array<(r: any) => boolean>) => rows.filter((r) => filters.every((f) => f(r)));

  const builder = (rows: any[]) => {
    const filters: Array<(r: any) => boolean> = [];

    const api: any = {
      select: () => api,
      eq: (col: string, value: any) => {
        filters.push((r) => r[col] === value);
        return api;
      },
      is: (col: string, value: any) => {
        if (value === null) filters.push((r) => r[col] == null);
        return api;
      },
      neq: (col: string, value: any) => {
        filters.push((r) => r[col] !== value);
        return api;
      },
      not: (col: string, op: string, value: any) => {
        if (op === "is" && value === null) filters.push((r) => r[col] != null);
        return api;
      },
      lt: (col: string, value: any) => {
        const cutoff = Date.parse(String(value));
        filters.push((r) => Date.parse(String(r[col])) < cutoff);
        return api;
      },
      order: () => api,
      limit: async () => {
        return { data: apply(rows, filters), error: null };
      },
    };

    return api;
  };

  return {
    supabase: {
      from: (table: string) => {
        if (table === "chores") {
          const rows = choresSeed.map((c) => ({ ...c, household_id: "hid", deleted_at: null }));
          return builder(rows);
        }

        // ChatInterface checks home profile existence on mount.
        if (table === "home_profiles") {
          return builder([{ household_id: "hid" }]);
        }

        // Default: return empty set for any other incidental queries during mount.
        return builder([]);
      },
      auth: {
        getSession: vi.fn(async () => ({ data: { session: { access_token: "token" } }, error: null })),
        refreshSession: vi.fn(async () => ({ data: { session: { access_token: "token" } }, error: null })),
      },
    },
  };
});

vi.mock("../../hooks/useSarvamChat", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    useSarvamChat: () => {
      const [messages, setMessages] = React.useState<any[]>([]);

      const appendUserMessage = (content: string) => {
        setMessages((prev: any[]) => [...prev, { id: prev.length + 1, role: "user", content, timestamp: "" }]);
      };

      const appendAssistantMessage = (content: string) => {
        setMessages((prev: any[]) => [...prev, { id: prev.length + 1, role: "assistant", content, timestamp: "" }]);
      };

      return {
        messages,
        isStreaming: false,
        error: null,
        memoryReady: true,
        memoryScope: "user",
        setMemoryScope: vi.fn(),
        conversationId: "c1",
        sendMessage: vi.fn(async () => {}),
        appendUserMessage,
        appendAssistantMessage,
        clearHistory: vi.fn(async () => {}),
      };
    },
  };
});

import { ChatInterface } from "./ChatInterface";
import { normalizeChoreTextFromUserUtterance } from "./chatTextUtils";

beforeEach(() => {
  executeToolCall.mockClear();
});

describe("ChatInterface delete chores flow", () => {
  it("overdue preview -> click Delete -> shows confirmation", async () => {
    const user = userEvent.setup();
    render(<ChatInterface />);

    const textbox = screen.getByPlaceholderText(/ask anything about your home/i);

    await user.type(textbox, "delete chores{enter}");
    expect(await screen.findByText(/which chores do you want to delete/i)).toBeInTheDocument();

    await user.type(textbox, "overdue{enter}");
    expect(await screen.findByText(/delete chores \(preview\)/i, {}, { timeout: 15000 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/deleted 2 chores\./i)).toBeInTheDocument();
    expect(executeToolCall).toHaveBeenCalledTimes(2);
  }, 15000);

  it("preview -> click Cancel -> adds cancelled message", async () => {
    const user = userEvent.setup();
    render(<ChatInterface />);

    const textbox = screen.getByPlaceholderText(/ask anything about your home/i);

    await user.type(textbox, "delete chores{enter}");
    await user.type(textbox, "overdue{enter}");

    expect(await screen.findByText(/delete chores \(preview\)/i, {}, { timeout: 15000 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(await screen.findByText(/cancelled — no chores were deleted\./i)).toBeInTheDocument();
  }, 15000);

  it("specific select -> choose chore -> delete selected", async () => {
    const user = userEvent.setup();
    render(<ChatInterface />);

    const textbox = screen.getByPlaceholderText(/ask anything about your home/i);

    await user.type(textbox, "delete chores{enter}");
    await user.type(textbox, "specific ones{enter}");

    expect(await screen.findByText(/delete chores \(select specific\)/i)).toBeInTheDocument();

    const list = screen.getByRole("list");
    const firstItem = within(list).getByText("Sweep kitchen").closest("li");
    expect(firstItem).not.toBeNull();

    const checkbox = within(firstItem as HTMLElement).getByRole("checkbox");
    await user.click(checkbox);

    await user.click(screen.getByRole("button", { name: /delete selected/i }));

    expect(await screen.findByText(/deleted 1 chore\./i)).toBeInTheDocument();
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  }, 15000);

  it("syncs delete preview card across two ChatInterface instances", async () => {
    const user = userEvent.setup();
    render(
      <>
        <div data-testid="chat1">
          <ChatInterface />
        </div>
        <div data-testid="chat2">
          <ChatInterface embedded />
        </div>
      </>
    );

    const chat1 = within(screen.getByTestId("chat1"));
    const chat2 = within(screen.getByTestId("chat2"));

    const textbox1 = chat1.getByPlaceholderText(/ask anything about your home/i);

    await user.type(textbox1, "delete chores{enter}");
    await user.type(textbox1, "overdue{enter}");

    expect(await chat1.findByText(/delete chores \(preview\)/i)).toBeInTheDocument();
    expect(await chat2.findByText(/delete chores \(preview\)/i)).toBeInTheDocument();
  }, 15000);

  it("normalizes chore text by stripping imperative prefixes", () => {
    const norm = normalizeChoreTextFromUserUtterance("add a chore to deep clean deck area");
    expect(norm.title).toBe("Deep clean deck area");
    expect(norm.description.toLowerCase()).toContain("deep clean deck area");
    expect(norm.description.toLowerCase()).not.toContain("add a chore");
  });

  it("normalizes chore text with 'for' prefix and gerunds", () => {
    const norm = normalizeChoreTextFromUserUtterance("add a chore for dusting kitchen cupboards");
    expect(norm.title).toBe("Dust kitchen cupboards");
    expect(norm.description.toLowerCase()).toBe("dust kitchen cupboards");
  });
});
