---
description: Orchestrator Manifest (Chat → Clarifications → Tool Calls)
scope: orchestrator
version: 1
---

# Objective
Provide a robust “Orchestrator” layer that sits between:
- the UI chat client,
- the Edge function tool executor,
- and the LLM/agent-service,

to ensure:
- strict, safe output schemas
- deterministic clarifications (space selection, schedule)
- tool call validation and allowlisting
- zero hallucinated DB writes
- regression-safe integration with existing chores/helpers/home profile experiences.

This manifest is reverse-engineered from the current implementation:
- Agent-service: `services/agent-service/main.py` (strict JSON contract, clarification extraction, fallback logic)
- Edge: `supabase/functions/server/index.ts` (tool allowlist, DB execution, summarization)
- Client: `src/app/components/chat/ChatInterface.tsx` and `src/app/services/agentActions.ts` (parsing + UI flows)
- Prompt rules: `src/app/services/sarvamApi.ts` (system prompt guardrails)

# Non-Goals
- The orchestrator must not become a “business logic dumping ground.”
- Do not embed chores UI logic into orchestration.
- Do not add new tool capabilities without allowlisting and tests.

# Hard Constraints (Safety + Regression)
- Never claim a database write occurred unless a valid `tool_calls` payload was produced and executed.
- Never request internal IDs from the user.
- Never invent entities (chores, helpers, spaces) not returned by tool results.
- Preserve backward compatibility of:
  - `actions` payload parsing
  - `tool_calls` payload parsing
  - `clarification` payload parsing
- Tool execution must be restricted by allowlist.

# Responsibilities
## 1) Message shaping
- Maintain a consistent message array `{role, content}`.
- Inject system-level guardrails and strict output contracts.

## 2) Clarification handling
### Space selection
- Detect when space selection is required using a deterministic signal:
  - Edge-injected system block containing `CLARIFICATION NEEDED (critical):`.
- Convert this block into a structured clarification payload:

```json
{ "clarification": { "kind": "space_selection", "title": "...", "required": true, "multi": true, "options": ["..."] } }
```

- Accept a structured user response:

```json
{ "clarification_response": { "spaces": ["..."], "due_at": "<optional>" } }
```

- Auto-select when user text uniquely matches a single option.

### Scheduling
- If user intent indicates scheduling (schedule/book/plan) and no explicit datetime is found:
  - emit structured clarification `kind=schedule`.

## 3) Strict JSON output enforcement
- Enforce “final-only” strict schema for the LLM output:
  - Either `{ "final_text": "..." }`
  - Or `{ "tool_calls": [ ... ] }`
- No markdown fences in the final-only mode.
- Provide a repair/regenerate loop at most once or twice:
  - initial parse
  - repair attempt
  - regen attempt
  - deterministic fallback question

## 4) Tool call validation
- Validate tool call shape before execution:
  - tool name in {db.select, db.insert, db.update, db.delete}
  - args is object
  - table is allowlisted
  - required keys present
- Reject tool calls with extra keys or invalid structure.

## 5) Result summarization
- Summarize tool results deterministically (Edge-side), capped to a small number of rows.
- Never include PII beyond what the user already has access to.

# Data Flow
1. UI sends chat messages to Edge chat endpoint.
2. Edge calls agent-service `/v1/chat/respond` with the conversation.
3. Agent-service returns one of:
   - clarification payload (fenced JSON)
   - tool_calls payload (fenced JSON)
   - user-facing text
4. UI parses the latest assistant message:
   - `parseClarificationFromAssistantText`
   - `parseToolCallsFromAssistantText`
   - `parseAgentActionsFromAssistantText`
5. UI renders:
   - clarification dialogs
   - proposal/approval cards
6. UI calls Edge `/tools/execute` to execute tool calls.

# Interfaces / Schemas
## Clarification block (Edge → agent-service)
System message must contain:
- Header: `CLARIFICATION NEEDED (critical):`
- A user-facing question/title
- Options lines prefixed with `- `

## Tool allowlist (Edge)
- Enforced via a per-table allowlist (select/insert/update/delete).

# Modularity / Isolation
- Keep orchestrator logic in `services/agent-service/main.py`.
- Keep tool execution logic in `supabase/functions/server/index.ts`.
- Keep parsing logic in `src/app/services/agentActions.ts`.
- Keep UI flows in `src/app/components/chat/ChatInterface.tsx`.

Any new orchestrator feature must:
- introduce new modules rather than growing `main.py` indefinitely
- include unit tests for parsing and schema validation

# Observability (required)
- Log minimal structured events:
  - strict schema parse failures
  - repair attempts
  - clarification emitted
  - tool call validation failures
- Never log secrets (API keys) or user tokens.

# Test Requirements (must-have)
## Unit tests
- JSON extraction:
  - fenced json blocks
  - embedded json objects
- Strict schema parsing:
  - accept `{final_text}` and `{tool_calls}`
  - reject anything else
- Clarification extraction from Edge system block.
- Tool allowlist enforcement.

## Integration tests
- End-to-end chat flow with:
  - space clarification
  - schedule clarification
  - tool call execution

## E2E (Playwright)
- Ambiguous bathroom scenario:
  - orchestrator emits clarification
  - user selects
  - tool call executed
- Schedule scenario:
  - orchestrator emits schedule clarification
  - user provides datetime
  - tool call executed

# Definition of Done
- Orchestrator behaves deterministically.
- Clarifications are structured and recoverable.
- Tool calls are validated and allowlisted.
- No regressions to chat UX or chores page.
- Test suite covers main happy paths and key failures.
