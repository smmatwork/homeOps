import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "@supabase/supabase-js";
import * as kv from "./kv_store.ts";

type HonoEnv = {
  Variables: {
    actor_user_id?: string;
  };
};

type _MaybeSingleResult = {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
};

type _SupabaseMaybeSingleQuery = {
  select: (columns: string) => _SupabaseMaybeSingleQuery;
  eq: (column: string, value: string) => _SupabaseMaybeSingleQuery;
  maybeSingle: () => Promise<_MaybeSingleResult>;
};

type _SupabaseDynamicFrom = {
  from: (table: string) => _SupabaseMaybeSingleQuery;
};

const app = new Hono<HonoEnv>();
const api = new Hono<HonoEnv>();

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function sanitizeLangfuseChatInput(
  msgs: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): { message_count: number; last_user: string | null; messages_tail: Array<{ role: string; content: string }> } {
  const tail = msgs.slice(-12).map((m) => ({ role: m.role, content: (m.content || "").slice(0, 1000) }));
  let lastUser: string | null = null;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role === "user") {
      lastUser = (m.content || "").slice(0, 500);
      break;
    }
  }
  return { message_count: msgs.length, last_user: lastUser, messages_tail: tail };
}

async function ensureLangfuseTraceId(c: any, seed: string): Promise<string> {
  const incoming = (c.req.header("x-langfuse-trace-id") ?? "").trim();
  if (isHex32(incoming)) return incoming.toLowerCase();
  const derived = await makeLangfuseTraceId(seed);
  return isHex32(derived) ? derived.toLowerCase() : "";
}

async function makeLangfuseTraceId(seed: string): Promise<string> {
  const s = (seed || "").trim();
  const base = s || crypto.randomUUID();
  const hex = await sha256Hex(base);
  return hex.slice(0, 32);
}

function optionalEnv(name: string): string {
  const raw = Deno.env.get(name);
  if (!raw) return "";
  const trimmed = raw.trim();
  return trimmed.replace(/^"(.*)"$/, "$1");
}

function base64Encode(text: string): string {
  try {
    return btoa(text);
  } catch {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
}

function isHex32(s: string): boolean {
  return /^[0-9a-f]{32}$/i.test(s || "");
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || "");
}

function devActorUserIdFromRequest(c: { req: { header: (name: string) => string | undefined } }): string {
  const override = (optionalEnv("DEV_USER_ID") || "").trim();
  if (override && isUuid(override)) return override;

  const hdr = (c.req.header("x-user-id") ?? "").trim();
  if (hdr && isUuid(hdr)) return hdr;

  // Stable placeholder UUID for local dev bypass mode.
  return "00000000-0000-0000-0000-000000000001";
}

let _langfuseDebugMissingEnvLogged = false;
let _langfuseEnvPresenceLogged = false;

async function langfuseIngest(batch: unknown[]): Promise<void> {
  const publicKey = optionalEnv("LANGFUSE_PUBLIC_KEY");
  const secretKey = optionalEnv("LANGFUSE_SECRET_KEY");
  const baseUrl = (optionalEnv("LANGFUSE_BASE_URL") || optionalEnv("LANGFUSE_HOST") || "").trim();
  const debugRaw = (optionalEnv("LANGFUSE_DEBUG") || "").trim().toLowerCase();
  const debug = debugRaw === "1" || debugRaw === "true" || debugRaw === "yes" || debugRaw === "y" || debugRaw === "on";
  if ((!publicKey || !secretKey || !baseUrl) && debug && !_langfuseDebugMissingEnvLogged) {
    _langfuseDebugMissingEnvLogged = true;
    try {
      console.log("langfuse_ingest_skipped_missing_env", {
        hasPublicKey: Boolean(publicKey),
        hasSecretKey: Boolean(secretKey),
        hasBaseUrl: Boolean(baseUrl),
      });
    } catch {
      // ignore
    }
  }
  if (!publicKey || !secretKey) return;
  if (!baseUrl) return;
  if (!Array.isArray(batch) || batch.length === 0) return;

  const url = baseUrl.replace(/\/+$/, "") + "/api/public/ingestion";
  const auth = base64Encode(`${publicKey}:${secretKey}`);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ batch }),
    });
    if (debug) {
      const text = await resp.text().catch(() => "");
      try {
        console.log("langfuse_ingest_debug", { status: resp.status, body: text.slice(0, 2000) });
      } catch {
        // ignore
      }
      return;
    }
    if (resp.status === 207 || resp.status >= 400) {
      const text = await resp.text().catch(() => "");
      try {
        console.log("langfuse_ingest_response", { status: resp.status, body: text.slice(0, 4000) });
      } catch {
        // ignore
      }
    }
  } catch {
    try {
      console.log("langfuse_ingest_failed");
    } catch {
      // ignore
    }
    return;
  }
}

function requiredEnv(name: string): string {
  const raw = Deno.env.get(name);
  if (!raw) throw new Error(`Missing required env var: ${name}`);
  const trimmed = raw.trim();
  return trimmed.replace(/^"(.*)"$/, "$1");
}

function requiredAnyEnv(names: string[]): string {
  for (const n of names) {
    const raw = Deno.env.get(n);
    if (raw && raw.trim()) return raw.trim().replace(/^"(.*)"$/, "$1");
  }
  throw new Error(`Missing required env var: ${names.join(" or ")}`);
}

function escapePostgrestLike(s: string): string {
  return String(s || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function parseRegexAlternation(pattern: string): string[] {
  const raw = String(pattern || "").trim();
  if (!raw) return [];
  return raw
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 10);
}

type WhereValue =
  | null
  | string
  | number
  | boolean
  | { $regex?: unknown; $options?: unknown }
  | Record<string, unknown>;

function applyToolWhere(
  q: any,
  whereRaw: unknown,
): any {
  if (!whereRaw || typeof whereRaw !== "object" || Array.isArray(whereRaw)) return q;
  const where = whereRaw as Record<string, WhereValue>;

  const orParts: string[] = [];

  for (const [field, cond] of Object.entries(where)) {
    if (cond === null) {
      q = q.is(field, null);
      continue;
    }
    if (typeof cond === "string" || typeof cond === "number" || typeof cond === "boolean") {
      q = q.eq(field, cond);
      continue;
    }
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const obj = cond as { $regex?: unknown; $options?: unknown };
      if (typeof obj.$regex === "string") {
        const tokens = parseRegexAlternation(obj.$regex);
        if (tokens.length > 0) {
          const opt = typeof obj.$options === "string" ? obj.$options : "";
          const caseInsensitive = /i/i.test(opt);
          for (const t of tokens) {
            const pat = `%${escapePostgrestLike(t)}%`;
            orParts.push(`${field}.${caseInsensitive ? "ilike" : "like"}.${pat}`);
          }
          continue;
        }
      }
    }
  }

  if (orParts.length > 0) {
    q = q.or(orParts.join(","));
  }

  return q;
}

type ToolName = "db.select" | "db.insert" | "db.update" | "db.delete" | "query.rpc";
type ToolTable =
  | "chores"
  | "helpers"
  | "alerts"
  | "member_time_off"
  | "chore_helper_assignments"
  | "helper_feedback"
  | "helper_rewards"
  | "helper_reward_snapshots"
  | "home_profiles"
  | "households"
  | "household_members"
  | "profiles"
  | "agent_audit_log"
  | "support_audit_log"
  // Phase 1.0 helper module + assignment engine tables.
  | "helper_invites"
  | "helper_consents"
  | "helper_compensation_ledger"
  | "helper_outreach_attempts"
  | "assignment_rules"
  | "assignment_strategy_weights"
  | "assignment_decisions"
  | "assignment_overrides"
  | "pattern_elicitation_state";

type ToolCall = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  reason?: string;
};

function normalizeChoreTextFromUserUtterance(text: string): { title: string; description: string } {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const cleaned = raw
    .replace(/^please\s+/i, "")
    .replace(/^(add|create|make|set up)\s+(a\s+)?chore\s+((to|for)\s+)?/i, "")
    .replace(/^add\s+chore\s+(to\s+)?/i, "")
    .trim();

  const finalText0 = cleaned || raw || "Chore";
  const gerundMatch = finalText0.match(/^([A-Za-z]+ing)\s+(.*)$/);
  const finalText = (() => {
    if (!gerundMatch) return finalText0;
    const verbIng = gerundMatch[1];
    const rest = gerundMatch[2];
    if (!verbIng || !rest) return finalText0;

    const lower = verbIng.toLowerCase();
    const irregular: Record<string, string> = {
      making: "make",
      taking: "take",
      having: "have",
      doing: "do",
      lying: "lie",
      dying: "die",
      tying: "tie",
    };
    if (lower in irregular) {
      return `${irregular[lower]} ${rest}`.trim();
    }

    let stem = verbIng.slice(0, -3);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      stem = stem.slice(0, -1);
    }
    if (!stem) return finalText0;
    return `${stem} ${rest}`.trim();
  })();
  const titleRaw = finalText.replace(/[.?!]+\s*$/, "").trim();
  const title = titleRaw ? titleRaw.charAt(0).toUpperCase() + titleRaw.slice(1) : "Chore";
  return {
    title: title.slice(0, 120) || "Chore",
    description: finalText,
  };
}

const TOOL_ALLOWLIST: Record<ToolTable, { select: boolean; insert: boolean; update: boolean; delete: boolean }> = {
  chores: { select: true, insert: true, update: true, delete: true },
  helpers: { select: true, insert: true, update: true, delete: true },
  alerts: { select: true, insert: true, update: true, delete: true },
  member_time_off: { select: true, insert: true, update: true, delete: true },
  chore_helper_assignments: { select: true, insert: true, update: false, delete: false },
  helper_feedback: { select: true, insert: true, update: false, delete: false },
  helper_rewards: { select: true, insert: true, update: true, delete: true },
  helper_reward_snapshots: { select: true, insert: true, update: false, delete: false },
  home_profiles: { select: true, insert: true, update: false, delete: false },
  households: { select: true, insert: false, update: false, delete: false },
  household_members: { select: true, insert: false, update: false, delete: false },
  profiles: { select: true, insert: false, update: true, delete: false },
  agent_audit_log: { select: true, insert: false, update: false, delete: false },
  support_audit_log: { select: true, insert: false, update: false, delete: false },
  // Phase 1.0 helper module + assignment engine tables.
  // Owner capabilities only — helper-side writes to consents/ledger
  // go through a separate magic-link flow in P1.1b.
  helper_invites: { select: true, insert: true, update: true, delete: false },
  helper_consents: { select: true, insert: false, update: false, delete: false },
  helper_compensation_ledger: { select: true, insert: true, update: true, delete: false },
  helper_outreach_attempts: { select: true, insert: false, update: false, delete: false },
  assignment_rules: { select: true, insert: true, update: true, delete: true },
  assignment_strategy_weights: { select: true, insert: true, update: true, delete: false },
  assignment_decisions: { select: true, insert: false, update: false, delete: false },
  assignment_overrides: { select: true, insert: false, update: true, delete: false },
  pattern_elicitation_state: { select: true, insert: true, update: true, delete: false },
};

function isToolName(v: unknown): v is ToolName {
  return v === "db.select" || v === "db.insert" || v === "db.update" || v === "db.delete" || v === "query.rpc";
}

type RpcName =
  | "count_chores_assigned_to"
  | "apply_chore_assignments"
  | "assign_or_create_chore"
  | "complete_chore_by_query"
  | "reassign_chore_by_query"
  | "resolve_helper"
  | "resolve_space"
  | "count_chores"
  | "group_chores_by_status"
  | "group_chores_by_assignee"
  | "list_chores_enriched"
  | "find_chores_matching_keywords"
  | "apply_assignment_decision"
  | "record_assignment_override"
  | "find_chores_needing_reassignment"
  | "compensation_ledger_summary"
  | "bulk_reassign_chores_by_query"
  | "add_space_to_profile";

