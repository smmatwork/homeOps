"""
Intent Registry — single source of truth for all intent handling.

Each intent is a row in INTENT_REGISTRY with:
  - name:          unique identifier
  - detect:        list of (priority, regex) for classification — higher priority wins
  - extract:       optional sync function(user_text) -> ExtractedIntent | None
  - to_tool_calls: optional async function(intent, facts, household_id, user_id) -> [tool_calls] | None
  - llm_hint:      instruction appended to system prompt when this intent is active
  - requires_plan: whether to show plan-confirm before executing (default True)

The registry replaces:
  - INTENT_PATTERNS + _COMPOUND_OVERRIDES  → detect
  - _extract_intent_regex / _extract_add_space_intent → extract
  - _intent_to_tool_calls (per-action branches) → to_tool_calls
  - intent_specific_instruction → llm_hint
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable, Optional


@dataclass
class ExtractedIntent:
    action: str
    entity: str
    match_text: str
    match_field: str | None
    update_field: str | None
    update_value: str | None
    bulk: bool
    confidence: float


@dataclass
class IntentDef:
    """One row in the intent registry."""
    name: str

    # Detection: list of (priority, compiled_regex). Higher priority = checked first.
    # All regexes across all intents are sorted by priority, first match wins.
    detect: list[tuple[int, re.Pattern[str]]] = field(default_factory=list)

    # Deterministic extraction (sync). Returns ExtractedIntent or None.
    extract: Optional[Callable[[str], ExtractedIntent | None]] = None

    # Convert extracted intent to tool calls (async). Returns list or None.
    to_tool_calls: Optional[Callable[..., Awaitable[list[dict[str, Any]] | None]]] = None

    # LLM system prompt hint when this intent is classified
    llm_hint: str = ""

    # Whether to show plan-confirm before executing tool calls
    requires_plan: bool = True


# ── Detection helpers ────────────────────────────────────────────────

def _p(priority: int, pattern: str) -> tuple[int, re.Pattern[str]]:
    """Shorthand for (priority, compiled_regex)."""
    return (priority, re.compile(pattern, re.IGNORECASE))


# ── Extraction functions ─────────────────────────────────────────────

_ADD_SPACE_RE = re.compile(
    r"\badd\s+(?P<space>.+?)\s+to\s+(?:my\s+)?(?:home\s*profile|rooms?|spaces?|house)\b",
    re.IGNORECASE,
)

def _extract_add_space(text: str) -> ExtractedIntent | None:
    m = _ADD_SPACE_RE.search(text or "")
    if not m:
        return None
    space_name = m.group("space").strip().strip("\"'")
    if not space_name:
        return None
    return ExtractedIntent(
        action="add_space", entity="space", match_text=space_name,
        match_field=None, update_field=None, update_value=None,
        bulk=False, confidence=1.0,
    )


# ── Elicitation scope detection ──────────────────────────────────────
#
# Maps free-text hints ("kitchen", "cooking", "outdoor", "laundry", etc.)
# to a canonical elicitation template_id. Returned as update_value on the
# ExtractedIntent so the tool-call builder can pass it to the UI.
_SCOPE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("specialty_kitchen",  re.compile(r"\b(kitchen|cook|dish|dining)\b", re.IGNORECASE)),
    ("specialty_outdoor",  re.compile(r"\b(garden|outdoor|balcony|terrace|garage|lawn)\b", re.IGNORECASE)),
    ("specialty_laundry",  re.compile(r"\b(laundry|wash\s*cloth|iron|dhobi)\b", re.IGNORECASE)),
    ("specialty_cleaning", re.compile(r"\b(clean|sweep|mop|dust|bathroom|bedroom|room)\b", re.IGNORECASE)),
]

def _extract_elicitation(text: str) -> ExtractedIntent | None:
    t = (text or "").strip()
    if not t:
        return None
    scope: str | None = None
    for template_id, pat in _SCOPE_PATTERNS:
        if pat.search(t):
            scope = template_id
            break
    return ExtractedIntent(
        action="elicit",
        entity="preferences",
        match_text="elicitation",
        match_field=None,
        update_field="scope",
        update_value=scope,
        bulk=False,
        confidence=0.9 if scope else 0.6,
    )


async def _start_elicitation_tool_calls(
    extracted: ExtractedIntent,
    facts: str = "",
    *,
    household_id: str = "",
    user_id: str = "",
) -> list[dict[str, Any]] | None:
    """Emit a ui.* pseudo tool call. The client recognizes the `ui.` prefix
    and dispatches to a React action (opening the elicitation dialog)
    instead of routing through the edge function."""
    scope = extracted.update_value  # e.g. "specialty_kitchen" or None
    return [{
        "id": f"tc_elicit_{uuid.uuid4().hex[:8]}",
        "tool": "ui.open_elicitation",
        "args": {"scope": scope},
        "reason": (
            f"Open the assignment-preference setup dialog for {scope}"
            if scope else "Open the assignment-preference setup dialog"
        ),
    }]


_REASSIGN_RE = re.compile(
    r"\b(assign|reassign|move)\b\s+(?:the\s+)?(?P<chore>.+?)\s+to\s+(?:the\s+)?(?P<helper>.+?)\s*$",
    re.IGNORECASE,
)

def _extract_reassign(text: str) -> ExtractedIntent | None:
    m = _REASSIGN_RE.search((text or "").strip().lower())
    if not m:
        return None
    chore = re.sub(r"[.?!,;:]+$", "", (m.group("chore") or "").strip()).strip()
    helper = re.sub(r"[.?!,;:]+$", "", (m.group("helper") or "").strip()).strip()
    if not chore or not helper:
        return None
    is_bulk = any(w in chore for w in ("all ", "my ", "every "))
    return ExtractedIntent(
        action="reassign", entity="chore", match_text=chore,
        match_field="title", update_field="helper_id", update_value=helper,
        bulk=is_bulk, confidence=1.0,
    )


_COMPLETE_RE = re.compile(
    r"\b(?:done|complete|mark\s+(?:as\s+)?done|finished|check\s+off)\s+(?:the\s+)?(?:chore\s+)?(?P<chore>.+?)\s*$",
    re.IGNORECASE,
)

def _extract_complete(text: str) -> ExtractedIntent | None:
    m = _COMPLETE_RE.search((text or "").strip())
    if not m:
        return None
    chore = re.sub(r"[.?!,;:]+$", "", (m.group("chore") or "").strip()).strip()
    if not chore:
        return None
    return ExtractedIntent(
        action="complete", entity="chore", match_text=chore,
        match_field="title", update_field=None, update_value=None,
        bulk=False, confidence=1.0,
    )


# ── Tool call builders ───────────────────────────────────────────────

async def _add_space_tool_calls(
    extracted: ExtractedIntent, facts: str = "", *, household_id: str = "", user_id: str = "",
) -> list[dict[str, Any]] | None:
    if not extracted.match_text:
        return None
    return [{
        "id": f"tc_add_space_{uuid.uuid4().hex[:8]}",
        "tool": "query.rpc",
        "args": {"name": "add_space_to_profile", "params": {"p_display_name": extracted.match_text}},
        "reason": f"Add '{extracted.match_text}' to home profile spaces.",
    }]


async def _complete_tool_calls(
    extracted: ExtractedIntent, facts: str = "", *, household_id: str = "", user_id: str = "",
) -> list[dict[str, Any]] | None:
    if not extracted.match_text:
        return None
    return [{
        "id": f"tc_complete_{uuid.uuid4().hex[:8]}",
        "tool": "query.rpc",
        "args": {"name": "complete_chore_by_query", "params": {"p_query": extracted.match_text}},
        "reason": f"Mark '{extracted.match_text}' as done.",
    }]


async def _reassign_tool_calls(
    extracted: ExtractedIntent, facts: str = "", *, household_id: str = "", user_id: str = "",
) -> list[dict[str, Any]] | None:
    if not extracted.match_text or not extracted.update_value:
        return None
    if extracted.bulk:
        return [{
            "id": f"tc_bulk_reassign_{uuid.uuid4().hex[:8]}",
            "tool": "query.rpc",
            "args": {
                "name": "bulk_reassign_chores_by_query",
                "params": {"p_chore_query": extracted.match_text, "p_new_helper_query": extracted.update_value},
            },
            "reason": f"Bulk reassign '{extracted.match_text}' chores to '{extracted.update_value}'.",
        }]
    return [{
        "id": f"tc_reassign_{uuid.uuid4().hex[:8]}",
        "tool": "query.rpc",
        "args": {
            "name": "reassign_chore_by_query",
            "params": {"p_chore_query": extracted.match_text, "p_new_helper_query": extracted.update_value},
        },
        "reason": f"Reassign '{extracted.match_text}' to '{extracted.update_value}'.",
    }]


# ── The Registry ─────────────────────────────────────────────────────

INTENT_REGISTRY: list[IntentDef] = [
    # ── Add space to home profile (highest priority compound) ────
    IntentDef(
        name="add_space",
        detect=[
            _p(100, r"\badd\s+.+\s+to\s+(?:my\s+)?(?:home\s*profile|rooms?|spaces?|house)\b"),
        ],
        extract=_extract_add_space,
        to_tool_calls=_add_space_tool_calls,
        llm_hint=(
            "\nThe user wants to ADD a new room/space to their home profile. "
            "Use query.rpc with name='add_space_to_profile' and p_display_name.\n"
        ),
        requires_plan=True,
    ),

    # ── Start pattern elicitation (assignment preferences) ────────
    # Priority 95/90 beats the generic `create` intent's `set\s*up` match (85)
    # so utterances like "set up kitchen preference" route here.
    IntentDef(
        name="start_elicitation",
        detect=[
            _p(95, r"\b(set\s*up|configure)\s+[\w\s]{0,25}\b(preference|assignment\s+pattern|patterns)\b"),
            _p(90, r"\bwho\s+(should|does|handles?)\s+[\w\s]{0,20}\b(cook|kitchen|clean|laundry|iron|garden|outdoor|bathroom)\b"),
            _p(88, r"\belicit(ation)?\b"),
        ],
        extract=_extract_elicitation,
        to_tool_calls=_start_elicitation_tool_calls,
        llm_hint=(
            "\nThe user wants to set assignment preferences. Emit a single "
            "tool call `ui.open_elicitation` with args.scope set to the "
            "matching template_id (specialty_kitchen / specialty_cleaning / "
            "specialty_outdoor / specialty_laundry) or null. The client will "
            "open a dialog; do NOT use db.insert or query.rpc for this intent.\n"
        ),
        requires_plan=False,
    ),

    # ── Complete / mark done ─────────────────────────────────────
    IntentDef(
        name="complete",
        detect=[
            _p(90, r"\bcheck\s+off\b"),
            _p(50, r"\b(done|complete|mark\s*(as\s*)?done|finished|complete\s+chore|check\s+off)\b"),
        ],
        extract=_extract_complete,
        to_tool_calls=_complete_tool_calls,
        llm_hint=(
            "\nThe user wants to mark a chore as DONE. "
            "Use query.rpc with name='complete_chore_by_query' and the chore title as p_query.\n"
        ),
        requires_plan=False,
    ),

    # ── Bulk assign ──────────────────────────────────────────────
    IntentDef(
        name="bulk_assign",
        detect=[
            _p(60, r"\b(assign\s+(all|my|unassigned)|bulk\s+assign|distribute\s+chores|assign\s+chores\s+to\s+(helpers|everyone|members|us))\b"),
        ],
        extract=None,  # handled by LLM extraction
        to_tool_calls=_reassign_tool_calls,
        llm_hint=(
            "\nThe user wants to BULK ASSIGN multiple chores. "
            "Use query.rpc with name='bulk_reassign_chores_by_query' or 'apply_chore_assignments'.\n"
        ),
        requires_plan=True,
    ),

    # ── Assign / reassign ────────────────────────────────────────
    IntentDef(
        name="assign",
        detect=[
            _p(80, r"\b(assign\s+(it\s+)?to\s+me|i'?ll\s+(do|take|handle)\b)"),
            _p(55, r"\b(assign|reassign|give\s+to|move\s+to|hand\s+over|transfer\s+to)\b"),
        ],
        extract=_extract_reassign,
        to_tool_calls=_reassign_tool_calls,
        llm_hint=(
            "\nThe user wants to ASSIGN or REASSIGN a chore. "
            "Use query.rpc with name='reassign_chore_by_query' or 'bulk_reassign_chores_by_query'.\n"
        ),
        requires_plan=True,
    ),

    # ── Schedule ─────────────────────────────────────────────────
    IntentDef(
        name="schedule",
        detect=[
            _p(50, r"\b(schedule|reschedule|when\s+should|set\s+frequency|change\s+frequency|set\s+day|which\s+day)\b"),
        ],
        extract=None,  # handled by LLM extraction
        to_tool_calls=None,  # handled by LLM
        llm_hint=(
            "\nThe user wants to SCHEDULE or RESCHEDULE chores. "
            "Use db.update to set due_at and/or metadata.cadence.\n"
        ),
        requires_plan=True,
    ),

    # ── Update / edit / rename ───────────────────────────────────
    IntentDef(
        name="update",
        detect=[
            _p(85, r"\b(remove|clear)\s+(the\s+)?(description|title|name|text)\b"),
            _p(45, r"\b(change|update|edit|modify|rename|replace|adjust)\b"),
        ],
        extract=None,  # handled by _extract_intent_regex in main.py (field-level regex)
        to_tool_calls=None,  # handled by main.py's match_ids → db.update pipeline
        llm_hint=(
            "\nThe user wants to UPDATE an existing record. "
            "Step 1: Use db.select to find the matching record. "
            "Step 2: Use db.update with the record's id and patch.\n"
        ),
        requires_plan=True,
    ),

    # ── Delete ───────────────────────────────────────────────────
    IntentDef(
        name="delete",
        detect=[
            _p(75, r"\b(cancel|remove)\s+(this\s+|the\s+|my\s+)?(chore|task|item)\b"),
            _p(70, r"\b(remove|cancel)\b(?!.*\b(description|title|name|text)\b)"),
            _p(40, r"\b(delete|erase|drop)\b"),
        ],
        extract=None,
        to_tool_calls=None,
        llm_hint=(
            "\nThe user wants to DELETE records. "
            "Step 1: Use db.select to find matching records. "
            "Step 2: Use db.delete with each record's id.\n"
        ),
        requires_plan=True,
    ),

    # ── Create ───────────────────────────────────────────────────
    IntentDef(
        name="create",
        detect=[
            _p(85, r"\bset\s*up\b"),
            _p(35, r"\b(create|add|new|plan|insert)\b"),
        ],
        extract=None,
        to_tool_calls=None,
        llm_hint=(
            "\nThe user wants to CREATE new records. "
            "Use db.insert to create them.\n"
        ),
        requires_plan=False,
    ),

    # ── Query / read ─────────────────────────────────────────────
    IntentDef(
        name="query",
        detect=[
            _p(80, r"\bcheck\s+(status|how|what|which|if)\b"),
            _p(65, r"\bcheck\b"),
            _p(30, r"\b(how many|count|list|show|what|which|status|report|summary|view|display|tell\s+me)\b"),
        ],
        extract=None,
        to_tool_calls=None,
        llm_hint=(
            "\nThe user wants to READ/QUERY data. "
            "Use db.select or query.rpc. Do NOT use db.insert, db.update, or db.delete.\n"
        ),
        requires_plan=False,
    ),
]

# ── Build the sorted detection list and lookup maps ──────────────────

# Flatten all (priority, regex, intent_name) and sort by priority desc
_DETECTION_LIST: list[tuple[int, re.Pattern[str], str]] = []
for intent_def in INTENT_REGISTRY:
    for priority, pattern in intent_def.detect:
        _DETECTION_LIST.append((priority, pattern, intent_def.name))
_DETECTION_LIST.sort(key=lambda x: -x[0])

# Lookup by name
_INTENT_MAP: dict[str, IntentDef] = {d.name: d for d in INTENT_REGISTRY}


def classify_intent(text: str) -> str:
    """Classify user message into an intent using the registry. First match wins (sorted by priority)."""
    t = (text or "").strip().lower()
    if not t:
        return "unknown"
    for _priority, pattern, name in _DETECTION_LIST:
        if pattern.search(t):
            return name
    return "unknown"


def get_intent_def(name: str) -> IntentDef | None:
    """Lookup an intent definition by name."""
    return _INTENT_MAP.get(name)


def get_llm_hint(name: str) -> str:
    """Get the LLM system prompt hint for an intent."""
    d = _INTENT_MAP.get(name)
    return d.llm_hint if d else ""


def extract_intent(name: str, user_text: str) -> ExtractedIntent | None:
    """Run the registered deterministic extractor for an intent."""
    d = _INTENT_MAP.get(name)
    if d and d.extract:
        return d.extract(user_text)
    return None


async def intent_to_tool_calls(
    name: str,
    extracted: ExtractedIntent,
    facts: str = "",
    *,
    household_id: str = "",
    user_id: str = "",
) -> list[dict[str, Any]] | None:
    """Run the registered tool call builder for an intent."""
    d = _INTENT_MAP.get(name)
    if d and d.to_tool_calls:
        return await d.to_tool_calls(extracted, facts, household_id=household_id, user_id=user_id)
    return None


def requires_plan(name: str) -> bool:
    """Check if this intent requires plan-confirm before execution."""
    d = _INTENT_MAP.get(name)
    return d.requires_plan if d else True


def list_intents() -> list[dict[str, Any]]:
    """Return a summary of all registered intents (for debugging)."""
    return [
        {
            "name": d.name,
            "detect_count": len(d.detect),
            "has_extract": d.extract is not None,
            "has_tool_calls": d.to_tool_calls is not None,
            "requires_plan": d.requires_plan,
            "priorities": sorted([p for p, _ in d.detect], reverse=True),
        }
        for d in INTENT_REGISTRY
    ]
