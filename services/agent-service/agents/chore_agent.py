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

import json
import os
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

        # ── Shortcut: "Chores by status" ───────────────────────────────────
        if _wants_status_breakdown(messages):
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
                "args": {"name": "group_chores_by_status", "params": {"p_filters": {}}},
                "reason": "Group chores by status.",
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
                return AgentResult(kind="text", text=f"Tool error while grouping chores by status{suffix}")

            payload = out.get("result") if isinstance(out, dict) else None
            # Edge wraps RPC payload under out.result; RPC returns a row with key 'result' containing the list.
            rows: list[Any] = []
            if isinstance(payload, dict):
                r0 = payload.get("result")
                if isinstance(r0, list):
                    rows = r0
            elif isinstance(payload, list) and payload and isinstance(payload[0], dict):
                r0 = payload[0].get("result")
                if isinstance(r0, list):
                    rows = r0
            if not rows:
                return AgentResult(kind="text", text="No chores found.")
            lines: list[str] = []
            for r in rows:
                if not isinstance(r, dict):
                    continue
                st = str(r.get("status") or "").strip()
                cnt = r.get("count")
                if st and isinstance(cnt, int):
                    lines.append(f"- {st}: {cnt}")
            if len(lines) <= 1:
                return AgentResult(kind="text", text="Chores by status (only one status bucket found):\n" + "\n".join(lines))
            return AgentResult(kind="text", text="Chores by status:\n" + "\n".join(lines))

        # ── Shortcut: "Chores by assignee" ─────────────────────────────────
        if _wants_assignee_breakdown(messages):
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
                "args": {"name": "group_chores_by_assignee", "params": {"p_filters": {}}},
                "reason": "Group chores by assignee.",
            }
            out = await ctx.edge_execute_tools(
                {"household_id": ctx.household_id, "tool_call": tc},
                user_id=ctx.user_id,
            )
            payload = out.get("result") if isinstance(out, dict) else None
            result = payload.get("result") if isinstance(payload, dict) else None
            rows = result if isinstance(result, list) else []
            if not rows:
                return AgentResult(kind="text", text="No chores found.")
            lines = []
            for r in rows:
                if not isinstance(r, dict):
                    continue
                name = str(r.get("helper_name") or r.get("helper") or "").strip()
                cnt = r.get("count")
                if name and isinstance(cnt, int):
                    lines.append(f"- {name}: {cnt}")
            return AgentResult(kind="text", text="Chores by assignee:\n" + "\n".join(lines))

        # ── Shortcut: "Chores in <space>" ──────────────────────────────────
        try:
            space_q = _extract_space_list_query(messages)
        except Exception:
            space_q = ""
        if space_q:
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
                "args": {"name": "list_chores_enriched", "params": {"p_filters": {"space_query": space_q}, "p_limit": 25}},
                "reason": "List chores for a space.",
            }
            out = await ctx.edge_execute_tools(
                {"household_id": ctx.household_id, "tool_call": tc},
                user_id=ctx.user_id,
            )
            payload = out.get("result") if isinstance(out, dict) else None
            match_type = payload.get("match_type") if isinstance(payload, dict) else None
            if match_type == "ambiguous_space":
                return AgentResult(kind="text", text="Which space did you mean?")
            result = payload.get("result") if isinstance(payload, dict) else None
            chores = result if isinstance(result, list) else []
            if not chores:
                return AgentResult(kind="text", text=f"No chores found for {space_q}.")
            lines = []
            for c0 in chores[:25]:
                if not isinstance(c0, dict):
                    continue
                title = str(c0.get("title") or "").strip()
                status = str(c0.get("status") or "").strip()
                if title and status:
                    lines.append(f"- {title} [{status}]")
                elif title:
                    lines.append(f"- {title}")
            return AgentResult(kind="text", text=f"Chores in {space_q}:\n" + "\n".join(lines))

        # ── Shortcut: "Chores assigned to <name>" (list, not count) ────────
        try:
            list_name = _extract_list_assigned_to_name(messages)
        except Exception:
            list_name = ""
        if list_name:
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
                    "name": "list_chores_enriched",
                    "params": {
                        "p_filters": {"helper_query": list_name},
                        "p_limit": 25,
                    },
                },
                "reason": "List chores assigned to the specified helper.",
            }
            out = await ctx.edge_execute_tools(
                {"household_id": ctx.household_id, "tool_call": tc},
                user_id=ctx.user_id,
            )

            payload = out.get("result") if isinstance(out, dict) else None
            match_type = payload.get("match_type") if isinstance(payload, dict) else None
            result = payload.get("result") if isinstance(payload, dict) else None
            helper_candidates = payload.get("helper_candidates") if isinstance(payload, dict) else None

            if match_type == "ambiguous_helper" and helper_candidates:
                return AgentResult(
                    kind="text",
                    text="Which helper did you mean? " + json.dumps(helper_candidates, ensure_ascii=False),
                )
            if match_type == "none_helper":
                return AgentResult(kind="text", text=f"I couldn't find a helper matching '{list_name}'.")

            chores = result if isinstance(result, list) else []
            if not chores:
                return AgentResult(kind="text", text=f"No chores are currently assigned to {list_name}.")

            lines = []
            for c0 in chores[:25]:
                if not isinstance(c0, dict):
                    continue
                title = str(c0.get("title") or "").strip()
                status = str(c0.get("status") or "").strip()
                due_at = str(c0.get("due_at") or "").strip()
                space = str(c0.get("space") or "").strip()
                parts: list[str] = []
                if title:
                    parts.append(title)
                if status:
                    parts.append(f"[{status}]")
                meta: list[str] = []
                if due_at:
                    meta.append(f"due {due_at}")
                if space:
                    meta.append(f"{space}")
                suffix = f" — {', '.join(meta)}" if meta else ""
                if parts:
                    lines.append("- " + " ".join(parts) + suffix)

            return AgentResult(
                kind="text",
                text="Here are the chores assigned to " + list_name + ":\n" + "\n".join(lines),
            )

        # ── Shortcut: "How many chores are assigned to <name>?" ────────────
        # Uses the curated read-only RPC count_chores_assigned_to which
        # accepts p_helper_name and returns match_type=unique/none/ambiguous
        # with a helper_name + chore_count (unique) or candidates[] (ambiguous).
        try:
            helper_name = _extract_count_assigned_to_name(messages)
        except Exception:
            helper_name = ""
        if helper_name:
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
                "args": {"name": "count_chores_assigned_to", "params": {"p_helper_name": helper_name}},
                "reason": "Count chores assigned to the specified helper.",
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
                return AgentResult(
                    kind="text",
                    text=f"Tool error while counting chores assigned to {helper_name}{suffix}",
                )

            if isinstance(out, dict) and out.get("ok"):
                res = out.get("result")
                if isinstance(res, list) and len(res) > 0:
                    res = res[0]
                if isinstance(res, dict):
                    match_type = res.get("match_type", "")
                    count = res.get("chore_count", 0)
                    h_name = res.get("helper_name", helper_name)

                    if match_type == "unique":
                        plural = "chore" if count == 1 else "chores"
                        verb = "is" if count == 1 else "are"
                        return AgentResult(
                            kind="text",
                            text=f"There {verb} {count} {plural} assigned to {h_name}.",
                        )
                    elif match_type == "none":
                        return AgentResult(
                            kind="text",
                            text=f"I couldn't find a helper named '{helper_name}' in your household.",
                        )
                    elif match_type == "ambiguous":
                        cands = res.get("candidates") or []
                        cands_str = ", ".join(str(c) for c in cands if c)
                        return AgentResult(
                            kind="text",
                            text=f"I found multiple helpers matching '{helper_name}': {cands_str}. Please be more specific.",
                        )

                # Fallback if structure is unexpected.
                return AgentResult(kind="text", text=f"Result: {json.dumps(res)}")

            return AgentResult(
                kind="text",
                text=f"Unexpected error while counting chores assigned to {helper_name}.",
            )

        # No shortcut matched — defer to the next handler.
        return AgentResult(kind="defer")

    async def try_deterministic_action(self, ctx: AgentContext) -> AgentResult:
        """Phase 6b — regex-parsed action shortcuts that emit a single
        query.rpc tool call for the UI to execute.

        Different shape from try_analytics_shortcut: these don't execute
        the edge themselves; they return the tool_call JSON payload
        wrapped in a markdown-fenced code block, which the UI parses
        and then dispatches back to the edge on a follow-up round-trip.

        Returns kind="text" on a detector match (the text holds the
        fenced JSON payload), kind="defer" otherwise. Three detectors,
        checked in order:
          1. Assign/create a chore      (assign_or_create_chore RPC)
          2. Complete chore by query    (complete_chore_by_query RPC)
          3. Reassign/unassign by query (reassign_chore_by_query RPC)
        """
        last_user_text = ctx.last_user_text

        assign_req = _extract_assign_or_create_chore(last_user_text)
        if assign_req is not None:
            tool_calls = [
                {
                    "id": f"tc_{uuid.uuid4().hex}",
                    "tool": "query.rpc",
                    "args": {
                        "name": "assign_or_create_chore",
                        "params": {
                            "p_helper_query": assign_req.get("helper_query") or "",
                            "p_task": assign_req.get("task") or "",
                            "p_when": assign_req.get("when") or None,
                        },
                    },
                    "reason": "Resolve helper, find a matching chore for the requested day/task (or create a new one), then assign it using the helper schedule default time.",
                }
            ]
            payload = {"tool_calls": tool_calls}
            return AgentResult(
                kind="text",
                text="```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```",
            )

        complete_req = _extract_complete_chore_by_query(last_user_text)
        if complete_req is not None:
            tool_calls = [
                {
                    "id": f"tc_{uuid.uuid4().hex}",
                    "tool": "query.rpc",
                    "args": {
                        "name": "complete_chore_by_query",
                        "params": {
                            "p_query": complete_req.get("query") or "",
                            "p_when": complete_req.get("when") or None,
                        },
                    },
                    "reason": "Find the best matching pending chore and mark it as done (or ask for clarification if ambiguous).",
                }
            ]
            payload = {"tool_calls": tool_calls}
            return AgentResult(
                kind="text",
                text="```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```",
            )

        reassign_req = _extract_reassign_or_unassign_chore(last_user_text)
        if reassign_req is not None:
            tool_calls = [
                {
                    "id": f"tc_{uuid.uuid4().hex}",
                    "tool": "query.rpc",
                    "args": {
                        "name": "reassign_chore_by_query",
                        "params": {
                            "p_chore_query": str(reassign_req.get("chore_query") or ""),
                            "p_helper_query": (
                                str(reassign_req.get("helper_query"))
                                if reassign_req.get("helper_query") is not None
                                else None
                            ),
                            "p_when": str(reassign_req.get("when") or "") or None,
                        },
                    },
                    "reason": "Find the best matching pending chore and reassign/unassign it (or ask for clarification if ambiguous).",
                }
            ]
            payload = {"tool_calls": tool_calls}
            return AgentResult(
                kind="text",
                text="```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```",
            )

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