function isRpcName(v: unknown): v is RpcName {
  return (
    v === "count_chores_assigned_to" ||
    v === "apply_chore_assignments" ||
    v === "assign_or_create_chore" ||
    v === "complete_chore_by_query" ||
    v === "reassign_chore_by_query" ||
    v === "resolve_helper" ||
    v === "resolve_space" ||
    v === "count_chores" ||
    v === "group_chores_by_status" ||
    v === "group_chores_by_assignee" ||
    v === "list_chores_enriched" ||
    v === "find_chores_matching_keywords" ||
    v === "apply_assignment_decision" ||
    v === "record_assignment_override" ||
    v === "find_chores_needing_reassignment" ||
    v === "compensation_ledger_summary" ||
    v === "bulk_reassign_chores_by_query" ||
    v === "add_space_to_profile"
  );
}

function isToolTable(v: unknown): v is ToolTable {
  return (
    v === "chores" ||
    v === "helpers" ||
    v === "alerts" ||
    v === "member_time_off" ||
    v === "chore_helper_assignments" ||
    v === "helper_feedback" ||
    v === "helper_rewards" ||
    v === "helper_reward_snapshots" ||
    v === "home_profiles" ||
    v === "households" ||
    v === "household_members" ||
    v === "profiles" ||
    v === "agent_audit_log" ||
    v === "support_audit_log"
  );
}

function summarizeTableRows(table: ToolTable, rows: unknown[]): string {
  const count = rows.length;
  if (count === 0) {
    if (table === "chores") return "You don’t have any chores yet.";
    if (table === "helpers") return "You don’t have any helpers added yet.";
    if (table === "alerts") return "You don’t have any alerts right now.";
    if (table === "home_profiles") return "Your home profile isn’t set up yet.";
    if (table === "household_members") return "No one is linked to this home yet.";
    if (table === "households") return "Nothing found yet.";
    if (table === "member_time_off") return "No time off entries found.";
    if (table === "chore_helper_assignments") return "No helper assignment history found.";
    if (table === "helper_feedback") return "No helper feedback found.";
    if (table === "helper_rewards") return "No helper rewards found.";
    if (table === "helper_reward_snapshots") return "No helper reward snapshots found.";
    if (table === "agent_audit_log" || table === "support_audit_log") return "No activity yet.";
    return "Nothing found yet.";
  }

  const head = rows.slice(0, 10);
  const asRecord = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  if (table === "helpers") {
    return (
      `Found ${count} helpers:\n` +
      head
        .map((h) => {
          const r = asRecord(h);
          const name = r.name ?? "(no name)";
          const type = r.type ? ` (${r.type})` : "";
          const phone = r.phone ? ` — ${r.phone}` : "";
          return `- ${name}${type}${phone}`;
        })
        .join("\n")
    );
  }
  if (table === "chores") {
    return (
      `Found ${count} chores:\n` +
      head
        .map((c) => {
          const r = asRecord(c);
          const title = r.title ?? "(no title)";
          const status = r.status ? ` [${r.status}]` : "";
          const due = r.due_at ? ` (due ${r.due_at})` : "";
          return `- ${title}${status}${due}`;
        })
        .join("\n")
    );
  }
  if (table === "alerts") {
    return (
      `Found ${count} alerts:\n` +
      head
        .map((a) => {
          const r = asRecord(a);
          const title = r.title ?? "(no title)";
          const severity = r.severity ? ` [${r.severity}]` : "";
          return `- ${title}${severity}`;
        })
        .join("\n")
    );
  }
  if (table === "member_time_off") {
    return (
      `Found ${count} time off entries:\n` +
      head
        .map((row) => {
          const r = asRecord(row);
          const kind = r.member_kind ?? "member";
          const ref = r.helper_id ?? r.person_id ?? "?";
          const start = r.start_at ?? "?";
          const end = r.end_at ?? "?";
          return `- ${kind}=${ref} (${start} → ${end})`;
        })
        .join("\n")
    );
  }
  if (table === "chore_helper_assignments") {
    return (
      `Found ${count} helper assignment events:\n` +
      head
        .map((row) => {
          const r = asRecord(row);
          const action = r.action ?? "?";
          const choreId = r.chore_id ?? "?";
          const helperId = r.helper_id ?? "(unassigned)";
          const at = r.created_at ?? "";
          return `- ${action} chore=${choreId} helper=${helperId}${at ? ` (${at})` : ""}`;
        })
        .join("\n")
    );
  }
  if (table === "helper_feedback") {
    return (
      `Found ${count} helper feedback entries:\n` +
      head
        .map((row) => {
          const r = asRecord(row);
          const helperId = r.helper_id ?? "?";
          const rating = r.rating ?? "?";
          const at = r.occurred_at ?? r.created_at ?? "";
          return `- helper=${helperId} rating=${rating}${at ? ` (${at})` : ""}`;
        })
        .join("\n")
    );
  }
  if (table === "helper_rewards") {
    return (
      `Found ${count} helper rewards:\n` +
      head
        .map((row) => {
          const r = asRecord(row);
          const helperId = r.helper_id ?? "?";
          const quarter = r.quarter ?? "?";
          const kind = r.reward_type ?? "?";
          const amount = r.amount ?? "";
          return `- helper=${helperId} quarter=${quarter} type=${kind}${amount ? ` amount=${amount}` : ""}`;
        })
        .join("\n")
    );
  }
  if (table === "helper_reward_snapshots") {
    return (
      `Found ${count} helper reward snapshots:\n` +
      head
        .map((row) => {
          const r = asRecord(row);
          const helperId = r.helper_id ?? "?";
          const quarter = r.quarter ?? "?";
          const avg = r.avg_rating ?? "";
          const leaveDays = r.leave_days ?? "";
          return `- helper=${helperId} quarter=${quarter}${avg ? ` avg_rating=${avg}` : ""}${leaveDays ? ` leave_days=${leaveDays}` : ""}`;
        })
        .join("\n")
    );
  }
  if (table === "home_profiles") {
    const hp = asRecord(rows[0]);
    const homeType = hp.home_type ?? "(unknown)";
    const bhk = typeof hp.bhk === "number" ? hp.bhk : hp.bhk ?? "?";
    const balcony = hp.has_balcony ? "Yes" : "No";
    const pets = hp.has_pets ? "Yes" : "No";
    const kids = hp.has_kids ? "Yes" : "No";
    const sqft = typeof hp.square_feet === "number" ? `\n- Area: ${hp.square_feet} sq ft` : "";
    const floors = typeof hp.floors === "number" ? `\n- Floors: ${hp.floors}` : "";
    const spacesCount = Array.isArray(hp.spaces) ? hp.spaces.length : null;
    const spaces = typeof spacesCount === "number" && spacesCount > 0 ? `\n- Extra spaces: ${spacesCount}` : "";
    const counts = hp.space_counts && typeof hp.space_counts === "object" ? hp.space_counts : null;
    const countsObj = counts && !Array.isArray(counts) ? (counts as Record<string, unknown>) : null;
    const balconyCount = countsObj && typeof countsObj.balcony === "number" ? countsObj.balcony : null;
    const terraceCount = countsObj && typeof countsObj.terrace === "number" ? countsObj.terrace : null;
    const countsLine =
      typeof balconyCount === "number" || typeof terraceCount === "number"
        ? `\n- Counts: ${typeof balconyCount === "number" ? `balconies=${balconyCount}` : ""}${
            typeof balconyCount === "number" && typeof terraceCount === "number" ? ", " : ""
          }${typeof terraceCount === "number" ? `terraces=${terraceCount}` : ""}`
        : "";
    const flooring = hp.flooring_type ? `\n- Flooring: ${hp.flooring_type}` : "";
    const baths = typeof hp.num_bathrooms === "number" ? `\n- Bathrooms: ${hp.num_bathrooms}` : "";
    return (
      "Here’s your current home profile:\n" +
      `- Type: ${homeType}\n` +
      `- BHK: ${bhk}\n` +
      `- Balcony: ${balcony}\n` +
      `- Pets: ${pets}\n` +
      `- Kids: ${kids}` +
      sqft +
      floors +
      spaces +
      countsLine +
      flooring +
      baths
    );
  }
  if (table === "household_members") {
    return (
      `Found ${count} household members:\n` +
      head
        .map((m) => {
          const r = asRecord(m);
          return `- ${r.user_id ?? "?"}${r.role ? ` (${r.role})` : ""}`;
        })
        .join("\n")
    );
  }
  if (table === "profiles") {
    return (
      `Found ${count} profiles:\n` +
      head
        .map((p) => {
          const r = asRecord(p);
          const name = r.full_name ?? "(no name)";
          return `- ${name} — ${r.id ?? "?"}`;
        })
        .join("\n")
    );
  }
  if (table === "households") {
    return (
      `Found ${count} households:\n` +
      head
        .map((h) => {
          const r = asRecord(h);
          return `- ${r.name ?? "(no name)"} — ${r.id ?? "?"}`;
        })
        .join("\n")
    );
  }
  if (table === "agent_audit_log" || table === "support_audit_log") {
    return `Found ${count} audit log rows in ${table}. Showing latest ${Math.min(10, count)}.`;
  }
  return `Found ${count} rows in ${table}.`;
}

const supabaseAdmin = () =>
  createClient(
    requiredAnyEnv(["SB_URL", "SUPABASE_URL"]),
    requiredAnyEnv(["SB_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]),
  );

const SUPPORTED_PATCH_TABLES = new Set([
  "chores",
  "alerts",
  "helpers",
  "member_time_off",
  "helper_rewards",
  "profiles",
]);

const SUPPORTED_AGENT_TABLES = new Set([
  "chores",
  "alerts",
  "helpers",
  "member_time_off",
  "chore_helper_assignments",
  "helper_feedback",
  "helper_rewards",
  "helper_reward_snapshots",
  "profiles",
]);

const FORBIDDEN_PATCH_COLUMNS = new Set([
  "id",
  // High-risk fields that commonly control tenancy/ownership. Remove if you truly want to allow them.
  "household_id",
  "created_by",
  "user_id",
  "created_at",
  "updated_at",
]);

function getBearerToken(req: Request): string | null {
  // Our clients send the user JWT in x-user-authorization, while the standard
  // Authorization header is reserved for the Supabase anon key.
  const header =
    req.headers.get("x-user-authorization") ??
    req.headers.get("X-User-Authorization") ??
    req.headers.get("authorization") ??
    req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function validatePatch(patch: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_PATCH_COLUMNS.has(key)) {
      return { ok: false, reason: `Column '${key}' cannot be patched.` };
    }
  }
  return { ok: true };
}

type ChatScope = "user" | "household";

function parseChatScope(raw: string | null): ChatScope | null {
  const v = (raw ?? "").trim();
  if (v === "user" || v === "household") return v;
  return null;
}

function assertMessagesArray(raw: unknown): Array<{ role: "system" | "user" | "assistant"; content: string }> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "system" && role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string" || !content.trim()) return null;
    out.push({ role, content: content });

  }
  return out;
}

