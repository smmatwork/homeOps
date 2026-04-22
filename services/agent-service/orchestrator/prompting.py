"""Clarification / apply-assignments / schedule+space prompting phase.

Runs between helper-agent routing and the main LLM orchestrator turn. Three
deterministic shortcuts that either return a final response (structured
clarification payload, or db.insert tool_calls to the UI) or return None to
let the caller continue to the LLM.

Public entry points:

  handle_apply_assignments(messages, lf_span) -> str | None
      When the user confirms a previously-suggested assignment list with
      "yes" / "create these assignments", parse the stashed suggestions and
      emit a single `apply_chore_assignments` RPC tool_call.

  handle_schedule_and_space(messages, latest_user_text) -> str | None
      Handles:
        - Edge-injected CLARIFICATION NEEDED block → structured
          space_selection payload
        - `wants_schedule` without an explicit datetime → schedule
          clarification payload
        - user-provided selected_spaces + due_at → deterministic db.insert
          tool_calls to create the chore(s)

All helpers from the pre-refactor main.py that this phase needs (_extract_*,
_wants_*, _has_*, _infer_*, _normalize_*) moved here too; test_helper_agent.py
still imports _extract_assignment_suggestions through a main.py shim.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Callable

from orchestrator.parsing import _try_parse_json_obj


LfSpanFn = Callable[..., None]


# ── Parsing + inference helpers ──────────────────────────────────────────────


def _extract_assignment_suggestions(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Extract a list of assignment suggestions from prior assistant messages.

    Expected line shapes (examples):
    - 1. Clean kitchen (2026-04-01T07:05:00+00:00) → Cook
    - Clean kitchen (2026-04-01T07:05:00+00:00) -> Cook
    """
    last_text = ""
    for m in reversed(messages or []):
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role not in ("assistant", "user"):
            continue
        if not isinstance(m.get("content"), str):
            continue
        txt = str(m.get("content") or "")
        if "→" in txt or "->" in txt:
            last_text = txt
            break

    if not last_text:
        return []

    out: list[dict[str, str]] = []
    for raw_ln in last_text.splitlines():
        ln = raw_ln.strip()
        if not ln:
            continue
        ln = re.sub(r"^\s*[-*]\s+", "", ln)
        ln = re.sub(r"^\s*\d+\s*[.)]\s+", "", ln)

        # Prefer unicode arrow; fall back to ASCII.
        if "→" in ln:
            parts = ln.split("→", 1)
        elif "->" in ln:
            parts = ln.split("->", 1)
        else:
            continue
        left = parts[0].strip()
        helper_name = parts[1].strip()
        # Drop any trailing helper metadata like "(helper_id: ...)".
        helper_name = re.sub(r"\s*\(\s*helper_id\s*:\s*[^)]*\)\s*$", "", helper_name, flags=re.IGNORECASE).strip()
        if not left or not helper_name:
            continue

        # Extract ISO-ish due_at from the first parenthesized timestamp.
        m = re.search(r"\((\d{4}-\d{2}-\d{2}T[^)]+)\)", left)
        if not m:
            continue
        due_at = (m.group(1) or "").strip()
        title = left[: m.start()].strip()
        if not title or not due_at:
            continue

        out.append({"title": title, "due_at": due_at, "helper_name": helper_name})

    return out


def _normalize_space_token(s: str) -> str:
    return re.sub(r"[^a-z0-9\s]", " ", (s or "").lower()).strip()


def _infer_spaces_from_user_text(options: list[str], user_text: str) -> list[str]:
    text = _normalize_space_token(user_text)
    if not text:
        return []
    opts = [(o, _normalize_space_token(o)) for o in (options or []) if isinstance(o, str) and o.strip()]
    if not opts:
        return []

    # Exact/substring matches.
    direct: list[str] = []
    for raw, norm in opts:
        if not norm:
            continue
        if norm in text or text in norm:
            direct.append(raw)
    if len(direct) == 1:
        return direct

    # Heuristic aliases for common bathrooms.
    aliases = [
        ("master", ["master", "primary", "main"]),
        ("common", ["common", "hall", "shared"]),
        ("guest", ["guest"]),
        ("attached", ["attached", "ensuite", "en suite"]),
    ]
    for label, keys in aliases:
        if any(k in text for k in keys):
            matches = [raw for raw, norm in opts if label in norm]
            if len(matches) == 1:
                return matches

    return []


