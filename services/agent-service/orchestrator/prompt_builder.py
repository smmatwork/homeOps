"""System-prompt augmentation before the main LLM turn.

Three responsibilities:
  1. Build the FINAL_ONLY_CLAUSE — the strict JSON output contract that tells
     the LLM to return ONLY `{"final_text": ...}` or `{"tool_calls": [...]}`.
  2. Compose the enhanced system prompt: FACTS + intent instruction + the
     final-only clause (or a lighter onboarding-mode guard).
  3. Mutate `messages` in place to prepend/append the enhanced suffix onto
     the existing system prompt, keeping the structure the caller expects.

Keeps the handler's chat_respond body shorter and makes the strict-contract
text trivially diffable without navigating around other phase logic.
"""

from __future__ import annotations

from typing import Any

from orchestrator.facts import build_facts_section as _build_facts_section
from orchestrator.intent import classify_intent, intent_specific_instruction


FINAL_ONLY_CLAUSE = (
    "\n\nCRITICAL OUTPUT CONTRACT (must follow):\n"
    "Return ONLY a single JSON object and nothing else (no markdown, no prose).\n"
    "The JSON must be EXACTLY one of:\n"
    "1) {\"final_text\": <string>}\n"
    "2) {\"tool_calls\": [ {\"id\": <string>, \"tool\": \"db.select\"|\"db.insert\"|\"db.update\"|\"db.delete\"|\"query.rpc\", \"args\": <object>, \"reason\": <string optional>} ] }\n"
    "Rules:\n"
    "- Do NOT include analysis/reasoning/chain-of-thought.\n"
    "- If you need missing information to complete a task, ASK a clarifying question in final_text. "
    "Do NOT guess, do NOT list chores as a substitute for acting. Examples of when to ask:\n"
    "  * User says 'assign bathroom chores to Roopa' but FACTS has multiple bathrooms → ask 'Which bathrooms? All of them, or specific ones?'\n"
    "  * User says 'change frequency' but doesn't say which chores or what frequency → ask 'Which chores, and what frequency?'\n"
    "  * User describes a complex pattern ('Roopa does bathrooms daily, except guest bathroom weekly') → break it into steps and confirm: 'I'll: 1) assign all bathroom chores to Roopa, 2) set them to daily, 3) set Guest Bathroom to weekly. Shall I proceed?'\n"
    "- If a request involves bulk assignment or complex scheduling that can't be done in a single tool call, "
    "guide the user: 'For bulk workload changes, go to Chores → Coverage → Utilization → Optimize workload.'\n"
    "- NEVER respond by just listing chores when the user asked to assign/change/update them. Either act or ask what's needed to act.\n"
    "- Never invent helpers/chores/people/IDs; use provided FACTS or request tool_calls.\n"
    "- Chores can be assigned to EITHER a helper (helper_id) OR a household person (assignee_person_id). "
    "If the user says 'assign to me' or names a household member from the People list, use assignee_person_id. "
    "Never set both helper_id and assignee_person_id on the same chore.\n"
    "- For analytics / reporting questions about chores/helpers/spaces (counts, grouping, listing), prefer query.rpc over db.select.\n"
    "- Tool call args MUST follow these shapes:\n"
    "  - db.select: {\"table\": <string>, \"columns\": <string or array>, \"where\": <object optional>, \"limit\": <number optional>}\n"
    "  - db.insert: {\"table\": <string>, \"record\": <object>}\n"
    "  - db.update: {\"table\": <string>, \"id\": <string>, \"patch\": <object>}\n"
    "  - db.delete: {\"table\": <string>, \"id\": <string>}\n"
    "  - query.rpc: {\"name\": <string>, \"params\": <object optional>}\n"
    "  - Allowlisted query.rpc names for analytics: resolve_helper, resolve_space, count_chores_assigned_to, count_chores, group_chores_by_status, group_chores_by_assignee, list_chores_enriched, get_o1_cognitive_load_ratio.\n"
    "  - For analytics RPCs, pass filters via params.p_filters (json object). Example: {\"name\":\"count_chores\", \"params\":{\"p_filters\":{\"status\":\"closed\"}}}.\n"
    "  - Allowlisted query.rpc names for writes: apply_chore_assignments, assign_or_create_chore, complete_chore_by_query, reassign_chore_by_query, apply_assignment_decision.\n"
    "- For creating chores: use db.insert with table=\"chores\" and put fields under record (e.g., title, due_at, helper_id, metadata).\n"
    "\nCanonical examples (follow structure exactly; do not copy IDs verbatim):\n"
    "A) Count pending chores:\n"
    "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"count_chores\",\"params\":{\"p_filters\":{\"status\":\"pending\"}}},\"reason\":\"Count pending chores.\"}]}\n"
    "B) Count unassigned chores:\n"
    "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"count_chores\",\"params\":{\"p_filters\":{\"unassigned\":true}}},\"reason\":\"Count unassigned chores.\"}]}\n"
    "C) Group chores by status:\n"
    "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"group_chores_by_status\",\"params\":{\"p_filters\":{}}},\"reason\":\"Group chores by status.\"}]}\n"
    "D) List chores in a space (example space query):\n"
    "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"list_chores_enriched\",\"params\":{\"p_filters\":{\"space_query\":\"Kitchen\"},\"p_limit\":25}},\"reason\":\"List chores for a space.\"}]}\n"
    "E) Complete a chore by text query:\n"
    "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"complete_chore_by_query\",\"params\":{\"p_query\":\"mop kitchen\"}},\"reason\":\"Complete the matching chore.\"}]}\n"
)