api.post("/tools/execute", async (c) => {
  const token = getBearerToken(c.req.raw);
  const admin = supabaseAdmin();

  // Normal path: frontend requests are authorized with a bearer token.
  // Internal path (manager pattern): agent-service may execute tools without a user bearer token,
  // but must present the shared x-agent-service-key and a concrete x-user-id.
  const internalKey = (c.req.header("x-agent-service-key") ?? "").trim();
  const expectedInternalKey = (optionalEnv("AGENT_SERVICE_KEY") || "").trim();
  const internalUserId = (c.req.header("x-user-id") ?? "").trim();

  const isInternal = !token && Boolean(expectedInternalKey) && internalKey === expectedInternalKey && Boolean(internalUserId);
  if (!token && !isInternal) return c.json({ error: "Missing authorization header" }, 401);

  const actorUserId = isInternal ? internalUserId : await getAuthedUserId(admin, token as string);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);
  try {
    c.set("actor_user_id", actorUserId);
  } catch {
    // ignore
  }

  let body: { household_id?: string; scope?: string; tool_call?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    console.error("tools.execute forbidden: user is not a member of household", {
      actorUserId,
      householdId,
      error: (memberCheck as { error?: string }).error,
    });
    return c.json({ error: memberCheck.error ?? "You don't have permission to access this home. Please open 'Setup & Connection' and click 'Set up my home'." }, 403);
  }

  if (!body.tool_call || typeof body.tool_call !== "object" || Array.isArray(body.tool_call)) {
    return c.json({ error: "Missing tool_call" }, 400);
  }
  const tc = body.tool_call as Partial<ToolCall>;
  if (typeof tc.id !== "string" || !tc.id.trim()) return c.json({ error: "tool_call.id is required" }, 400);
  if (!isToolName(tc.tool)) return c.json({ error: "Unsupported tool" }, 400);
  if (!tc.args || typeof tc.args !== "object" || Array.isArray(tc.args)) return c.json({ error: "tool_call.args is required" }, 400);

  const reqId = (c.req.header("x-request-id") ?? "").trim();
  const convId = (c.req.header("x-conversation-id") ?? "").trim();
  const sessId = (c.req.header("x-session-id") ?? "").trim();
  const langfuseSessionId = sessId || convId || reqId;
  const langfuseTraceSeed = convId || sessId || reqId || `${Date.now()}`;
  const lfTraceId = await ensureLangfuseTraceId(c, langfuseTraceSeed);

  const traceNowIso = new Date().toISOString();
  if (lfTraceId) {
    await langfuseIngest([
      {
        id: crypto.randomUUID(),
        timestamp: traceNowIso,
        type: "trace-create",
        body: {
          id: lfTraceId,
          timestamp: traceNowIso,
          name: "edge.tools.execute",
          environment: optionalEnv("LANGFUSE_ENV") || optionalEnv("NODE_ENV") || "default",
          userId: actorUserId || null,
          sessionId: langfuseSessionId || null,
          input: {
            request_id: reqId || null,
            conversation_id: convId || null,
          },
          metadata: {
            request_id: reqId || undefined,
            conversation_id: convId || undefined,
            session_id: langfuseSessionId || undefined,
          },
          tags: [],
          public: false,
        },
      },
    ]);
  }

  const toolSpanId = lfTraceId
    ? (await sha256Hex(`span:tools.execute:${langfuseTraceSeed}:${crypto.randomUUID()}`)).slice(0, 16)
    : "";
  const toolSpanStartIso = new Date().toISOString();
  if (lfTraceId && toolSpanId) {
    await langfuseIngest([
      {
        id: crypto.randomUUID(),
        timestamp: toolSpanStartIso,
        type: "span-create",
        body: {
          id: toolSpanId,
          traceId: lfTraceId,
          name: "edge.tools.execute",
          startTime: toolSpanStartIso,
          environment: optionalEnv("LANGFUSE_ENV") || optionalEnv("NODE_ENV") || "default",
          input: {
            tool: tc.tool,
            tool_call_id: tc.id,
            rpc: tc.tool === "query.rpc" ? (tc.args as any)?.name : null,
            table: tc.tool !== "query.rpc" ? (tc.args as any)?.table : null,
          },
          metadata: {
            request_id: reqId || undefined,
            conversation_id: convId || undefined,
            session_id: langfuseSessionId || undefined,
            actor_user_id: actorUserId || undefined,
            household_id: householdId || undefined,
          },
        },
      },
    ]);
  }

  // query.rpc: run allowlisted Postgres RPCs server-side.
  if (tc.tool === "query.rpc") {
    const args = tc.args as Record<string, unknown>;
    const name = args.name;
    const paramsRaw = args.params;
    if (!isRpcName(name)) return c.json({ error: "Unsupported rpc name" }, 400);
    if (paramsRaw !== undefined && (typeof paramsRaw !== "object" || paramsRaw === null || Array.isArray(paramsRaw))) {
      return c.json({ error: "query.rpc requires args.params to be an object" }, 400);
    }

    const params = (paramsRaw && typeof paramsRaw === "object" ? (paramsRaw as Record<string, unknown>) : {}) as Record<string, unknown>;

    // Backward-compat: older tool-call templates used separate params like p_status.
    // Our curated analytics RPCs accept a single p_filters jsonb.
    if ((name === "count_chores" || name === "group_chores_by_status" || name === "group_chores_by_assignee" || name === "list_chores_enriched") && !("p_filters" in params)) {
      const legacyStatus = typeof (params as any).p_status === "string" ? String((params as any).p_status).trim() : "";
      const legacyHelperId = typeof (params as any).p_helper_id === "string" ? String((params as any).p_helper_id).trim() : "";
      const legacySpace = typeof (params as any).p_space === "string" ? String((params as any).p_space).trim() : "";
      const legacyOverdue = (params as any).p_overdue;

      const filters: Record<string, unknown> = {};
      if (legacyStatus) filters.status = legacyStatus;
      if (legacyHelperId) filters.helper_id = legacyHelperId;
      if (legacySpace) filters.space = legacySpace;
      if (legacyOverdue === true) filters.overdue = true;

      if (Object.keys(filters).length > 0) {
        (params as any).p_filters = filters;
      }
      delete (params as any).p_status;
      delete (params as any).p_helper_id;
      delete (params as any).p_space;
      delete (params as any).p_overdue;
    }
    // Enforce household + actor in RPC params.
    const rpcParams: Record<string, unknown> = {
      ...params,
      p_household_id: householdId,
      p_actor_user_id: actorUserId,
    };

    const rpcSpanId = lfTraceId
      ? (await sha256Hex(`span:tools.execute.rpc:${langfuseTraceSeed}:${name}:${crypto.randomUUID()}`)).slice(0, 16)
      : "";
    const rpcSpanStartIso = new Date().toISOString();
    if (lfTraceId && rpcSpanId) {
      await langfuseIngest([
        {
          id: crypto.randomUUID(),
          timestamp: rpcSpanStartIso,
          type: "span-create",
          body: {
            id: rpcSpanId,
            traceId: lfTraceId,
            name: `db.rpc.${name}`,
            startTime: rpcSpanStartIso,
            environment: optionalEnv("LANGFUSE_ENV") || optionalEnv("NODE_ENV") || "default",
            input: {
              name,
              params_keys: Object.keys(rpcParams || {}).slice(0, 40),
            },
          },
        },
      ]);
    }

    const { data, error } = await admin.rpc(name, rpcParams);
    if (error) {
      console.error("tools.execute query.rpc failed", {
        rpc: name,
        householdId,
        actorUserId,
        error: error.message,
      });
      const rpcSpanEndIso = new Date().toISOString();
      if (lfTraceId && rpcSpanId) {
        await langfuseIngest([
          {
            id: crypto.randomUUID(),
            timestamp: rpcSpanEndIso,
            type: "span-update",
            body: {
              id: rpcSpanId,
              traceId: lfTraceId,
              endTime: rpcSpanEndIso,
              output: { ok: false, error: error.message },
              statusMessage: error.message,
            },
          },
        ]);
      }
      const toolSpanEndIso = new Date().toISOString();
      if (lfTraceId && toolSpanId) {
        await langfuseIngest([
          {
            id: crypto.randomUUID(),
            timestamp: toolSpanEndIso,
            type: "span-update",
            body: {
              id: toolSpanId,
              traceId: lfTraceId,
              endTime: toolSpanEndIso,
              output: { ok: false, error: error.message },
              statusMessage: error.message,
            },
          },
        ]);
      }
      return c.json(
        {
          ok: false,
          tool_call_id: tc.id,
          error: { message: error.message },
          result: null,
        },
        200,
      );
    }

    const rpcSpanEndIso = new Date().toISOString();
    if (lfTraceId && rpcSpanId) {
      await langfuseIngest([
        {
          id: crypto.randomUUID(),
          timestamp: rpcSpanEndIso,
          type: "span-update",
          body: {
            id: rpcSpanId,
            traceId: lfTraceId,
            endTime: rpcSpanEndIso,
            output: { ok: true },
          },
        },
      ]);
    }

    const payload = Array.isArray(data) ? (data.length === 1 ? data[0] : data) : data;
    let summary = `RPC ${name} executed.`;

    const asRecord = (v: unknown): Record<string, unknown> =>
      v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const toStr = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
    const tryBuildClarificationSummary = (rpcPayload: unknown): string | null => {
      const obj = asRecord(rpcPayload);
      const action = toStr(obj.action).trim();
      if (!action) return null;

      const pickList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
      const candList = pickList(obj.candidates);
      const helperCandList = pickList(obj.helper_candidates);
      const choreCandList = pickList(obj.chore_candidates);

      const listForAction = (kind: "helper" | "chore"): unknown[] => {
        if (kind === "helper") {
          return helperCandList.length > 0 ? helperCandList : candList;
        }
        return choreCandList.length > 0 ? choreCandList : candList;
      };

      if (action === "clarify_helper") {
        const options = listForAction("helper")
          .map((c) => {
            const r = asRecord(c);
            const id = toStr(r.id).trim();
            const nm = toStr(r.name).trim();
            const label = nm || id;
            return label ? (id && nm ? `${nm} (${id})` : label) : "";
          })
          .filter(Boolean)
          .slice(0, 10);
        if (options.length === 0) return null;
        const clarification = {
          clarification: {
            kind: "helper_selection",
            title: "Which helper did you mean?",
            required: true,
            multi: false,
            options,
          },
        };
        return "```json\n" + JSON.stringify(clarification, null, 2) + "\n```";
      }

      if (action === "clarify_chore") {
        const options = listForAction("chore")
          .map((c) => {
            const r = asRecord(c);
            const id = toStr(r.id).trim();
            const title = toStr(r.title).trim();
            const dueAt = toStr(r.due_at).trim();
            const base = title || id;
            if (!base) return "";
            const duePart = dueAt ? ` — due ${dueAt}` : "";
            return id && title ? `${title} (${id})${duePart}` : `${base}${duePart}`;
          })
          .filter(Boolean)
          .slice(0, 10);
        if (options.length === 0) return null;
        const clarification = {
          clarification: {
            kind: "chore_selection",
            title: "Which chore did you mean?",
            required: true,
            multi: false,
            options,
          },
        };
        return "```json\n" + JSON.stringify(clarification, null, 2) + "\n```";
      }

      return null;
    };

    try {
      const clar = tryBuildClarificationSummary(payload);
      if (clar) {
        summary = clar;
      } else {
        const json = JSON.stringify(payload);
        summary = json.length > 1800 ? `RPC ${name} result: ${json.slice(0, 1800)}…` : `RPC ${name} result: ${json}`;
      }
    } catch {
      // ignore
    }

    const { error: auditErr } = await admin.from("agent_audit_log").insert({
      actor_user_id: actorUserId,
      household_id: householdId,
      table_name: "tools",
      row_ref: { tool_call_id: tc.id, tool: tc.tool, rpc: name },
      action: "patch",
      reason: typeof tc.reason === "string" ? tc.reason : null,
      patch: tc.args,
      before: null,
      after: { summary },
    });
    if (auditErr) {
      return c.json({ ok: false, tool_call_id: tc.id, error: { message: auditErr.message }, result: null }, 200);
    }

    const toolSpanEndIso = new Date().toISOString();
    if (lfTraceId && toolSpanId) {
      await langfuseIngest([
        {
          id: crypto.randomUUID(),
          timestamp: toolSpanEndIso,
          type: "span-update",
          body: {
            id: toolSpanId,
            traceId: lfTraceId,
            endTime: toolSpanEndIso,
            output: { ok: true, tool: tc.tool, rpc: name },
          },
        },
      ]);
    }
    return c.json({ ok: true, tool_call_id: tc.id, summary, result: payload });
  }

  const table = (tc.args as { table?: unknown }).table;
  if (!isToolTable(table)) return c.json({ error: "Unsupported table" }, 400);

  const perms = TOOL_ALLOWLIST[table];
  const op = tc.tool.split(".")[1] as "select" | "insert" | "update" | "delete";
  if (!perms[op]) return c.json({ error: `Operation not allowed for table '${table}'` }, 403);

  // Execute
  let summary = "";
  let payload: any = null;

  if (tc.tool === "db.select") {
    const limitRaw = (tc.args as Record<string, unknown>).limit;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 25;

    // Force household scoping where it applies
    if (table === "profiles") {
      // Only profiles for members of the household
      const { data: members, error: memErr } = await admin
        .from("household_members")
        .select("user_id")
        .eq("household_id", householdId);
      if (memErr) {
        return c.json(
          { ok: false, tool_call_id: tc.id, error: { message: memErr.message }, result: null },
          200,
        );
      }
      const ids = (members ?? [])
        .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).user_id : null))
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      const { data, error } = await admin
        .from("profiles")
        .select("id, full_name, avatar_url")
        .in("id", ids)
        .limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("profiles", data ?? []);
      payload = data;
    } else if (table === "households") {
      const { data, error } = await admin
        .from("households")
        .select("id, name")
        .eq("id", householdId)
        .limit(1);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("households", data ?? []);
    } else if (table === "household_members") {
      const { data, error } = await admin
        .from("household_members")
        .select("user_id, role")
        .eq("household_id", householdId)
        .limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("household_members", data ?? []);
    } else if (table === "home_profiles") {
      const { data, error } = await admin
        .from("home_profiles")
        .select(
          "household_id, timezone, address, home_type, home_size_sqft, bedrooms, bathrooms, occupants, pets, notes"
        )
        .eq("household_id", householdId)
        .limit(1);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("home_profiles", data ?? []);
    } else if (table === "agent_audit_log") {
      const { data, error } = await admin.from("agent_audit_log").select("*").eq("household_id", householdId).order("created_at", { ascending: false }).limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("agent_audit_log", data ?? []);
    } else if (table === "support_audit_log") {
      const { data, error } = await admin.from("support_audit_log").select("*").eq("household_id", householdId).order("created_at", { ascending: false }).limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("support_audit_log", data ?? []);
    } else if (table === "member_time_off") {
      const { data, error } = await admin
        .from("member_time_off")
        .select("*")
        .eq("household_id", householdId)
        .order("start_at", { ascending: false })
        .limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("member_time_off", data ?? []);
    } else if (table === "chore_helper_assignments") {
      const { data, error } = await admin
        .from("chore_helper_assignments")
        .select("*")
        .eq("household_id", householdId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("chore_helper_assignments", data ?? []);
    } else if (table === "helper_feedback") {
      const { data, error } = await admin
        .from("helper_feedback")
        .select("*")
        .eq("household_id", householdId)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("helper_feedback", data ?? []);
    } else if (table === "helper_rewards") {
      const { data, error } = await admin
        .from("helper_rewards")
        .select("*")
        .eq("household_id", householdId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("helper_rewards", data ?? []);
    } else if (table === "helper_reward_snapshots") {
      const { data, error } = await admin
        .from("helper_reward_snapshots")
        .select("*")
        .eq("household_id", householdId)
        .order("computed_at", { ascending: false })
        .limit(limit);
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = summarizeTableRows("helper_reward_snapshots", data ?? []);
    } else {
      // chores/helpers/alerts are household-scoped
      const args = tc.args as Record<string, unknown>;
      const where = args.where;
      const columnsRaw = typeof args.columns === "string" ? args.columns.trim() : "";

      const defaultSelect =
        table === "helpers"
          ? "id, name, type, phone, created_at"
          : table === "alerts"
            ? "id, title, severity, created_at"
            : "id, title, status, due_at, helper_id, created_at";

      const sanitizeHelperColumns = (raw: string): string => {
        const s = (raw || "").trim();
        if (!s) return "";
        // Block dangerous selects; keep this simple and defensive.
        if (/[()]/.test(s)) return "";
        const allowed = new Set(["id", "name", "type", "phone", "created_at"]);
        const cols = s
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
          // Disallow qualified names and aliases.
          .map((c) => c.split(/\s+/)[0])
          .filter((c) => allowed.has(c));
        return cols.join(", ");
      };

      const wantsCount = /\bcount\s*\(/i.test(columnsRaw);

      if (wantsCount) {
        // Guardrail: models sometimes emit helper_id as a helper NAME when asking for counts.
        // chores.helper_id is a UUID, so this would error. Route to the curated RPC instead.
        const whereObj = where && typeof where === "object" && !Array.isArray(where) ? (where as Record<string, unknown>) : null;
        const helperIdMaybe = whereObj ? whereObj.helper_id : undefined;
        const looksLikeUuid = (v: unknown): boolean =>
          typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
        if (table === "chores" && typeof helperIdMaybe === "string" && helperIdMaybe.trim() && !looksLikeUuid(helperIdMaybe)) {
          const helperName = helperIdMaybe.trim();
          const { data, error } = await admin.rpc("count_chores_assigned_to", {
            p_household_id: householdId,
            p_actor_user_id: actorUserId,
            p_helper_name: helperName,
          });
          if (error) {
            console.error("tools.execute count_chores_assigned_to failed", {
              householdId,
              actorUserId,
              helperName,
              error: error.message,
            });
            return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
          }

          const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
          const matchType = typeof row?.match_type === "string" ? String(row?.match_type) : "";
          const choreCount = typeof row?.chore_count === "number" ? row?.chore_count : null;
          if (matchType === "ambiguous") {
            summary = `Multiple helpers match '${helperName}'. Please specify which one.`;
          } else if (matchType === "not_found") {
            summary = `No helper matched '${helperName}'.`;
          } else if (typeof choreCount === "number") {
            summary = `${helperName} has ${choreCount} chores assigned.`;
          } else {
            summary = `Counted chores assigned to ${helperName}.`;
          }
        } else {
          let q = admin.from(table).select("id", { count: "exact", head: true }).eq("household_id", householdId);
          q = applyToolWhere(q, where);
          const { count, error } = await q;
          if (error) {
            console.error("tools.execute db.count failed", {
              householdId,
              actorUserId,
              columns: columnsRaw,
              where,
              error: error.message,
            });
            return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
          }
          summary = `Counted ${count ?? 0} rows in ${table}.`;
        }
      } else {
        const selectColumns = table === "helpers" ? (sanitizeHelperColumns(columnsRaw) || defaultSelect) : (columnsRaw || defaultSelect);
        let q = admin.from(table).select(selectColumns).eq("household_id", householdId);
        q = applyToolWhere(q, where);
        const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
        if (error) {
          console.error("tools.execute db.select failed", {
            table,
            householdId,
            actorUserId,
            columns: selectColumns,
            where,
            limit,
            error: error.message,
          });
          return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
        }
        summary = summarizeTableRows(table, data ?? []);
      }
    }
  }

  if (tc.tool === "db.insert") {
    const record = (tc.args as Record<string, unknown>).record;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return c.json({ error: "db.insert requires args.record" }, 400);
    }
    if (table === "household_members" || table === "households" || table === "agent_audit_log" || table === "support_audit_log") {
      return c.json({ error: `Insert not allowed for table '${table}'` }, 403);
    }
    payload = { ...record, household_id: householdId };
    if (table === "chores") {
      const titleRaw = typeof payload.title === "string" ? String(payload.title) : "";
      const descRaw = typeof payload.description === "string" ? String(payload.description) : "";
      const seed = descRaw.trim() ? descRaw : titleRaw;
      const norm = normalizeChoreTextFromUserUtterance(seed);
      if (titleRaw.trim() && /^(please\s+)?(add|create|make|set up)\s+(a\s+)?chore\b/i.test(titleRaw)) {
        payload.title = norm.title;
      }
      if (descRaw.trim() && /^(please\s+)?(add|create|make|set up)\s+(a\s+)?chore\b/i.test(descRaw)) {
        payload.description = norm.description;
      }
    }
    if (table === "chores" && typeof payload.user_id !== "string") payload.user_id = actorUserId;
    if (table === "chores" && typeof payload.helper_id === "string") {
      const helperCheck = await validateHelperBelongsToHousehold(admin, String(payload.helper_id), householdId);
      if (!helperCheck.ok) return c.json({ error: helperCheck.error }, 400);
    }

    if (
      table === "chore_helper_assignments" ||
      table === "helper_rewards" ||
      table === "helper_reward_snapshots"
    ) {
      const adminCheck = await isHouseholdAdminUser(admin, householdId, actorUserId);
      if (!adminCheck.ok) {
        return c.json({ error: `Only a home admin can manage ${table}.` }, 403);
      }
    }

    if (table === "chore_helper_assignments") {
      const choreId = (payload as Record<string, unknown>).chore_id;
      if (typeof choreId !== "string" || !choreId.trim()) return c.json({ error: "chore_helper_assignments requires chore_id" }, 400);
      const choreCheck = await validateChoreBelongsToHousehold(admin, String(choreId), householdId);
      if (!choreCheck.ok) return c.json({ error: choreCheck.error }, 400);

      const helperId = (payload as Record<string, unknown>).helper_id;
      if (typeof helperId === "string" && helperId.trim()) {
        const helperCheck = await validateHelperBelongsToHousehold(admin, String(helperId), householdId);
        if (!helperCheck.ok) return c.json({ error: helperCheck.error }, 400);
      }
    }

    if (table === "helper_feedback") {
      const helperId = (payload as Record<string, unknown>).helper_id;
      if (typeof helperId !== "string" || !helperId.trim()) return c.json({ error: "helper_feedback requires helper_id" }, 400);
      const helperCheck = await validateHelperBelongsToHousehold(admin, String(helperId), householdId);
      if (!helperCheck.ok) return c.json({ error: helperCheck.error }, 400);

      const choreId = (payload as Record<string, unknown>).chore_id;
      if (typeof choreId === "string" && choreId.trim()) {
        const choreCheck = await validateChoreBelongsToHousehold(admin, String(choreId), householdId);
        if (!choreCheck.ok) return c.json({ error: choreCheck.error }, 400);
      }

      if (typeof (payload as Record<string, unknown>).author_id !== "string") {
        (payload as Record<string, unknown>).author_id = actorUserId;
      }
    }

    if (table === "helper_rewards" || table === "helper_reward_snapshots") {
      const helperId = (payload as Record<string, unknown>).helper_id;
      if (typeof helperId !== "string" || !helperId.trim()) return c.json({ error: `${table} requires helper_id` }, 400);
      const helperCheck = await validateHelperBelongsToHousehold(admin, String(helperId), householdId);
      if (!helperCheck.ok) return c.json({ error: helperCheck.error }, 400);

      if (table === "helper_rewards" && typeof (payload as Record<string, unknown>).awarded_by !== "string") {
        (payload as Record<string, unknown>).awarded_by = actorUserId;
      }
    }

    if (table === "member_time_off") {
      const adminCheck = await isHouseholdAdminUser(admin, householdId, actorUserId);
      if (!adminCheck.ok) {
        return c.json({ error: "Only a home admin can manage time off." }, 403);
      }
    }

    if (table === "home_profiles") {
      const adminCheck = await isHouseholdAdminUser(admin, householdId, actorUserId);
      if (!adminCheck.ok) {
        return c.json({ error: "Only a home admin can update the home profile." }, 403);
      }
      const { error } = await admin.from("home_profiles").upsert(payload, { onConflict: "household_id" });
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = "Saved your home profile.";
    } else {
      const { data: created, error } = await admin.from(table).insert(payload).select("id").maybeSingle();
      if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
      summary = `Inserted 1 row into ${table}. id=${created?.id ?? "(unknown)"}`;
    }
  }

  if (tc.tool === "db.update") {
    const id = (tc.args as Record<string, unknown>).id;
    const patch = (tc.args as Record<string, unknown>).patch;
    if (typeof id !== "string" || !id.trim()) return c.json({ error: "db.update requires args.id" }, 400);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return c.json({ error: "db.update requires args.patch" }, 400);
    if (table === "household_members" || table === "households" || table === "agent_audit_log" || table === "support_audit_log") {
      return c.json({ error: `Update not allowed for table '${table}'` }, 403);
    }
    if (table === "profiles" && id !== actorUserId) return c.json({ error: "Cannot update other users' profiles" }, 403);

    if (table === "member_time_off") {
      const adminCheck = await isHouseholdAdminUser(admin, householdId, actorUserId);
      if (!adminCheck.ok) {
        return c.json({ error: "Only a home admin can manage time off." }, 403);
      }
    }

    const patchValidation = validatePatch(patch as Record<string, unknown>);
    if (!patchValidation.ok) return c.json({ error: patchValidation.reason }, 400);

    const hasHelperIdPatch =
      table === "chores" && Object.prototype.hasOwnProperty.call(patch as Record<string, unknown>, "helper_id");
    const nextHelperIdRaw = hasHelperIdPatch ? (patch as Record<string, unknown>).helper_id : undefined;
    const nextHelperId =
      typeof nextHelperIdRaw === "string" ? nextHelperIdRaw.trim() || null : nextHelperIdRaw === null ? null : undefined;

    let beforeRow: Record<string, unknown> | null = null;

    if (table !== "profiles") {
      const beforeSelect = table === "chores" ? "household_id, helper_id" : "household_id";
      const adminDyn = admin as unknown as _SupabaseDynamicFrom;
      const { data: before, error: beforeErr } = await adminDyn.from(table).select(beforeSelect).eq("id", id).maybeSingle();
      if (beforeErr) {
        return c.json({ ok: false, tool_call_id: tc.id, error: { message: beforeErr.message }, result: null }, 200);
      }
      const beforeObj = before as Record<string, unknown> | null;
      if (!beforeObj || beforeObj.household_id !== householdId) return c.json({ error: "Row not found" }, 404);

      beforeRow = beforeObj;

      if (hasHelperIdPatch) {
        const adminCheck = await isHouseholdAdminUser(admin, householdId, actorUserId);
        if (!adminCheck.ok) {
          return c.json({ error: "Only a home admin can assign chores." }, 403);
        }

        if (nextHelperId !== null && typeof nextHelperId === "string") {
          const helperCheck = await validateHelperBelongsToHousehold(admin, String(nextHelperId), householdId);
          if (!helperCheck.ok) return c.json({ error: helperCheck.error }, 400);
        }
      }
    }

    if (table === "chores" && typeof (patch as Record<string, unknown>).helper_id === "string") {
      const helperCheck = await validateHelperBelongsToHousehold(admin, String((patch as Record<string, unknown>).helper_id), householdId);
      if (!helperCheck.ok) return c.json({ error: helperCheck.error }, 400);
    }

    const { error } = await admin.from(table).update(patch).eq("id", id);
    if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);

    if (table === "chores" && hasHelperIdPatch) {
      const { data: after, error: afterErr } = await admin
        .from("chores")
        .select("id, helper_id")
        .eq("id", id)
        .maybeSingle();
      if (afterErr) {
        return c.json({ ok: false, tool_call_id: tc.id, error: { message: afterErr.message }, result: null }, 200);
      }

      const prevHelperIdRaw = beforeRow?.helper_id;
      const prevHelperId = typeof prevHelperIdRaw === "string" && prevHelperIdRaw.trim() ? prevHelperIdRaw.trim() : null;
      const actualNextRaw = (after as Record<string, unknown> | null)?.helper_id;
      const actualNext = typeof actualNextRaw === "string" && actualNextRaw.trim() ? actualNextRaw.trim() : null;

      if (prevHelperId !== actualNext) {
        const action = !prevHelperId && actualNext ? "assigned" : prevHelperId && !actualNext ? "unassigned" : "reassigned";
        const { error: histErr } = await admin.from("chore_helper_assignments").insert({
          household_id: householdId,
          chore_id: id,
          helper_id: actualNext,
          action,
          assigned_by: actorUserId,
          metadata: { previous_helper_id: prevHelperId, next_helper_id: actualNext },
        });
        if (histErr) {
          return c.json({ ok: false, tool_call_id: tc.id, error: { message: histErr.message }, result: null }, 200);
        }
      }
    }

    payload = patch;
    summary = `Updated 1 row in ${table}. id=${id}`;
  }

  if (tc.tool === "db.delete") {
    const id = (tc.args as Record<string, unknown>).id;
    if (typeof id !== "string" || !id.trim()) return c.json({ error: "db.delete requires args.id" }, 400);
    if (table === "household_members" || table === "households" || table === "agent_audit_log" || table === "support_audit_log" || table === "profiles") {
      return c.json({ error: `Delete not allowed for table '${table}'` }, 403);
    }

    if (table === "member_time_off") {
      const adminCheck = await isHouseholdAdminUser(admin, householdId, actorUserId);
      if (!adminCheck.ok) {
        return c.json({ error: "Only a home admin can manage time off." }, 403);
      }
    }

    const { data: before, error: beforeErr } = await admin.from(table).select("household_id").eq("id", id).maybeSingle();
    if (beforeErr) {
      return c.json({ ok: false, tool_call_id: tc.id, error: { message: beforeErr.message }, result: null }, 200);
    }
    if (!before || before.household_id !== householdId) return c.json({ error: "Row not found" }, 404);

    const { error } = await admin.from(table).delete().eq("id", id);
    if (error) return c.json({ ok: false, tool_call_id: tc.id, error: { message: error.message }, result: null }, 200);
    payload = { id };
    summary = `Deleted 1 row from ${table}. id=${id}`;
  }

  const auditAction = tc.tool === "db.insert" ? "create" : tc.tool === "db.delete" ? "delete" : "patch";

  const { error: auditErr } = await admin.from("agent_audit_log").insert({
    actor_user_id: actorUserId,
    household_id: householdId,
    table_name: "tools",
    row_ref: { tool_call_id: tc.id, tool: tc.tool, table },
    action: auditAction,
    reason: typeof tc.reason === "string" ? tc.reason : null,
    patch: tc.args,
    before: null,
    after: { summary },
  });
  if (auditErr) {
    return c.json({ ok: false, tool_call_id: tc.id, error: { message: auditErr.message }, result: null }, 200);
  }

  const toolSpanEndIso = new Date().toISOString();
  if (lfTraceId && toolSpanId) {
    await langfuseIngest([
      {
        id: crypto.randomUUID(),
        timestamp: toolSpanEndIso,
        type: "span-update",
        body: {
          id: toolSpanId,
          traceId: lfTraceId,
          endTime: toolSpanEndIso,
          output: { ok: true, tool: tc.tool, table },
        },
      },
    ]);
  }

  return c.json({ ok: true, tool_call_id: tc.id, summary, result: payload });
});

