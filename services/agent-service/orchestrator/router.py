"""Top-level orchestrator router.

Owns the per-turn dispatch sequence for `/v1/chat/respond`. A user message
flows through the phases in strict order — the first phase that produces a
final response wins; anything "None" or "defer" falls through to the next:

    1. Pending confirmation               (orchestrator.confirmation)
    2. ChoreAgent analytics shortcut      (agents.chore_agent)
    3. Helper agent routing               (agents.helper_agent, if helper_intent)
    4. apply_chore_assignments shortcut   (orchestrator.prompting)
    5. ChoreAgent deterministic action    (6b assign/complete/reassign)
    6. Schedule/space clarification       (orchestrator.prompting)
    7. Prompt-builder augmentation        (orchestrator.prompt_builder)
    8. ChoreAgent 6d structured extraction (plan-confirm-execute)
    9. Main LLM orchestrator loop          (orchestrator.llm_loop)

All infra (chat_fn, edge_execute_tools, judge_fn, etc.) is injected so this
module has no import dependency on main.py — keeps the test-patch plumbing
that runs through `agent_main._sarvam_chat` / `_edge_execute_tools` intact.

The `chat_respond` FastAPI endpoint stays in main.py and is a thin wrapper
around this router; it handles auth, headers, langfuse/otel trace setup,
and the two langfuse callbacks (_lf_span / _lf_return) that the router
expects.
"""

from __future__ import annotations

import json
import os
from typing import Any, Awaitable, Callable

from agents import AgentContext
from orchestrator.confirmation import handle_pending_confirmation
from orchestrator.llm_loop import run_llm_loop
from orchestrator.parsing import _deterministic_trim_chain_of_thought
from orchestrator.prompt_builder import build_system_prompt_augmentation
from orchestrator.prompting import handle_apply_assignments, handle_schedule_and_space


ChatFn = Callable[..., Awaitable[Any]]
EdgeExecuteFn = Callable[..., Awaitable[Any]]
JudgeFn = Callable[..., Awaitable[dict[str, Any]]]
SummarizeFn = Callable[..., Awaitable[list[dict[str, str]]]]
IntentToToolCallsFn = Callable[..., Awaitable[Any]]
NeedsFetchOverrideFn = Callable[[str], bool]
LfSpanFn = Callable[..., None]
LfReturnFn = Callable[[dict[str, Any]], dict[str, Any]]
GetChoreAgentFn = Callable[[], Any]
GetHelperAgentFn = Callable[[], Any]