# ── Phase 6b action parsers ──────────────────────────────────────────────────
# Regex-parsed one-shot shortcuts that emit a single query.rpc tool call for
# the UI to execute (assign_or_create_chore, complete_chore_by_query,
# reassign_chore_by_query). Separate from the analytics detectors above
# because these return structured dicts the downstream handler turns into
# tool_call params, not just bool/str.


def _extract_assign_or_create_chore(latest_user_text: str) -> dict[str, str] | None:
    t = (latest_user_text or "").strip()
    if not t:
        return None
    lower = t.lower()
    if "chore" not in lower or "assign" not in lower:
        return None

    # Common shape: "Assign a chore to the cook to make chick biryani tomorrow"
    m = re.search(
        r"\bassign\s+(?:a\s+)?chore\s+to\s+(?:the\s+)?(?P<helper>.+?)\s+to\s+(?P<task>.+?)\s*(?P<when>tomorrow|today)?\s*$",
        lower,
    )
    if not m:
        return None

    helper = (m.group("helper") or "").strip()
    task = (m.group("task") or "").strip()
    when = (m.group("when") or "").strip()

    # Trim trailing punctuation in helper/task.
    helper = re.sub(r"[.?!,;:]+$", "", helper).strip()
    task = re.sub(r"[.?!,;:]+$", "", task).strip()

    if not helper or not task:
        return None

    # If the message contains "tomorrow"/"today" anywhere, treat that as the schedule hint.
    if not when and re.search(r"\btomorrow\b", lower):
        when = "tomorrow"
    if not when and re.search(r"\btoday\b", lower):
        when = "today"

    return {"helper_query": helper, "task": task, "when": when}