ONBOARDING_OUTPUT_GUARD = (
    "\n\nOUTPUT GUARD (onboarding mode):\n"
    "- Return ONLY user-facing text. No chain-of-thought, no narration, no meta-commentary.\n"
    "- NEVER say 'User has submitted', 'Next steps:', 'I will now', 'Let me process'.\n"
    "- After receiving form data, respond with a 1-sentence acknowledgment then the next form or tool_calls.\n"
    "- NEVER ask 'What would you like to do?' — always auto-proceed to the next onboarding step.\n"
)


async def build_system_prompt_augmentation(
    messages: list[dict[str, Any]],
    *,
    household_id: str,
    user_id: str,
    last_user_text: str,
    is_onboarding: bool,
) -> tuple[list[dict[str, Any]], str, str]:
    """Compose the enhanced system prompt and prepend/append it to `messages`.

    Returns (augmented_messages, facts_section, intent_label). Callers use the
    facts_section later for entity-ID validation and the intent_label for
    telemetry. `messages` is replaced (not mutated) with a new list — the
    head system message is patched in a fresh dict, tail messages are shared
    by reference.

    Behaviour:
      - Normal mode: append FACTS + intent-specific instruction + the strict
        FINAL_ONLY_CLAUSE to the head system message.
      - Onboarding mode: append FACTS + a lighter output guard so the
        onboarding system prompt retains its own behavior rules.
    """
    facts_section = ""
    try:
        facts_section = await _build_facts_section(household_id, user_id)
    except Exception:
        facts_section = ""

    intent = classify_intent(last_user_text)
    intent_instruction = intent_specific_instruction(intent)

    enhanced_suffix = ""
    if not is_onboarding:
        if facts_section:
            enhanced_suffix += "\n\n" + facts_section
        if intent_instruction:
            enhanced_suffix += "\n" + intent_instruction
        enhanced_suffix += FINAL_ONLY_CLAUSE
    else:
        if facts_section:
            enhanced_suffix += "\n\n" + facts_section
        enhanced_suffix += ONBOARDING_OUTPUT_GUARD

    out_messages = list(messages)
    if out_messages and isinstance(out_messages[0], dict) and out_messages[0].get("role") == "system":
        c0 = out_messages[0].get("content")
        if isinstance(c0, str):
            # Don't mutate the original dict — caller may still hold a reference.
            head = dict(out_messages[0])
            head["content"] = c0.rstrip() + enhanced_suffix
            out_messages[0] = head
    else:
        out_messages = [{"role": "system", "content": enhanced_suffix.strip()}] + out_messages

    return out_messages, facts_section, intent


__all__ = [
    "FINAL_ONLY_CLAUSE",
    "ONBOARDING_OUTPUT_GUARD",
    "build_system_prompt_augmentation",
]
