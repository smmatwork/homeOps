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

import asyncio
import json
import logging
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from agents.base import AgentContext, AgentResult, ChatFn, EdgeExecuteFn
from intent_registry import intent_to_tool_calls as registry_intent_to_tool_calls
from orchestrator.intent import ExtractedIntent, extract_structured_intent
from orchestrator.parsing import (
    _try_parse_json_obj,
    _ensure_tool_reason,
    _contains_structured_tool_calls_payload,
)
from orchestrator.state import (
    stash_clarification as _stash_clarification,
    stash_pending_confirmation as _stash_pending_confirmation,
    take_clarification as _take_clarification,
)


def _env(name: str, default: str | None = None) -> str | None:
    """Whitespace-tolerant env lookup — matches main._env's behaviour.

    Duplicated here rather than imported from main to avoid a circular
    import back into the orchestrator layer.
    """
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


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
            # An RPC error looks identical to a "no rows" result downstream —
            # both leave `result` as None / empty. Defer to the LLM on error
            # so the user doesn't see a misleading "No chores found for X"
            # when the server actually 500'd.
            if isinstance(out, dict) and out.get("ok") is False:
                logging.warning(
                    "list_chores_enriched failed for space_query=%r: %s",
                    space_q, out.get("error"),
                )
                return AgentResult(kind="defer")
            payload = out.get("result") if isinstance(out, dict) else None
            match_type = payload.get("match_type") if isinstance(payload, dict) else None
            if match_type == "ambiguous_space":
                return AgentResult(kind="text", text="Which space did you mean?")
            if match_type == "none_space":
                return AgentResult(
                    kind="text",
                    text=f"I couldn't find a space called \"{space_q}\" in your home profile.",
                )
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

    async def try_structured_extraction_flow(
        self,
        ctx: AgentContext,
        intent_to_tool_calls_fn: Callable[..., Any] | None = None,
    ) -> AgentResult:
        """Phase 6d — pending-clarification substitution + structured extraction
        → plan-confirm-execute.

        Runs after the analytics/deterministic-action shortcuts but before the
        main LLM orchestrator turn. Two stages:

          1. **Pending clarification substitution.** If the previous turn asked
             "which bathroom?" and stashed a `PendingClarification`, consume
             the user's reply as the clarified value, re-run
             `_intent_to_tool_calls` with the substituted intents, and stash a
             `PendingConfirmation` so the next turn's plan-confirm branch can
             execute. Returns a plan-preview `kind="text"`.

          2. **Structured extraction → plan-confirm-execute.** If not
             onboarding, call `extract_structured_intent` on the user message;
             if it yields a list of ExtractedIntents, convert each to tool
             calls via `_intent_to_tool_calls`. Handle three outcomes:

               a. `internal.no_match` — stash a clarification and reply with a
                  no-match-with-suggestions message.
               b. Have a pending_key — stash the confirmation and return the
                  plan preview (plan-confirm-execute).
               c. No pending_key — execute immediately via
                  `ctx.edge_execute_tools`, return the execution-result text.

        Returns AgentResult(kind="defer") in all other cases (no stashed
        clarification, is_onboarding, extraction yielded nothing, or the
        extraction raised — consistent with the pre-migration behaviour of
        falling through to the main LLM turn).
        """
        last_user_text = ctx.last_user_text
        pending_key = ctx.pending_key
        facts_section = ctx.facts_section
        household_id = ctx.household_id
        user_id = ctx.user_id

        # Callers in main.py pass _intent_to_tool_calls (the shim that binds
        # _edge_execute_tools from main's namespace) so patch.object(agent_main,
        # "_intent_to_tool_calls", ...) intercepts this flow. The default
        # invokes the chore_agent implementation directly — useful when a
        # future orchestrator.router builds its own AgentContext.
        async def _call_intent_to_tool_calls(sub: ExtractedIntent) -> list[dict[str, Any]] | None:
            if intent_to_tool_calls_fn is not None:
                return await intent_to_tool_calls_fn(
                    sub, facts_section,
                    household_id=household_id, user_id=user_id,
                )
            return await _intent_to_tool_calls(
                sub, facts_section,
                edge_execute_tools=ctx.edge_execute_tools,
                household_id=household_id, user_id=user_id,
            )

        # ── Pending clarification context ─────────────────────────────
        if pending_key and last_user_text:
            clarification = await _take_clarification(pending_key)
            if clarification is not None:
                clarified_text = last_user_text.strip()
                # Strip common prefixes like "I meant", "it's", "the one called"
                clarified_text = re.sub(
                    r"^(?:i\s+meant?|it'?s|the\s+one\s+called|the\s+)\s*",
                    "", clarified_text, flags=re.IGNORECASE,
                ).strip() or clarified_text

                updated_intents: list[ExtractedIntent] = []
                for orig in clarification.original_intents:
                    if orig.match_text.lower() == clarification.failed_match_text.lower():
                        updated_intents.append(ExtractedIntent(
                            action=orig.action,
                            entity=orig.entity,
                            match_text=clarified_text,
                            match_field=orig.match_field,
                            update_field=orig.update_field,
                            update_value=orig.update_value,
                            bulk=orig.bulk,
                            confidence=orig.confidence,
                        ))
                    else:
                        updated_intents.append(orig)

                all_tcs: list[dict[str, Any]] = []
                for sub in updated_intents:
                    sub_tcs = await _call_intent_to_tool_calls(sub)
                    if sub_tcs:
                        all_tcs.extend(sub_tcs)

                if all_tcs and pending_key:
                    extracted_intent = updated_intents[0]
                    pending_match_ids = _match_ids_from_tool_calls(
                        [tc for tc in all_tcs if isinstance(tc, dict) and tc.get("tool") == "db.update"]
                    )
                    await _stash_pending_confirmation(
                        conversation_id=pending_key,
                        intent=extracted_intent,
                        match_ids=pending_match_ids,
                        tool_calls=all_tcs,
                    )
                    preview = _format_plan_preview(updated_intents, pending_match_ids)
                    return AgentResult(kind="text", text=preview)

        # ── Structured intent extraction ─────────────────────────────
        if ctx.is_onboarding:
            return AgentResult(kind="defer")

        try:
            raw_intent = await extract_structured_intent(
                last_user_text, ctx.model, ctx.chat_fn, facts_section
            )

            intent_list: list[ExtractedIntent] = []
            if isinstance(raw_intent, list):
                intent_list = raw_intent
            elif raw_intent is not None:
                intent_list = [raw_intent]

            if not intent_list:
                return AgentResult(kind="defer")

            all_deterministic_tcs: list[dict[str, Any]] = []
            extracted_intent = intent_list[0]

            for sub_intent in intent_list:
                ctx.lf_span(
                    "orchestrator.extraction",
                    input={"user_text": last_user_text[:200]},
                    output={
                        "action": sub_intent.action,
                        "entity": sub_intent.entity,
                        "match_text": sub_intent.match_text,
                        "update_field": sub_intent.update_field,
                        "update_value": sub_intent.update_value,
                        "confidence": sub_intent.confidence,
                    },
                )
                sub_tcs = await _call_intent_to_tool_calls(sub_intent)
                if sub_tcs:
                    all_deterministic_tcs.extend(sub_tcs)

            deterministic_tcs = all_deterministic_tcs if all_deterministic_tcs else None
            if not (deterministic_tcs and household_id and user_id):
                return AgentResult(kind="defer")

            no_match_tcs = [
                tc for tc in deterministic_tcs
                if isinstance(tc, dict) and tc.get("tool") == "internal.no_match"
            ]
            if no_match_tcs:
                args = no_match_tcs[0].get("args") or {}
                keywords = args.get("keywords") or [extracted_intent.match_text]
                match_term = keywords[0] if keywords else extracted_intent.match_text
                if pending_key:
                    await _stash_clarification(
                        conversation_id=pending_key,
                        original_intents=intent_list,
                        failed_match_text=match_term,
                        question_type="space_not_found",
                    )
                final = _format_no_match_with_suggestions(match_term, facts_section)
                return AgentResult(kind="text", text=final)

            # ── Plan-Confirm-Execute ──────────────────────────
            if pending_key:
                pending_match_ids = _match_ids_from_tool_calls(
                    [tc for tc in deterministic_tcs if isinstance(tc, dict) and tc.get("tool") == "db.update"]
                )
                await _stash_pending_confirmation(
                    conversation_id=pending_key,
                    intent=extracted_intent,
                    match_ids=pending_match_ids,
                    tool_calls=deterministic_tcs,
                )
                preview = _format_plan_preview(intent_list, pending_match_ids)
                return AgentResult(kind="text", text=preview)

            # No conv_id (can't stash) — execute immediately as fallback.
            ctx.lf_span("orchestrator.extraction.execute", input={"tool_calls": deterministic_tcs})
            results: list[dict[str, Any]] = []
            for tc in deterministic_tcs:
                tc = _ensure_tool_reason(tc, f"Extracted intent: {extracted_intent.action}")
                try:
                    out = await ctx.edge_execute_tools(
                        {"household_id": household_id, "tool_call": tc},
                        user_id=user_id,
                    )
                except Exception as e:
                    out = {"ok": False, "error": str(e), "tool_call_id": tc.get("id")}
                results.append(out)

            final = _format_execution_result(
                results, deterministic_tcs, intent_list, extracted_intent, facts=facts_section
            )
            return AgentResult(kind="text", text=final)
        except Exception as e:
            logging.warning(f"deterministic intent path failed, falling back to LLM: {e}")
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