def _extract_complete_chore_by_query(latest_user_text: str) -> dict[str, str] | None:
    t = (latest_user_text or "").strip()
    if not t:
        return None
    lower = t.lower().strip()
    # Examples:
    # - "Mark clean kitchen as done"
    # - "Complete the biryani chore"
    m = re.search(r"\b(mark|complete|finish|done)\b\s+(?:the\s+)?(?P<q>.+?)\s*(?:chore\s*)?(?:as\s+done)?\s*$", lower)
    if not m:
        return None
    q = (m.group("q") or "").strip()
    q = re.sub(r"[.?!,;:]+$", "", q).strip()
    if not q:
        return None
    when = ""
    if re.search(r"\btomorrow\b", lower):
        when = "tomorrow"
    elif re.search(r"\btoday\b", lower):
        when = "today"
    return {"query": q, "when": when}


def _extract_reassign_or_unassign_chore(latest_user_text: str) -> dict[str, str | None] | None:
    t = (latest_user_text or "").strip()
    if not t:
        return None
    lower = t.lower().strip()

    # Reassign shape: "Assign/Move <chore> to <helper>".
    m = re.search(
        r"\b(assign|reassign|move)\b\s+(?:the\s+)?(?P<chore>.+?)\s+to\s+(?:the\s+)?(?P<helper>.+?)\s*$",
        lower,
    )
    if m:
        cq = re.sub(r"[.?!,;:]+$", "", (m.group("chore") or "").strip()).strip()
        hq = re.sub(r"[.?!,;:]+$", "", (m.group("helper") or "").strip()).strip()
        if cq and hq:
            when = ""
            if re.search(r"\btomorrow\b", lower):
                when = "tomorrow"
            elif re.search(r"\btoday\b", lower):
                when = "today"
            return {"chore_query": cq, "helper_query": hq, "when": when}

    # Unassign shape: "Unassign <chore>".
    m2 = re.search(r"\bunassign\b\s+(?:the\s+)?(?P<chore>.+?)\s*$", lower)
    if m2:
        cq = re.sub(r"[.?!,;:]+$", "", (m2.group("chore") or "").strip()).strip()
        if cq:
            when = ""
            if re.search(r"\btomorrow\b", lower):
                when = "tomorrow"
            elif re.search(r"\btoday\b", lower):
                when = "today"
            return {"chore_query": cq, "helper_query": None, "when": when}

    return None


