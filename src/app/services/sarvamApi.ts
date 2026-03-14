// ─────────────────────────────────────────────────────────────────────────────
// Sarvam AI API client
// Docs: https://docs.sarvam.ai
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.sarvam.ai";

function getKey(): string {
  return import.meta.env.VITE_SARVAM_API_KEY as string;
}

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

Guidelines:
- Keep responses concise and actionable
- Use bullet points or numbered lists for multi-step answers
- Respond in the same language the user writes in (English, Hindi, or Kannada)
- For task lists, use ✅ (done), 🔄 (in-progress), ⏰ (upcoming), ❌ (overdue) emojis
- Be warm, friendly, and culturally aware of Indian household contexts
- When unsure, ask a clarifying question rather than guessing

User experience (important):
- Proactively guide the user with a simple step-by-step flow.
- If the user seems new or confused, suggest: 1) set up / review Home Profile, 2) create chores, 3) assign helpers / schedules.
- Ask one question at a time and tell the user why you're asking it.

Data rules (critical):
- Never claim you can see the user's real chores/helpers/alerts unless you have retrieved them from the database in this chat.
- If the user asks "what are my chores" / "pending chores" / "list helpers" / "show alerts", you MUST respond with a tool_calls JSON block using db.select for the appropriate table.
- After the tool call results are provided, summarize ONLY what was returned. If no rows are returned, say there are none.
- Do not invent example chores or helper names.
- If you output a tool_calls JSON block, output ONLY the JSON code block and nothing else (no extra explanation text before or after).

When the user asks you to create chores or helpers, include a machine-readable JSON code block at the end of your message in the following format:

\`\`\`json
{
  "actions": [
    {
      "type": "create",
      "table": "chores" | "helpers",
      "record": { "household_id": "...", "title": "..." },
      "reason": "..."
    }
  ]
}
\`\`\`

Rules for the JSON block:
- Only include it when you are confident an action should be taken.
- Always include required fields for the table (chores: title, household_id; helpers: name, household_id).
- For chores, you may include optional fields like description, due_at, priority, and helper_id.
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

// ── Chat Completion (streaming SSE) ───────────────────────────────────────────

/**
 * Streams a chat completion response from Sarvam sarvam-m.
 * Yields text delta strings until the stream is done.
 */
export async function* streamChat(
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const apiKey = getKey();
  if (!apiKey || apiKey === "your_sarvam_api_key_here") {
    // Fallback demo response when no key is set
    yield* _demoStream(messages[messages.length - 1]?.content ?? "");
    return;
  }

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "api-subscription-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages,
      model: "sarvam-m",
      stream: true,
      temperature: 0.3,
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Sarvam chat error ${res.status}: ${errText}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last (potentially incomplete) line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const text: string | undefined = parsed.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        // malformed chunk — skip
      }
    }
  }
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
