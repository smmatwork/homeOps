"""Intent extraction cascade — shared by all domain agents.

Four-tier cascade (deterministic-first, LLM fallback):

  Tier 1 — Registry extractors (intent_registry.INTENT_REGISTRY): per-intent
           regex extractors registered as IntentDef.extract callables
           (_extract_add_space, _extract_reassign, _extract_elicitation, ...).
  Tier 2 — _UPDATE_FIELD_RE fallback: generic "remove/change <field> of <X>
           [to <Y>]" update-pattern regex for update phrasings the registry
           extractors don't cover.
  Tier 3 — LLM extraction: Sarvam call with EXTRACTION_SYSTEM_PROMPT, JSON-only
           output, temperature=0.0. Reached only when Tiers 1 and 2 miss.
  Tier 4 — Confidence gate: any LLM-produced intent with confidence < 0.5 is
           dropped (array and single paths both enforced).

classify_intent() and intent_specific_instruction() are a separate, parallel
system: they return an intent NAME (string) used to append a per-intent hint
to the LLM system prompt. They do not drive tool-call generation directly.
Re-exported here so domain agents have one import surface.
"""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

from intent_registry import (
    INTENT_REGISTRY,
    ExtractedIntent,
    classify_intent,
)
from intent_registry import get_llm_hint as intent_specific_instruction


ChatFn = Callable[..., Awaitable[Any]]


EXTRACTION_SYSTEM_PROMPT = (
    "You are a structured data extractor for a home management app. "
    "Given the user's message, extract the intent into JSON.\n"
    "Return ONLY the JSON. No reasoning, no thinking, no explanation.\n\n"
    "If the message contains a SINGLE intent, return ONE JSON object.\n"
    "If the message contains MULTIPLE distinct instructions (e.g., 'assign X to Y and change Z to weekly'), "
    "return a JSON array of objects — one per instruction.\n\n"
    "Each object has these fields:\n"
    "{\n"
    "  \"action\": \"update\" | \"rename\" | \"reassign\" | \"change_cadence\" | \"change_priority\" | \"change_due\" | \"add_note\" | \"remove_field\" | \"none\",\n"
    "  \"entity\": \"chore\" | \"helper\" | \"space\",\n"
    "  \"match_text\": \"<text to find the target record, e.g. chore title, helper name, or space/room name>\",\n"
    "  \"match_field\": \"title\" | \"name\" | \"space\" | null,\n"
    "  \"update_field\": \"description\" | \"title\" | \"cadence\" | \"priority\" | \"due_at\" | \"helper_id\" | \"phone\" | \"schedule\" | null,\n"
    "  \"update_value\": \"<the new value to set>\",\n"
    "  \"bulk\": false,\n"
    "  \"confidence\": 0.0 to 1.0\n"
    "}\n\n"
    "Rules:\n"
    "- If the user says 'remove the description' or 'clear the description', set update_value to null.\n"
    "- If the user says 'instead mention X' or 'change to X' or 'replace with X', extract X as update_value.\n"
    "- match_text should be the existing chore title/helper name/space the user is referring to.\n"
    "- match_text is matched as a single ILIKE substring against title AND description, so pick ONE\n"
    "  distinctive keyword the user mentioned. Do NOT join multiple keywords with 'and'/'or' —\n"
    "  if the user references two unrelated keywords, pick the most distinctive one.\n"
    "- If the user's reference (e.g. 'toy') sounds like a description word rather than a chore title,\n"
    "  set match_field='title' anyway (the search covers both fields).\n"
    "- When the user says 'assign bathroom chores to Roopa', that's a reassign with match_text='bathroom',\n"
    "  match_field='space', update_field='helper_id', update_value='Roopa'.\n"
    "- When the user combines assignment + cadence in one message (e.g., 'Roopa should clean bathrooms daily,\n"
    "  but guest bathroom weekly'), split into separate intents: one reassign + one or more change_cadence.\n"
    "- If you can't determine the intent, set action='none' and confidence=0.\n"
    "- Do NOT invent data. Only extract what the user explicitly stated.\n\n"
    "Examples:\n"
    "User: 'Change the description of toy and clutter sweep to arrange cloths or books'\n"
    "{\"action\":\"update\",\"entity\":\"chore\",\"match_text\":\"toy\",\"match_field\":\"title\","
    "\"update_field\":\"description\",\"update_value\":\"Arrange cloths or books\",\"bulk\":true,\"confidence\":0.9}\n\n"
    "User: 'Rename kitchen cleaning to kitchen jhadu pocha'\n"
    "{\"action\":\"rename\",\"entity\":\"chore\",\"match_text\":\"kitchen cleaning\",\"match_field\":\"title\","
    "\"update_field\":\"title\",\"update_value\":\"Kitchen jhadu pocha\",\"bulk\":false,\"confidence\":0.9}\n\n"
    "User: 'Make all bathroom chores weekly'\n"
    "{\"action\":\"change_cadence\",\"entity\":\"chore\",\"match_text\":\"bathroom\",\"match_field\":\"space\","
    "\"update_field\":\"cadence\",\"update_value\":\"weekly\",\"bulk\":true,\"confidence\":0.85}\n\n"
    "User: 'Give Alice\\'s kitchen tasks to Bob'\n"
    "{\"action\":\"reassign\",\"entity\":\"chore\",\"match_text\":\"kitchen\",\"match_field\":\"space\","
    "\"update_field\":\"helper_id\",\"update_value\":\"Bob\",\"bulk\":true,\"confidence\":0.85}\n\n"
    "User: 'Roopa should clean all bathrooms daily, but guest bathroom and home office bathroom at lower frequency'\n"
    "[{\"action\":\"reassign\",\"entity\":\"chore\",\"match_text\":\"bathroom\",\"match_field\":\"space\","
    "\"update_field\":\"helper_id\",\"update_value\":\"Roopa\",\"bulk\":true,\"confidence\":0.9},"
    "{\"action\":\"change_cadence\",\"entity\":\"chore\",\"match_text\":\"bathroom\",\"match_field\":\"space\","
    "\"update_field\":\"cadence\",\"update_value\":\"daily\",\"bulk\":true,\"confidence\":0.85},"
    "{\"action\":\"change_cadence\",\"entity\":\"chore\",\"match_text\":\"guest bathroom\",\"match_field\":\"space\","
    "\"update_field\":\"cadence\",\"update_value\":\"weekly\",\"bulk\":true,\"confidence\":0.85},"
    "{\"action\":\"change_cadence\",\"entity\":\"chore\",\"match_text\":\"home office bathroom\",\"match_field\":\"space\","
    "\"update_field\":\"cadence\",\"update_value\":\"weekly\",\"bulk\":true,\"confidence\":0.85}]\n\n"
    "User: 'What chores are due today?'\n"
    "{\"action\":\"none\",\"entity\":\"chore\",\"match_text\":\"\",\"match_field\":null,"
    "\"update_field\":null,\"update_value\":null,\"bulk\":false,\"confidence\":0.0}\n"
)