# ── Phase 6c chore-domain formatters ────────────────────────────────────────
# Pure string-building from structured inputs (ExtractedIntent + tool-call
# results + FACTS). No edge calls, no state mutation. Used by chat_respond's
# plan-confirm-execute phase, the no-match fallback, and the rich RPC
# reassign response formatter.


def _extract_spaces_from_facts(facts: str, keyword: str = "") -> list[str]:
    """Pull room/space names from the FACTS section, optionally filtered by keyword."""
    spaces: list[str] = []
    kw = keyword.lower().strip()
    for line in (facts or "").split("\n"):
        # Format: "Spaces: Kitchen, Living Room, Master Bathroom-Attached Master Bedroom, ..."
        if line.startswith("Spaces:") or line.startswith("Rooms:"):
            raw = line.split(":", 1)[1].strip()
            for name in raw.split(","):
                name = name.strip()
                if name and (not kw or kw in name.lower()):
                    spaces.append(name)
    return spaces


def _format_no_match_with_suggestions(
    match_text: str,
    facts: str,
) -> str:
    """Format a helpful no-match message with similar space/room suggestions."""
    # Try each word in match_text as a keyword to find similar spaces
    words = match_text.lower().split() if match_text else []
    similar: list[str] = []
    for word in words:
        if len(word) >= 3:  # skip short words like "the", "a"
            similar = _extract_spaces_from_facts(facts, word)
            if similar:
                break

    add_hint = (
        f"\n\nIf \"{match_text}\" is a new room that's not in your home profile yet, "
        f"you can add it from the **Home Profile** page, or say "
        f"*\"add {match_text} to my home profile\"*."
    )

    if not similar:
        # Broader search — get all spaces
        all_spaces = _extract_spaces_from_facts(facts)
        if all_spaces:
            space_list = "\n".join(f"  - {s}" for s in all_spaces[:10])
            more = f"\n  ...and {len(all_spaces) - 10} more" if len(all_spaces) > 10 else ""
            return (
                f"I couldn't find \"{match_text}\" in your home profile. "
                f"Here are your current rooms:\n{space_list}{more}\n\n"
                f"Did you mean one of these?"
                f"{add_hint}"
            )
        return (
            f"I couldn't find \"{match_text}\" in your home profile. "
            f"Could you give me the exact room name?"
            f"{add_hint}"
        )

    space_list = "\n".join(f"  - {s}" for s in similar[:8])
    return (
        f"I couldn't find an exact match for \"{match_text}\" in your home profile. "
        f"Did you mean one of these?\n{space_list}\n\n"
        f"Tell me which one and I'll proceed."
        f"{add_hint}"
    )