api.post("/queries/chores/count_assigned_to", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

  let body: { household_id?: string; helper_name?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const helperName = typeof body.helper_name === "string" ? body.helper_name.trim() : "";
  if (!helperName) return c.json({ error: "Missing helper_name" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    console.error("queries.chores.count_assigned_to forbidden: user is not a member of household", {
      actorUserId,
      householdId,
      error: (memberCheck as { error?: string }).error,
    });
    return c.json({ error: memberCheck.error ?? "Forbidden" }, 403);
  }

  const { data, error } = await admin.rpc("count_chores_assigned_to", {
    p_household_id: householdId,
    p_actor_user_id: actorUserId,
    p_helper_name: helperName,
  });

  if (error) {
    console.error("queries.chores.count_assigned_to rpc failed", {
      actorUserId,
      householdId,
      helperName,
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }

  const row = Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  if (!row) return c.json({ error: "Unexpected RPC response" }, 500);

  return c.json({
    ok: true,
    match_type: row.match_type,
    helper_id: row.helper_id,
    helper_name: row.helper_name,
    chore_count: row.chore_count,
    candidates: row.candidates,
  });
});

api.post("/queries/helpers/resolve", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

  let body: { household_id?: string; query?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return c.json({ error: "Missing query" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    console.error("queries.helpers.resolve forbidden: user is not a member of household", {
      actorUserId,
      householdId,
      error: (memberCheck as { error?: string }).error,
    });
    return c.json({ error: memberCheck.error ?? "Forbidden" }, 403);
  }

  const { data, error } = await admin.rpc("resolve_helper", {
    p_household_id: householdId,
    p_actor_user_id: actorUserId,
    p_query: query,
  });

  if (error) {
    console.error("queries.helpers.resolve rpc failed", {
      actorUserId,
      householdId,
      query,
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }

  const row = Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  if (!row) return c.json({ error: "Unexpected RPC response" }, 500);

  return c.json({
    ok: true,
    match_type: row.match_type,
    helper_id: row.helper_id,
    helper_name: row.helper_name,
    candidates: row.candidates,
  });
});

api.post("/queries/spaces/resolve", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

  let body: { household_id?: string; query?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return c.json({ error: "Missing query" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    console.error("queries.spaces.resolve forbidden: user is not a member of household", {
      actorUserId,
      householdId,
      error: (memberCheck as { error?: string }).error,
    });
    return c.json({ error: memberCheck.error ?? "Forbidden" }, 403);
  }

  const { data, error } = await admin.rpc("resolve_space", {
    p_household_id: householdId,
    p_actor_user_id: actorUserId,
    p_query: query,
  });

  if (error) {
    console.error("queries.spaces.resolve rpc failed", {
      actorUserId,
      householdId,
      query,
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }

  const row = Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  if (!row) return c.json({ error: "Unexpected RPC response" }, 500);

  return c.json({
    ok: true,
    match_type: row.match_type,
    space: row.space,
    candidates: row.candidates,
  });
});

api.post("/queries/chores/count", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

  let body: { household_id?: string; filters?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    console.error("queries.chores.count forbidden: user is not a member of household", {
      actorUserId,
      householdId,
      error: (memberCheck as { error?: string }).error,
    });
    return c.json({ error: memberCheck.error ?? "Forbidden" }, 403);
  }

  const filters = body.filters && typeof body.filters === "object" && !Array.isArray(body.filters) ? body.filters : {};

  const { data, error } = await admin.rpc("count_chores", {
    p_household_id: householdId,
    p_actor_user_id: actorUserId,
    p_filters: filters,
  });

  if (error) {
    console.error("queries.chores.count rpc failed", {
      actorUserId,
      householdId,
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }

  const row = Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  if (!row) return c.json({ error: "Unexpected RPC response" }, 500);

  return c.json({
    ok: true,
    match_type: row.match_type,
    chore_count: row.chore_count,
    resolved_helper_id: row.resolved_helper_id,
    resolved_space: row.resolved_space,
    helper_candidates: row.helper_candidates,
    space_candidates: row.space_candidates,
  });
});

api.post("/queries/chores/group_by_status", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

  let body: { household_id?: string; filters?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    console.error("queries.chores.group_by_status forbidden: user is not a member of household", {
      actorUserId,
      householdId,
      error: (memberCheck as { error?: string }).error,
    });
    return c.json({ error: memberCheck.error ?? "Forbidden" }, 403);
  }

  const filters = body.filters && typeof body.filters === "object" && !Array.isArray(body.filters) ? body.filters : {};

  const { data, error } = await admin.rpc("group_chores_by_status", {
    p_household_id: householdId,
    p_actor_user_id: actorUserId,
    p_filters: filters,
  });

  if (error) {
    console.error("queries.chores.group_by_status rpc failed", {
      actorUserId,
      householdId,
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }

  const row = Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  if (!row) return c.json({ error: "Unexpected RPC response" }, 500);

  return c.json({
    ok: true,
    match_type: row.match_type,
    result: row.result,
    resolved_helper_id: row.resolved_helper_id,
    resolved_space: row.resolved_space,
    helper_candidates: row.helper_candidates,
    space_candidates: row.space_candidates,
  });
});

api.post("/queries/chores/group_by_assignee", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

  let body: { household_id?: string; filters?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    console.error("queries.chores.group_by_assignee forbidden: user is not a member of household", {
      actorUserId,
      householdId,
      error: (memberCheck as { error?: string }).error,
    });
    return c.json({ error: memberCheck.error ?? "Forbidden" }, 403);
  }

  const filters = body.filters && typeof body.filters === "object" && !Array.isArray(body.filters) ? body.filters : {};

  const { data, error } = await admin.rpc("group_chores_by_assignee", {
    p_household_id: householdId,
    p_actor_user_id: actorUserId,
    p_filters: filters,
  });

  if (error) {
    console.error("queries.chores.group_by_assignee rpc failed", {
      actorUserId,
      householdId,
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }

  const row = Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  if (!row) return c.json({ error: "Unexpected RPC response" }, 500);

  return c.json({
    ok: true,
    match_type: row.match_type,
    result: row.result,
    resolved_space: row.resolved_space,
    space_candidates: row.space_candidates,
  });
});

api.post("/queries/chores/list_enriched", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

  let body: { household_id?: string; filters?: unknown; limit?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    console.error("queries.chores.list_enriched forbidden: user is not a member of household", {
      actorUserId,
      householdId,
      error: (memberCheck as { error?: string }).error,
    });
    return c.json({ error: memberCheck.error ?? "Forbidden" }, 403);
  }

  const filters = body.filters && typeof body.filters === "object" && !Array.isArray(body.filters) ? body.filters : {};
  const limitRaw = body.limit;
  const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 25;

  const { data, error } = await admin.rpc("list_chores_enriched", {
    p_household_id: householdId,
    p_actor_user_id: actorUserId,
    p_filters: filters,
    p_limit: limit,
  });

  if (error) {
    console.error("queries.chores.list_enriched rpc failed", {
      actorUserId,
      householdId,
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }

  const row = Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  if (!row) return c.json({ error: "Unexpected RPC response" }, 500);

  return c.json({
    ok: true,
    match_type: row.match_type,
    result: row.result,
    resolved_helper_id: row.resolved_helper_id,
    resolved_space: row.resolved_space,
    helper_candidates: row.helper_candidates,
    space_candidates: row.space_candidates,
  });
});

api.post("/auth/bootstrap", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

  let body: { full_name?: unknown; household_name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const householdName = typeof body.household_name === "string" ? body.household_name.trim() : "";

  const { data: existingMembership, error: existingErr } = await admin
    .from("household_members")
    .select("household_id")
    .eq("user_id", actorUserId)
    .limit(1)
    .maybeSingle();
  if (existingErr) return c.json({ error: existingErr.message }, 500);

  if (fullName) {
    const { error: profErr } = await admin
      .from("profiles")
      .upsert({ id: actorUserId, full_name: fullName }, { onConflict: "id" });
    if (profErr) return c.json({ error: profErr.message }, 500);
  }

  if (existingMembership?.household_id) {
    return c.json({ ok: true, household_id: existingMembership.household_id, created: false });
  }

  const createName = householdName || (fullName ? `${fullName}'s Home` : "My Home");
  const { data: household, error: householdErr } = await admin
    .from("households")
    .insert({ name: createName, created_by: actorUserId })
    .select("id")
    .maybeSingle();
  if (householdErr) return c.json({ error: householdErr.message }, 500);
  if (!household?.id) return c.json({ error: "Failed to create household" }, 500);

  const { error: memberErr } = await admin
    .from("household_members")
    .insert({ household_id: household.id, user_id: actorUserId, role: "admin" });
  if (memberErr) return c.json({ error: memberErr.message }, 500);

  return c.json({ ok: true, household_id: household.id, created: true });
});

async function getAuthedUserId(admin: ReturnType<typeof supabaseAdmin>, token: string): Promise<string | null> {
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    console.log("auth.getUser failed", { message: userErr?.message });
    return null;
  }
  return userData.user.id;
}

async function isHouseholdMember(admin: ReturnType<typeof supabaseAdmin>, householdId: string, userId: string) {
  const { data, error } = await admin
    .from("household_members")
    .select("user_id")
    .eq("household_id", householdId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { ok: false as const, error: error.message };
  if (!data) return { ok: false as const };
  return { ok: true as const };
}

async function isHouseholdAdminUser(admin: ReturnType<typeof supabaseAdmin>, householdId: string, userId: string) {
  const { data, error } = await admin
    .from("household_members")
    .select("role")
    .eq("household_id", householdId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { ok: false as const, error: error.message };
  if (!data) return { ok: false as const };
  return { ok: data.role === "admin" || data.role === "owner" };
}

async function validateHelperBelongsToHousehold(
  admin: ReturnType<typeof supabaseAdmin>,
  helperId: string,
  householdId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await admin
    .from("helpers")
    .select("id, household_id")
    .eq("id", helperId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Helper not found" };
  if (data.household_id !== householdId) return { ok: false, error: "Helper does not belong to household" };
  return { ok: true };
}

async function validateChoreBelongsToHousehold(
  admin: ReturnType<typeof supabaseAdmin>,
  choreId: string,
  householdId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await admin
    .from("chores")
    .select("id, household_id")
    .eq("id", choreId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Chore not found" };
  if (data.household_id !== householdId) return { ok: false, error: "Chore does not belong to household" };
  return { ok: true };
}

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-user-authorization",
      "x-request-id",
      "x-conversation-id",
      "traceparent",
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

api.use("*", async (c, next) => {
  const start = Date.now();
  const reqId = (c.req.header("x-request-id") ?? "").trim();
  const convId = (c.req.header("x-conversation-id") ?? "").trim();
  const traceparent = (c.req.header("traceparent") ?? "").trim();
  try {
    await next();
  } finally {
    const ms = Date.now() - start;
    const status = c.res ? c.res.status : 0;
    const actorUserId = (() => {
      try {
        const v = c.get("actor_user_id");
        return typeof v === "string" ? v.trim() : "";
      } catch {
        return "";
      }
    })();
    try {
      console.log(
        JSON.stringify({
          event: "edge_http_request",
          method: c.req.method,
          path: c.req.path,
          status,
          ms,
          request_id: reqId || undefined,
          conversation_id: convId || undefined,
          user_id: actorUserId || undefined,
          traceparent: traceparent || undefined,
        }),
      );
    } catch {
      // ignore
    }
  }
});

api.post("/support/patch", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return c.json({ error: "Invalid token" }, 401);
  }
  const supportUserId = userData.user.id;

  const { data: supportRow, error: supportErr } = await admin
    .from("support_users")
    .select("user_id")
    .eq("user_id", supportUserId)
    .maybeSingle();

  if (supportErr) {
    return c.json({ error: supportErr.message }, 500);
  }
  if (!supportRow) {
    return c.json({ error: "User is not a support user" }, 403);
  }

  let body: { table?: string; id?: string; patch?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const table = body.table;
  const id = body.id;
  const patch = body.patch;

  if (!table || !SUPPORTED_PATCH_TABLES.has(table)) {
    return c.json({ error: "Unsupported table" }, 400);
  }
  if (!id) {
    return c.json({ error: "Missing id" }, 400);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    return c.json({ error: "Missing patch" }, 400);
  }

  const patchValidation = validatePatch(patch);
  if (!patchValidation.ok) {
    return c.json({ error: patchValidation.reason }, 400);
  }

  const { data: before, error: beforeErr } = await admin
    .from(table)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (beforeErr) {
    return c.json({ error: beforeErr.message }, 500);
  }
  if (!before) {
    return c.json({ error: "Row not found" }, 404);
  }

  const { data: after, error: patchErr } = await admin
    .from(table)
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (patchErr) {
    return c.json({ error: patchErr.message }, 500);
  }

  const householdId = typeof before.household_id === "string" ? before.household_id : null;
  const { error: auditErr } = await admin.from("support_audit_log").insert({
    support_user_id: supportUserId,
    household_id: householdId,
    table_name: table,
    row_ref: { id },
    action: "patch",
    patch,
    before,
    after,
  });

  if (auditErr) {
    return c.json({ error: auditErr.message }, 500);
  }

  return c.json({ ok: true, before, after });
});

api.post("/agent/patch", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }
  try {
    c.set("actor_user_id", actorUserId);
  } catch {
    // ignore
  }

  let body: { table?: string; id?: string; patch?: Record<string, unknown>; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const table = body.table;
  const id = body.id;
  const patch = body.patch;
  const reason = body.reason ?? null;

  if (!table || !SUPPORTED_AGENT_TABLES.has(table)) {
    return c.json({ error: "Unsupported table" }, 400);
  }
  if (!id) {
    return c.json({ error: "Missing id" }, 400);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    return c.json({ error: "Missing patch" }, 400);
  }

  const patchValidation = validatePatch(patch);
  if (!patchValidation.ok) {
    return c.json({ error: patchValidation.reason }, 400);
  }

  if (table === "profiles" && id !== actorUserId) {
    return c.json({ error: "Cannot patch other users' profiles" }, 403);
  }

  const { data: before, error: beforeErr } = await admin
    .from(table)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (beforeErr) {
    return c.json({ error: beforeErr.message }, 500);
  }
  if (!before) {
    return c.json({ error: "Row not found" }, 404);
  }

  let householdId: string | null = null;
  if (table !== "profiles") {
    householdId = typeof before.household_id === "string" ? before.household_id : null;
    if (!householdId) {
      return c.json({ error: "Row is missing household_id" }, 400);
    }

    const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
    if (!memberCheck.ok) {
      return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
    }
  }

  if (table === "chores" && householdId && typeof patch.helper_id === "string") {
    const helperCheck = await validateHelperBelongsToHousehold(admin, patch.helper_id, householdId);
    if (!helperCheck.ok) {
      return c.json({ error: helperCheck.error }, 400);
    }
  }

  const { data: after, error: patchErr } = await admin
    .from(table)
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (patchErr) {
    return c.json({ error: patchErr.message }, 500);
  }

  const { error: auditErr } = await admin.from("agent_audit_log").insert({
    actor_user_id: actorUserId,
    household_id: householdId,
    table_name: table,
    row_ref: { id },
    action: "patch",
    reason,
    patch,
    before,
    after,
  });

  if (auditErr) {
    return c.json({ error: auditErr.message }, 500);
  }

  return c.json({ ok: true, before, after });
});

api.post("/agent/create", async (c) => {
  const devBypass = (optionalEnv("DEV_BYPASS_AUTH") || "").trim().toLowerCase() in {
    "1": true,
    "true": true,
    "yes": true,
    "y": true,
    "on": true,
  };

  const token = getBearerToken(c.req.raw);
  if (!token && !devBypass) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = devBypass
    ? devActorUserIdFromRequest(c)
    : await getAuthedUserId(admin, token as string);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }

  let body: { table?: string; record?: Record<string, unknown>; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const table = body.table;
  const record = body.record;
  const reason = body.reason ?? null;

  if (!table || !SUPPORTED_AGENT_TABLES.has(table)) {
    return c.json({ error: "Unsupported table" }, 400);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return c.json({ error: "Missing record" }, 400);
  }

  if (table === "profiles") {
    return c.json({ error: "Profiles cannot be created via agent" }, 400);
  }

  if (table === "chores" && typeof (record as Record<string, unknown>).user_id !== "string") {
    (record as Record<string, unknown>).user_id = actorUserId;
  }

  const householdId = typeof record.household_id === "string" ? record.household_id : null;
  if (!householdId) {
    return c.json({ error: "Missing household_id" }, 400);
  }

  if (!devBypass) {
    const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
    if (!memberCheck.ok) {
      return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
    }
  }

  if (table === "chores" && typeof (record as Record<string, unknown>).helper_id === "string") {
    const helperCheck = await validateHelperBelongsToHousehold(
      admin,
      String((record as Record<string, unknown>).helper_id),
      householdId,
    );
    if (!helperCheck.ok) {
      return c.json({ error: helperCheck.error }, 400);
    }
  }

  const { data: created, error: createErr } = await admin
    .from(table)
    .insert(record)
    .select("*")
    .maybeSingle();

  if (createErr) {
    return c.json({ error: createErr.message }, 500);
  }

  const createdId = created && typeof created.id === "string" ? created.id : null;

  const { error: auditErr } = await admin.from("agent_audit_log").insert({
    actor_user_id: actorUserId,
    household_id: householdId,
    table_name: table,
    row_ref: createdId ? { id: createdId } : null,
    action: "create",
    reason,
    patch: record,
    before: null,
    after: created,
  });

  if (auditErr) {
    return c.json({ error: auditErr.message }, 500);
  }

  return c.json({ ok: true, created });
});

api.get("/chat/state", async (c) => {
  const devBypass = (optionalEnv("DEV_BYPASS_AUTH") || "").trim().toLowerCase() in {
    "1": true,
    "true": true,
    "yes": true,
    "y": true,
    "on": true,
  };

  const token = getBearerToken(c.req.raw);
  if (!token && !devBypass) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = devBypass
    ? devActorUserIdFromRequest(c)
    : await getAuthedUserId(admin, token as string);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const householdId = c.req.query("household_id")?.trim() ?? "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const scope = parseChatScope(c.req.query("scope") ?? null);
  if (!scope) return c.json({ error: "Missing or invalid scope" }, 400);

  const limitRaw = c.req.query("limit") ?? "";
  const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw))) : 50;

  if (!devBypass) {
    const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
    if (!memberCheck.ok) {
      return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
    }
  }

  const convoQuery = admin
    .from("chat_conversations")
    .select("id, household_id, scope, user_id")
    .eq("household_id", householdId)
    .eq("scope", scope)
    .order("created_at", { ascending: true })
    .limit(1);

  const convoRes =
    scope === "user"
      ? await convoQuery.eq("user_id", actorUserId).maybeSingle()
      : await convoQuery.is("user_id", null).maybeSingle();

  if (convoRes.error) {
    console.error("chat.append convo lookup failed", { error: convoRes.error.message, householdId, scope, actorUserId });
    return c.json({ error: convoRes.error.message }, 500);
  }

  let conversationId = convoRes.data?.id as string | undefined;
  if (!conversationId) {
    const { data: created, error: createErr } = await admin
      .from("chat_conversations")
      .insert({ household_id: householdId, scope, user_id: scope === "user" ? actorUserId : null })
      .select("id")
      .maybeSingle();
    if (createErr) {
      console.error("chat.append convo create failed", { error: createErr.message, householdId, scope, actorUserId });
      return c.json({ error: createErr.message }, 500);
    }
    conversationId = created?.id as string | undefined;
  }

  if (!conversationId) return c.json({ error: "Failed to create conversation" }, 500);

  const { data: summaryRow, error: summaryErr } = await admin
    .from("chat_summaries")
    .select("summary")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (summaryErr) return c.json({ error: summaryErr.message }, 500);

  const { data: messages, error: msgErr } = await admin
    .from("chat_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    // Pull the most recent N messages (then reverse below for chronological UI).
    .order("created_at", { ascending: false })
    .limit(limit);
  if (msgErr) return c.json({ error: msgErr.message }, 500);

  return c.json({
    ok: true,
    conversation_id: conversationId,
    summary: (summaryRow?.summary as string | undefined) ?? "",
    messages: (messages ?? []).slice().reverse(),
  });
});

api.post("/chat/respond", async (c) => {
  const devBypass = (optionalEnv("DEV_BYPASS_AUTH") || "").trim().toLowerCase() in {
    "1": true,
    "true": true,
    "yes": true,
    "y": true,
    "on": true,
  };

  const token = getBearerToken(c.req.raw);
  if (!token && !devBypass) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = devBypass
    ? devActorUserIdFromRequest(c)
    : await getAuthedUserId(admin, token as string);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }
  try {
    c.set("actor_user_id", actorUserId);
  } catch {
    // ignore
  }

  let body: {
    household_id?: string;
    messages?: unknown;
    model?: string;
    temperature?: number;
    max_tokens?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const msgs = assertMessagesArray(body.messages);
  if (!msgs || msgs.length === 0) return c.json({ error: "Missing messages" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
  }

  const agentUrlRaw = (Deno.env.get("AGENT_SERVICE_URL") ?? "").trim();
  const agentKey = (Deno.env.get("AGENT_SERVICE_KEY") ?? "").trim();
  if (!agentUrlRaw) return c.json({ error: "Missing AGENT_SERVICE_URL" }, 500);
  if (!agentKey) return c.json({ error: "Missing AGENT_SERVICE_KEY" }, 500);

  const agentUrl = agentUrlRaw.replace(/\/+$/, "");
  const reqId = (c.req.header("x-request-id") ?? "").trim();
  const convId = (c.req.header("x-conversation-id") ?? "").trim();
  const sessId = (c.req.header("x-session-id") ?? "").trim();
  const traceparent = (c.req.header("traceparent") ?? "").trim();

  const langfuseSessionId = sessId || convId || reqId;

  if (!_langfuseEnvPresenceLogged) {
    _langfuseEnvPresenceLogged = true;
    try {
      console.log("langfuse_env_presence", {
        hasPublicKey: Boolean(optionalEnv("LANGFUSE_PUBLIC_KEY")),
        hasSecretKey: Boolean(optionalEnv("LANGFUSE_SECRET_KEY")),
        hasBaseUrl: Boolean(optionalEnv("LANGFUSE_BASE_URL") || optionalEnv("LANGFUSE_HOST")),
        host: (optionalEnv("LANGFUSE_BASE_URL") || optionalEnv("LANGFUSE_HOST") || "").slice(0, 80),
      });
    } catch {
      // ignore
    }
  }

  const lfDebugRaw = (optionalEnv("LANGFUSE_DEBUG") || "").trim().toLowerCase();
  const lfDebug = lfDebugRaw === "1" || lfDebugRaw === "true" || lfDebugRaw === "yes" || lfDebugRaw === "y" || lfDebugRaw === "on";
  if (lfDebug) {
    try {
      console.log("langfuse_env_check", {
        hasPublicKey: Boolean(optionalEnv("LANGFUSE_PUBLIC_KEY")),
        hasSecretKey: Boolean(optionalEnv("LANGFUSE_SECRET_KEY")),
        hasBaseUrl: Boolean(optionalEnv("LANGFUSE_BASE_URL") || optionalEnv("LANGFUSE_HOST")),
      });
    } catch {
      // ignore
    }
  }

  const langfuseTraceSeed = convId || sessId || reqId || `${Date.now()}`;
  const langfuseTraceId = await makeLangfuseTraceId(langfuseTraceSeed);

  const nowIso = new Date().toISOString();
  const lfTraceId = isHex32(langfuseTraceId) ? langfuseTraceId.toLowerCase() : "";
  const lfSpanId = sha256Hex(`span:${langfuseTraceSeed}:${crypto.randomUUID()}`).then((h) => h.slice(0, 16));

  if (lfTraceId) {
    const chatInput = sanitizeLangfuseChatInput(msgs);
    await langfuseIngest([
      {
        id: crypto.randomUUID(),
        timestamp: nowIso,
        type: "trace-create",
        body: {
          id: lfTraceId,
          timestamp: nowIso,
          name: "edge.chat.respond",
          environment: optionalEnv("LANGFUSE_ENV") || optionalEnv("NODE_ENV") || "default",
          userId: actorUserId || null,
          sessionId: langfuseSessionId || null,
          input: {
            request_id: reqId || null,
            conversation_id: convId || null,
            message_count: chatInput.message_count,
            last_user: chatInput.last_user,
            messages_tail: chatInput.messages_tail,
          },
          metadata: {
            request_id: reqId || undefined,
            conversation_id: convId || undefined,
            session_id: (langfuseSessionId || undefined),
          },
          tags: [],
          public: false,
        },
      },
    ]);
  }

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-agent-service-key": agentKey,
  };
  if (reqId) upstreamHeaders["x-request-id"] = reqId;
  if (convId) upstreamHeaders["x-conversation-id"] = convId;
  if (sessId) upstreamHeaders["x-session-id"] = sessId;
  if (actorUserId) upstreamHeaders["x-user-id"] = actorUserId;
  if (householdId) upstreamHeaders["x-household-id"] = householdId;
  if (traceparent) upstreamHeaders["traceparent"] = traceparent;
  if (langfuseTraceId) upstreamHeaders["x-langfuse-trace-id"] = langfuseTraceId;

  const spanId = await lfSpanId;
  const spanStartIso = new Date().toISOString();
  if (lfTraceId && spanId) {
    await langfuseIngest([
      {
        id: crypto.randomUUID(),
        timestamp: spanStartIso,
        type: "span-create",
        body: {
          id: spanId,
          traceId: lfTraceId,
          name: "orchestrator.call_agent_service",
          startTime: spanStartIso,
          environment: optionalEnv("LANGFUSE_ENV") || optionalEnv("NODE_ENV") || "default",
          input: {
            url: `${agentUrl}/v1/chat/respond`,
          },
          metadata: {
            request_id: reqId || undefined,
            conversation_id: convId || undefined,
            session_id: sessId || undefined,
          },
        },
      },
    ]);
  }

  let upstream: Response | null = null;
  let upstreamErr: unknown = null;
  try {
    upstream = await fetch(`${agentUrl}/v1/chat/respond`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify({
        messages: msgs,
        model: typeof body.model === "string" ? body.model : undefined,
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
      }),
    });
  } catch (e) {
    upstreamErr = e;
    console.error("chat.respond upstream fetch failed", {
      agentUrl,
      error: String((e as any)?.message ?? e),
    });
  } finally {
    const spanEndIso = new Date().toISOString();
    if (lfTraceId && spanId) {
      await langfuseIngest([
        {
          id: crypto.randomUUID(),
          timestamp: spanEndIso,
          type: "span-update",
          body: {
            id: spanId,
            traceId: lfTraceId,
            endTime: spanEndIso,
            output: upstream ? { ok: upstream.ok, status: upstream.status } : { ok: false, error: "upstream_fetch_failed" },
            statusMessage: upstreamErr ? String((upstreamErr as any)?.message ?? upstreamErr) : undefined,
          },
        },
      ]);
    }
  }

  if (!upstream) {
    const msg = upstreamErr ? String((upstreamErr as any)?.message ?? upstreamErr) : "Agent service unavailable";
    return c.json({ error: msg }, 502);
  }

  const text = await upstream.text().catch(() => "");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!upstream.ok) {
    const msg =
      json && typeof json === "object" && (json as { detail?: unknown; error?: unknown }).detail
        ? String((json as { detail?: unknown }).detail)
        : json && typeof json === "object" && (json as { error?: unknown }).error
          ? String((json as { error?: unknown }).error)
          : text || upstream.statusText;
    return c.json({ error: msg }, { status: upstream.status as any });
  }

  return c.body(text || JSON.stringify({ ok: true }), 200, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
  });
});

api.post("/chat/append", async (c) => {
  const devBypassRaw = (optionalEnv("DEV_BYPASS_AUTH") || "").trim().toLowerCase();
  const devBypass = devBypassRaw === "1" || devBypassRaw === "true" || devBypassRaw === "yes" || devBypassRaw === "y" || devBypassRaw === "on";

  const token = getBearerToken(c.req.raw);
  if (!token && !devBypass) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = devBypass
    ? devActorUserIdFromRequest(c)
    : await getAuthedUserId(admin, token as string);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }
  try {
    c.set("actor_user_id", actorUserId);
  } catch {
    // ignore
  }

  let body: { household_id?: string; scope?: string; messages?: unknown; summary?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const scope = parseChatScope(typeof body.scope === "string" ? body.scope : null);
  if (!scope) return c.json({ error: "Missing or invalid scope" }, 400);

  const msgs = assertMessagesArray(body.messages);
  if (!msgs || msgs.length === 0) return c.json({ error: "Missing messages" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
  }

  const convoQuery = admin
    .from("chat_conversations")
    .select("id, household_id, scope, user_id")
    .eq("household_id", householdId)
    .eq("scope", scope)
    .order("created_at", { ascending: true })
    .limit(1);

  const convoRes =
    scope === "user"
      ? await convoQuery.eq("user_id", actorUserId).maybeSingle()
      : await convoQuery.is("user_id", null).maybeSingle();

  if (convoRes.error) return c.json({ error: convoRes.error.message }, 500);

  let conversationId = convoRes.data?.id as string | undefined;
  if (!conversationId) {
    const { data: created, error: createErr } = await admin
      .from("chat_conversations")
      .insert({ household_id: householdId, scope, user_id: scope === "user" ? actorUserId : null })
      .select("id")
      .maybeSingle();
    if (createErr) return c.json({ error: createErr.message }, 500);
    conversationId = created?.id as string | undefined;
  }

  if (!conversationId) return c.json({ error: "Failed to create conversation" }, 500);

  const rows = msgs.map((m) => ({
    conversation_id: conversationId,
    household_id: householdId,
    role: m.role,
    content: m.content,
  }));

  const { error: insertErr } = await admin.from("chat_messages").insert(rows);
  if (insertErr) {
    console.error("chat.append message insert failed", { error: insertErr.message, householdId, conversationId, actorUserId });
    return c.json({ error: insertErr.message }, 500);
  }

  const summary = typeof body.summary === "string" ? body.summary : null;
  if (summary !== null) {
    const { error: upsertErr } = await admin
      .from("chat_summaries")
      .upsert({ conversation_id: conversationId, household_id: householdId, summary }, { onConflict: "conversation_id" });
    if (upsertErr) {
      console.error("chat.append summary upsert failed", { error: upsertErr.message, householdId, conversationId, actorUserId });
      return c.json({ error: upsertErr.message }, 500);
    }
  }

  return c.json({ ok: true, conversation_id: conversationId });
});

api.post("/chat/clear", async (c) => {
  const devBypassRaw = (optionalEnv("DEV_BYPASS_AUTH") || "").trim().toLowerCase();
  const devBypass = devBypassRaw === "1" || devBypassRaw === "true" || devBypassRaw === "yes" || devBypassRaw === "y" || devBypassRaw === "on";

  const token = getBearerToken(c.req.raw);
  if (!token && !devBypass) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = devBypass
    ? devActorUserIdFromRequest(c)
    : await getAuthedUserId(admin, token as string);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }

  let body: { household_id?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id.trim() : "";
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const scope = parseChatScope(typeof body.scope === "string" ? body.scope : null);
  if (!scope) return c.json({ error: "Missing or invalid scope" }, 400);

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
  }

  // Find the current conversation
  const convoQuery = admin
    .from("chat_conversations")
    .select("id")
    .eq("household_id", householdId)
    .eq("scope", scope)
    .order("created_at", { ascending: true })
    .limit(1);

  const convoRes =
    scope === "user"
      ? await convoQuery.eq("user_id", actorUserId).maybeSingle()
      : await convoQuery.is("user_id", null).maybeSingle();

  if (convoRes.data?.id) {
    const oldConvoId = convoRes.data.id as string;
    // Delete messages and summary for the old conversation
    await admin.from("chat_messages").delete().eq("conversation_id", oldConvoId);
    await admin.from("chat_summaries").delete().eq("conversation_id", oldConvoId);
    await admin.from("chat_conversations").delete().eq("id", oldConvoId);
  }

  // Create a fresh conversation
  const { data: newConvo, error: createErr } = await admin
    .from("chat_conversations")
    .insert({ household_id: householdId, scope, user_id: scope === "user" ? actorUserId : null })
    .select("id")
    .maybeSingle();

  if (createErr) return c.json({ error: createErr.message }, 500);

  return c.json({ ok: true, conversation_id: newConvo?.id ?? "" });
});

api.get("/agent/helpers", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const householdId = c.req.query("household_id")?.trim() ?? "";
  if (!householdId) {
    return c.json({ error: "Missing household_id" }, 400);
  }

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
  }

  const { data, error } = await admin
    .from("helpers")
    .select("id, name, type, phone")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true, helpers: data ?? [] });
});

api.get("/settings/youtube", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const householdId = c.req.query("household_id")?.trim() ?? "";
  if (!householdId) {
    return c.json({ error: "Missing household_id" }, 400);
  }

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
  }

  const key = `youtube_settings:${householdId}`;
  const value = await kv.get(key);
  return c.json({ ok: true, settings: value ?? null });
});

api.post("/settings/youtube", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }

  let body: { household_id?: string; settings?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const householdId = typeof body.household_id === "string" ? body.household_id : "";
  if (!householdId) {
    return c.json({ error: "Missing household_id" }, 400);
  }

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
  }

  const key = `youtube_settings:${householdId}`;
  await kv.set(key, body.settings ?? null);
  return c.json({ ok: true });
});

api.post("/agent/delete", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
  }

  let body: { table?: string; id?: string; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const table = body.table;
  const id = body.id;
  const reason = body.reason ?? null;

  if (!table || !SUPPORTED_AGENT_TABLES.has(table)) {
    return c.json({ error: "Unsupported table" }, 400);
  }
  if (!id) {
    return c.json({ error: "Missing id" }, 400);
  }
  if (table === "profiles") {
    return c.json({ error: "Profiles cannot be deleted via agent" }, 400);
  }

  const { data: before, error: beforeErr } = await admin
    .from(table)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (beforeErr) {
    return c.json({ error: beforeErr.message }, 500);
  }
  if (!before) {
    return c.json({ error: "Row not found" }, 404);
  }

  const householdId = typeof before.household_id === "string" ? before.household_id : null;
  if (!householdId) {
    return c.json({ error: "Row is missing household_id" }, 400);
  }

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
  }

  const { error: deleteErr } = await admin
    .from(table)
    .delete()
    .eq("id", id);

  if (deleteErr) {
    return c.json({ error: deleteErr.message }, 500);
  }

  const { error: auditErr } = await admin.from("agent_audit_log").insert({
    actor_user_id: actorUserId,
    household_id: householdId,
    table_name: table,
    row_ref: { id },
    action: "delete",
    reason,
    patch: null,
    before,
    after: null,
  });

  if (auditErr) {
    return c.json({ error: auditErr.message }, 500);
  }

  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// Helper Stage 2 magic-link routes (Phase 1.1b)
//
// Both routes are UNAUTHENTICATED. The URL token is the only auth;
// the backing RPCs (fetch_helper_invite, complete_helper_stage2)
// validate the token internally and return status strings the caller
// uses to route the response. No x-user-authorization required.
// ─────────────────────────────────────────────────────────────────────

// GET /h/:token — resolve a magic-link invite for the Stage 2 page.
// Returns helper basics + invite status. No auth required.
api.get("/h/:token", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!token) {
    return c.json({ error: "Missing token" }, 400);
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("fetch_helper_invite", { p_token: token });
  if (error) {
    console.error("fetch_helper_invite RPC failed", { error: error.message });
    return c.json({ error: "Internal error" }, 500);
  }

  // RPC returns a setof rows; we unwrap the first (there's exactly one).
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return c.json({ status: "not_found" }, 404);
  }

  const status = String((row as Record<string, unknown>).status || "not_found");

  if (status === "not_found") {
    return c.json({ status: "not_found" }, 404);
  }

  // For revoked/expired/already_completed we still return 200 with
  // the status field so the magic-link page can render a clear
  // message without a network-error fallback.
  return c.json({
    status,
    helper_id: (row as Record<string, unknown>).helper_id,
    helper_name: (row as Record<string, unknown>).helper_name,
    household_id: (row as Record<string, unknown>).household_id,
    channel_chain: (row as Record<string, unknown>).channel_chain,
    preferred_language: (row as Record<string, unknown>).preferred_language,
    expires_at: (row as Record<string, unknown>).expires_at,
  }, 200);
});

