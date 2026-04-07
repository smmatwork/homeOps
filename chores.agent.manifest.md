---
description: Chores Agent Manifest
scope: chores
version: 1
---

# Objective
Provide an AI-driven “Chores Agent” that can safely help the user create, schedule, list, update, complete, and delete chores, while operating within strict tool-call and data-access guardrails.

This manifest is a reverse-engineered specification of the current system behavior and contracts implemented across:
- Client: `src/app/components/chat/ChatInterface.tsx` and parsers in `src/app/services/agentActions.ts`
- Edge: Supabase function `supabase/functions/server/index.ts`
- Agent service: `services/agent-service/main.py`
- System prompt rules: `src/app/services/sarvamApi.ts`

# Hard Constraints (Regression / Isolation)
- Do **not** change existing chore semantics:
  - `chores.status` meaning and lifecycle must remain unchanged.
  - `chores.due_at` scheduling behavior must remain unchanged.
  - `chores.metadata` must remain backward compatible.
- Any AI or orchestrator changes must be additive and gated:
  - Do not break existing parsing for `actions`, `tool_calls`, `clarification` payloads.
  - Maintain compatibility with existing UI approval flows.
- Do not require users to provide internal IDs (household_id, chore UUIDs) in chat.

# Must-Have Capabilities
## Chore creation
- Create a chore from natural language.
- Support optional fields:
  - `description`
  - `due_at`
  - `priority`
  - `helper_id`
  - `metadata.space` (space label)
- Provide deterministic behavior when a structured clarification is required (spaces, schedule).

## Scheduling
- If user asks to schedule/book/plan and no explicit datetime is provided:
  - request a schedule clarification (structured) instead of guessing.

## Space-aware chores
- If the user intent implies a space category (bathrooms/balconies/terrace etc.) and multiple relevant spaces exist:
  - request a space selection clarification.
- If the user text uniquely matches one space option (e.g., “master bathroom”):
  - auto-select it and proceed.

## Listing / query
- If user asks for chores (e.g., “pending chores”, “what are my chores”):
  - emit `db.select` tool call.
- Summarize only the rows returned; do not invent chores.

## Update / complete / delete
- Support updates via `db.update` and deletions via `db.delete` with appropriate where clauses.
- Never claim success unless a tool call was emitted and confirmed by the system.

# Clarification Protocol (Chores)
The agent may emit a structured clarification payload:

```json
{
  "clarification": {
    "kind": "space_selection" | "schedule",
    "title": "...",
    "required": true,
    "multi": true,
    "options": ["..."]
  }
}
```

The client responds with a structured clarification response message:

```json
{ "clarification_response": { "spaces": ["..."], "due_at": "<ISO optional>" } }
```

Rules:
- The agent must be able to continue after receiving `clarification_response`.
- Space selection may be multi-select for bathrooms (including “All bathrooms”).

# Tool Call Contract
## Allowed tools
`db.select`, `db.insert`, `db.update`, `db.delete`

## Tool call payload
The assistant output must include a JSON payload that can be parsed by `parseToolCallsFromAssistantText`:

```json
{ "tool_calls": [ { "id": "...", "tool": "db.insert", "args": { "table": "chores", "record": { "title": "..." } }, "reason": "..." } ] }
```

## Shapes (current expectations)
- `db.select`: `{ "table": <string>, "columns": <string | string[]>, "where"?: <object>, "limit"?: <number> }`
- `db.insert`: `{ "table": <string>, "record": <object> }`
- `db.update`: `{ "table": <string>, "where": <object>, "updates": <object> }`
- `db.delete`: `{ "table": <string>, "where": <object> }`

# Data & Content Guardrails
- Never fabricate chores or helpers.
- When tool results are empty, report “none found.”
- Do not reveal chain-of-thought.
- Avoid printing home profile summaries unless explicitly asked.

# UI Integration Requirements
- The chat UI must:
  - parse `actions`, `tool_calls`, `clarification` payloads
  - display clarification dialogs (space selection, schedule)
  - require explicit user approval for DB writes
- The chores UI (`src/app/components/chores/Chores.tsx`) remains a separate non-agent workflow.

# Modularity / File Structure (required)
- Do not add chores-agent logic into `Chores.tsx`.
- Prefer isolated modules:
  - `src/app/services/agentActions.ts` for parsing
  - `src/app/services/agentApi.ts` for transport/tool execution
  - `services/agent-service/main.py` for orchestrator + strict-contract LLM calls
  - `supabase/functions/server/index.ts` for tool execution allowlist and DB access

# Test Requirements (must-have)
## Unit tests
- Parsing:
  - `parseToolCallsFromAssistantText` accepts valid payloads and rejects invalid payloads.
  - `parseClarificationFromAssistantText` handles fenced blocks and embedded JSON.
- Scheduling:
  - schedule request triggers `clarification.kind=schedule` if missing datetime.

## Component tests
- ChatInterface:
  - space selection prompt opens when ambiguity exists
  - auto-selects when user message matches a single option
  - schedule clarification flow
  - tool approval card flow does not duplicate writes

## E2E (Playwright)
- Create chore in chat, approve, verify it appears in chores list.
- Ambiguous bathroom flow: prompt -> select -> approve -> verify.
- Schedule flow: prompt -> provide due_at -> approve -> verify.

# Definition of Done
- All must-have capabilities function end-to-end.
- No regressions to chores list/daily/coverage views.
- Tests added and passing (unit + component + e2e).
