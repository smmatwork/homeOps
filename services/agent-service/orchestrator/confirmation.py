"""Pending-confirmation branch — the "yes / no / freeform" reply handler.

When the previous turn stashed a PendingConfirmation (plan-preview, sync
follow-up, or clarification), the router calls `handle_pending_confirmation`
at the top of the next turn. The function either:

  - Returns a str — the final response text (router returns it)
  - Returns None — no pending (or user typed freeform); continue routing

Three branches internally, matching the pre-refactor chat_respond body:

  1. **Sync follow-up** (pending.sync_field is set). The previous turn updated
     title OR description and detected the other field is out of sync;
     pending.tool_calls is pre-built to mirror. Accept / cancel / freeform
     value.
  2. **Regular confirmation accept.** Execute pending.tool_calls, possibly
     stash a sync follow-up, format the execution result.
  3. **Regular confirmation cancel.** Increment clarification counter; if
     under MAX_CLARIFICATION_TURNS ask a clarifying question, else guide to
     the UI.

Anything else (freeform reply) → pending is discarded, counter cleared,
return None so the normal extraction flow can re-read the message.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Awaitable, Callable

from agents.chore_agent import _fetch_chores_by_ids, _format_execution_result
from orchestrator.intent import ExtractedIntent
from orchestrator.parsing import _ensure_tool_reason
from orchestrator.state import (
    MAX_CLARIFICATION_TURNS,
    clarification_counts as _clarification_counts,
    is_cancellation,
    is_confirmation,
    pending_confirmations as _pending_confirmations,
    stash_pending_confirmation as _stash_pending_confirmation,
    take_pending_confirmation as _take_pending_confirmation,
)


EdgeExecuteFn = Callable[..., Awaitable[Any]]
LfSpanFn = Callable[..., None]


async def _execute_tool_calls(
    tool_calls: list[dict[str, Any]],
    *,
    household_id: str,
    user_id: str,
    edge_execute_tools: EdgeExecuteFn,
    reason_prefix: str,
) -> tuple[int, list[dict[str, Any]]]:
    """Execute a list of tool calls and return (update_count, raw_results)."""
    results_local: list[dict[str, Any]] = []
    if not (household_id and user_id):
        return 0, results_local
    for tc in tool_calls:
        tc = _ensure_tool_reason(tc, reason_prefix)
        try:
            out = await edge_execute_tools(
                {"household_id": household_id, "tool_call": tc},
                user_id=user_id,
            )
        except Exception as e:
            out = {"ok": False, "error": str(e), "tool_call_id": tc.get("id")}
        results_local.append(out)
    update_count_local = sum(
        1 for tc, r in zip(tool_calls, results_local)
        if isinstance(tc, dict) and isinstance(r, dict)
        and tc.get("tool") == "db.update" and r.get("ok")
    )
    return update_count_local, results_local


async def _maybe_stash_sync_followup(
    *,
    executed_intent: ExtractedIntent,
    updated_match_ids: list[tuple[str, str]],
    pending_key: str,
    household_id: str,
) -> str | None:
    """After a successful description/title update, see if a sync follow-up
    should be offered. Returns a sync-prompt string if yes (and stashes new
    pending state), or None to skip.
    """
    if executed_intent.update_field not in ("description", "title"):
        return None
    if executed_intent.update_value is None:
        return None
    if not pending_key or not updated_match_ids:
        return None

    other_field = "title" if executed_intent.update_field == "description" else "description"
    chore_ids = [cid for cid, _t in updated_match_ids]
    current = await _fetch_chores_by_ids(household_id, chore_ids)
    if not current:
        return None

    mismatched = [
        row for row in current
        if (row.get("title") or "").strip().lower()
        != (row.get("description") or "").strip().lower()
    ]
    if not mismatched:
        # title and description already match for every updated chore.
        return None

    # Build precomputed mirror tool_calls so a "yes" reply executes immediately.
    # Freeform replies build their own tool_calls at confirmation time using
    # sync_chore_ids + sync_field.
    new_value = executed_intent.update_value
    mirror_tcs: list[dict[str, Any]] = []
    for row in mismatched:
        cid = row.get("id") or ""
        if not cid:
            continue
        mirror_tcs.append({
            "id": f"tc_sync_{uuid.uuid4().hex[:8]}",
            "tool": "db.update",
            "args": {
                "table": "chores",
                "id": cid,
                "patch": {other_field: new_value},
            },
            "reason": f"sync: mirror {other_field} on '{row.get('title') or cid[:8]}'",
        })

    sync_chore_ids = [row.get("id") or "" for row in mismatched if row.get("id")]
    sync_match_ids = [(row.get("id") or "", row.get("title") or "") for row in mismatched]
    await _stash_pending_confirmation(
        conversation_id=pending_key,
        intent=executed_intent,
        match_ids=sync_match_ids,
        tool_calls=mirror_tcs,
    )
    # Patch sync-followup metadata onto the just-stashed row. For the
    # in-process backend this mutates the dict entry; for the Supabase
    # backend we re-stash with the extended shape (a second round trip
    # is acceptable — this path only fires once per update).
    stashed = _pending_confirmations.get(pending_key)
    if stashed is not None:
        stashed.sync_field = other_field
        stashed.sync_chore_ids = sync_chore_ids
        stashed.sync_default_value = new_value

    count = len(mismatched)
    example = mismatched[0]
    current_other = (example.get(other_field) or "").strip() or "(empty)"
    if count == 1:
        head = (
            f"Done! Updated the {executed_intent.update_field} to \"{new_value}\".\n\n"
            f"The {other_field} is currently \"{current_other}\". "
            f"Want me to also set the {other_field} to \"{new_value}\"?"
        )
    else:
        head = (
            f"Done! Updated the {executed_intent.update_field} of {count} chore(s) "
            f"to \"{new_value}\".\n\n"
            f"Their {other_field}s are still mixed (e.g. \"{current_other}\"). "
            f"Want me to also set the {other_field} to \"{new_value}\" for all {count}?"
        )
    return head + (
        f"\n\nReply **yes** to mirror, **no** to keep the {other_field} as-is, "
        f"or paste a different {other_field} to use that instead."
    )


async def handle_pending_confirmation(
    *,
    pending_key: str,
    last_user: str,
    conv_id: str,
    user_id: str,
    household_id: str,
    facts_section: str,
    edge_execute_tools: EdgeExecuteFn,
    lf_span: LfSpanFn,
) -> str | None:
    """Handle a pending-confirmation reply. Returns final response text or
    None (caller should continue routing).

    Three outcomes:
      - No pending stashed → returns None.
      - Sync follow-up / accept / cancel → consumes the pending, returns text.
      - Freeform reply → pending is discarded here, clarification counter
        reset, caller should run the normal extraction flow on the message.
    """
    if not (pending_key and last_user):
        return None

    pending = await _take_pending_confirmation(pending_key)
    if pending is None:
        return None

    # ── Branch 1: this pending is a SYNC FOLLOWUP ──
    if pending.sync_field is not None:
        other_field = pending.sync_field
        if is_cancellation(last_user):
            lf_span("orchestrator.sync.cancelled", input={"count": len(pending.match_ids)})
            return f"Okay, leaving the {other_field} as-is."

        if is_confirmation(last_user):
            lf_span("orchestrator.sync.accepted", input={"count": len(pending.match_ids)})
            sync_count, _ = await _execute_tool_calls(
                pending.tool_calls,
                household_id=household_id,
                user_id=user_id,
                edge_execute_tools=edge_execute_tools,
                reason_prefix=f"Sync mirror to {other_field}",
            )
            if sync_count > 0:
                return f"Done! Also updated the {other_field} of {sync_count} chore(s) to \"{pending.sync_default_value}\"."
            return f"I tried to mirror the {other_field} but nothing changed."

        # Freeform reply → use it as the new value for sync_field.
        free_value = last_user.strip().strip('"').strip("'")
        if not free_value or not pending.sync_chore_ids:
            return f"Okay, leaving the {other_field} as-is."
        free_tcs: list[dict[str, Any]] = []
        for cid in pending.sync_chore_ids:
            free_tcs.append({
                "id": f"tc_sync_free_{uuid.uuid4().hex[:8]}",
                "tool": "db.update",
                "args": {
                    "table": "chores",
                    "id": cid,
                    "patch": {other_field: free_value},
                },
                "reason": f"sync (freeform): set {other_field} on chore {cid[:8]}",
            })
        free_count, _ = await _execute_tool_calls(
            free_tcs,
            household_id=household_id,
            user_id=user_id,
            edge_execute_tools=edge_execute_tools,
            reason_prefix=f"Sync freeform {other_field}",
        )
        if free_count > 0:
            return f"Done! Updated the {other_field} of {free_count} chore(s) to \"{free_value}\"."
        return f"I tried to set the {other_field} but nothing changed."

    # ── Branch 2: regular update/plan confirmation ──
    if is_confirmation(last_user):
        lf_span("orchestrator.confirmation.accepted", input={"count": len(pending.tool_calls)})
        # Reset clarification counter on success
        _clarification_counts.pop(pending_key or conv_id or "", None)

        # Execute ALL stashed tool calls (db.update + query.rpc)
        results: list[dict[str, Any]] = []
        for tc in pending.tool_calls:
            tc = _ensure_tool_reason(tc, f"Confirmed: {pending.intent.action}")
            try:
                out = await edge_execute_tools(
                    {"household_id": household_id, "tool_call": tc},
                    user_id=user_id,
                )
            except Exception as e:
                out = {"ok": False, "error": str(e), "tool_call_id": tc.get("id")}
            results.append(out)

        all_ok = all(r.get("ok") for r in results)
        if not all_ok and not any(r.get("ok") for r in results):
            for i, r in enumerate(results):
                logging.warning(f"confirmation.execute result[{i}]: ok={r.get('ok')} error={r.get('error', 'none')}")
            errors = [str(r.get("error", "")) for r in results if not r.get("ok") and r.get("error")]
            err_hint = errors[0][:100] if errors else ""
            if "unsupported" in err_hint.lower() or "not allowed" in err_hint.lower():
                return (
                    "I wasn't able to complete that action — it's not supported through chat yet. "
                    "You can do this from the app directly."
                )
            return (
                "Something went wrong while applying the changes. Please try again, "
                "or make the change directly from the app."
            )

        # Try sync follow-up for single-intent updates
        if len(pending.tool_calls) <= 5:
            sync_prompt = await _maybe_stash_sync_followup(
                executed_intent=pending.intent,
                updated_match_ids=pending.match_ids,
                pending_key=pending_key,
                household_id=household_id,
            )
            if sync_prompt:
                return sync_prompt

        return _format_execution_result(
            results, pending.tool_calls, [pending.intent], pending.intent, facts=facts_section
        )

    if is_cancellation(last_user):
        lf_span("orchestrator.confirmation.cancelled", input={"count": len(pending.match_ids)})

        # Track clarification turns — ask follow-ups before giving up
        clar_key = pending_key or conv_id or ""
        turn = _clarification_counts.get(clar_key, 0) + 1
        _clarification_counts[clar_key] = turn

        if turn >= MAX_CLARIFICATION_TURNS:
            # Exhausted clarification budget — guide to UI
            _clarification_counts.pop(clar_key, None)
            return (
                "No worries — it seems like this might be easier to do visually. "
                "You can:\n\n"
                "- **Reassign chores**: Go to **Chores → Coverage → Utilization → Optimize workload**\n"
                "- **Change frequency**: Same page, use the **Reduce Frequency** step\n"
                "- **Assign by specialty or floor**: Click the **Assign** button on the Dashboard\n\n"
                "Or tell me exactly what you'd like — e.g., *\"assign kitchen sweep to Roopa\"* or *\"make bathroom mopping weekly\"*."
            )

        # Build a clarifying question based on the original intent
        intent_desc = pending.intent.action.replace("_", " ")
        target = pending.intent.match_text or "those chores"
        return (
            f"Got it, I won't {intent_desc} {target} yet. "
            f"Could you help me understand what you'd like instead?\n\n"
            f"For example:\n"
            f"- Which specific chores or rooms should be affected?\n"
            f"- Which helper should handle them?\n"
            f"- What frequency works best (daily, weekly, etc.)?"
        )

    # Any other freeform message — the user is clarifying further.
    # Reset clarification counter since they're engaging, and let the message
    # flow through normal intent extraction in the caller.
    clar_key2 = pending_key or conv_id or ""
    _clarification_counts.pop(clar_key2, None)
    lf_span("orchestrator.confirmation.discarded_freeform", input={"count": len(pending.match_ids)})
    return None


__all__ = ["handle_pending_confirmation"]
