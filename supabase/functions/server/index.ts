import { Hono } from "jsr:@hono/hono@4";
import { cors } from "jsr:@hono/hono@4/cors";
import { logger } from "jsr:@hono/hono@4/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import * as kv from "./kv_store.ts";
const app = new Hono();
const api = new Hono();

function requiredEnv(name: string): string {
  const raw = Deno.env.get(name);
  if (!raw) throw new Error(`Missing required env var: ${name}`);
  const trimmed = raw.trim();
  return trimmed.replace(/^"(.*)"$/, "$1");
}

type ToolName = "db.select" | "db.insert" | "db.update" | "db.delete";
type ToolTable =
  | "chores"
  | "helpers"
  | "alerts"
  | "households"
  | "household_members"
  | "profiles"
  | "agent_audit_log"
  | "support_audit_log";

type ToolCall = {
  id: string;
  tool: ToolName;
  args: Record<string, unknown>;
  reason?: string;
};

const TOOL_ALLOWLIST: Record<ToolTable, { select: boolean; insert: boolean; update: boolean; delete: boolean }> = {
  chores: { select: true, insert: true, update: true, delete: true },
  helpers: { select: true, insert: true, update: true, delete: true },
  alerts: { select: true, insert: true, update: true, delete: true },
  households: { select: true, insert: false, update: false, delete: false },
  household_members: { select: true, insert: false, update: false, delete: false },
  profiles: { select: true, insert: false, update: true, delete: false },
  agent_audit_log: { select: true, insert: false, update: false, delete: false },
  support_audit_log: { select: true, insert: false, update: false, delete: false },
};

function isToolName(v: unknown): v is ToolName {
  return v === "db.select" || v === "db.insert" || v === "db.update" || v === "db.delete";
}

function isToolTable(v: unknown): v is ToolTable {
  return (
    v === "chores" ||
    v === "helpers" ||
    v === "alerts" ||
    v === "households" ||
    v === "household_members" ||
    v === "profiles" ||
    v === "agent_audit_log" ||
    v === "support_audit_log"
  );
}

function summarizeTableRows(table: ToolTable, rows: any[]): string {
  const count = rows.length;
  if (count === 0) {
    if (table === "chores") return "You don’t have any chores yet.";
    if (table === "helpers") return "You don’t have any helpers added yet.";
    if (table === "alerts") return "You don’t have any alerts right now.";
    if (table === "household_members") return "No one is linked to this home yet.";
    if (table === "profiles") return "No profiles found for this home yet.";
    if (table === "agent_audit_log" || table === "support_audit_log") return "No activity yet.";
    return "Nothing found yet.";
  }

  const head = rows.slice(0, 10);
  if (table === "helpers") {
    return (
      `Found ${count} helpers:\n` +
      head
        .map((h) => {
          const name = h.name ?? "(no name)";
          const type = h.type ? ` (${h.type})` : "";
          const phone = h.phone ? ` — ${h.phone}` : "";
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
          const title = c.title ?? "(no title)";
          const status = c.status ? ` [${c.status}]` : "";
          const due = c.due_at ? ` (due ${c.due_at})` : "";
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
          const title = a.title ?? "(no title)";
          const severity = a.severity ? ` [${a.severity}]` : "";
          return `- ${title}${severity}`;
        })
        .join("\n")
    );
  }
  if (table === "household_members") {
    return (
      `Found ${count} household members:\n` +
      head
        .map((m) => `- ${m.user_id ?? "?"}${m.role ? ` (${m.role})` : ""}`)
        .join("\n")
    );
  }
  if (table === "profiles") {
    return (
      `Found ${count} profiles:\n` +
      head
        .map((p) => {
          const name = p.full_name ?? "(no name)";
          return `- ${name} — ${p.id ?? "?"}`;
        })
        .join("\n")
    );
  }
  if (table === "households") {
    return (
      `Found ${count} households:\n` +
      head.map((h) => `- ${h.name ?? "(no name)"} — ${h.id ?? "?"}`).join("\n")
    );
  }
  if (table === "agent_audit_log" || table === "support_audit_log") {
    return `Found ${count} audit log rows in ${table}. Showing latest ${Math.min(10, count)}.`;
  }
  return `Found ${count} rows in ${table}.`;
}

const supabaseAdmin = () =>
  createClient(
    requiredEnv("SB_URL"),
    requiredEnv("SB_SERVICE_ROLE_KEY"),
  );

