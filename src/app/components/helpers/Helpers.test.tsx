import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Helpers } from "./Helpers";

const executeToolCallMock = vi.fn();

vi.mock("../../auth/AuthProvider", () => {
  return {
    useAuth: () => ({ accessToken: "test-token", householdId: "test-household" }),
  };
});

vi.mock("../../services/agentApi", () => {
  return {
    executeToolCall: (...args: any[]) => executeToolCallMock(...args),
  };
});

type SupabaseResult = { data: any; error: any };

function createThenableBuilder(result: SupabaseResult) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    is: () => builder,
    gte: () => builder,
    lt: () => builder,
    neq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => builder,
    then: (resolve: any, _reject?: any) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

const supabaseFromMock = vi.fn();

vi.mock("../../services/supabaseClient", () => {
  return {
    supabase: {
      from: (...args: any[]) => supabaseFromMock(...args),
    },
  };
});

function setupSupabaseMocks(params: { helpers?: any[]; feedback?: any[]; rewards?: any[] }) {
  const helpers = params.helpers ?? [];
  const feedback = params.feedback ?? [];
  const rewards = params.rewards ?? [];

  supabaseFromMock.mockImplementation((table: string) => {
    if (table === "helpers") {
      return createThenableBuilder({ data: helpers, error: null });
    }
    if (table === "helper_feedback") {
      return createThenableBuilder({ data: feedback, error: null });
    }
    if (table === "helper_rewards") {
      return createThenableBuilder({ data: rewards, error: null });
    }
    return createThenableBuilder({ data: [], error: null });
  });
}

describe("Helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSupabaseMocks({
      helpers: [
        {
          id: "helper-1",
          household_id: "test-household",
          name: "Alice",
          type: "Cleaning",
          phone: null,
          notes: null,
          daily_capacity_minutes: 120,
          metadata: {},
          created_at: new Date().toISOString(),
        },
      ],
      feedback: [
        {
          id: "fb-1",
          household_id: "test-household",
          helper_id: "helper-1",
          author_id: "profile-1",
          rating: 5,
          comment: "Great",
          occurred_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ],
      rewards: [
        {
          id: "rw-1",
          household_id: "test-household",
          helper_id: "helper-1",
          quarter: "2026-Q1",
          reward_type: "bonus",
          amount: "500",
          currency: "INR",
          reason: "Excellent work",
          awarded_by: "profile-1",
          created_at: new Date().toISOString(),
        },
      ],
    });

    executeToolCallMock.mockResolvedValue({ ok: true, summary: "ok", toolCallId: "tc" });
  });

  it("opens feedback dialog, shows recent feedback, and submits feedback via tool call", async () => {
    const user = userEvent.setup();
    render(<Helpers />);

    expect((await screen.findAllByText("Alice")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Feedback" }));

    const dialog = await screen.findByRole("dialog", { name: "Feedback" });
    expect(within(dialog).getByText("Recent feedback")).toBeInTheDocument();
    expect(within(dialog).getByText("Great")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Submit feedback" }));

    expect(executeToolCallMock).toHaveBeenCalled();
    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.toolCall.tool).toBe("db.insert");
    expect(call.toolCall.args.table).toBe("helper_feedback");
    expect(call.toolCall.args.record.helper_id).toBe("helper-1");
  });

  it("opens rewards dialog, shows recent rewards, and creates reward via tool call", async () => {
    const user = userEvent.setup();
    render(<Helpers />);

    expect((await screen.findAllByText("Alice")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Rewards" }));

    const dialog = await screen.findByRole("dialog", { name: "Rewards" });
    expect(within(dialog).getByText("Recent rewards")).toBeInTheDocument();
    expect(within(dialog).getByText(/2026-Q1/)).toBeInTheDocument();

    const quarterInput = within(dialog).getByLabelText("Quarter") as HTMLInputElement;
    await user.clear(quarterInput);
    await user.type(quarterInput, "2026-Q2");

    await user.click(within(dialog).getByRole("button", { name: "Create reward" }));

    expect(executeToolCallMock).toHaveBeenCalled();
    const call = executeToolCallMock.mock.calls[0]?.[0];
    expect(call.toolCall.tool).toBe("db.insert");
    expect(call.toolCall.args.table).toBe("helper_rewards");
    expect(call.toolCall.args.record.helper_id).toBe("helper-1");
    expect(call.toolCall.args.record.quarter).toBe("2026-Q2");
  });
});