def _extract_clarification_block(messages: list[dict[str, str]]) -> dict[str, Any] | None:
    """Parse an edge-injected "CLARIFICATION NEEDED (critical):" system block.

    The edge function adds this when it detects ambiguous bathrooms/balconies.
    We extract the options so the frontend can render a multi-select list.
    """
    for m in messages:
        if not isinstance(m, dict) or m.get("role") != "system":
            continue
        content = m.get("content")
        if not isinstance(content, str) or "CLARIFICATION NEEDED (critical):" not in content:
            continue

        # Options are written as markdown-ish lines: "- Master Bathroom" etc.
        lines = [ln.strip() for ln in content.splitlines()]
        title = "Choose a space"
        opts: list[str] = []
        in_block = False
        for ln in lines:
            if ln.startswith("CLARIFICATION NEEDED"):
                in_block = True
                continue
            if not in_block:
                continue
            if ln.startswith("Options:"):
                continue
            if ln.startswith("- "):
                val = ln[2:].strip()
                if val:
                    opts.append(val)
                continue
            # The first non-empty line after the header is usually the question.
            if title == "Choose a space" and ln:
                title = ln

        opts = [o for o in opts if isinstance(o, str) and o.strip()]
        if not opts:
            return None
        return {
            "kind": "space_selection",
            "title": title,
            "multi": True,
            "options": opts,
        }
    return None


def _infer_base_chore_title(messages: list[dict[str, str]]) -> str:
    # Cheap heuristic: grab last meaningful user instruction.
    for m in reversed(messages):
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        c = m.get("content")
        if not isinstance(c, str):
            continue
        t = c.strip()
        if not t:
            continue
        lower = t.lower()
        if "deep clean" in lower:
            return "Deep clean"
        if "clean" in lower:
            return "Clean"
        if "schedule" in lower or "book" in lower or "plan" in lower:
            return "Scheduled chore"
        return "Chore"
    return "Chore"


def _wants_schedule(messages: list[dict[str, str]]) -> bool:
    # Look across recent user messages.
    count = 0
    for m in reversed(messages):
        if count >= 6:
            break
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        count += 1
        c = m.get("content")
        if not isinstance(c, str):
            continue
        if re.search(r"\b(schedule|book|plan|set\s*(up)?|set\s+a\s+time)\b", c.lower()):
            return True
    return False


def _has_explicit_datetime(messages: list[dict[str, str]]) -> bool:
    count = 0
    for m in reversed(messages):
        if count >= 6:
            break
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        count += 1
        c = m.get("content")
        if not isinstance(c, str):
            continue
        t = c.lower()
        if re.search(r"\b\d{1,2}:\d{2}\b", t):
            return True
        if re.search(r"\b\d{4}-\d{2}-\d{2}\b", t):
            return True
        if re.search(r"\b(today|tomorrow)\b", t):
            return True
    return False


# ── Phase handlers ────────────────────────────────────────────────────────────


_APPROVAL_PHRASES = (
    "yes", "y", "yeah", "yep", "ok", "okay", "sure",
    "go ahead", "proceed", "do it",
)

_APPLY_TRIGGER_PHRASES = (
    "create these assignments",
    "crate these assignments",
    "create these assignment",
    "crate these assignment",
    "create the assignments",
    "crate the assignments",
    "create assignments",
    "apply these assignments",
)


def handle_apply_assignments(
    messages: list[dict[str, Any]],
    latest_user_text: str,
    *,
    lf_span: LfSpanFn,
) -> str | None:
    """Deterministic shortcut: the user confirmed a previously-suggested set of
    chore assignments. Parse the suggestions and emit a single
    apply_chore_assignments RPC tool_call.

    Returns the response text (fenced JSON payload, or a clarification asking
    for the list) on match, or None if the user's message isn't an approval.
    """
    norm_user = re.sub(r"\s+", " ", (latest_user_text or "").strip().lower())
    norm_user = re.sub(r"[^a-z\s]", "", norm_user).strip()
    if norm_user not in _APPLY_TRIGGER_PHRASES and norm_user not in _APPROVAL_PHRASES:
        return None

    assignments = _extract_assignment_suggestions(messages)
    if not assignments:
        if norm_user in _APPROVAL_PHRASES:
            return (
                "I can proceed, but I don't see an assignment list. Please paste the "
                "assignment list (Title (due_at) → Helper) and then say 'Create these assignments'."
            )
        return (
            "Please paste the assignment list (Title (due_at) → Helper) and then say "
            "'Create these assignments'."
        )

    tool_calls = [
        {
            "id": f"tc_{uuid.uuid4().hex}",
            "tool": "query.rpc",
            "args": {"name": "apply_chore_assignments", "params": {"p_assignments": assignments}},
            "reason": (
                "Apply the suggested helper assignments to existing chores by matching "
                "title + due_at and resolving helper names."
            ),
        }
    ]
    payload = {"tool_calls": tool_calls}
    lf_span(
        "orchestrator.deterministic.apply_assignments",
        input={"assignment_count": len(assignments)},
        output={"tool": "query.rpc", "name": "apply_chore_assignments"},
    )
    return "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"