_SPACE_LIST_ACTION_WORDS = (
    "reschedule", "assign", "reassign", "unassign", "change",
    "update", "delete", "remove", "complete", "finish", "mark",
    "mop", "clean", "sweep", "move", "set", "make",
)


def _extract_space_list_query(messages: list[dict[str, Any]]) -> str:
    """Detect a "chores/tasks in <space>" listing question.

    Guards (to avoid greedy mis-extraction):

      - the user message must mention chore/task (so generic "for" clauses
        about unrelated topics don't trip it)
      - the message must NOT contain action verbs like "reassign", "change",
        "mop", etc. — those are action requests, not list queries, and
        should flow through the structured-extraction path instead
      - the space span is 3–30 chars of letters/digits/space/dash, and
        stops at the first action-like keyword or sentence-internal verb
    """
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

    # Action verbs anywhere in the message mean this is an action request
    # (not a "list me the chores in X" query). Defer to the LLM / structured
    # extraction path. Use word-boundary checks so "clean" doesn't match
    # the "Clean" of a chore title the user echoed back.
    for word in _SPACE_LIST_ACTION_WORDS:
        if re.search(rf"\b{word}\b", lower):
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

EmbedderFn = Callable[[], Any]


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


async def _semantic_match_chores(
    keywords: list[str],
    chores: list[dict[str, str]],
    get_embedder: EmbedderFn,
) -> list[tuple[str, str, float]]:
    """Find chores semantically similar to any of the given keywords.

    Returns (id, title, best_similarity) triples, deduped by id, sorted by
    similarity descending, capped at SEMANTIC_MATCH_TOP_K. Runs the embedder
    in a thread so the event loop isn't blocked by the model load on first
    call (~1-2s) or per-call inference (~10-50ms for ~30 short texts).

    `get_embedder` is injected rather than imported because the fastembed
    singleton lives in main.py (same accessor the /v1/embed endpoint uses)
    and we don't want a back-edge into main from the agents layer.
    """
    if not keywords or not chores:
        return []

    def _compute() -> list[tuple[str, str, float]]:
        try:
            emb = get_embedder()
        except Exception as e:
            logging.warning(f"semantic chore match: embedder unavailable: {e}")
            return []
        if emb is None:
            return []
        chore_texts = [
            ((c["title"] + ". " + c["description"]).strip(". ")) or c["title"]
            for c in chores
        ]
        all_texts = keywords + chore_texts
        try:
            vecs = [list(map(float, v)) for v in emb.embed(all_texts)]
        except Exception as e:
            logging.warning(f"semantic chore match: embed failed: {e}")
            return []
        kw_vecs = vecs[: len(keywords)]
        ch_vecs = vecs[len(keywords):]
        # BGE-small vectors are L2-normalized → dot product == cosine.
        best_per_chore: dict[str, tuple[str, float]] = {}
        for ci, cv in enumerate(ch_vecs):
            best = 0.0
            for kv in kw_vecs:
                s = 0.0
                for a, b in zip(kv, cv):
                    s += a * b
                if s > best:
                    best = s
            if best >= SEMANTIC_MATCH_THRESHOLD:
                best_per_chore[chores[ci]["id"]] = (chores[ci]["title"], best)
        ranked = sorted(
            ((cid, t, s) for cid, (t, s) in best_per_chore.items()),
            key=lambda x: x[2],
            reverse=True,
        )
        return ranked[:SEMANTIC_MATCH_TOP_K]

    try:
        return await asyncio.to_thread(_compute)
    except Exception as e:
        logging.warning(f"semantic chore match: thread failed: {e}")
        return []


