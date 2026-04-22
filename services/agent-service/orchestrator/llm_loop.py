"""Main LLM orchestrator loop — the manager pattern.

Everything from "prompt augmentation is done" through "final_text to return"
lives here. Owns:

  1. `_orchestrator_once` inner helper — summarize → Sarvam chat → strict parse
  2. Initial LLM call + parse/repair/regen safety net
  3. If kind=="tool_calls": validate IDs, enforce policy, execute via edge,
     run a followup LLM turn with tool_results, run LLM-as-Judge, possibly
     re-run under a correction prompt, return final_text.
  4. If kind=="final_text": hallucination override (detect invented lists
     and force a tool-backed retry), schedule/bath clarification guardrail,
     "never claim write" guardrail, LLM-as-Judge on direct final text
     (fatal/intent_mismatch → guidance; correctable → re-run), empty-text
     fallback.

External deps are injected (chat_fn, edge_execute_tools, judge_fn,
summarize_history_fn, needs_fetch_override_fn, lf_span) so this module has
no back-edge into main.py and test patches on main's module-level names
still flow through the thin shim the router keeps.
"""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

from agents.chore_agent import _enforce_assignment_policy, _validate_tool_calls
from orchestrator.parsing import (
    _deterministic_trim_chain_of_thought,
    _ensure_tool_reason,
    _parse_strict_llm_payload,
)


ChatFn = Callable[..., Awaitable[Any]]
EdgeExecuteFn = Callable[..., Awaitable[Any]]
JudgeFn = Callable[..., Awaitable[dict[str, Any]]]
SummarizeFn = Callable[..., Awaitable[list[dict[str, str]]]]
NeedsFetchOverrideFn = Callable[[str], bool]
LfSpanFn = Callable[..., None]


REPAIR_SYSTEM_PROMPT = (
    "Convert the input into ONLY a single JSON object that matches one of:\n"
    "1) {\"final_text\": <string>}\n"
    "2) {\"tool_calls\": [ {\"id\": <string>, \"tool\": \"db.select\"|\"db.insert\"|\"db.update\"|\"db.delete\"|\"query.rpc\", \"args\": <object>, \"reason\": <string optional>} ] }\n"
    "Tool call args MUST follow these shapes:\n"
    "- db.select: {\"table\": <string>, \"columns\": <string or array>, \"where\": <object optional>, \"limit\": <number optional>}\n"
    "- db.insert: {\"table\": <string>, \"record\": <object>}\n"
    "- db.update: {\"table\": <string>, \"id\": <string>, \"patch\": <object>}\n"
    "- db.delete: {\"table\": <string>, \"id\": <string>}\n"
    "- query.rpc: {\"name\": <string>, \"params\": <object optional>}\n"
    "For chores, always insert into table=\"chores\" with record={...}.\n"
    "Return VALID JSON ONLY (no markdown fences, no extra text).\n"
    "Example: {\"final_text\": \"Created the chore for Monday 1:30pm.\"}"
)


def _extract_known_entity_ids(
    facts_section: str,
) -> tuple[set[str], set[str], set[str]]:
    """Walk the FACTS section once and bucket `id=<uuid>` tokens into
    (chores, helpers, people) sets, so _validate_tool_calls can confirm
    the LLM isn't referencing invented IDs.

    Uses the section headers (Helpers / Chores / People / Spaces) as the
    bucketing signal; IDs outside those sections are added to chores +
    helpers as a conservative fallback so a hallucinated ID still trips.
    """
    known_chore_ids: set[str] = set()
    known_helper_ids: set[str] = set()
    known_person_ids: set[str] = set()
    current_section = ""
    for line in (facts_section or "").split("\n"):
        if line.startswith("Helpers"):
            current_section = "helpers"
        elif line.startswith("Chores"):
            current_section = "chores"
        elif line.startswith("People"):
            current_section = "people"
        elif line.startswith("Spaces"):
            current_section = "spaces"
        for m_id in re.findall(r"\bid=([0-9a-f-]{36})\b", line):
            if current_section == "chores":
                known_chore_ids.add(m_id)
            elif current_section == "helpers":
                known_helper_ids.add(m_id)
            elif current_section == "people":
                known_person_ids.add(m_id)
            else:
                known_chore_ids.add(m_id)
                known_helper_ids.add(m_id)
    return known_chore_ids, known_helper_ids, known_person_ids


