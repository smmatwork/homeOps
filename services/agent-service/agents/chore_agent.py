"""Chore Agent — handles chore assignment, scheduling, completion, reassignment,
update, deletion, and the related pattern-elicitation + coverage flows.

Scaffolding stage. `is_intent()` returns True (chore is the default route
today; there's no dedicated "chore detector" because any message that isn't
a helper-management request falls here) and `run()` returns an AgentResult
with kind="defer" — the orchestrator treats that as "this agent does not
take ownership of the turn; fall through to the legacy handler."

The actual chore logic still lives inside main.py's chat_respond handler
(phases 6-16: deterministic analytics shortcuts, assign/complete/reassign
regex parsers, clarification + schedule + space prompting flows, structured
extraction -> plan-confirm-execute, main LLM turn, tool execution loop,
hallucination-override guards, LLM-as-Judge). That code will migrate into
this class in follow-up commits:

  6a. Analytics shortcuts   (7 deterministic RPC paths)
  6b. Deterministic actions (assign/complete/reassign regex -> tool_calls)
  6c. Formatters            (plan preview, confirmation preview, no-match)
  6d. Structured extraction (pending-clarification substitution + preview)
  6e. Chore helpers         (intent_to_tool_calls, resolve_match_ids,
                             validate_tool_calls, enforce_assignment_policy,
                             judge, graduation_status)
  6f. Hallucination guards  (needs_fetch_override detectors, schedule
                             guardrails)

Each sub-commit is bounded and reviewable. This file exists today so those
migrations have a target and the `ChoreAgent` class can be instantiated
alongside `HelperAgent` in the orchestrator router (Commit 5).
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from agents.base import AgentContext, AgentResult, ChatFn, EdgeExecuteFn


ExtractJsonCandidateFn = Callable[[str], "str | None"]
SafeJsonLoadsFn = Callable[[str], Any]
ValidateToolCallsFn = Callable[[Any], "list[dict[str, Any]] | None"]


@dataclass
class ChoreAgent:
    """Domain agent for chore management. Instantiate once at orchestrator
    startup. Dependency shape matches HelperAgent's (chat_fn + the three
    JSON/tool-call utilities) plus edge_execute_tools — every chore-domain
    migration in phases 6a-6f needs at least one of these:

      - chat_fn: main LLM turn, summarizer, judge
      - edge_execute_tools: every tool_call execution (RPC, db.update, etc.)
      - extract_json_candidate / safe_json_loads: parse LLM envelope output
      - validate_tool_calls_list: shape-check before dispatch to edge

    They're accepted here even though run() is currently a placeholder so
    that adding them later isn't a breaking API change for callers (main.py
    orchestrator and future orchestrator/router.py)."""

    chat_fn: ChatFn
    edge_execute_tools: EdgeExecuteFn
    extract_json_candidate: ExtractJsonCandidateFn
    safe_json_loads: SafeJsonLoadsFn
    validate_tool_calls_list: ValidateToolCallsFn

    def is_intent(self, ctx: AgentContext) -> bool:
        """Chore is the default route — every turn that isn't an explicit
        helper-management request falls here. There's no dedicated chore
        intent detector because chore coverage is the broadest.

        A future `start_elicitation` domain agent or `service_and_maintenance`
        domain agent would reduce this class's scope — at that point,
        `is_intent` would become an actual check. For now: True.
        """
        return True

    async def run(self, ctx: AgentContext) -> AgentResult:
        """Placeholder: returns AgentResult(kind="defer") so the orchestrator
        falls through to the legacy chat_respond body in main.py.

        Follow-up commits 6a-6f progressively migrate phases 6-16 of
        chat_respond into this method. During that migration the method
        will start returning real results (text / tool_calls_preview /
        tool_calls_execute / clarification) for the phases it has absorbed,
        and "defer" only for phases that haven't moved yet.
        """
        return AgentResult(kind="defer")

    async def try_analytics_shortcut(self, ctx: AgentContext) -> AgentResult:
        """Phase 6 deterministic analytics shortcuts — when the user's
        message matches one of 7 fixed patterns, short-circuit with a
        single query.rpc call + formatted response instead of going
        through the full LLM loop.

        This method currently implements ONE shortcut (unassigned count);
        the other six legacy handlers in main.py's chat_respond will migrate
        here incrementally. Callers should treat kind=="defer" as "no
        shortcut matched — continue with the normal flow," and kind=="text"
        as "I handled it, use this text."
        """
        messages = ctx.messages

        # ── Shortcut: "How many unassigned chores are there?" ──────────────
        if _wants_unassigned_count(messages):
            if not ctx.household_id:
                return AgentResult(
                    kind="text",
                    text="I need your household context to look up chores. Please reconnect your home and try again.",
                )
            if not ctx.user_id:
                return AgentResult(
                    kind="text",
                    text="I need your user context to look up chores. Please reconnect your home and try again.",
                )

            tc = {
                "id": f"tc_{uuid.uuid4().hex}",
                "tool": "query.rpc",
                "args": {"name": "count_chores", "params": {"p_filters": {"unassigned": True}}},
                "reason": "Count unassigned chores in the household.",
            }
            out = await ctx.edge_execute_tools(
                {"household_id": ctx.household_id, "tool_call": tc},
                user_id=ctx.user_id,
            )
            if isinstance(out, dict) and out.get("ok") is False:
                err = out.get("error")
                msg = err.get("message") if isinstance(err, dict) else None
                msg2 = str(msg).strip() if isinstance(msg, str) else ""
                suffix = f": {msg2}" if msg2 else "."
                return AgentResult(kind="text", text=f"Tool error while counting unassigned tasks{suffix}")

            payload = out.get("result") if isinstance(out, dict) else None
            chore_count: Any = None
            if isinstance(payload, dict):
                chore_count = payload.get("chore_count")
                if chore_count is None and isinstance(payload.get("result"), dict):
                    chore_count = (payload.get("result") or {}).get("chore_count")
                if chore_count is None and isinstance(payload.get("result"), list) and payload.get("result"):
                    first = payload.get("result")[0]
                    if isinstance(first, dict):
                        chore_count = first.get("chore_count")
            elif isinstance(payload, list) and payload:
                first = payload[0]
                if isinstance(first, dict):
                    chore_count = first.get("chore_count")

            # Wording preserved byte-for-byte from the pre-migration handler
            # in chat_respond so integration behaviour stays identical.
            if isinstance(chore_count, int):
                return AgentResult(kind="text", text=f"Total unassigned tasks: {chore_count}.")
            return AgentResult(
                kind="text",
                text="There was an error retrieving the number of unassigned tasks. Please try again later.",
            )

        # ── Shortcut: "Total pending tasks?" ───────────────────────────────
        if _wants_total_pending_count(messages):
            if not ctx.household_id:
                return AgentResult(
                    kind="text",
                    text="I need your household context to look up chores. Please reconnect your home and try again.",
                )
            if not ctx.user_id:
                return AgentResult(
                    kind="text",
                    text="I need your user context to look up chores. Please reconnect your home and try again.",
                )

            tc = {
                "id": f"tc_{uuid.uuid4().hex}",
                "tool": "query.rpc",
                "args": {
                    "name": "count_chores",
                    "params": {"p_filters": {"status": "pending"}},
                },
                "reason": "Count pending chores in the household.",
            }
            out = await ctx.edge_execute_tools(
                {"household_id": ctx.household_id, "tool_call": tc},
                user_id=ctx.user_id,
            )
            if isinstance(out, dict) and out.get("ok") is False:
                err = out.get("error")
                msg = err.get("message") if isinstance(err, dict) else None
                msg2 = str(msg).strip() if isinstance(msg, str) else ""
                suffix = f": {msg2}" if msg2 else "."
                return AgentResult(kind="text", text=f"Tool error while counting pending tasks{suffix}")

            payload = out.get("result") if isinstance(out, dict) else None
            chore_count = None
            if isinstance(payload, dict):
                chore_count = payload.get("chore_count")
                if chore_count is None and isinstance(payload.get("result"), dict):
                    chore_count = (payload.get("result") or {}).get("chore_count")
                if chore_count is None and isinstance(payload.get("result"), list) and payload.get("result"):
                    first = payload.get("result")[0]
                    if isinstance(first, dict):
                        chore_count = first.get("chore_count")
            elif isinstance(payload, list) and payload:
                first = payload[0]
                if isinstance(first, dict):
                    chore_count = first.get("chore_count")
            if isinstance(chore_count, int):
                return AgentResult(kind="text", text=f"Total pending tasks: {chore_count}.")
            return AgentResult(
                kind="text",
                text="There was an error retrieving the total number of pending tasks. Please try again later.",
            )

        # No shortcut matched — defer to the next handler.
        return AgentResult(kind="defer")


# ── Chore-domain intent detectors ────────────────────────────────────────────
# These functions inspect the most recent user message and return True/str
# when the message matches one of the 7 deterministic analytics shortcut
# patterns (unassigned count, total pending count, status breakdown,
# assignee breakdown, space list, chores assigned to <name>, count
# assigned to <name>). They're the first check chat_respond runs in phase
# 6 after helper-agent routing; when one fires, the handler executes a
# single query.rpc tool call and formats a short sentence — no main LLM
# turn.
#
# Private to the chore-domain module. Re-imported from main.py under the
# same names so the existing chat_respond call sites keep working while
# phase 6 handlers migrate into ChoreAgent.run() across follow-up commits.


def _wants_unassigned_count(messages: list[dict[str, Any]]) -> bool:
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    if not last_user:
        return False
    lower = last_user.lower()
    if "unassigned" not in lower:
        return False
    if not ("task" in lower or "tasks" in lower or "chore" in lower or "chores" in lower):
        return False
    if not ("how many" in lower or "count" in lower or "number" in lower or "total" in lower):
        return False
    return True


def _extract_count_assigned_to_name(messages: list[dict[str, Any]]) -> str:
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    if not last_user:
        return ""

    s = last_user.strip()
    lower = s.lower()
    if "chore" not in lower and "chores" not in lower:
        return ""
    if "assigned to" not in lower:
        return ""
    if not ("how many" in lower or "count" in lower or "number of" in lower or "total" in lower):
        return ""

    # Extract the substring after "assigned to" (strip punctuation).
    try:
        after = re.split(r"assigned\s+to\s+", s, flags=re.IGNORECASE, maxsplit=1)[1]
    except Exception:
        return ""
    after = after.strip().strip(".?!)\"]} ")
    if after.lower().startswith("the "):
        after = after[4:].strip()
    # Keep only the first clause if the user continues with more text.
    after = re.split(r"[\n,;]|\s+and\s+|\s+with\s+|\s+in\s+|\s+for\s+", after, maxsplit=1)[0].strip()
    # Avoid returning something obviously not a name.
    if not after or len(after) > 80:
        return ""
    return after


def _wants_total_pending_count(messages: list[dict[str, Any]]) -> bool:
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    if not last_user:
        return False
    lower = last_user.lower()
    if not ("pending" in lower and ("task" in lower or "tasks" in lower or "chore" in lower or "chores" in lower)):
        return False
    if not ("total" in lower or "how many" in lower or "count" in lower or "number" in lower):
        return False
    return True


def _wants_status_breakdown(messages: list[dict[str, Any]]) -> bool:
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    if not last_user:
        return False
    lower = last_user.lower()
    wants = False
    if "by status" in lower or "status breakdown" in lower:
        wants = True
    if ("group" in lower and "status" in lower) or ("breakdown" in lower and "status" in lower):
        wants = True
    if ("other status" in lower or "other statuses" in lower or "all status" in lower or "all statuses" in lower) and "status" in lower:
        wants = True
    if not wants:
        return False
    if not ("task" in lower or "tasks" in lower or "chore" in lower or "chores" in lower):
        return False
    return True


def _wants_assignee_breakdown(messages: list[dict[str, Any]]) -> bool:
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    if not last_user:
        return False
    lower = last_user.lower()
    if not ("by assignee" in lower or "by helper" in lower or "assignee breakdown" in lower):
        return False
    if not ("task" in lower or "tasks" in lower or "chore" in lower or "chores" in lower):
        return False
    return True


def _extract_space_list_query(messages: list[dict[str, Any]]) -> str:
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    if not last_user:
        return ""
    s = last_user.strip()
    lower = s.lower()
    if not ("task" in lower or "tasks" in lower or "chore" in lower or "chores" in lower):
        return ""
    m = re.search(r"\b(in|for)\s+([A-Za-z][A-Za-z0-9\s\-]{1,40})\b", s, flags=re.IGNORECASE)
    if not m:
        return ""
    cand = (m.group(2) or "").strip().strip(".?!)\"]} ")
    if not cand or len(cand) > 40:
        return ""
    return cand


def _extract_list_assigned_to_name(messages: list[dict[str, Any]]) -> str:
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    if not last_user:
        return ""

    s = last_user.strip()
    lower = s.lower()
    if "assigned to" not in lower:
        return ""
    if not ("task" in lower or "tasks" in lower or "chore" in lower or "chores" in lower):
        return ""
    # If the user is explicitly asking for a count, let the count shortcut handle it.
    if "how many" in lower or "count" in lower or "number of" in lower or "total" in lower:
        return ""

    try:
        after = re.split(r"assigned\s+to\s+", s, flags=re.IGNORECASE, maxsplit=1)[1]
    except Exception:
        return ""
    after = after.strip().strip(".?!)\"]} ")
    if after.lower().startswith("the "):
        after = after[4:].strip()
    after = re.split(r"[\n,;]|\s+and\s+|\s+with\s+|\s+in\s+|\s+for\s+", after, maxsplit=1)[0].strip()
    if not after or len(after) > 80:
        return ""
    return after


__all__ = [
    "ChoreAgent",
    "_wants_unassigned_count",
    "_extract_count_assigned_to_name",
    "_wants_total_pending_count",
    "_wants_status_breakdown",
    "_wants_assignee_breakdown",
    "_extract_space_list_query",
    "_extract_list_assigned_to_name",
]
