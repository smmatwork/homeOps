/**
 * Unit tests for the pure helpers of the Helper Onboarding wizard
 * (Phase 1.1a). These are all synchronous pure functions so we don't
 * need to render the component — that's covered separately by the
 * existing Helpers.test.tsx integration-style tests.
 */

import { describe, expect, it } from "vitest";

import {
  INITIAL_FORM,
  buildPreferredCallWindow,
  isStepValid,
  type HelperOnboardingFormData,
} from "./HelperOnboardingFlow";
import {
  DEFAULT_CHANNEL_CHAIN,
  moveChannelDown,
  moveChannelUp,
  partitionChannels,
  toggleChannel,
} from "./ChannelChainStep";
import {
  generateInviteToken,
  parseInsertedId,
} from "../../services/helpersApi";

// ── helpersApi pure helpers ─────────────────────────────────────────

describe("helpersApi.parseInsertedId", () => {
  it("extracts a uuid from the edge function's db.insert summary", () => {
    const summary = "Inserted 1 row into helpers. id=3fda14a1-c6f5-4dbf-80f3-22589ad5d59c";
    expect(parseInsertedId(summary)).toBe("3fda14a1-c6f5-4dbf-80f3-22589ad5d59c");
  });

  it("extracts a uuid with uppercase hex", () => {
    const summary = "Inserted 1 row into helper_invites. id=ABCDEF12-3456-7890-ABCD-EF1234567890";
    expect(parseInsertedId(summary)).toBe("ABCDEF12-3456-7890-ABCD-EF1234567890");
  });

  it("returns null on a summary that doesn't contain a uuid", () => {
    expect(parseInsertedId("Inserted 1 row into helpers. id=(unknown)")).toBeNull();
    expect(parseInsertedId("")).toBeNull();
    expect(parseInsertedId("random text")).toBeNull();
  });
});

describe("helpersApi.generateInviteToken", () => {
  it("returns a non-empty URL-safe base64 string", () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 256-bit encoded as URL-safe base64 without padding = 43 chars.
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token.length).toBeLessThanOrEqual(44);
  });

  it("returns distinct values on successive calls", () => {
    const tokens = new Set();
    for (let i = 0; i < 32; i++) tokens.add(generateInviteToken());
    // Probability of collision over 32 samples of 256-bit tokens is
    // astronomically low. If this ever fails, the RNG is broken.
    expect(tokens.size).toBe(32);
  });

  it("contains neither '+' nor '/' nor '='", () => {
    for (let i = 0; i < 16; i++) {
      const t = generateInviteToken();
      expect(t).not.toContain("+");
      expect(t).not.toContain("/");
      expect(t).not.toContain("=");
    }
  });
});

// ── Channel-chain pure helpers ──────────────────────────────────────

describe("ChannelChainStep pure helpers", () => {
  it("moveChannelUp shifts a channel one position earlier", () => {
    const chain = ["voice", "whatsapp_tap", "sms"];
    expect(moveChannelUp(chain, "whatsapp_tap")).toEqual(["whatsapp_tap", "voice", "sms"]);
    expect(moveChannelUp(chain, "sms")).toEqual(["voice", "sms", "whatsapp_tap"]);
  });

  it("moveChannelUp is a no-op on the first channel", () => {
    const chain = ["voice", "whatsapp_tap", "sms"];
    expect(moveChannelUp(chain, "voice")).toEqual(chain);
  });

  it("moveChannelUp is a no-op on a channel not in the chain", () => {
    const chain = ["voice", "sms"];
    expect(moveChannelUp(chain, "web")).toEqual(chain);
  });

  it("moveChannelDown shifts a channel one position later", () => {
    const chain = ["voice", "whatsapp_tap", "sms"];
    expect(moveChannelDown(chain, "voice")).toEqual(["whatsapp_tap", "voice", "sms"]);
    expect(moveChannelDown(chain, "whatsapp_tap")).toEqual(["voice", "sms", "whatsapp_tap"]);
  });

  it("moveChannelDown is a no-op on the last channel", () => {
    const chain = ["voice", "whatsapp_tap", "sms"];
    expect(moveChannelDown(chain, "sms")).toEqual(chain);
  });

  it("toggleChannel removes a channel that's present", () => {
    expect(toggleChannel(["voice", "sms"], "voice")).toEqual(["sms"]);
    expect(toggleChannel(["voice", "whatsapp_tap", "sms"], "whatsapp_tap")).toEqual([
      "voice",
      "sms",
    ]);
  });

  it("toggleChannel adds a channel that's absent", () => {
    expect(toggleChannel(["voice"], "sms")).toEqual(["voice", "sms"]);
  });

  it("partitionChannels splits enabled from disabled preserving chain order", () => {
    const { enabled, disabled } = partitionChannels(["sms", "voice"]);
    expect(enabled).toEqual(["sms", "voice"]);
    // Disabled contains every channel not in the enabled chain.
    expect(disabled).toEqual(
      expect.arrayContaining(["whatsapp_voice", "whatsapp_tap", "whatsapp_form", "web"]),
    );
    expect(disabled).not.toContain("voice");
    expect(disabled).not.toContain("sms");
  });

  it("DEFAULT_CHANNEL_CHAIN matches the schema default", () => {
    // The DB default in migration 20260415000000 is
    // ARRAY['voice','whatsapp_tap','sms'].
    expect(DEFAULT_CHANNEL_CHAIN).toEqual(["voice", "whatsapp_tap", "sms"]);
  });
});