const SUPPORTED_PATCH_TABLES = new Set([
  "chores",
  "alerts",
  "helpers",
  "profiles",
]);

const SUPPORTED_AGENT_TABLES = new Set([
  "chores",
  "alerts",
  "helpers",
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
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
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
  if (!token) return c.json({ error: "Missing authorization header" }, 401);

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) return c.json({ error: "Invalid token" }, 401);

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

  const table = (tc.args as { table?: unknown }).table;
  if (!isToolTable(table)) return c.json({ error: "Unsupported table" }, 400);

  const perms = TOOL_ALLOWLIST[table];
  const op = tc.tool.split(".")[1] as "select" | "insert" | "update" | "delete";
  if (!perms[op]) return c.json({ error: `Operation not allowed for table '${table}'` }, 403);

  // Execute
  let summary = "";

  if (tc.tool === "db.select") {
    const limitRaw = (tc.args as any).limit;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 25;

    // Force household scoping where it applies
    if (table === "profiles") {
      // Only profiles for members of the household
      const { data: members, error: memErr } = await admin
        .from("household_members")
        .select("user_id")
        .eq("household_id", householdId);
      if (memErr) return c.json({ error: memErr.message }, 500);
      const ids = (members ?? []).map((m: any) => m.user_id).filter(Boolean);
      const { data, error } = await admin
        .from("profiles")
        .select("id, full_name, avatar_url")
        .in("id", ids)
        .limit(limit);
      if (error) return c.json({ error: error.message }, 500);
      summary = summarizeTableRows("profiles", data ?? []);
    } else if (table === "households") {
      const { data, error } = await admin
        .from("households")
        .select("id, name")
        .eq("id", householdId)
        .limit(1);
      if (error) return c.json({ error: error.message }, 500);
      summary = summarizeTableRows("households", data ?? []);
    } else if (table === "household_members") {
      const { data, error } = await admin
        .from("household_members")
        .select("user_id, role")
        .eq("household_id", householdId)
        .limit(limit);
      if (error) return c.json({ error: error.message }, 500);
      summary = summarizeTableRows("household_members", data ?? []);
    } else if (table === "agent_audit_log") {
      const { data, error } = await admin
        .from("agent_audit_log")
        .select("created_at, actor_user_id, table_name, action")
        .eq("household_id", householdId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return c.json({ error: error.message }, 500);
      summary = summarizeTableRows("agent_audit_log", data ?? []);
    } else if (table === "support_audit_log") {
      const { data, error } = await admin
        .from("support_audit_log")
        .select("created_at, support_user_id, table_name, action")
        .eq("household_id", householdId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return c.json({ error: error.message }, 500);
      summary = summarizeTableRows("support_audit_log", data ?? []);
    } else {
      // chores/helpers/alerts are household-scoped
      const select = table === "helpers"
        ? "id, name, type, phone, created_at"
        : table === "alerts"
        ? "id, title, severity, created_at"
        : "id, title, status, due_at, helper_id, created_at";

      const { data, error } = await admin
        .from(table)
        .select(select)
        .eq("household_id", householdId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return c.json({ error: error.message }, 500);
      summary = summarizeTableRows(table, data ?? []);
    }
  }

  if (tc.tool === "db.insert") {
    const record = (tc.args as any).record;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return c.json({ error: "db.insert requires args.record" }, 400);
    }
    if (table === "household_members" || table === "households" || table === "agent_audit_log" || table === "support_audit_log") {
      return c.json({ error: `Insert not allowed for table '${table}'` }, 403);
    }
    const payload: Record<string, unknown> = { ...record, household_id: householdId };
    if (table === "chores" && typeof payload.user_id !== "string") payload.user_id = actorUserId;
    if (table === "chores" && typeof payload.helper_id === "string") {
      const helperCheck = await validateHelperBelongsToHousehold(admin, String(payload.helper_id), householdId);
      if (!helperCheck.ok) return c.json({ error: helperCheck.error }, 400);
    }
    const { data: created, error } = await admin.from(table).insert(payload).select("id").maybeSingle();
    if (error) return c.json({ error: error.message }, 500);
    summary = `Inserted 1 row into ${table}. id=${created?.id ?? "(unknown)"}`;
  }

  if (tc.tool === "db.update") {
    const id = (tc.args as any).id;
    const patch = (tc.args as any).patch;
    if (typeof id !== "string" || !id.trim()) return c.json({ error: "db.update requires args.id" }, 400);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return c.json({ error: "db.update requires args.patch" }, 400);
    if (table === "household_members" || table === "households" || table === "agent_audit_log" || table === "support_audit_log") {
      return c.json({ error: `Update not allowed for table '${table}'` }, 403);
    }
    if (table === "profiles" && id !== actorUserId) return c.json({ error: "Cannot update other users' profiles" }, 403);

    const patchValidation = validatePatch(patch as Record<string, unknown>);
    if (!patchValidation.ok) return c.json({ error: patchValidation.reason }, 400);

    if (table !== "profiles") {
      const { data: before, error: beforeErr } = await admin.from(table).select("household_id").eq("id", id).maybeSingle();
      if (beforeErr) return c.json({ error: beforeErr.message }, 500);
      if (!before || before.household_id !== householdId) return c.json({ error: "Row not found" }, 404);
    }

    if (table === "chores" && typeof (patch as any).helper_id === "string") {
      const helperCheck = await validateHelperBelongsToHousehold(admin, String((patch as any).helper_id), householdId);
      if (!helperCheck.ok) return c.json({ error: helperCheck.error }, 400);
    }

    const { error } = await admin.from(table).update(patch).eq("id", id);
    if (error) return c.json({ error: error.message }, 500);
    summary = `Updated 1 row in ${table}. id=${id}`;
  }

  if (tc.tool === "db.delete") {
    const id = (tc.args as any).id;
    if (typeof id !== "string" || !id.trim()) return c.json({ error: "db.delete requires args.id" }, 400);
    if (table === "household_members" || table === "households" || table === "agent_audit_log" || table === "support_audit_log" || table === "profiles") {
      return c.json({ error: `Delete not allowed for table '${table}'` }, 403);
    }

    const { data: before, error: beforeErr } = await admin.from(table).select("household_id").eq("id", id).maybeSingle();
    if (beforeErr) return c.json({ error: beforeErr.message }, 500);
    if (!before || before.household_id !== householdId) return c.json({ error: "Row not found" }, 404);

    const { error } = await admin.from(table).delete().eq("id", id);
    if (error) return c.json({ error: error.message }, 500);
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
  if (auditErr) return c.json({ error: auditErr.message }, 500);

  return c.json({ ok: true, tool_call_id: tc.id, summary });
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
  if (!data) return { ok: false, error: "helper_id not found" };
  if (data.household_id !== householdId) {
    return { ok: false, error: "helper_id does not belong to household" };
  }
  return { ok: true };
}

// Enable logger
app.use('*', logger(console.log));

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

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
  const token = getBearerToken(c.req.raw);
  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
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

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
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
  if (!householdId) return c.json({ error: "Missing household_id" }, 400);

  const scope = parseChatScope(c.req.query("scope") ?? null);
  if (!scope) return c.json({ error: "Missing or invalid scope" }, 400);

  const limitRaw = c.req.query("limit") ?? "";
  const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw))) : 50;

  const memberCheck = await isHouseholdMember(admin, householdId, actorUserId);
  if (!memberCheck.ok) {
    return c.json({ error: memberCheck.error ?? "User cannot access household" }, 403);
  }

  const convoQuery = admin
    .from("chat_conversations")
    .select("id, household_id, scope, user_id")
    .eq("household_id", householdId)
    .eq("scope", scope);

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
    .order("created_at", { ascending: true })
    .limit(limit);
  if (msgErr) return c.json({ error: msgErr.message }, 500);

  return c.json({
    ok: true,
    conversation_id: conversationId,
    summary: (summaryRow?.summary as string | undefined) ?? "",
    messages: messages ?? [],
  });
});

api.post("/chat/append", async (c) => {
  const token = getBearerToken(c.req.raw);
  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const admin = supabaseAdmin();
  const actorUserId = await getAuthedUserId(admin, token);
  if (!actorUserId) {
    return c.json({ error: "Invalid token" }, 401);
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
    .eq("scope", scope);

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
  if (insertErr) return c.json({ error: insertErr.message }, 500);

  const summary = typeof body.summary === "string" ? body.summary : null;
  if (summary !== null) {
    const { error: upsertErr } = await admin
      .from("chat_summaries")
      .upsert({ conversation_id: conversationId, household_id: householdId, summary }, { onConflict: "conversation_id" });
    if (upsertErr) return c.json({ error: upsertErr.message }, 500);
  }

  return c.json({ ok: true, conversation_id: conversationId });
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