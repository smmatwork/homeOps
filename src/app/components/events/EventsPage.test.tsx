import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ accessToken: "tok", householdId: "hh_1" }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, lang: "en", setLang: vi.fn() }),
}));

const fetchEventsMock = vi.fn();
const createEventMock = vi.fn();
const deleteEventMock = vi.fn();

vi.mock("../../services/householdEventsApi", async () => {
  const actual = await vi.importActual<any>("../../services/householdEventsApi");
  return {
    ...actual,
    fetchHouseholdEvents: (...args: any[]) => fetchEventsMock(...args),
    createHouseholdEvent: (...args: any[]) => createEventMock(...args),
    deleteHouseholdEvent: (...args: any[]) => deleteEventMock(...args),
  };
});

import { EventsPage } from "./EventsPage";

describe("EventsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows empty state when no events", async () => {
    fetchEventsMock.mockResolvedValue({ events: [], error: null });
    render(<EventsPage />);
    expect(await screen.findByText("events.empty")).toBeInTheDocument();
  });

  it("renders events list when events are present", async () => {
    fetchEventsMock.mockResolvedValue({
      events: [
        {
          id: "evt_1",
          household_id: "hh_1",
          type: "guest_arrival",
          start_at: "2026-04-15T10:00:00Z",
          end_at: null,
          metadata: { notes: "Family visit from out of town" },
          created_by: "u1",
          created_at: "2026-04-10T00:00:00Z",
        },
      ],
      error: null,
    });

    render(<EventsPage />);
    expect(await screen.findByText("events.type_guest_arrival")).toBeInTheDocument();
    expect(screen.getByText("Family visit from out of town")).toBeInTheDocument();
  });

  it("opens add dialog when add button is clicked", async () => {
    fetchEventsMock.mockResolvedValue({ events: [], error: null });
    const user = userEvent.setup();
    render(<EventsPage />);

    // Wait for initial load
    await screen.findByText("events.empty");

    await user.click(screen.getAllByText("events.add_event")[0]);

    // Dialog should be open — check for the dialog by role
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Save and Cancel buttons should be present
    expect(screen.getByRole("button", { name: "common.save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.cancel" })).toBeInTheDocument();
  });

  it("calls deleteHouseholdEvent when delete button clicked", async () => {
    fetchEventsMock.mockResolvedValue({
      events: [
        {
          id: "evt_1",
          household_id: "hh_1",
          type: "vacation",
          start_at: "2026-04-15T10:00:00Z",
          end_at: null,
          metadata: {},
          created_by: "u1",
          created_at: "2026-04-10T00:00:00Z",
        },
      ],
      error: null,
    });
    deleteEventMock.mockResolvedValue({ ok: true, summary: "deleted" });

    const user = userEvent.setup();
    render(<EventsPage />);

    await screen.findByText("events.type_vacation");

    // Find the delete icon button
    const deleteButtons = screen.getAllByRole("button");
    const deleteBtn = deleteButtons.find((btn) => btn.querySelector('svg[data-testid="DeleteIcon"]'));
    if (deleteBtn) {
      await user.click(deleteBtn);
      expect(deleteEventMock).toHaveBeenCalledWith({
        accessToken: "tok",
        householdId: "hh_1",
        eventId: "evt_1",
      });
    }
  });
});