def handle_schedule_and_space(
    messages: list[dict[str, Any]],
    latest_user_text: str,
) -> str | None:
    """Handle space-selection and schedule clarification prompts.

    Four possible outcomes (in order of precedence):

      - wants_schedule with no datetime and no clarification_response due_at
        → return a `schedule` clarification payload
      - clarification_block present and no selected_spaces resolved
        → return the `space_selection` payload for the UI
      - selected_spaces resolved but wants_schedule without due_at
        → return the `schedule` payload
      - selected_spaces resolved + due_at present
        → return db.insert tool_calls for each selected space

    Returns None if none of the above apply (caller continues routing).
    """
    clarification_block = _extract_clarification_block(messages)

    clarification_response: dict[str, Any] | None = None
    if latest_user_text and latest_user_text.strip().startswith("{"):
        parsed_user_obj = _try_parse_json_obj(latest_user_text)
        if parsed_user_obj and isinstance(parsed_user_obj.get("clarification_response"), dict):
            clarification_response = parsed_user_obj.get("clarification_response")  # type: ignore

    wants_schedule = _wants_schedule(messages)
    has_datetime = _has_explicit_datetime(messages)

    # If schedule was requested but no explicit datetime was given, ask for it.
    if wants_schedule and not has_datetime:
        due_at = None
        if clarification_response and isinstance(clarification_response.get("due_at"), str):
            due_at = str(clarification_response.get("due_at") or "").strip()
        if not due_at:
            payload = {
                "clarification": {
                    "kind": "schedule",
                    "title": "When should I schedule this?",
                    "required": True,
                }
            }
            return "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"

    # Resolve selected_spaces from user's clarification_response or inference.
    selected_spaces: list[str] = []
    if clarification_response:
        raw_spaces = clarification_response.get("spaces")
        if isinstance(raw_spaces, list):
            selected_spaces = [
                str(s).strip() for s in raw_spaces
                if isinstance(s, (str, int, float)) and str(s).strip()
            ]
        elif isinstance(raw_spaces, str):
            selected_spaces = [s.strip() for s in raw_spaces.split(",") if s.strip()]

    if clarification_block and not selected_spaces:
        # If the user already mentioned a specific space (e.g., "master bathroom"),
        # auto-select it.
        try:
            options = clarification_block.get("options")
            opts = options if isinstance(options, list) else []
            inferred = _infer_spaces_from_user_text([str(o) for o in opts], latest_user_text)
            if inferred:
                selected_spaces = inferred
        except Exception:
            pass

    if clarification_block and not selected_spaces:
        payload = {
            "clarification": {
                **clarification_block,
                "required": True,
            }
        }
        return "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"

    # If we have selected spaces, emit deterministic chore tool calls.
    if selected_spaces:
        due_at = None
        if clarification_response and isinstance(clarification_response.get("due_at"), str):
            due_at = str(clarification_response.get("due_at") or "").strip()
        if wants_schedule and not due_at:
            payload = {
                "clarification": {
                    "kind": "schedule",
                    "title": "When should I schedule this?",
                    "required": True,
                }
            }
            return "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"

        base_title = _infer_base_chore_title(messages)
        tool_calls: list[dict[str, Any]] = []
        for sp in selected_spaces:
            tool_calls.append(
                {
                    "id": f"tc_{uuid.uuid4().hex}",
                    "tool": "db.insert",
                    "args": {
                        "table": "chores",
                        "record": {
                            "title": f"{base_title} {sp}" if sp else base_title,
                            "status": "pending",
                            "due_at": due_at,
                            "metadata": {"space": sp},
                        },
                    },
                    "reason": "Create a chore for the selected space.",
                }
            )
        payload = {"tool_calls": tool_calls}
        return "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"

    return None


__all__ = [
    "handle_apply_assignments",
    "handle_schedule_and_space",
    "_extract_assignment_suggestions",
    "_extract_clarification_block",
    "_infer_spaces_from_user_text",
    "_infer_base_chore_title",
    "_normalize_space_token",
    "_wants_schedule",
    "_has_explicit_datetime",
]