def _format_rpc_reassign_result(
    results: list[dict[str, Any]],
    intent: ExtractedIntent,
    facts: str = "",
) -> str | None:
    """Extract a human-readable message from reassign/bulk_reassign/add_space RPC results."""
    for r in results:
        if not isinstance(r, dict) or not r.get("ok"):
            continue
        result_data = r.get("result")
        if not result_data:
            continue

        # Handle list-wrapped RPC results (Supabase returns [{...}])
        rows = result_data if isinstance(result_data, list) else [result_data]
        for row in rows:
            if not isinstance(row, dict):
                continue
            action = row.get("action", "")

            # Bulk reassign result
            if action == "reassigned" and "reassigned_count" in row:
                count = row.get("reassigned_count", 0)
                helper = row.get("helper_name", intent.update_value or "the helper")
                titles = row.get("chore_titles") or []
                if count > 0:
                    preview = ", ".join(str(t) for t in titles[:5])
                    more = f" and {count - 5} more" if count > 5 else ""
                    return f"Done! Reassigned {count} chore(s) to {helper}: {preview}{more}."
                return f"No chores matching \"{intent.match_text}\" were found to reassign."

            # Single reassign result
            if action == "reassigned":
                title = row.get("chore_title", intent.match_text)
                helper = row.get("helper_name", intent.update_value or "the helper")
                return f"Done! Reassigned \"{title}\" to {helper}."

            if action == "unassigned":
                title = row.get("chore_title", intent.match_text)
                return f"Done! Unassigned \"{title}\"."

            if action == "none_found":
                return _format_no_match_with_suggestions(intent.match_text, facts)

            if action == "clarify_chore":
                candidates = row.get("chore_candidates") or []
                if candidates:
                    names = [str(c.get("title", "?")) for c in candidates[:5]]
                    return (
                        f"I found multiple chores matching \"{intent.match_text}\". "
                        f"Which one?\n" + "\n".join(f"  - {n}" for n in names)
                    )
                return f"Multiple chores match \"{intent.match_text}\". Could you be more specific?"

            if action == "clarify_helper":
                candidates = row.get("helper_candidates") or []
                if candidates:
                    names = [str(c.get("name", "?")) for c in candidates[:5]]
                    return (
                        f"I'm not sure which helper you mean by \"{intent.update_value}\". "
                        f"Did you mean one of these?\n" + "\n".join(f"  - {n}" for n in names)
                    )
                return f"I couldn't find a helper named \"{intent.update_value}\". Could you check the name?"

            # Add space to profile result
            if action == "added":
                space_name = row.get("display_name", intent.match_text)
                total = row.get("total_spaces", "?")
                return (
                    f"Done! Added **{space_name}** to your home profile. "
                    f"You now have {total} rooms/spaces. "
                    f"You can now assign chores to this room."
                )
            if action == "already_exists":
                space_name = row.get("display_name", intent.match_text)
                return f"**{space_name}** already exists in your home profile — no changes needed."

    return None


def _format_plan_preview(
    intents: list[ExtractedIntent],
    match_ids: list[tuple[str, str]],
) -> str:
    """Format a numbered plan from extracted intents for user confirmation."""
    steps: list[str] = []
    for i, intent in enumerate(intents, 1):
        action = intent.action.replace("_", " ").capitalize()
        target = intent.match_text or "chores"
        if intent.action == "add_space":
            steps.append(f"{i}. Add **{target}** to your home profile")
        elif intent.action == "reassign" and intent.update_value:
            steps.append(f"{i}. Assign **{target}** chores to **{intent.update_value}**")
        elif intent.action == "change_cadence" and intent.update_value:
            steps.append(f"{i}. Set **{target}** chores to **{intent.update_value}**")
        elif intent.action in ("update", "rename") and intent.update_value:
            steps.append(f"{i}. {action} **{target}** → \"{intent.update_value}\"")
        elif intent.update_field and intent.update_value:
            steps.append(f"{i}. Set {intent.update_field} of **{target}** to \"{intent.update_value}\"")
        else:
            steps.append(f"{i}. {action} **{target}**")

    plan_body = "\n".join(steps)

    # Add matched chore names if we have them (from db.update tool calls)
    chore_list = ""
    if match_ids:
        names = [title for _, title in match_ids[:10]]
        chore_list = "\n\nChores affected: " + ", ".join(names)
        if len(match_ids) > 10:
            chore_list += f" (+{len(match_ids) - 10} more)"

    return (
        f"Here's my plan:\n\n"
        f"{plan_body}"
        f"{chore_list}\n\n"
        f"Reply **yes** to proceed, or **no** to cancel."
    )