// POST /h/:token/complete — submit Stage 2 consent payload.
// Body: { preferred_language?, profile_photo_url?, preferred_channel?,
//         consents: { id_verification?, vision_capture?, ... } }
// No auth required; the token is the auth.
api.post("/h/:token/complete", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!token) {
    return c.json({ error: "Missing token" }, 400);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return c.json({ error: "Body must be an object" }, 400);
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("complete_helper_stage2", {
    p_token: token,
    p_payload: payload,
  });
  if (error) {
    console.error("complete_helper_stage2 RPC failed", { error: error.message });
    return c.json({ error: "Internal error" }, 500);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return c.json({ status: "not_found" }, 404);
  }

  const status = String((row as Record<string, unknown>).status || "not_found");

  const httpStatus =
    status === "completed"
      ? 200
      : status === "not_found"
        ? 404
        : status === "invalid_payload"
          ? 400
          : status === "expired" || status === "revoked" || status === "already_completed"
            ? 409
            : 500;

  return c.json({
    status,
    helper_id: (row as Record<string, unknown>).helper_id ?? null,
    household_id: (row as Record<string, unknown>).household_id ?? null,
  }, httpStatus);
});

// Health check endpoint
api.get("/make-server-e874fae9/health", (c) => {
  return c.json({ status: "ok" });
});

// Mount the same API under multiple prefixes. Depending on local/prod gateways,
// requests may arrive as /<route>, /server/<route>, or /server/server/<route>.
app.route("/", api);
app.route("/server", api);
app.route("/server/server", api);

Deno.serve(app.fetch);