async def route_chat_turn(
    *,
    messages: list[dict[str, Any]],
    model: str,
    temperature: float | int | None,
    max_tokens: int | None,
    req_id: str,
    conv_id: str,
    sess_id: str,
    user_id: str,
    household_id: str,
    # Langfuse handles
    lf_span: LfSpanFn,
    lf_return: LfReturnFn,
    # Injected agent deps
    get_chore_agent: GetChoreAgentFn,
    get_helper_agent: GetHelperAgentFn,
    # Injected infra
    chat_fn: ChatFn,
    edge_execute_tools: EdgeExecuteFn,
    judge_fn: JudgeFn,
    summarize_history: SummarizeFn,
    intent_to_tool_calls_fn: IntentToToolCallsFn,
    needs_fetch_override: NeedsFetchOverrideFn,
) -> dict[str, Any]:
    """Run one conversational turn through all orchestrator phases.

    Returns the `{"ok": True, "text": str}` response dict (already wrapped
    by `lf_return` so Langfuse completion telemetry is flushed).
    """
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break

    # Derive pending_key early — every subsequent phase that reads/writes
    # stashed conversation state keys on it.
    pending_key = conv_id or (
        f"fallback:{user_id}:{household_id}" if user_id and household_id else ""
    )

    # facts_section is empty at this point; build_system_prompt_augmentation
    # fills it in later. The confirmation handler only formats execution
    # results when there's a pending confirmation, and the formatter's
    # facts-based no-match fallback degrades gracefully on empty input.
    facts_section = ""

    # ── Phase 1: pending confirmation ──
    pending_response = await handle_pending_confirmation(
        pending_key=pending_key,
        last_user=last_user,
        conv_id=conv_id,
        user_id=user_id,
        household_id=household_id,
        facts_section=facts_section,
        edge_execute_tools=edge_execute_tools,
        lf_span=lf_span,
    )
    if pending_response is not None:
        return lf_return({"ok": True, "text": pending_response})

    # Detect onboarding mode early — skip helper-agent routing entirely.
    early_onboarding = False
    if messages and isinstance(messages[0], dict):
        sys0 = str(messages[0].get("content") or "")
        early_onboarding = "ONBOARDING FLOW" in sys0

    helper_intent = False if early_onboarding else get_helper_agent().is_intent(messages)
    lf_span(
        "orchestrator.intent_route",
        input={"last_user": last_user[:600], "onboarding": early_onboarding},
        output={"helper_intent": bool(helper_intent)},
    )

    try:
        dbg_raw = (os.environ.get("DEBUG_INTENT_ROUTING") or "").strip().lower()
        if dbg_raw in {"1", "true", "yes", "y", "on"}:
            print(
                "intent_routing_debug",
                json.dumps(
                    {
                        "request_id": req_id,
                        "conversation_id": conv_id,
                        "session_id": sess_id,
                        "helper_intent": helper_intent,
                        "last_user": last_user,
                    },
                    ensure_ascii=False,
                ),
            )
    except Exception:
        pass

    # ── Phase 2: ChoreAgent analytics shortcut ──
    chore_ctx = AgentContext(
        messages=messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        req_id=req_id,
        conv_id=conv_id,
        sess_id=sess_id,
        user_id=user_id,
        household_id=household_id,
        pending_key=pending_key,
        last_user_text=last_user,
        facts_section=facts_section,
        is_onboarding=early_onboarding,
        chat_fn=chat_fn,
        edge_execute_tools=edge_execute_tools,
        lf_span=lf_span,
    )
    chore_result = await get_chore_agent().try_analytics_shortcut(chore_ctx)
    if chore_result.kind != "defer":
        lf_span(
            "orchestrator.deterministic.chore_agent_shortcut",
            output={"agent_result_kind": chore_result.kind},
        )
        return lf_return({"ok": True, "text": chore_result.text or ""})

    # ── Phase 3: helper agent ──
    if helper_intent:
        lf_span("orchestrator.route.helper_agent", output={"routed": True})
        helper = await get_helper_agent().run(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        if helper is None:
            return lf_return({"ok": True, "text": "I can help manage helpers. What exactly would you like to do?"})

        clarifications = helper.get("clarifications")
        tool_calls = helper.get("tool_calls")
        user_summary = str(helper.get("user_summary") or "").strip()

        if isinstance(clarifications, list) and clarifications:
            lines: list[str] = []
            for c in clarifications:
                if not isinstance(c, dict):
                    continue
                q = c.get("question")
                if isinstance(q, str) and q.strip():
                    lines.append(f"- {_deterministic_trim_chain_of_thought(q).strip()}")
                opts = c.get("options")
                if isinstance(opts, list) and opts:
                    opts_clean = [str(o).strip() for o in opts if isinstance(o, str) and str(o).strip()]
                    if opts_clean:
                        lines.append("  Options: " + ", ".join(opts_clean))
            return lf_return({
                "ok": True,
                "text": _deterministic_trim_chain_of_thought("\n".join(lines).strip()) or "What would you like to do?",
            })

        if isinstance(tool_calls, list) and tool_calls:
            payload = {"tool_calls": tool_calls}
            return lf_return({
                "ok": True,
                "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```",
            })

        safe_summary = _deterministic_trim_chain_of_thought(user_summary or "")
        return lf_return({"ok": True, "text": safe_summary or "What would you like to do?"})

    # ── Phase 4-6: apply_chore_assignments / deterministic action / schedule-space ──
    latest_user_text = ""
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            latest_user_text = str(m.get("content") or "").strip()
            break

    apply_resp = handle_apply_assignments(messages, latest_user_text, lf_span=lf_span)
    if apply_resp is not None:
        return lf_return({"ok": True, "text": apply_resp})

    # ChoreAgent Phase 6b deterministic action (assign/complete/reassign regex).
    # Rebuild ctx because last_user_text differs from `last_user` used above.
    chore_ctx_b = AgentContext(
        messages=messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        req_id=req_id,
        conv_id=conv_id,
        sess_id=sess_id,
        user_id=user_id,
        household_id=household_id,
        pending_key=pending_key,
        last_user_text=latest_user_text,
        facts_section=facts_section,
        is_onboarding=early_onboarding,
        chat_fn=chat_fn,
        edge_execute_tools=edge_execute_tools,
        lf_span=lf_span,
    )
    chore_action = await get_chore_agent().try_deterministic_action(chore_ctx_b)
    if chore_action.kind != "defer":
        lf_span(
            "orchestrator.deterministic.chore_agent_action",
            output={"agent_result_kind": chore_action.kind},
        )
        return lf_return({"ok": True, "text": chore_action.text or ""})

    schedule_resp = handle_schedule_and_space(messages, latest_user_text)
    if schedule_resp is not None:
        return lf_return({"ok": True, "text": schedule_resp})

    # ── Phase 7: system-prompt augmentation (FACTS + intent + strict contract) ──
    is_onboarding = False
    if messages and isinstance(messages[0], dict):
        sys_content = str(messages[0].get("content") or "")
        is_onboarding = "ONBOARDING FLOW" in sys_content

    # Recompute last_user_text from the (possibly mutated) messages so the
    # structured-extraction + LLM loop see the same string.
    last_user_text = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user_text = str(m["content"]).strip()
            break

    messages, facts_section, intent_label = await build_system_prompt_augmentation(
        messages,
        household_id=household_id,
        user_id=user_id,
        last_user_text=last_user_text,
        is_onboarding=is_onboarding,
    )

    lf_span(
        "orchestrator.hardening",
        input={"intent": intent_label, "facts_len": len(facts_section)},
    )

    # ── Phase 8: ChoreAgent 6d structured extraction + plan-confirm-execute ──
    ctx_6d = AgentContext(
        messages=messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        req_id=req_id,
        conv_id=conv_id,
        sess_id=sess_id,
        user_id=user_id,
        household_id=household_id,
        pending_key=pending_key,
        last_user_text=last_user_text,
        facts_section=facts_section,
        is_onboarding=is_onboarding,
        chat_fn=chat_fn,
        edge_execute_tools=edge_execute_tools,
        lf_span=lf_span,
    )
    result_6d = await get_chore_agent().try_structured_extraction_flow(
        ctx_6d,
        intent_to_tool_calls_fn=intent_to_tool_calls_fn,
    )
    if result_6d.kind == "text":
        return lf_return({"ok": True, "text": result_6d.text or ""})

    # ── Phase 9: main LLM orchestrator loop ──
    final_text = await run_llm_loop(
        messages=messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        conv_id=conv_id,
        user_id=user_id,
        household_id=household_id,
        last_user_text=last_user_text,
        facts_section=facts_section,
        chat_fn=chat_fn,
        edge_execute_tools=edge_execute_tools,
        judge_fn=judge_fn,
        summarize_history=summarize_history,
        needs_fetch_override=needs_fetch_override,
        lf_span=lf_span,
    )
    return lf_return({"ok": True, "text": final_text})


__all__ = ["route_chat_turn"]