def _format_execution_result(
    results: list[dict[str, Any]],
    tool_calls: list[dict[str, Any]],
    intent_list: list[ExtractedIntent],
    primary_intent: ExtractedIntent,
    facts: str = "",
) -> str:
    """Format the execution result for display after plan confirmation."""
    update_count = sum(
        1 for tc, r in zip(tool_calls, results)
        if isinstance(tc, dict) and isinstance(r, dict)
        and tc.get("tool") == "db.update" and r.get("ok")
    )
    all_ok = all(r.get("ok") for r in results)

    if len(intent_list) > 1 and all_ok:
        parts: list[str] = ["Done!"]
        rpc_msg = _format_rpc_reassign_result(results, primary_intent, facts)
        if rpc_msg:
            parts.append(rpc_msg)
        if update_count > 0:
            parts.append(f"Updated {update_count} chore(s).")
        for si in intent_list:
            if si.action == "change_cadence" and si.update_value:
                parts.append(f"Set {si.match_text} chores to {si.update_value}.")
        return " ".join(parts)

    rpc_final = _format_rpc_reassign_result(results, primary_intent, facts)
    if rpc_final:
        return rpc_final
    if update_count > 0 and primary_intent.update_field and primary_intent.update_value is not None:
        return f"Done! Updated the {primary_intent.update_field} of {update_count} chore(s) to \"{primary_intent.update_value}\"."
    if update_count > 0 and primary_intent.update_field and primary_intent.update_value is None:
        return f"Done! Cleared the {primary_intent.update_field} of {update_count} chore(s)."
    if all_ok and update_count == 0:
        return _format_no_match_with_suggestions(primary_intent.match_text, facts)
    if all_ok:
        return f"Done! {primary_intent.action.capitalize()}d \"{primary_intent.match_text}\" successfully."
    errors = [str(r.get("error", "unknown error")) for r in results if not r.get("ok")]
    return f"Error: {'; '.join(errors)}"


def _format_confirmation_preview(
    intent: ExtractedIntent,
    match_ids: list[tuple[str, str]],
) -> str:
    lines = [f"{i+1}. {title}" for i, (_id, title) in enumerate(match_ids[:25])]
    body = "\n".join(lines)
    count = len(match_ids)
    overflow = f"\n(…and {count - 25} more)" if count > 25 else ""
    action_desc: str
    if intent.update_field and intent.update_value is not None:
        action_desc = (
            f"set the {intent.update_field} to \"{intent.update_value}\""
        )
    elif intent.update_field:
        action_desc = f"clear the {intent.update_field}"
    else:
        action_desc = f"{intent.action} them"
    return (
        f"I found {count} chore(s) matching \"{intent.match_text}\":\n"
        f"{body}{overflow}\n\n"
        f"Should I {action_desc} for all {count}? Reply **yes** to confirm or **no** to cancel."
    )


# ── Phase 6e (partial) match-resolution utilities ────────────────────────────
# Keyword splitting, FACTS chore parsing, and substring match resolution.
# Pure functions with no cross-module dependencies — used by
# chore_agent.py's eventual run() and by the existing call sites in
# main.py that still work via shim imports.
#
# NOT moved in this commit: _semantic_match_chores (depends on
# _get_embedder singleton in main.py), _resolve_chore_match_ids_via_rpc
# (depends on _edge_execute_tools in a way that entangles test patches),
# _fetch_chores_by_ids, _intent_to_tool_calls, _validate_tool_calls,
# _enforce_assignment_policy, _judge_response, _check_graduation_status.
# Those migrate in follow-up commits once their infra dependencies are
# plumbed through AgentContext properly.

