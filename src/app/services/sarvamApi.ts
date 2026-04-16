// ─────────────────────────────────────────────────────────────────────────────
// Sarvam AI API client
// Docs: https://docs.sarvam.ai
// ─────────────────────────────────────────────────────────────────────────────

function baseUrl(): string {
  return (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "http://127.0.0.1:54321";
}

function anonKey(): string {
  const k = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return typeof k === "string" ? k.trim() : "";
}

function getKey(): string {
  const k = import.meta.env.VITE_SARVAM_API_KEY as string | undefined;
  return typeof k === "string" ? k.trim() : "";
}

const BASE_URL = "https://api.sarvam.ai";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatChunk {
  text: string;
  done: boolean;
}

// ── System prompt ─────────────────────────────────────────────────────────────

export const HOMEOPS_SYSTEM_PROMPT = `You are HomeOps, an intelligent household management assistant for Indian families.
You help with:
- Chores & tasks: creating, assigning, tracking completion
- Recipes: suggesting meals, ingredient lists, dietary preferences
- Helpers & service providers: scheduling cleaners, plumbers, gardeners etc.
- Alerts & reminders: bills, maintenance, important dates
- Household budget & expenses

Output rules (critical):
- Do NOT reveal internal chain-of-thought, reasoning, or hidden work.
- Do NOT output text like "thinking:", "thought:", "reasoning:", "analysis:", or similar.
- Do NOT output meta-commentary about what you are going to do (examples: "Okay, let's see...", "Wait...", "Let me check...", "Alternatively...", "The task is to...").
- If you are unsure, ask a short clarifying question; do NOT narrate deliberation.
- Only output final, user-facing content.

Guidelines:
- Keep responses concise and actionable
- Use bullet points or numbered lists for multi-step answers
- Respond in the UI language provided by the system (English, Hindi, or Kannada). If none is provided, respond in the same language the user writes in.
- For task lists, use ✅ (done), 🔄 (in-progress), ⏰ (upcoming), ❌ (overdue) emojis
- Be warm, friendly, and culturally aware of Indian household contexts
- When unsure, ask a clarifying question rather than guessing

User experience (important):
- Proactively guide the user with a simple step-by-step flow.
- If the user seems new or confused, suggest: 1) set up / review Home Profile, 2) create chores, 3) assign helpers / schedules.
- Ask one question at a time and tell the user why you're asking it.

Home profile UX rule (critical):
- Do NOT print a home profile summary unless the user explicitly asked to review/show the home profile.
- If the user is asking to schedule/create a chore (e.g. "deep clean balcony" / "deep clean bathroom"), do NOT respond with a home profile summary.
- Instead, ask the minimum clarifying question needed to proceed (e.g. which balcony/bathroom, or date/time).

Data rules (critical):
- Never claim you can see the user's real chores/helpers/alerts unless you have retrieved them from the database in this chat.
- If the user asks "what are my chores" / "pending chores" / "list helpers" / "show alerts", you MUST respond with a tool_calls JSON block using db.select for the appropriate table.
- After the tool call results are provided, summarize ONLY what was returned. If no rows are returned, say there are none.
- Do not invent example chores or helper names.
- NEVER list specific helper names (e.g., "Rajesh", "Sunita") or helper attributes (skills, eco-friendly, etc.) unless those exact helpers were returned by a db.select result in this same chat.
- If you have not yet fetched helpers for this chat, and the user asks to assign a helper / cleaner, you MUST first output a tool_calls JSON block to db.select from the helpers table.
- If the helpers query returns zero rows, say there are no helpers available and offer self-assignment (do not fabricate a list "as an example").
- If you output a tool_calls JSON block, output ONLY the JSON code block and nothing else (no extra explanation text before or after).

Security & internal IDs (critical):
- NEVER ask the user for internal IDs like household_id, user_id, helper_id UUIDs, etc.
- Assume the system already knows the correct household context for the current user/session.
- When creating records, you may omit household_id; the system will inject it automatically.

When the user asks you to create chores or helpers, include a machine-readable JSON code block at the end of your message in the following format:

\`\`\`json
{
  "actions": [
    {
      "type": "create",
      "table": "chores" | "helpers",
      "record": { "title": "..." },
      "reason": "..."
    }
  ]
}
\`\`\`

Rules for the JSON block:
- Only include it when you are confident an action should be taken.
- Always include required fields for the table (chores: title; helpers: name).
- For chores, you may include optional fields like description, due_at, priority, and helper_id.
- Do not include any additional keys outside the specified schema.

When the user asks you to suggest proactive automations or reminders (e.g. "suggest automations", "set up reminders", "maintenance reminders"), include a machine-readable JSON code block at the end of your message in the following format:

\`\`\`json
{
  "automation_suggestions": [
    {
      "title": "...",
      "body": "...",
      "suggested_automation": {
        "title": "...",
        "description": "...",
        "cadence": "daily" | "weekly" | "monthly",
        "at_time": "HH:MM:SS" | null,
        "day_of_week": 0 | 1 | 2 | 3 | 4 | 5 | 6 | null,
        "day_of_month": 1-31 | null,
        "next_run_at": "<ISO timestamp in UTC>",
        "status": "active"
      },
      "reason": "..."
    }
  ]
}
\`\`\`

Rules for automation_suggestions:
- Keep suggestions household-relevant and practical.
- Always include a valid cadence.
- Always include next_run_at (ISO timestamp in UTC). If the user doesn't specify timing, choose a reasonable default.
- Use at_time/day_of_week/day_of_month only when relevant to the cadence.
- Do not include any additional keys outside the specified schema.

When the user asks to set up or generate a home profile, you should ask a short sequence of questions (one at a time) to collect:
- home_type: apartment or villa
- bhk: 1/2/3/4
- approximate square_feet (optional, number)
- floors (optional, number of floors)
- spaces: a list of notable extra spaces / areas (optional). Examples: multiple balconies, terrace, store room, deck, lift, battery room, solar storage area, pooja room, utility room, home office, gym, basement.
- has_balcony (yes/no) (if they say spaces has balconies, still set this true)
- (optional) if they have balconies/terrace, ask for approximate counts:
  - space_counts.balcony (number)
  - space_counts.terrace (number)
- has_pets (yes/no)
- has_kids (yes/no)
- (optional) flooring_type
- (optional) num_bathrooms

After you have enough information, output a machine-readable JSON code block with an action to create a home profile draft:

\`\`\`json
{
  "actions": [
    {
      "type": "create",
      "table": "home_profiles",
      "record": {
        "home_type": "apartment",
        "bhk": 2,
        "square_feet": null,
        "floors": null,
        "spaces": [],
        "space_counts": {},
        "has_balcony": false,
        "has_pets": false,
        "has_kids": false,
        "flooring_type": null,
        "num_bathrooms": null
      },
      "reason": "Draft home profile based on your answers"
    }
  ]
}
\`\`\`

When the user asks you to look up information from the database (e.g. list helpers, list chores, show alerts, show household members), you MAY instead include a machine-readable JSON code block using this tool-calling format:

\`\`\`json
{
  "tool_calls": [
    {
      "id": "tc_1",
      "tool": "db.select" | "db.insert" | "db.update" | "db.delete",
      "args": { "table": "helpers" | "chores" | "alerts" | "home_profiles" | "households" | "household_members" | "profiles" | "agent_audit_log" | "support_audit_log", "...": "..." },
      "reason": "..."
    }
  ]
}
\`\`\`

Rules for tool_calls:
- Only propose tool calls that are necessary for the user's request.
- Assume the user will review and approve tool calls before execution.
- For db.select, prefer small limits (<= 50) and only request relevant fields.
`;

export const ONBOARDING_SYSTEM_PROMPT = `You are HomeOps, an intelligent household management assistant. You are currently onboarding a new user. Your job is to have a friendly conversation to set up their home profile and initial chores.

ONBOARDING FLOW (follow this sequence):
1. GREET the user warmly and ask about their home (type, size).
2. ASK about rooms/spaces — bedrooms, bathrooms, kitchen, balconies, special rooms.
3. ASK about household features — AC units, water purifier, solar panels, geyser, chimney, garden, etc.
4. ASK about household members — pets, kids, number of bathrooms, flooring type.
5. SUMMARIZE what you've gathered and create the home profile using a tool_calls JSON block.
6. RECOMMEND initial chores based on the home profile (e.g., kitchen daily wipe, bathroom weekly clean, etc.) and create them using tool_calls.
7. ASK if they have household helpers (maid, cook, driver, gardener, etc.). If yes, create them.
8. ASSIGN chores to helpers if they have any.
9. WRAP UP — tell them they're all set and their agent will manage the schedule.

RESUME HANDLING:
- The user's first message may contain an ONBOARDING STATE block showing what's already done.
- If you see "ALREADY COMPLETED" items, do NOT repeat those steps. Skip to the first REMAINING step.
- If the home profile exists but features are missing, ask about features.
- If the home profile and features exist but no chores, recommend chores.
- If everything is done, congratulate and offer to fine-tune.
- Acknowledge what's already set up briefly (e.g., "I see you've already set up your 3BHK apartment with 8 rooms. Let's continue with...")

RULES:
- Ask ONE question at a time. Be conversational, not form-like.
- After each answer, acknowledge briefly and move to the next question.
- Infer defaults from context (e.g., "3BHK apartment" implies 3 bedrooms, kitchen, 2 bathrooms, living room).
- For rooms, use the spaces array format: [{"id":"<unique>","template_name":"<name>","display_name":"<name>","floor":0}]
- When creating home_profiles, use tool_calls with db.insert (NOT the actions JSON format).
- When creating chores, group them in a single tool_calls block and ask for confirmation before executing.
- Be culturally aware of Indian households (pooja room, utility area, servant room, etc.).
- Keep the conversation warm but efficient — aim for 5-8 exchanges to complete onboarding.
- Respond in the same language the user uses. Default to English.

Output rules (critical):
- Do NOT reveal internal chain-of-thought, reasoning, or hidden work.
- Only output final, user-facing content.
- If you output a tool_calls JSON block, output ONLY the JSON code block and nothing else.

Security & internal IDs (critical):
- NEVER ask the user for internal IDs like household_id, user_id, helper_id UUIDs, etc.
- When creating records, you may omit household_id; the system will inject it automatically.
`;

// ── Chat Completion (streaming SSE) ───────────────────────────────────────────

/**
 * Streams a chat completion response from Sarvam sarvam-m.
 * Yields text delta strings until the stream is done.
 */
export async function* streamChat(
  messages: Array<{ role: string; content: string }> | string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const accessToken = localStorage.getItem("homeops.agent.access_token") ?? "";
  const householdId = localStorage.getItem("homeops.agent.household_id") ?? "";
  if (!accessToken.trim() || !householdId.trim()) {
    const lastText =
      typeof messages === "string"
        ? messages
        : (messages[messages.length - 1] && typeof messages[messages.length - 1].content === "string" ? messages[messages.length - 1].content : "");
    yield* _demoStream(lastText);
    return;
  }

  const controller = new AbortController();
  let timeoutId: number | null = null;
  const abort = () => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  // Prevent UI from being stuck in a streaming state if the local Edge function or agent-service hangs.
  const timeoutMsRaw = (import.meta as any)?.env?.VITE_CHAT_TIMEOUT_MS;
  const timeoutMsNum = typeof timeoutMsRaw === "string" ? Number(timeoutMsRaw) : NaN;
  const timeoutMs = Number.isFinite(timeoutMsNum) && timeoutMsNum > 0 ? timeoutMsNum : 90000;
  timeoutId = window.setTimeout(() => abort(), timeoutMs);

  const anon = anonKey();
  const res = await fetch(`${baseUrl()}/functions/v1/server/chat/respond`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "x-user-authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      household_id: householdId,
      messages,
      model: "sarvam-m",
      temperature: 0.3,
      max_tokens: 900,
    }),
  });

  if (timeoutId !== null) {
    window.clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    const lower = (errText || "").toLowerCase();
    if (res.status === 401 && lower.includes("invalid token")) {
      // Clear stale auth so the app falls back to demo mode until the user re-connects.
      localStorage.removeItem("homeops.agent.access_token");
      localStorage.removeItem("homeops.agent.household_id");
      throw new Error(
        "Your session token is invalid/expired. Open Agent Setup and sign in again to refresh your access_token + household_id.",
      );
    }
    throw new Error(`Sarvam chat error ${res.status}: ${errText}`);
  }

  const rawText = await res.text().catch(() => "");
  let parsed: any = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  let outText = "";
  if (parsed && typeof parsed === "object") {
    if (typeof (parsed as any).text === "string") {
      outText = String((parsed as any).text);
    } else if (typeof (parsed as any).final_text === "string") {
      outText = String((parsed as any).final_text);
    } else if (typeof (parsed as any).finalText === "string") {
      outText = String((parsed as any).finalText);
    } else if (Array.isArray((parsed as any).tool_calls)) {
      try {
        outText = "```json\n" + JSON.stringify({ tool_calls: (parsed as any).tool_calls }, null, 2) + "\n```";
      } catch {
        outText = "";
      }
    }
  }
  if (!outText) {
    outText = rawText;
  }
  if (!outText) return;
  yield outText;
}