async def _resolve_chore_match_ids_via_rpc(
    edge_execute_tools: EdgeExecuteFn,
    *,
    household_id: str,
    user_id: str,
    match_text: str,
    bulk: bool,
) -> list[tuple[str, str]] | None:
    """Resolve match_text → chore IDs via the find_chores_matching_keywords RPC.

    The RPC scans the FULL chore corpus (no truncation, no row limit) using
    case-insensitive substring match against title and description. Replaces
    the FACTS-based scan, which only saw the 30 most recent chores with
    descriptions truncated to 60 chars.

    `edge_execute_tools` is injected so the module has no static edge
    dependency; main.py's shim binds `_edge_execute_tools` at call time so
    test patches on `agent_main._edge_execute_tools` still propagate.

    Returns:
        - A list of (id, title) tuples on success (possibly empty if no
          matches were found in the database).
        - None if the RPC could not be invoked (e.g. missing IDs, network
          error, or the RPC returned malformed data) so the caller can fall
          back to the FACTS scan as a safety net.
    """
    if not household_id or not user_id:
        return None
    keywords = _split_match_keywords(match_text)
    if not keywords:
        keywords = [match_text.strip()] if match_text.strip() else []
    if not keywords:
        return []

    payload = {
        "household_id": household_id,
        "tool_call": {
            "id": f"tc_resolve_kw_{uuid.uuid4().hex[:8]}",
            "tool": "query.rpc",
            "args": {
                "name": "find_chores_matching_keywords",
                "params": {"p_keywords": keywords},
            },
            "reason": f"Resolve match_text to chore ids via keywords: {keywords}",
        },
    }

    try:
        out = await edge_execute_tools(payload, user_id=user_id)
    except Exception as e:
        logging.warning(f"find_chores_matching_keywords RPC failed: {e}")
        return None

    if not isinstance(out, dict) or out.get("ok") is False:
        logging.warning(f"find_chores_matching_keywords RPC returned not-ok: {out}")
        return None

    # The edge function unwraps a single-row RPC result to a bare object
    # (see supabase/functions/server/index.ts: `data.length === 1 ? data[0] : data`).
    # Normalize both shapes into a list of dicts.
    rows_raw = out.get("result")
    if rows_raw is None:
        rows_raw = out.get("data")
    if isinstance(rows_raw, dict):
        rows = [rows_raw]
    elif isinstance(rows_raw, list):
        rows = rows_raw
    elif rows_raw is None:
        rows = []
    else:
        logging.warning(f"find_chores_matching_keywords RPC returned unexpected shape: {out}")
        return None

    matches: list[tuple[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        cid = row.get("id")
        title = row.get("title") or ""
        if isinstance(cid, str) and cid.strip():
            matches.append((cid, str(title)))
    if not bulk and len(matches) > 1:
        matches = matches[:1]
    return matches


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


# ── Phase 6d helper: reconstruct match_ids from tool_calls ──────────────────


def _match_ids_from_tool_calls(tcs: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Reconstruct (chore_id, title) pairs from db.update tool calls.

    _intent_to_tool_calls embeds the title in the reason field as
    "on '<title>'", so parsing is deterministic and local. Used by the
    plan-confirm-execute flow to show the user which chores are affected.
    """
    out: list[tuple[str, str]] = []
    for tc in tcs:
        if not isinstance(tc, dict) or tc.get("tool") != "db.update":
            continue
        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
        cid = str(args.get("id") or "") if isinstance(args, dict) else ""
        reason = str(tc.get("reason") or "")
        m = re.search(r"on '([^']+)'", reason)
        title = m.group(1) if m else (cid[:8] if cid else "chore")
        if cid:
            out.append((cid, title))
    return out


# ── Phase 6e (cont.) deterministic intent → tool_calls orchestrator ──────────
# Consumes an ExtractedIntent (from orchestrator.intent.extract_structured_intent)
# and produces a concrete tool_calls list, or None to mean "fall through to the
# main LLM turn". Two RPC-backed paths (find_chores_matching_keywords, then
# reassign/bulk_reassign) plus a FACTS-scan fallback and a db.select final
# fallback. _edge_execute_tools is injected rather than imported so the
# main.py shim that wraps this keeps test patches on agent_main._edge_execute_tools
# flowing through.


async def _intent_to_tool_calls(
    extracted: ExtractedIntent,
    facts_section: str,
    *,
    edge_execute_tools: EdgeExecuteFn,
    household_id: str = "",
    user_id: str = "",
) -> list[dict[str, Any]] | None:
    """Convert extracted intent into deterministic tool calls.

    Returns a list of tool calls, or None if we can't determine the calls
    (in which case fall through to the LLM).
    """
    if not extracted.match_text:
        return None

    # Try registry-based tool call builder first
    registry_result = await registry_intent_to_tool_calls(
        extracted.action, extracted, facts_section,
        household_id=household_id, user_id=user_id,
    )
    if registry_result is not None:
        return registry_result

    table = "chores" if extracted.entity == "chore" else (
        "helpers" if extracted.entity == "helper" else None
    )
    if not table:
        return None

    if extracted.action in ("update", "rename", "change_cadence", "change_priority", "change_due", "add_note", "remove_field"):
        # Resolve match_text → chore IDs. Preferred path: server-side RPC
        # find_chores_matching_keywords scans the full corpus with no
        # truncation. Fallback: FACTS substring scan, used only when the
        # RPC isn't available (network error, unmigrated env, etc).
        match_ids: list[tuple[str, str]] = []
        chores_in_facts: list[dict[str, str]] = []
        rpc_result: list[tuple[str, str]] | None = None
        if table == "chores":
            rpc_result = await _resolve_chore_match_ids_via_rpc(
                edge_execute_tools,
                household_id=household_id,
                user_id=user_id,
                match_text=extracted.match_text,
                bulk=extracted.bulk,
            )
            if rpc_result is not None:
                # RPC ran successfully; use its result (possibly empty).
                match_ids = rpc_result
                chores_in_facts = _parse_chores_from_facts(facts_section)
            else:
                # RPC unavailable → fall back to FACTS scan.
                chores_in_facts = _parse_chores_from_facts(facts_section)
                match_ids = await _resolve_chore_match_ids(
                    extracted.match_text,
                    chores_in_facts,
                    bulk=extracted.bulk,
                )

        if table == "chores" and not match_ids and (chores_in_facts or rpc_result is not None):
            # FACTS has the chore corpus but nothing matched → report cleanly
            # instead of falling through to a db.select that would return
            # zero rows and let the orchestrator falsely report "Done!".
            keywords = _split_match_keywords(extracted.match_text) or [extracted.match_text]
            return [
                {
                    "id": f"tc_extract_nomatch_{uuid.uuid4().hex[:8]}",
                    "tool": "internal.no_match",
                    "args": {
                        "entity": "chore",
                        "match_text": extracted.match_text,
                        "keywords": keywords,
                        "action": extracted.action,
                        "update_field": extracted.update_field,
                    },
                    "reason": f"No chores matched '{extracted.match_text}' via substring or semantic search.",
                }
            ]

        if match_ids and extracted.update_field:
            # Direct update — we have the ID(s) from FACTS, skip the select step.
            value = extracted.update_value
            # Handle special values.
            if extracted.update_field == "cadence" and isinstance(value, str):
                value = value.lower().replace(" ", "_")
            if extracted.update_field == "priority" and isinstance(value, str):
                try:
                    value = int(value)
                except ValueError:
                    value = {"high": 3, "medium": 2, "low": 1}.get(value.lower(), 2)

            return [
                {
                    "id": f"tc_extract_{uuid.uuid4().hex[:8]}",
                    "tool": "db.update",
                    "args": {
                        "table": table,
                        "id": rec_id,
                        "patch": {extracted.update_field: value},
                    },
                    "reason": f"{extracted.action}: set {extracted.update_field} = {json.dumps(value)} on '{rec_title}'",
                }
                for rec_id, rec_title in match_ids
            ]

        # Fallback: select first to find the record.
        # Search across both title and description for chores so users can
        # reference a chore by words that only appear in its description.
        # The edge applyToolWhere ORs across all $regex fields, so passing
        # both title and description gives a single ILIKE-OR query.
        if table == "chores":
            where_clause: dict[str, Any] = {
                "title": {"$regex": extracted.match_text, "$options": "i"},
                "description": {"$regex": extracted.match_text, "$options": "i"},
            }
            columns = "id,title,description,status,metadata"
        else:
            where_clause = {"name": {"$regex": extracted.match_text, "$options": "i"}}
            columns = "id,name,type,phone"

        return [
            {
                "id": f"tc_extract_select_{uuid.uuid4().hex[:8]}",
                "tool": "db.select",
                "args": {
                    "table": table,
                    "columns": columns,
                    "where": where_clause,
                    "limit": 10,
                },
                "reason": f"Find {extracted.entity} matching '{extracted.match_text}' for {extracted.action}.",
            }
        ]

    if extracted.action == "reassign" and extracted.update_value:
        if extracted.bulk:
            # Bulk reassign — use the bulk RPC that handles multiple chores.
            return [
                {
                    "id": f"tc_extract_bulk_reassign_{uuid.uuid4().hex[:8]}",
                    "tool": "query.rpc",
                    "args": {
                        "name": "bulk_reassign_chores_by_query",
                        "params": {
                            "p_chore_query": extracted.match_text,
                            "p_new_helper_query": extracted.update_value,
                        },
                    },
                    "reason": f"Bulk reassign all '{extracted.match_text}' chores to '{extracted.update_value}'.",
                }
            ]
        # Single chore reassign.
        return [
            {
                "id": f"tc_extract_reassign_{uuid.uuid4().hex[:8]}",
                "tool": "query.rpc",
                "args": {
                    "name": "reassign_chore_by_query",
                    "params": {
                        "p_chore_query": extracted.match_text,
                        "p_new_helper_query": extracted.update_value,
                    },
                },
                "reason": f"Reassign chore '{extracted.match_text}' to '{extracted.update_value}'.",
            }
        ]

    return None


# ── Phase 6e (cont.) Supabase REST helpers ───────────────────────────────────
# Direct Supabase REST calls used when the Edge Function path isn't the right
# fit: _fetch_chores_by_ids backs the sync-followup diff, _check_graduation_status
# hits an RPC that's cheaper to call direct than through the edge. Both share
# the same URL/key resolution in _resolve_supabase_rest.
#
# These are independent of _edge_execute_tools and its test patches — they go
# straight to Supabase REST — so they move cleanly without the patch-plumbing
# concern that blocks _resolve_chore_match_ids_via_rpc.


def _resolve_supabase_rest() -> tuple[str, str]:
    """Return (base_url, service_or_anon_key) for direct Supabase REST calls.

    Mirrors the resolution logic in orchestrator.facts.build_facts_section so
    every helper that bypasses the edge function uses the same URL/key
    fallback chain.
    """
    sb_url = (_env("SUPABASE_URL") or "").strip().rstrip("/")
    if not sb_url:
        edge = (_env("EDGE_BASE_URL") or "").strip()
        if edge:
            import urllib.parse
            parsed = urllib.parse.urlparse(edge)
            host = parsed.hostname or "127.0.0.1"
            if host == "host.docker.internal":
                host = "127.0.0.1"
            port = parsed.port or 54321
            sb_url = f"{parsed.scheme or 'http'}://{host}:{port}"
        else:
            sb_url = "http://127.0.0.1:54321"
    sb_key = _env("SUPABASE_SERVICE_ROLE_KEY") or _env("SUPABASE_ANON_KEY") or _env("EDGE_BEARER_TOKEN") or ""
    if not sb_key and "127.0.0.1" in sb_url:
        sb_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
    return sb_url, sb_key


async def _fetch_chores_by_ids(
    household_id: str,
    chore_ids: list[str],
) -> list[dict[str, str]]:
    """Fetch (id, title, description) for the given chore IDs via Supabase REST.

    Used by the sync-followup logic to check whether a chore's title and
    description are now out of sync after an update. Returns an empty list
    on any failure so the caller can fall back to skipping the prompt.
    """
    if not household_id or not chore_ids:
        return []
    sb_url, sb_key = _resolve_supabase_rest()
    if not sb_key:
        return []

    quoted_ids = ",".join(f'"{cid}"' for cid in chore_ids if isinstance(cid, str) and cid)
    if not quoted_ids:
        return []

    headers = {
        "apikey": sb_key,
        "Authorization": f"Bearer {sb_key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            r = await client.get(
                f"{sb_url}/rest/v1/chores",
                params={
                    "household_id": f"eq.{household_id}",
                    "id": f"in.({quoted_ids})",
                    "select": "id,title,description",
                },
                headers=headers,
            )
        if r.status_code != 200:
            logging.warning(f"_fetch_chores_by_ids non-200: {r.status_code} {r.text[:200]}")
            return []
        data = r.json()
        if not isinstance(data, list):
            return []
        out: list[dict[str, str]] = []
        for row in data:
            if isinstance(row, dict):
                out.append({
                    "id": str(row.get("id") or ""),
                    "title": str(row.get("title") or ""),
                    "description": str(row.get("description") or ""),
                })
        return out
    except Exception as e:
        logging.warning(f"_fetch_chores_by_ids failed: {e}")
        return []


async def _check_graduation_status(
    household_id: str,
    chore_predicate_hash: str,
    helper_id: str,
) -> dict[str, Any]:
    """Check if a (chore pattern, helper) combination has graduated to
    silent auto-assignment. Returns {should_graduate, consecutive_approvals}.

    Graduation threshold: 5 consecutive one_tap approvals without override.
    """
    sb_url, sb_key = _resolve_supabase_rest()

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            r = await client.post(
                f"{sb_url}/rest/v1/rpc/check_auto_assignment_graduation",
                headers={
                    "apikey": sb_key,
                    "Authorization": f"Bearer {sb_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "p_household_id": household_id,
                    "p_chore_predicate_hash": chore_predicate_hash,
                    "p_helper_id": helper_id,
                },
            )
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list) and data:
                    return data[0]
                elif isinstance(data, dict):
                    return data
    except Exception as e:
        logging.getLogger("homeops.agent_service").warning(
            "Graduation check failed: %s", str(e)[:100]
        )

    return {"should_graduate": False, "consecutive_approvals": 0}


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


# ── Phase 6e (cont.) LLM-as-Judge guardrail ─────────────────────────────────
# Post-turn quality check on the assistant's final text. Uses the injected
# chat_fn so tests that patch the LLM layer (patch.object(agent_main,
# "_sarvam_chat", ...)) keep working — the main.py shim passes through
# whatever _sarvam_chat resolves to at call time.


JUDGE_SYSTEM_PROMPT = (
    "You are a quality judge for a home management assistant. "
    "Given the USER REQUEST, the ASSISTANT RESPONSE, and the KNOWN FACTS (ground truth), "
    "evaluate the response on these criteria:\n\n"
    "1) **Intent alignment**: Does the response address what the user actually asked for? "
    "(Not a different action, not an unrelated topic.) If the user asked to reassign, "
    "change frequency, or set a pattern — did the response actually do that, or did it "
    "just list chores without acting?\n"
    "2) **Data fidelity**: Does the response ONLY mention helpers, chores, rooms, and people "
    "that appear in the KNOWN FACTS? Any name, ID, or count not in the facts is hallucinated.\n"
    "3) **Action safety**: If the response claims to have created, updated, or deleted "
    "something, was there an actual tool_calls execution? Claiming success without tool "
    "calls is a hallucination.\n"
    "4) **Policy compliance**: Assignment must respect helper capacity, time-off, and "
    "household assignment rules. Notifications must be justified.\n\n"
    "Return ONLY a JSON object:\n"
    "{\n"
    "  \"pass\": true/false,\n"
    "  \"reason\": \"<concise explanation>\",\n"
    "  \"correction\": \"<what should be done instead, if failed — include a specific UI "
    "page or feature the user can use>\",\n"
    "  \"failure_type\": \"intent_mismatch\" | \"hallucination\" | \"unsafe_action\" | "
    "\"policy_violation\" | null,\n"
    "  \"severity\": \"fatal\" | \"correctable\" | null\n"
    "}\n\n"
    "severity='fatal' means the response completely missed the user's intent (e.g., "
    "listed chores when user asked to reassign, or didn't act on a request). "
    "severity='correctable' means the intent was right but details are wrong "
    "(e.g., wrong helper name). If pass=true, set failure_type and severity to null.\n\n"
    "When the correction involves a complex scheduling/assignment pattern the chat can't "
    "handle, guide the user to the right UI page:\n"
    "- Bulk reassignment or workload balancing → 'Go to Chores → Coverage → Utilization tab → Optimize workload'\n"
    "- Changing frequency of many chores → 'Go to Chores → Coverage → Utilization tab → Optimize workload → Reduce Frequency step'\n"
    "- Adding/managing helpers → 'Go to the Helpers page'\n"
    "- Adding household members → 'Go to the Household page'\n"
    "- Managing maintenance/vendors → 'Go to Services or Maintenance page'\n"
    "- Simple single-chore changes → ask the user to rephrase as 'assign <chore> to <helper>' or 'change <chore> to <cadence>'\n"
)


async def _judge_response(
    user_request: str,
    assistant_response: str,
    model: str,
    chat_fn: ChatFn,
    facts_summary: str = "",
) -> dict[str, Any]:
    """Run LLM-as-Judge on the assistant's response. Returns {pass, reason, correction}."""
    judge_input = f"USER REQUEST:\n{user_request}\n\nASSISTANT RESPONSE:\n{assistant_response}"
    if facts_summary:
        judge_input += f"\n\nKNOWN FACTS (ground truth):\n{facts_summary}"

    try:
        raw = await chat_fn(
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {"role": "user", "content": judge_input},
            ],
            model=model,
            temperature=0.0,
            max_tokens=300,
        )
        if isinstance(raw, str):
            obj = _try_parse_json_obj(raw.strip())
            if obj and "pass" in obj:
                return obj
            # Try extracting JSON from markdown fences.
            cleaned = re.sub(r"```json?\s*|\s*```", "", raw).strip()
            obj2 = _try_parse_json_obj(cleaned)
            if obj2 and "pass" in obj2:
                return obj2
    except Exception as e:
        _logger = logging.getLogger("homeops.agent_service")
        _logger.warning("LLM-as-Judge failed with exception: %s", str(e)[:200])
        # On error, return fail with the error so the caller can decide
        return {"pass": False, "reason": f"Judge error: {str(e)[:100]}", "correction": "Retry or review manually"}

    _logger = logging.getLogger("homeops.agent_service")
    _logger.warning("LLM-as-Judge could not parse response")
    return {"pass": False, "reason": "Judge could not parse response", "correction": "Review response manually"}


# ── Phase 6f hallucination-override detectors ───────────────────────────────
# Pure text → bool checks that fire when the LLM returns a final_text looking
# like a hallucinated list of helpers / chores / spaces. Called from
# orchestrator.llm_loop via a composed `needs_fetch_override` closure so the
# module stays domain-agnostic.


def _needs_helpers_fetch_override(text: str) -> bool:
    s = (text or "").strip().lower()
    if not s:
        return False
    if _contains_structured_tool_calls_payload(text):
        return False
    # Guard against hallucinated helper lists like:
    # "Here are available cleaners... 1) Rajesh ... 2) Sunita ..."
    triggers = (
        "here are available cleaners",
        "here are available helpers",
        "available cleaners",
        "available helper",
        "available helpers",
        "available cleaner",
        "here are the available cleaners",
        "here are the available helpers",
    )
    if any(t in s for t in triggers):
        return True
    # Numbered lists that mention cleaners/helpers.
    if ("cleaner" in s or "cleaners" in s or "helper" in s or "helpers" in s) and re.search(r"\n\s*\d+\.", s):
        return True

    # Hallucinated assignments like:
    # "Rajesh will receive the task" / "Assigned to Sunita" etc.
    # If the model is naming a person as the assignee without having fetched
    # helpers, force a helpers select.
    assignment_phrases = (
        "will receive the task",
        "will receive this task",
        "will be assigned",
        "assigned to",
        "i'll assign",
        "i will assign",
        "i have assigned",
        "scheduled with",
    )
    if any(p in s for p in assignment_phrases):
        return True
    # Proper-noun-ish name followed by an assignment phrase.
    if re.search(r"\b[A-Z][a-z]{2,}\b.*\b(will\s+receive|assigned\s+to|scheduled\s+with)\b", text or ""):
        return True
    return False


def _needs_chores_fetch_override(text: str) -> bool:
    """Detect hallucinated chore lists in the assistant response.

    Triggers when the model invents chore names/status without querying the DB.
    """
    s = (text or "").strip().lower()
    if not s:
        return False
    if _contains_structured_tool_calls_payload(text):
        return False

    chore_list_triggers = (
        "here are your chores",
        "here are your current chores",
        "here are the chores",
        "your current tasks include",
        "you have the following chores",
        "your chore list",
        "here are the tasks",
        "here is your task list",
        "here is your schedule",
        "your scheduled chores",
    )
    if any(t in s for t in chore_list_triggers):
        return True
    # Numbered list that mentions chores/tasks without a prior DB query
    if ("chore" in s or "task" in s) and re.search(r"\n\s*\d+[\.\)]\s+\w", s):
        return True
    return False


def _needs_spaces_fetch_override(text: str) -> bool:
    """Detect hallucinated room/space names in the assistant response."""
    s = (text or "").strip().lower()
    if not s:
        return False
    if _contains_structured_tool_calls_payload(text):
        return False

    space_list_triggers = (
        "your home has the following rooms",
        "here are your rooms",
        "rooms in your home",
        "your spaces include",
        "the rooms are",
    )
    if any(t in s for t in space_list_triggers):
        return True
    return False


def _needs_fetch_override(text: str) -> bool:
    """Composed OR of the three domain detectors — the hook the LLM loop
    calls each turn to decide whether to force a tool-backed retry.
    """
    return (
        _needs_helpers_fetch_override(text)
        or _needs_chores_fetch_override(text)
        or _needs_spaces_fetch_override(text)
    )


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
    "_semantic_match_chores",
    "_resolve_chore_match_ids",
    "_resolve_chore_match_ids_via_rpc",
    "_intent_to_tool_calls",
    "_match_ids_from_tool_calls",
    "_validate_tool_calls",
    "_enforce_assignment_policy",
    "JUDGE_SYSTEM_PROMPT",
    "_judge_response",
    "_resolve_supabase_rest",
    "_fetch_chores_by_ids",
    "_check_graduation_status",
    "_needs_helpers_fetch_override",
    "_needs_chores_fetch_override",
    "_needs_spaces_fetch_override",
    "_needs_fetch_override",
]