SEMANTIC_MATCH_THRESHOLD = float(
    (os.environ.get("AGENT_SEMANTIC_MATCH_THRESHOLD") or "").strip() or "0.55"
)
SEMANTIC_MATCH_TOP_K = int(
    (os.environ.get("AGENT_SEMANTIC_MATCH_TOP_K") or "").strip() or "5"
)

_KEYWORD_SPLIT_RE = re.compile(r"\s+(?:and|or)\s+|[,/&]", re.IGNORECASE)
_KEYWORD_STOPWORDS = {
    "the", "a", "an", "of", "for", "to", "in", "on", "with",
    "this", "that", "those", "these", "any", "all", "some",
}
_LEADING_ARTICLE_RE = re.compile(r"^(?:the|a|an)\s+", re.IGNORECASE)


def _split_match_keywords(text: str) -> list[str]:
    """Split match_text into individual searchable keywords.

    Splits on conjunctions (and/or) and separators (comma, slash, ampersand),
    strips leading articles, drops stopwords, dedupes case-insensitively
    while preserving order.
    """
    if not text:
        return []
    parts = _KEYWORD_SPLIT_RE.split(text)
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        s = p.strip().strip("\"'.,;:")
        # Strip leading articles ("the toy" → "toy") so substring matches
        # against actual chore content work.
        s = _LEADING_ARTICLE_RE.sub("", s).strip()
        if not s or s.lower() in _KEYWORD_STOPWORDS:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def _parse_chores_from_facts(facts_section: str) -> list[dict[str, str]]:
    """Extract structured chore records (id/title/description) from FACTS."""
    line_re = re.compile(
        r'"(?P<title>[^"]+)"\s*\(id=(?P<id>[0-9a-f-]{36})[^)]*?(?:desc="(?P<desc>[^"]*)")?\)'
    )
    out: list[dict[str, str]] = []
    for m in line_re.finditer(facts_section):
        out.append({
            "id": m.group("id"),
            "title": m.group("title"),
            "description": m.group("desc") or "",
        })
    return out


async def _resolve_chore_match_ids(
    match_text: str,
    chores: list[dict[str, str]],
    *,
    bulk: bool,
) -> list[tuple[str, str]]:
    """Resolve match_text into chore (id, title) pairs via substring only.

    Splits match_text into keywords and runs a case-insensitive substring
    scan against title and description. Returns the union of hits.

    We deliberately do NOT fall back to semantic search: short keywords
    like "toy" or "clutter sweep" collapse onto generic "cleaning"
    semantics in BGE-small and produce loose false positives (e.g.
    "Sweep Deck area" scoring above threshold for "clutter sweep"). If
    no substring hits, the caller reports "no matches" and asks the user
    to clarify. _semantic_match_chores stays in place for future
    conceptual-query use cases (e.g. explicit "anything about ...").
    """
    keywords = _split_match_keywords(match_text)
    if not keywords:
        keywords = [match_text.strip()] if match_text.strip() else []
    if not keywords or not chores:
        return []

    matched: dict[str, str] = {}  # id -> title

    for kw in keywords:
        kw_lower = kw.lower()
        hits_for_kw: list[tuple[str, str]] = []
        for c in chores:
            if kw_lower in c["title"].lower() or kw_lower in c["description"].lower():
                hits_for_kw.append((c["id"], c["title"]))
                if not bulk:
                    break
        if hits_for_kw:
            for cid, ctitle in hits_for_kw:
                matched.setdefault(cid, ctitle)
            if not bulk:
                # Single-target intent — first substring hit wins, stop.
                return list(matched.items())

    return list(matched.items())


# ── Phase 6e (cont.) tool-call validation + assignment policy ────────────────
# Pure-logic guards over the tool_calls list the orchestrator is about to
# dispatch. Called from chat_respond's post-LLM validation step. No I/O, no
# LLM calls — safe to live next to the match-resolution utilities.


