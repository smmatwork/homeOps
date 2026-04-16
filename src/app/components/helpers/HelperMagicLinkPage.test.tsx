/**
 * Unit tests for the Stage 2 helper magic-link page (Phase 1.1b).
 *
 * Focuses on the pure helpers exported from the page module +
 * end-to-end mocked-fetch tests for the service layer. The
 * component-level render tests live separately — these are the
 * cheap, deterministic ones that catch regressions in the data
 * model and URL/body shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INITIAL_ANSWERS,
  buildStage2Payload,
  statusHeadline,
  type HelperFormAnswers,
} from "./HelperMagicLinkPage";
import {
  completeHelperInvite,
  fetchHelperInvite,
} from "../../services/helpersApi";

// ── Pure helpers ───────────────────────────────────────────────────

describe("HelperMagicLinkPage.buildStage2Payload", () => {
  it("returns all consent fields as false when defaults are kept", () => {
    const p = buildStage2Payload(INITIAL_ANSWERS);
    expect(p.consents).toEqual({
      id_verification: false,
      vision_capture: false,
      multi_household_coord: false,
      call_recording: false,
      marketing_outreach: false,
    });
    // Optional fields are omitted when empty so the RPC's coalesce
    // logic doesn't overwrite existing values with empty strings.
    expect(p.preferredLanguage).toBeUndefined();
    expect(p.preferredChannel).toBeUndefined();
  });

  it("includes preferredLanguage and preferredChannel when set", () => {
    const answers: HelperFormAnswers = {
      ...INITIAL_ANSWERS,
      preferredLanguage: "kn",
      preferredChannel: "voice",
    };
    const p = buildStage2Payload(answers);
    expect(p.preferredLanguage).toBe("kn");
    expect(p.preferredChannel).toBe("voice");
  });

  it("mirrors each boolean answer into the corresponding snake_case consent key", () => {
    const answers: HelperFormAnswers = {
      ...INITIAL_ANSWERS,
      idVerification: true,
      visionCapture: true,
      multiHouseholdCoord: true,
      callRecording: true,
      marketingOutreach: true,
    };
    const p = buildStage2Payload(answers);
    expect(p.consents).toEqual({
      id_verification: true,
      vision_capture: true,
      multi_household_coord: true,
      call_recording: true,
      marketing_outreach: true,
    });
  });
});

describe("HelperMagicLinkPage.statusHeadline", () => {
  it("maps each status to a human-readable headline", () => {
    expect(statusHeadline("active")).toMatch(/welcome/i);
    expect(statusHeadline("expired")).toMatch(/expired/i);
    expect(statusHeadline("revoked")).toMatch(/cancelled/i);
    expect(statusHeadline("already_completed")).toMatch(/done/i);
    expect(statusHeadline("not_found")).toMatch(/not found/i);
    expect(statusHeadline("invalid_payload")).toMatch(/went wrong/i);
  });
});

// ── Service layer with mocked fetch ────────────────────────────────

describe("helpersApi.fetchHelperInvite", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("returns ok:true + normalized invite info on 200 active", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: "active",
          helper_id: "helper-1",
          helper_name: "Sunita",
          household_id: "hh-1",
          channel_chain: ["voice", "whatsapp_tap", "sms"],
          preferred_language: "kn",
          expires_at: "2026-05-15T07:00:00.000Z",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await fetchHelperInvite("test-token-abc");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.helperId).toBe("helper-1");
      expect(result.invite.helperName).toBe("Sunita");
      expect(result.invite.householdId).toBe("hh-1");
      expect(result.invite.channelChain).toEqual(["voice", "whatsapp_tap", "sms"]);
      expect(result.invite.preferredLanguage).toBe("kn");
      expect(result.invite.status).toBe("active");
    }
  });

  it("returns ok:false with not_found on HTTP 404", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ status: "not_found" }), { status: 404 });
    }) as typeof fetch;

    const result = await fetchHelperInvite("bad-token");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.status).toBe("not_found");
    }
  });

  it("returns ok:false with the status from the body on expired/revoked/already_completed", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: "expired",
          helper_id: "helper-1",
          helper_name: "Sunita",
          household_id: "hh-1",
          channel_chain: ["voice"],
          expires_at: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await fetchHelperInvite("expired-token");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.status).toBe("expired");
    }
  });

  it("hits the correct URL with the token URL-encoded", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ status: "not_found" }), { status: 404 });
    }) as typeof fetch;

    await fetchHelperInvite("tok with spaces");
    expect(capturedUrl).toContain("/functions/v1/server/h/");
    expect(capturedUrl).toContain("tok%20with%20spaces");
  });

  it("returns not_found when token is empty", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("should not be called");
    }) as typeof fetch;

    const result = await fetchHelperInvite("");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.status).toBe("not_found");
      expect(result.error).toMatch(/missing token/i);
    }
  });

  it("handles network errors gracefully", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const result = await fetchHelperInvite("any-token");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.status).toBe("not_found");
      expect(result.error).toMatch(/failed to fetch/i);
    }
  });
});

describe("helpersApi.completeHelperInvite", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs the snake_case payload shape the RPC expects", async () => {
    let capturedBody = "";
    let capturedMethod = "";
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      capturedMethod = String(init?.method || "");
      capturedBody = String(init?.body || "");
      return new Response(
        JSON.stringify({
          status: "completed",
          helper_id: "helper-1",
          household_id: "hh-1",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await completeHelperInvite("test-token", {
      preferredLanguage: "kn",
      preferredChannel: "voice",
      consents: {
        id_verification: false,
        vision_capture: false,
        multi_household_coord: false,
        call_recording: true,
        marketing_outreach: false,
      },
    });

    expect(capturedMethod).toBe("POST");
    const parsed = JSON.parse(capturedBody);
    expect(parsed.preferred_language).toBe("kn");
    expect(parsed.preferred_channel).toBe("voice");
    expect(parsed.consents.call_recording).toBe(true);
    expect(parsed.consents.vision_capture).toBe(false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("completed");
      expect(result.helperId).toBe("helper-1");
      expect(result.householdId).toBe("hh-1");
    }
  });

  it("returns ok:false with status already_completed on HTTP 409", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: "already_completed",
          helper_id: "helper-1",
          household_id: "hh-1",
        }),
        { status: 409 },
      );
    }) as typeof fetch;

    const result = await completeHelperInvite("t", { consents: {} });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.status).toBe("already_completed");
    }
  });

  it("returns ok:false with invalid_payload on HTTP 400", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: "invalid_payload",
          helper_id: null,
          household_id: null,
        }),
        { status: 400 },
      );
    }) as typeof fetch;

    const result = await completeHelperInvite("t", { consents: {} });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.status).toBe("invalid_payload");
    }
  });

  it("omits optional fields when they're undefined", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      capturedBody = String(init?.body || "");
      return new Response(
        JSON.stringify({
          status: "completed",
          helper_id: "h",
          household_id: "hh",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await completeHelperInvite("t", { consents: { vision_capture: false } });
    const parsed = JSON.parse(capturedBody);
    expect(parsed).not.toHaveProperty("preferred_language");
    expect(parsed).not.toHaveProperty("preferred_channel");
    expect(parsed.consents).toEqual({ vision_capture: false });
  });

  it("returns not_found when token is empty", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("should not be called");
    }) as typeof fetch;

    const result = await completeHelperInvite("", { consents: {} });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.status).toBe("not_found");
    }
  });
});