async def run_llm_loop(
    *,
    messages: list[dict[str, Any]],
    model: str,
    temperature: float | int | None,
    max_tokens: int | None,
    conv_id: str,
    user_id: str,
    household_id: str,
    last_user_text: str,
    facts_section: str,
    chat_fn: ChatFn,
    edge_execute_tools: EdgeExecuteFn,
    judge_fn: JudgeFn,
    summarize_history: SummarizeFn,
    needs_fetch_override: NeedsFetchOverrideFn,
    lf_span: LfSpanFn,
) -> str:
    """Run the main LLM orchestrator manager loop and return the final text.

    Returns a str (never None). Callers wrap with `{"ok": True, "text": ...}`
    and the Langfuse completion update.
    """
    async def _orchestrator_once(orchestrator_messages: list[dict[str, Any]]) -> dict[str, Any]:
        safe_msgs: list[dict[str, str]] = []
        for m in orchestrator_messages or []:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            content = m.get("content")
            if isinstance(role, str) and isinstance(content, str):
                safe_msgs.append({"role": role, "content": content})

        safe_msgs = await summarize_history(
            safe_msgs, conversation_id=conv_id, model=model,
        )

        raw = await chat_fn(
            messages=safe_msgs,
            model=model,
            temperature=float(temperature) if isinstance(temperature, (int, float)) else 0.0,
            max_tokens=int(max_tokens) if isinstance(max_tokens, int) else 900,
        )
        parsed_local = _parse_strict_llm_payload(raw)
        if parsed_local is None:
            cleaned = _deterministic_trim_chain_of_thought(raw or "").strip()
            return {"kind": "final_text", "final_text": cleaned}
        return parsed_local

    # ── Initial LLM call ──
    sarvam_messages: list[dict[str, str]] = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if isinstance(role, str) and isinstance(content, str):
            sarvam_messages.append({"role": role, "content": content})

    # Compress old turns via rolling summary before sending. The truncator
    # inside chat_fn is the safety net if we're still over.
    sarvam_messages = await summarize_history(
        sarvam_messages, conversation_id=conv_id, model=model,
    )

    text = await chat_fn(
        messages=sarvam_messages,
        model=model,
        temperature=float(temperature) if isinstance(temperature, (int, float)) else 0.0,
        max_tokens=int(max_tokens) if isinstance(max_tokens, int) else 900,
    )

    try:
        lf_span(
            "orchestrator.llm.chat",
            input={
                "model": model,
                "temperature": float(temperature) if isinstance(temperature, (int, float)) else 0.0,
                "max_tokens": int(max_tokens) if isinstance(max_tokens, int) else 900,
                "message_count": len(messages or []),
            },
            output={"response_len": len(text) if isinstance(text, str) else None},
        )
    except Exception:
        pass

    if isinstance(text, str):
        print("strict_schema_llm_raw", {"len": len(text), "prefix": text[:240]})

    parsed = _parse_strict_llm_payload(text)
    if parsed is None:
        print("strict_schema_parse_failed", {"stage": "initial"})
        # Repair once: ask the model to convert its output into the strict JSON schema.
        try:
            repair = await chat_fn(
                messages=[
                    {"role": "system", "content": REPAIR_SYSTEM_PROMPT},
                    {"role": "user", "content": text},
                ],
                model=model,
                temperature=0.0,
                max_tokens=min(int(max_tokens or 512), 512),
            )
            parsed = _parse_strict_llm_payload(repair)
            if isinstance(repair, str):
                print("strict_schema_llm_repair_raw", {"len": len(repair), "prefix": repair[:240]})
            if parsed is None:
                print("strict_schema_parse_failed", {"stage": "repair"})
        except Exception:
            parsed = None

    if parsed is None:
        # Regenerate once using the full conversation under the strict contract.
        # More reliable than attempting to "repair" an already-bad output.
        try:
            regen = await chat_fn(
                messages=messages,
                model=model,
                temperature=0.0,
                max_tokens=min(int(max_tokens or 512), 512),
            )
            parsed = _parse_strict_llm_payload(regen)
            if isinstance(regen, str):
                print("strict_schema_llm_regen_raw", {"len": len(regen), "prefix": regen[:240]})
            if parsed is None:
                print("strict_schema_parse_failed", {"stage": "regen"})
        except Exception:
            parsed = None

    if parsed is None:
        # Deterministic safe fallback with no invented entities.
        return "I can help with that. What date and time should I use?"

    # ── Branch A: tool_calls → validate, execute, followup, judge ──
    if parsed.get("kind") == "tool_calls":
        tool_calls = parsed.get("tool_calls")
        if not isinstance(tool_calls, list) or not tool_calls:
            return "I couldn't determine the next step. Please rephrase your request."

        if not household_id:
            return "I need your household context to run database tools. Please reconnect your home and try again."
        if not user_id:
            return "I need your user context to run database tools. Please reconnect your home and try again."

        known_chore_ids, known_helper_ids, known_person_ids = _extract_known_entity_ids(facts_section)

        # Policy enforcement: check assignment rules before execution
        policy_warnings = _enforce_assignment_policy(tool_calls, facts_section)
        if policy_warnings:
            lf_span("orchestrator.policy.warnings", output={"warnings": policy_warnings})
            hard_violations = [w for w in policy_warnings if "Cannot assign" in w]
            if hard_violations:
                return hard_violations[0]

        validation_errors = _validate_tool_calls(
            tool_calls, known_chore_ids, known_helper_ids, known_person_ids,
        )
        if validation_errors:
            lf_span("orchestrator.validation.failed", output={"errors": validation_errors})
            # Invalid IDs → ask the LLM to retry after a db.select.
            retry_msg = (
                f"Your tool calls reference IDs that don't exist: {'; '.join(validation_errors)}. "
                f"Please use db.select first to find the correct record ID, then retry the operation."
            )
            retry_messages = list(sarvam_messages) + [
                {"role": "assistant", "content": json.dumps({"tool_calls": tool_calls})},
                {"role": "user", "content": retry_msg},
            ]
            parsed_retry = await _orchestrator_once(retry_messages)
            if parsed_retry.get("kind") == "tool_calls":
                tool_calls = parsed_retry.get("tool_calls", tool_calls)
            elif parsed_retry.get("kind") == "final_text":
                return str(parsed_retry.get("final_text", ""))

        lf_span("orchestrator.tools.execute", input={"tool_calls": tool_calls})
        results: list[dict[str, Any]] = []
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            tool_name = str(tc.get("tool") or "").strip()
            tc = _ensure_tool_reason(tc, f"Execute {tool_name or 'tool'}.")
            one_payload = {"household_id": household_id, "tool_call": tc}
            try:
                out = await edge_execute_tools(one_payload, user_id=user_id)
            except Exception as e:
                out = {"ok": False, "error": str(e), "tool_call_id": tc.get("id")}
            results.append(out)
        tool_results = {"results": results}
        lf_span("orchestrator.tools.results", output={"results": tool_results})

        followup_messages = list(sarvam_messages)
        followup_messages.append(
            {
                "role": "user",
                "content": (
                    "TOOL_RESULTS_JSON:\n"
                    + json.dumps(tool_results, ensure_ascii=False)
                    + "\n\n"
                    + "Using the TOOL_RESULTS_JSON above, answer the user's request. "
                    + "Return ONLY a single JSON object: {\"final_text\": <string>} and nothing else."
                ),
            }
        )

        parsed2 = await _orchestrator_once(followup_messages)
        final_text2 = _deterministic_trim_chain_of_thought(str(parsed2.get("final_text") or "").strip())
        if not final_text2:
            final_text2 = "I executed the database queries but couldn't format the answer. Please try again."

        # LLM-as-Judge on post-tool final text
        try:
            judge = await judge_fn(last_user_text, final_text2, model, facts_section)
            lf_span("orchestrator.judge", output=judge)
            if not judge.get("pass", True):
                correction = str(judge.get("correction", "")).strip()
                reason = str(judge.get("reason", "")).strip()
                correction_messages = list(followup_messages) + [
                    {"role": "assistant", "content": final_text2},
                    {"role": "user", "content": (
                        f"QUALITY CHECK FAILED: {reason}\n"
                        f"Correction needed: {correction}\n"
                        f"Please provide a corrected response that accurately addresses the user's original request."
                    )},
                ]
                parsed_corrected = await _orchestrator_once(correction_messages)
                corrected_text = _deterministic_trim_chain_of_thought(str(parsed_corrected.get("final_text") or "").strip())
                if corrected_text:
                    final_text2 = corrected_text
        except Exception:
            pass  # Judge failure should not block the response.

        return final_text2

    # ── Branch B: final_text → hallucination override, guardrails, judge ──
    final_text = _deterministic_trim_chain_of_thought(str(parsed.get("final_text") or "").strip())

    if needs_fetch_override(final_text):
        lf_span("orchestrator.hallucination_override.triggered", output={"final_text_snippet": final_text[:200]})
        retry_messages = list(sarvam_messages) + [
            {"role": "assistant", "content": final_text},
            {"role": "user", "content": (
                "SYSTEM: Your response appears to contain invented data (helper names, chore lists, "
                "or room names) that didn't come from the database. Do NOT invent data. "
                "Use db.select or query.rpc to fetch real data first, then answer."
            )},
        ]
        parsed_override = await _orchestrator_once(retry_messages)
        if parsed_override.get("kind") == "tool_calls":
            tool_calls_override = parsed_override.get("tool_calls", [])
            if isinstance(tool_calls_override, list) and tool_calls_override and household_id:
                override_results: list[dict[str, Any]] = []
                for tc in tool_calls_override:
                    if not isinstance(tc, dict):
                        continue
                    tc = _ensure_tool_reason(tc, "Hallucination override — fetching real data.")
                    try:
                        out = await edge_execute_tools({"household_id": household_id, "tool_call": tc}, user_id=user_id)
                    except Exception as e_ovr:
                        out = {"ok": False, "error": str(e_ovr)}
                    override_results.append(out)
                followup = list(retry_messages) + [
                    {"role": "user", "content": (
                        "TOOL_RESULTS_JSON:\n"
                        + json.dumps({"results": override_results}, ensure_ascii=False)
                        + "\n\nUsing the real data above, answer the user. Return {\"final_text\": ...}."
                    )},
                ]
                parsed_followup = await _orchestrator_once(followup)
                corrected = _deterministic_trim_chain_of_thought(str(parsed_followup.get("final_text", "")).strip())
                if corrected:
                    return corrected
        elif parsed_override.get("kind") == "final_text":
            corrected = _deterministic_trim_chain_of_thought(str(parsed_override.get("final_text", "")).strip())
            if corrected:
                final_text = corrected

    # Guardrail: never claim a DB write happened unless we emitted tool_calls.
    last_user = ""
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    lower_user = last_user.lower()
    wants_schedule = bool(re.search(r"\b(schedule|book|plan|set\s*(up)?)\b", lower_user))
    mentions_bath = bool(re.search(r"\b(bath(room)?|washroom|restroom|toilet|powder\s*room)\b", lower_user))
    mentions_chore = bool(re.search(r"\b(chore|task|clean|deep\s*clean|cleanup)\b", lower_user))

    if wants_schedule and (mentions_chore or mentions_bath):
        if not re.search(r"\b\d{1,2}:\d{2}\b", lower_user) and not re.search(r"\b\d{4}-\d{2}-\d{2}\b", lower_user):
            return "What date and time should I use?"
        return "I can schedule this. Please confirm the exact bathrooms (or say 'all bathrooms') and the date/time."

    if re.search(r"\b(scheduled|created|updated|deleted)\b", final_text.lower()):
        return "I can do that, but I need your confirmation. Should I proceed?"

    # LLM-as-Judge on direct final text
    try:
        judge = await judge_fn(last_user_text, final_text, model, facts_section)
        failure_type = str(judge.get("failure_type") or "")
        severity = str(judge.get("severity") or "")
        lf_span("orchestrator.judge.direct", output={**judge, "failure_type": failure_type, "severity": severity})
        if not judge.get("pass", True):
            correction = str(judge.get("correction", "")).strip()
            reason = str(judge.get("reason", "")).strip()

            # Fatal or intent_mismatch — return guidance directly (don't re-run
            # through the LLM, which treats correction prompts as user questions)
            if severity == "fatal" or failure_type == "intent_mismatch":
                guidance = correction or reason
                if not guidance or "quality check" in guidance.lower():
                    guidance = (
                        "I wasn't able to do that directly. Could you rephrase your request? "
                        "For example: \"assign bathroom mopping to Roopa\" or \"make guest bathroom chores weekly\".\n\n"
                        "For bulk changes, go to **Chores → Coverage → Utilization → Optimize workload**."
                    )
                return guidance

            # Correctable failures (e.g. wrong helper name) — re-run with the correction
            correction_messages = list(sarvam_messages) + [
                {"role": "assistant", "content": final_text},
                {"role": "system", "content": (
                    f"INTERNAL CORRECTION (not from the user): {reason}\n"
                    f"Fix: {correction}\n"
                    f"Generate a corrected response for the USER's original request. "
                    f"Do NOT mention this correction to the user. Do NOT ask about quality checks."
                )},
            ]
            parsed_corrected = await _orchestrator_once(correction_messages)
            if parsed_corrected.get("kind") == "tool_calls":
                corrected_tcs = parsed_corrected.get("tool_calls", [])
                if isinstance(corrected_tcs, list) and corrected_tcs and household_id:
                    corr_results: list[dict[str, Any]] = []
                    for tc in corrected_tcs:
                        if not isinstance(tc, dict):
                            continue
                        tc = _ensure_tool_reason(tc, "Correction after judge.")
                        try:
                            out = await edge_execute_tools({"household_id": household_id, "tool_call": tc}, user_id=user_id)
                        except Exception as e2:
                            out = {"ok": False, "error": str(e2)}
                        corr_results.append(out)
                    corr_followup = list(correction_messages) + [
                        {"role": "user", "content": (
                            "TOOL_RESULTS_JSON:\n"
                            + json.dumps({"results": corr_results}, ensure_ascii=False)
                            + "\n\nUsing the results above, answer the user. Return {\"final_text\": ...}."
                        )},
                    ]
                    parsed_final = await _orchestrator_once(corr_followup)
                    corrected_text = _deterministic_trim_chain_of_thought(str(parsed_final.get("final_text", "")).strip())
                    if corrected_text:
                        return corrected_text
            elif parsed_corrected.get("kind") == "final_text":
                corrected_text = _deterministic_trim_chain_of_thought(str(parsed_corrected.get("final_text", "")).strip())
                if corrected_text:
                    return corrected_text
    except Exception:
        pass  # Judge failure should not block the response.

    if not final_text.strip():
        # Trimmer stripped everything as CoT → don't send an empty bubble.
        final_text = (
            "I couldn't complete that request. Could you rephrase or be "
            "more specific about which chore(s) you want to update?"
        )

    return final_text


__all__ = ["run_llm_loop", "REPAIR_SYSTEM_PROMPT"]