def _validate_tool_calls(
    tool_calls: list[dict],
    known_chore_ids: set[str],
    known_helper_ids: set[str],
    known_person_ids: set[str] | None = None,
) -> list[str]:
    """Validate tool call IDs against known entities. Returns list of error messages."""
    errors: list[str] = []
    _person_ids = known_person_ids or set()
    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        tool = str(tc.get("tool", ""))
        args = tc.get("args", {})
        if not isinstance(args, dict):
            continue

        if tool == "db.update" and "id" in args:
            rec_id = str(args["id"])
            table = str(args.get("table", ""))
            if table == "chores" and known_chore_ids and rec_id not in known_chore_ids:
                errors.append(f"db.update references unknown chore id={rec_id}")
            if table == "helpers" and known_helper_ids and rec_id not in known_helper_ids:
                errors.append(f"db.update references unknown helper id={rec_id}")
            # Validate person assignment: if patch sets assignee_person_id,
            # verify it's a known household person
            if table == "chores":
                patch = args.get("patch", {})
                if isinstance(patch, dict) and "assignee_person_id" in patch:
                    pid = str(patch["assignee_person_id"])
                    if pid and pid != "null" and _person_ids and pid not in _person_ids:
                        errors.append(f"db.update assigns chore to unknown person id={pid}")

        if tool == "db.delete" and "id" in args:
            rec_id = str(args["id"])
            table = str(args.get("table", ""))
            if table == "chores" and known_chore_ids and rec_id not in known_chore_ids:
                errors.append(f"db.delete references unknown chore id={rec_id}")

        # Validate RPC calls that reference helper/person IDs
        if tool == "query.rpc" and isinstance(args.get("params"), dict):
            params = args["params"]
            # Check p_helper_id in assignment RPCs
            helper_id = params.get("p_helper_id")
            if helper_id and known_helper_ids and str(helper_id) not in known_helper_ids:
                # Could be a person ID — check that too
                if not _person_ids or str(helper_id) not in _person_ids:
                    errors.append(f"query.rpc references unknown helper/person id={helper_id}")

    return errors


def _enforce_assignment_policy(
    tool_calls: list[dict],
    facts_section: str = "",  # noqa: ARG001 — reserved for future rule lookups
) -> list[str]:
    """Enforce assignment policy rules on tool calls. Returns list of warnings.

    Policy rules (from the system manifest):
    1. Cannot assign to both helper_id and assignee_person_id simultaneously
    2. Assignment operations must reference valid entities from FACTS
    3. Consent defaults: helper vision capture defaults to opt-out
    4. Override tracking: reassignments should use apply_assignment_decision RPC
    """
    warnings: list[str] = []

    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        tool = str(tc.get("tool", ""))
        args = tc.get("args", {})
        if not isinstance(args, dict):
            continue

        # Rule 1: Cannot set both helper_id and assignee_person_id
        if tool == "db.update":
            patch = args.get("patch", {})
            if isinstance(patch, dict):
                has_helper = "helper_id" in patch and patch["helper_id"] is not None
                has_person = "assignee_person_id" in patch and patch["assignee_person_id"] is not None
                if has_helper and has_person:
                    warnings.append(
                        "Cannot assign a chore to both a helper and a person. "
                        "Clear one before setting the other."
                    )

        # Rule 4: Prefer apply_assignment_decision RPC for assignments (O1 tracking)
        if tool == "db.update" and str(args.get("table", "")) == "chores":
            patch = args.get("patch", {})
            if isinstance(patch, dict) and ("helper_id" in patch or "assignee_person_id" in patch):
                # This is a direct chore assignment via db.update — warn that
                # apply_assignment_decision RPC should be used for O1 tracking.
                # Not blocking — some paths (like bulk assignment) use db.update.
                pass  # Logged for future telemetry but not blocking

    return warnings


__all__ = [
    "ChoreAgent",
    "_wants_unassigned_count",
    "_extract_count_assigned_to_name",
    "_wants_total_pending_count",
    "_wants_status_breakdown",
    "_wants_assignee_breakdown",
    "_extract_space_list_query",
    "_extract_list_assigned_to_name",
    "_extract_assign_or_create_chore",
    "_extract_complete_chore_by_query",
    "_extract_reassign_or_unassign_chore",
    "_extract_spaces_from_facts",
    "_format_no_match_with_suggestions",
    "_format_rpc_reassign_result",
    "_format_plan_preview",
    "_format_execution_result",
    "_format_confirmation_preview",
    "SEMANTIC_MATCH_THRESHOLD",
    "SEMANTIC_MATCH_TOP_K",
    "_split_match_keywords",
    "_parse_chores_from_facts",
    "_resolve_chore_match_ids",
    "_validate_tool_calls",
    "_enforce_assignment_policy",
]