// ── Wizard step validation ──────────────────────────────────────────

function makeForm(overrides: Partial<HelperOnboardingFormData> = {}): HelperOnboardingFormData {
  return { ...INITIAL_FORM, ...overrides };
}

describe("HelperOnboardingFlow.isStepValid", () => {
  it("welcome step is always valid", () => {
    expect(isStepValid(0, makeForm())).toBe(true);
    expect(isStepValid(0, makeForm({ name: "Sunita", phone: "9876543210" }))).toBe(true);
  });

  it("basics step requires a non-empty name and a plausibly long phone", () => {
    expect(isStepValid(1, makeForm({ name: "", phone: "9876543210" }))).toBe(false);
    expect(isStepValid(1, makeForm({ name: "   ", phone: "9876543210" }))).toBe(false);
    expect(isStepValid(1, makeForm({ name: "Sunita", phone: "" }))).toBe(false);
    expect(isStepValid(1, makeForm({ name: "Sunita", phone: "12345" }))).toBe(false);
    expect(isStepValid(1, makeForm({ name: "Sunita", phone: "987654" }))).toBe(true);
    expect(isStepValid(1, makeForm({ name: "Sunita", phone: "+91 98765 43210" }))).toBe(true);
  });

  it("schedule step is always valid (all fields optional)", () => {
    expect(isStepValid(2, makeForm())).toBe(true);
    expect(isStepValid(2, makeForm({ dailyCapacityMinutes: "180" }))).toBe(true);
  });

  it("channel step requires at least one enabled channel", () => {
    expect(isStepValid(3, makeForm({ channelPreferences: ["voice"] }))).toBe(true);
    expect(isStepValid(3, makeForm({ channelPreferences: ["voice", "whatsapp_tap"] }))).toBe(true);
    expect(isStepValid(3, makeForm({ channelPreferences: [] }))).toBe(false);
  });

  it("salary step accepts empty OR positive number, rejects negative or NaN", () => {
    expect(isStepValid(4, makeForm({ initialSalary: "" }))).toBe(true);
    expect(isStepValid(4, makeForm({ initialSalary: "0" }))).toBe(true);
    expect(isStepValid(4, makeForm({ initialSalary: "8000" }))).toBe(true);
    expect(isStepValid(4, makeForm({ initialSalary: "   " }))).toBe(true); // empty-ish
    expect(isStepValid(4, makeForm({ initialSalary: "-500" }))).toBe(false);
    expect(isStepValid(4, makeForm({ initialSalary: "abc" }))).toBe(false);
  });

  it("unknown step returns false", () => {
    expect(isStepValid(99, makeForm())).toBe(false);
    expect(isStepValid(-1, makeForm())).toBe(false);
  });
});

describe("HelperOnboardingFlow.buildPreferredCallWindow", () => {
  it("returns null when no call window fields are filled", () => {
    expect(buildPreferredCallWindow(makeForm())).toBeNull();
  });

  it("returns a populated object when days are selected", () => {
    const out = buildPreferredCallWindow(
      makeForm({ callWindowDays: ["mon", "wed", "fri"] }),
    );
    expect(out).toEqual({ days: ["mon", "wed", "fri"], start: null, end: null });
  });

  it("returns a populated object when only start time is set", () => {
    const out = buildPreferredCallWindow(
      makeForm({ callWindowStart: "10:00" }),
    );
    expect(out).toEqual({ days: [], start: "10:00", end: null });
  });

  it("returns a fully populated object when days + times are set", () => {
    const out = buildPreferredCallWindow(
      makeForm({
        callWindowDays: ["mon", "tue"],
        callWindowStart: "09:00",
        callWindowEnd: "12:00",
      }),
    );
    expect(out).toEqual({
      days: ["mon", "tue"],
      start: "09:00",
      end: "12:00",
    });
  });
});

describe("INITIAL_FORM defaults", () => {
  it("uses the default channel chain", () => {
    expect(INITIAL_FORM.channelPreferences).toEqual(["voice", "whatsapp_tap", "sms"]);
  });

  it("defaults currency to INR and effective date to today (YYYY-MM-DD)", () => {
    expect(INITIAL_FORM.salaryCurrency).toBe("INR");
    expect(INITIAL_FORM.salaryEffectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