_UPDATE_FIELD_RE = re.compile(
    r"""
    (?:
        (?:remove|clear|delete)\s+(?:the\s+)?(?P<field_remove>description|title|name|cadence|priority|due\s*date)
        \s+(?:of|for|from)\s+
        (?P<match_remove>.+?)
        \s*(?:,\s*(?:and\s+)?(?:instead\s+)?(?:mention|add|put|say|use|make\s+it)\s+(?P<value_remove>.+?))?
        \s*$
    )
    |
    (?:
        (?:change|update|edit|modify|rename|replace|set|adjust)
        \s+(?:the\s+)?(?P<field_change>description|title|name|cadence|priority|due\s*date)
        \s+(?:of|for)\s+
        (?P<match_change>.+?)
        \s+(?:to|with|as|into)\s+
        (?P<value_change>.+?)
        \s*$
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _strip_think_blocks(text: str) -> str:
    s = text or ""
    try:
        s = re.sub(r"<think>.*?</think>\s*", "", s, flags=re.DOTALL | re.IGNORECASE)
        s = re.sub(r"<analysis>.*?</analysis>\s*", "", s, flags=re.DOTALL | re.IGNORECASE)
        s = re.sub(r"^\s*(thinking|thought|analysis|reasoning)\s*:\s*", "", s, flags=re.IGNORECASE)
    except Exception:
        pass
    return s.strip()


def _try_parse_json_obj(text: str) -> dict[str, Any] | None:
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        return None
    return None


def extract_intent_regex(user_text: str) -> ExtractedIntent | None:
    """Tier 2: deterministic regex extractor for common update-chore patterns.

    Handles:
      - "remove the description of <X>, instead mention <Y>"
      - "change the description of <X> to <Y>"
      - "update the cadence of <X> to weekly"
      - "rename <X> to <Y>" is handled by the LLM extractor (no 'of' keyword).

    Returns an ExtractedIntent with confidence 1.0 on match, None otherwise.
    Downstream match resolution handles multi-keyword match_text via
    keyword splitting, so bulk=True is set by default.
    """
    if not user_text or not user_text.strip():
        return None
    s = user_text.strip().rstrip(".!?")
    m = _UPDATE_FIELD_RE.search(s)
    if not m:
        return None

    field = (m.group("field_remove") or m.group("field_change") or "").strip().lower()
    match_text = (m.group("match_remove") or m.group("match_change") or "").strip()
    new_value = m.group("value_remove") or m.group("value_change")

    if field == "description":
        update_field = "description"
    elif field == "title":
        update_field = "title"
    elif field == "name":
        update_field = "title"
    elif field == "cadence":
        update_field = "cadence"
    elif field == "priority":
        update_field = "priority"
    elif "due" in field:
        update_field = "due_at"
    else:
        return None

    match_text = re.sub(
        r"\s+(?:from\s+(?:the\s+)?(?:chores?|list|records?)|chores?)\s*$",
        "",
        match_text,
        flags=re.IGNORECASE,
    ).strip()

    if not match_text:
        return None

    update_value: str | None = new_value.strip() if new_value else None

    return ExtractedIntent(
        action="update",
        entity="chore",
        match_text=match_text,
        match_field="title",
        update_field=update_field,
        update_value=update_value,
        bulk=True,
        confidence=1.0,
    )


async def extract_structured_intent(
    user_text: str,
    model: str,
    chat_fn: ChatFn,
    facts_summary: str = "",  # accepted for compat; intentionally unused
) -> ExtractedIntent | list[ExtractedIntent] | None:
    """Full intent cascade: registry extractors → regex fallback → LLM extraction.

    `chat_fn` is the async LLM client (e.g. _sarvam_chat) injected by the
    caller so this module stays free of LLM infra dependencies. It is invoked
    as `await chat_fn(messages=..., model=..., temperature=0.0, max_tokens=1200)`
    and must return the raw assistant string.

    Returns a single ExtractedIntent, a list of ExtractedIntents (for compound
    instructions), or None if no actionable intent is found.
    """
    if not user_text.strip():
        return None

    # Tier 1: Registry extractors (per-intent regex, first hit wins).
    for intent_def_item in INTENT_REGISTRY:
        if intent_def_item.extract:
            hit = intent_def_item.extract(user_text)
            if hit:
                print(
                    "intent_registry_hit",
                    {"intent": intent_def_item.name, "match_text": hit.match_text},
                    flush=True,
                )
                return hit

    # Tier 2: Generic update-pattern regex.
    regex_hit = extract_intent_regex(user_text)
    if regex_hit:
        print(
            "intent_regex_hit",
            {
                "match_text": regex_hit.match_text,
                "update_field": regex_hit.update_field,
                "update_value": regex_hit.update_value,
            },
            flush=True,
        )
        return regex_hit

    # Tier 3: LLM extraction. Called only when deterministic tiers miss.
    extraction_input = f"User message: {user_text}"
    try:
        raw = await chat_fn(
            messages=[
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                {"role": "user", "content": extraction_input},
            ],
            model=model,
            temperature=0.0,
            max_tokens=1200,
        )
        if not isinstance(raw, str):
            return None

        cleaned = _strip_think_blocks(raw).strip()
        cleaned = re.sub(r"```json?\s*|\s*```", "", cleaned).strip()

        # Array path: compound intents.
        if cleaned.startswith("["):
            try:
                arr = json.loads(cleaned)
                if isinstance(arr, list) and len(arr) > 0:
                    intents: list[ExtractedIntent] = []
                    for obj in arr:
                        if not isinstance(obj, dict) or obj.get("action") == "none":
                            continue
                        confidence = float(obj.get("confidence", 0))
                        # Tier 4: confidence gate.
                        if confidence < 0.5:
                            continue
                        intents.append(ExtractedIntent(
                            action=str(obj.get("action", "")),
                            entity=str(obj.get("entity", "")),
                            match_text=str(obj.get("match_text", "")),
                            match_field=obj.get("match_field"),
                            update_field=obj.get("update_field"),
                            update_value=obj.get("update_value"),
                            bulk=bool(obj.get("bulk", False)),
                            confidence=confidence,
                        ))
                    if len(intents) == 0:
                        return None
                    if len(intents) == 1:
                        return intents[0]
                    return intents
            except (json.JSONDecodeError, ValueError):
                pass

        # Single-object path.
        obj = _try_parse_json_obj(cleaned)
        if not obj or obj.get("action") == "none":
            return None

        confidence = float(obj.get("confidence", 0))
        # Tier 4: confidence gate.
        if confidence < 0.5:
            return None

        return ExtractedIntent(
            action=str(obj.get("action", "")),
            entity=str(obj.get("entity", "")),
            match_text=str(obj.get("match_text", "")),
            match_field=obj.get("match_field"),
            update_field=obj.get("update_field"),
            update_value=obj.get("update_value"),
            bulk=bool(obj.get("bulk", False)),
            confidence=confidence,
        )
    except Exception:
        return None


__all__ = [
    "EXTRACTION_SYSTEM_PROMPT",
    "ExtractedIntent",
    "classify_intent",
    "extract_intent_regex",
    "extract_structured_intent",
    "intent_specific_instruction",
]