// ── Speech-to-Text (Saaras v3) ────────────────────────────────────────────────

/**
 * Transcribes an audio Blob using Sarvam Saaras v3.
 * Returns the transcript string.
 */
export async function transcribeAudio(
  audioBlob: Blob,
  languageCode: string,
): Promise<string> {
  const apiKey = getKey();
  if (!apiKey || apiKey === "your_sarvam_api_key_here") {
    throw new Error("VITE_SARVAM_API_KEY is not set. Please add it to your .env file.");
  }

  const form = new FormData();
  // Sarvam accepts webm/ogg directly from MediaRecorder
  form.append("file", audioBlob, "recording.webm");
  form.append("model", "saaras:v3");
  form.append("language_code", languageCode);
  form.append("mode", "transcribe");

  const res = await fetch(`${BASE_URL}/speech-to-text`, {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Sarvam STT error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return (data.transcript as string) ?? "";
}

// ── Demo fallback (no API key) ────────────────────────────────────────────────

async function* _demoStream(userMessage: string): AsyncGenerator<string> {
  const lower = userMessage.toLowerCase();
  let response = "";

  if (lower.includes("chore") || lower.includes("task") || lower.includes("due")) {
    response =
      "Here are your tasks for today:\n✅ Water plants — John (done!)\n🔄 Grocery shopping — Sarah (in progress)\n⏰ Take out trash — John (6:00 PM)\n\n2 tasks are overdue. Should I help reassign them?";
  } else if (lower.includes("recipe") || lower.includes("food") || lower.includes("dinner") || lower.includes("cook")) {
    response =
      "Here are some quick dinner ideas:\n1. 🍛 Dal Tadka with rice (30 min)\n2. 🥘 Paneer butter masala (25 min)\n3. 🫓 Roti with sabzi (20 min)\n\nWould you like a full recipe for any of these?";
  } else if (lower.includes("helper") || lower.includes("cleaner") || lower.includes("plumber")) {
    response =
      "Your scheduled helpers this week:\n- 🧹 Maria (Cleaner) — Tuesday 9 AM\n- 🌿 Green Thumb Co. (Gardener) — Monday 8 AM\n\nNeed to reschedule or add a new helper?";
  } else if (lower.includes("remind") || lower.includes("alert") || lower.includes("bill")) {
    response =
      "Upcoming reminders:\n⏰ Water bill due — Mar 4 ($87.50)\n⏰ HVAC maintenance — Mar 5\n⏰ Kids school fee — Mar 10\n\nShould I set a reminder notification for any of these?";
  } else if (lower.includes("shopping") || lower.includes("grocery")) {
    response =
      "Current shopping list:\n• Milk (2L)\n• Vegetables — onions, tomatoes, spinach\n• Bread\n• Dal & rice\n\nWant me to add anything or send this list to Sarah?";
  } else {
    response =
      "I'm your HomeOps assistant! I can help you:\n- 📋 Track and assign household chores\n- 🍽️ Find recipes and create grocery lists\n- 👷 Schedule helpers and service providers\n- 🔔 Set reminders and manage alerts\n\n*(Set VITE_SARVAM_API_KEY in .env to enable full AI responses)*\n\nWhat would you like to do?";
  }

  // Simulate streaming by yielding word-by-word
  const words = response.split(" ");
  for (const word of words) {
    yield word + " ";
    await _sleep(22);
  }
}

function _sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
