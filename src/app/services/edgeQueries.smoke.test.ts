import { describe, expect, it } from "vitest";

type JsonRecord = Record<string, unknown>;

type SmokeEnv = {
  baseUrl: string;
  accessToken: string;
  householdId: string;
};

function getSmokeEnv(): SmokeEnv | null {
  const baseUrl = String(process.env.HOMEOPS_FUNCTIONS_BASE_URL || "http://127.0.0.1:54321/functions/v1").replace(/\/$/, "");
  const accessToken = String(process.env.HOMEOPS_ACCESS_TOKEN || "").trim();
  const householdId = String(process.env.HOMEOPS_HOUSEHOLD_ID || "").trim();
  if (!accessToken || !householdId) return null;
  return { baseUrl, accessToken, householdId };
}

async function postJson(env: SmokeEnv, path: string, body: JsonRecord): Promise<JsonRecord> {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}: ${text}`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`Non-object JSON for ${path}: ${text}`);
  }
  return json as JsonRecord;
}

function isMatchType(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

describe("Edge query endpoint smoke tests", () => {
  const env = getSmokeEnv();
  const smoke = env ? it : it.skip;

  smoke("POST /server/queries/helpers/resolve returns a structured response", async () => {
    const q = String(process.env.HOMEOPS_HELPER_QUERY || "Rajesh");
    const out = await postJson(env!, "/server/queries/helpers/resolve", {
      household_id: env!.householdId,
      query: q,
    });
    expect(out.ok).toBe(true);
    expect(isMatchType(out.match_type)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "candidates")).toBe(true);
  });

  smoke("POST /server/queries/spaces/resolve returns a structured response", async () => {
    const q = String(process.env.HOMEOPS_SPACE_QUERY || "kitchen");
    const out = await postJson(env!, "/server/queries/spaces/resolve", {
      household_id: env!.householdId,
      query: q,
    });
    expect(out.ok).toBe(true);
    expect(isMatchType(out.match_type)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "candidates")).toBe(true);
  });

  smoke("POST /server/queries/chores/count returns a structured response", async () => {
    const out = await postJson(env!, "/server/queries/chores/count", {
      household_id: env!.householdId,
      filters: {},
    });
    expect(out.ok).toBe(true);
    expect(isMatchType(out.match_type)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "chore_count")).toBe(true);
  });

  smoke("POST /server/queries/chores/group_by_status returns a structured response", async () => {
    const out = await postJson(env!, "/server/queries/chores/group_by_status", {
      household_id: env!.householdId,
      filters: {},
    });
    expect(out.ok).toBe(true);
    expect(isMatchType(out.match_type)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "result")).toBe(true);
  });

  smoke("POST /server/queries/chores/group_by_assignee returns a structured response", async () => {
    const out = await postJson(env!, "/server/queries/chores/group_by_assignee", {
      household_id: env!.householdId,
      filters: {},
    });
    expect(out.ok).toBe(true);
    expect(isMatchType(out.match_type)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "result")).toBe(true);
  });

  smoke("POST /server/queries/chores/list_enriched returns a structured response", async () => {
    const out = await postJson(env!, "/server/queries/chores/list_enriched", {
      household_id: env!.householdId,
      filters: {},
      limit: 5,
    });
    expect(out.ok).toBe(true);
    expect(isMatchType(out.match_type)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "result")).toBe(true);
  });
});
