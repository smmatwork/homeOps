import os
import json
import re
import uuid
import math
import asyncio
import logging
import contextvars
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Any, Literal, Optional
from urllib.parse import urlencode

try:
    from zoneinfo import ZoneInfo  # py3.9+
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

import httpx
from fastapi import FastAPI, HTTPException, Header, Request
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

from langgraph.graph import END, StateGraph

# OpenTelemetry + Langfuse setup moved to kernel/observability.py.
# trace is still imported directly here because chat_respond starts a span
# (`tracer.start_as_current_span("agent.chat_respond")`) around the router
# invocation — the span object is what the Langfuse trace builder keys off.
from opentelemetry import trace  # type: ignore

from kernel.observability import (
    _log_request_id,
    _log_conversation_id,
    _log_trace_id,
    _log_user_id,
    _log_session_id,
    _logger,
    _init_otel,
    _init_langfuse,
    install_observability,
    build_chat_respond_langfuse,
)

try:
    from dotenv import load_dotenv  # type: ignore

    _env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(dotenv_path=_env_path, override=True)
except Exception:
    pass


# Generic LLM-output parsers and tool-call validators live in
# orchestrator/parsing.py. Imported here under their legacy underscore-
# prefixed names so every call site in this module + the existing test
# suite (which imports some of these from main) keep working.
from orchestrator.parsing import (
    _strip_think_blocks,
    _looks_like_chain_of_thought,
    _deterministic_trim_chain_of_thought,
    _extract_json_candidate,
    _safe_json_loads,
    _try_parse_json_obj,
    _validate_tool_calls_list,
    _actions_to_tool_calls,
    _ensure_tool_reason,
    _parse_strict_llm_payload,
    _try_normalize_tool_calls_block,
    _contains_structured_tool_calls_payload,
)
from orchestrator.router import route_chat_turn


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


# Correlation contextvars, log-record factory, logger, _init_otel, _init_langfuse
# moved to kernel/observability.py and imported above.


# _extract_assignment_suggestions / _normalize_space_token /
# _infer_spaces_from_user_text moved to orchestrator/prompting.py (they're
# only used by the prompting phase). Re-imported so the existing test
# import `from main import _extract_assignment_suggestions` stays green.
from orchestrator.prompting import (
    _extract_assignment_suggestions,
    _normalize_space_token,
    _infer_spaces_from_user_text,
)


# Phase 6f hallucination-override detectors moved to agents/chore_agent.py.
# The composed `_needs_fetch_override` callable the llm_loop calls is also
# there; main.py just re-imports it for the router call site below.
from agents.chore_agent import (
    _needs_helpers_fetch_override,
    _needs_chores_fetch_override,
    _needs_spaces_fetch_override,
    _needs_fetch_override,
)


# Helper Agent has moved to agents/helper_agent.py. It's instantiated lazily
# via _get_helper_agent() below so dependencies defined later in this file
# (_sarvam_chat, _safe_json_loads, etc.) are resolvable at call time. The
# HelperAgent import happens lower in this module after other imports; the
# annotation is deliberately omitted here to avoid forward-reference issues.

_helper_agent_instance = None


def _get_helper_agent():
    global _helper_agent_instance
    if _helper_agent_instance is None:
        _helper_agent_instance = HelperAgent(
            chat_fn=_sarvam_chat,
            extract_json_candidate=_extract_json_candidate,
            safe_json_loads=_safe_json_loads,
            validate_tool_calls_list=_validate_tool_calls_list,
        )
    return _helper_agent_instance


# ChoreAgent follows the same lazy-init pattern as HelperAgent so forward
# references to _sarvam_chat / _edge_execute_tools (defined later via the
# kernel imports) resolve at first call.
_chore_agent_instance = None


def _get_chore_agent():
    global _chore_agent_instance
    if _chore_agent_instance is None:
        from agents.chore_agent import ChoreAgent
        _chore_agent_instance = ChoreAgent(
            chat_fn=_sarvam_chat,
            edge_execute_tools=_edge_execute_tools,
            extract_json_candidate=_extract_json_candidate,
            safe_json_loads=_safe_json_loads,
            validate_tool_calls_list=_validate_tool_calls_list,
        )
    return _chore_agent_instance


# ═══════════════════════════════════════════════════════════════════════════════
# Agent Hardening: Intent classifier, FACTS injection, output validation,
# LLM-as-Judge guardrail.
# ═══════════════════════════════════════════════════════════════════════════════

# ── #2: Deterministic intent classifier ─────────────────────────────────────

from intent_registry import (
    get_intent_def,
    extract_intent as registry_extract_intent,
    intent_to_tool_calls as registry_intent_to_tool_calls,
    requires_plan as registry_requires_plan,
    list_intents,
)
from orchestrator.intent import (
    ExtractedIntent,
    classify_intent,
    extract_structured_intent,
    intent_specific_instruction,
)
from agents import AgentContext, HelperAgent
from agents.chore_agent import (
    _wants_unassigned_count,
    _extract_count_assigned_to_name,
    _wants_total_pending_count,
    _wants_status_breakdown,
    _wants_assignee_breakdown,
    _extract_space_list_query,
    _extract_list_assigned_to_name,
    _extract_assign_or_create_chore,
    _extract_complete_chore_by_query,
    _extract_reassign_or_unassign_chore,
    _extract_spaces_from_facts,
    _format_no_match_with_suggestions,
    _format_rpc_reassign_result,
    _format_plan_preview,
    _format_execution_result,
    _format_confirmation_preview,
)


# Structured intent extraction has moved to orchestrator/intent.py.
# The legacy EXTRACTION_SYSTEM_PROMPT, _UPDATE_FIELD_RE, and helper functions
# (_extract_intent_regex, _extract_structured_intent) now live there and are
# imported above as extract_intent_regex / extract_structured_intent.

# ── Keyword splitting + semantic chore matching ────────────────────────────
#
# Users often reference multiple chores in one breath ("the description of
# toy and clutter sweep"), and the keyword they pick may not appear verbatim
# in any chore — they're describing the chore semantically ("toy" for a chore
# whose description is "Tidy up scattered toys in the kids' room"). We handle
# both: split match_text into individual keywords, then resolve each via
# substring-then-semantic search against the FACTS chore list.

# Match-resolution utilities (SEMANTIC_MATCH_* constants, _split_match_keywords,
# _parse_chores_from_facts, _resolve_chore_match_ids) have moved to
# agents/chore_agent.py. Re-imported under the same names for existing
# call sites in main.py and test_helper_agent.py's direct imports.
from agents.chore_agent import (
    SEMANTIC_MATCH_THRESHOLD,
    SEMANTIC_MATCH_TOP_K,
    _split_match_keywords,
    _parse_chores_from_facts,
    _resolve_chore_match_ids,
)


# _semantic_match_chores has moved to agents/chore_agent.py. The function
# there takes `get_embedder` as a callable so it doesn't back-edge into
# main; this shim binds _get_embedder (the fastembed singleton, also used
# by /v1/embed) and forwards.
from agents.chore_agent import _semantic_match_chores as _chore_semantic_match_chores


async def _semantic_match_chores(
    keywords: list[str],
    chores: list[dict[str, str]],
) -> list[tuple[str, str, float]]:
    return await _chore_semantic_match_chores(keywords, chores, _get_embedder)


# _resolve_supabase_rest + _fetch_chores_by_ids have moved to
# agents/chore_agent.py. Re-imported under the legacy names so
# chat_respond's sync-followup flow (and the wider call sites that go
# direct to Supabase REST) keep working.
from agents.chore_agent import (
    _resolve_supabase_rest,
    _fetch_chores_by_ids,
)


# _resolve_chore_match_ids_via_rpc has moved to agents/chore_agent.py.
# The shim below binds _edge_execute_tools (looked up from main's namespace
# at call time) so existing tests that patch.object(agent_main,
# "_edge_execute_tools", ...) still intercept the RPC call.
from agents.chore_agent import _resolve_chore_match_ids_via_rpc as _chore_resolve_match_ids_via_rpc


async def _resolve_chore_match_ids_via_rpc(
    *,
    household_id: str,
    user_id: str,
    match_text: str,
    bulk: bool,
) -> list[tuple[str, str]] | None:
    return await _chore_resolve_match_ids_via_rpc(
        _edge_execute_tools,
        household_id=household_id,
        user_id=user_id,
        match_text=match_text,
        bulk=bulk,
    )


# _intent_to_tool_calls has moved to agents/chore_agent.py. The chore_agent
# version takes edge_execute_tools as an injected parameter; this shim binds
# _edge_execute_tools (looked up on main's namespace at call time) so both
# of the following patches continue to work:
#   patch.object(agent_main, "_intent_to_tool_calls", side_effect=...)
#   patch.object(agent_main, "_edge_execute_tools", side_effect=...)
from agents.chore_agent import _intent_to_tool_calls as _chore_intent_to_tool_calls


async def _intent_to_tool_calls(
    extracted: ExtractedIntent,
    facts_section: str,
    *,
    household_id: str = "",
    user_id: str = "",
) -> list[dict[str, Any]] | None:
    return await _chore_intent_to_tool_calls(
        extracted,
        facts_section,
        edge_execute_tools=_edge_execute_tools,
        household_id=household_id,
        user_id=user_id,
    )


# ── #1: FACTS injection ────────────────────────────────────────────────────

# FACTS injection moved to orchestrator/facts.py. Imported under the legacy
# name so call sites (and _resolve_supabase_rest comment references) keep
# working without churn.
from orchestrator.facts import build_facts_section as _build_facts_section


# ── #4: Output validation + #5: Policy enforcement ────────────────────────
# _validate_tool_calls (ID/shape checks vs FACTS) and _enforce_assignment_policy
# (helper-vs-person conflict rules) have moved to agents/chore_agent.py.
# Re-imported here so chat_respond's post-LLM validation step keeps working
# under the legacy names.
from agents.chore_agent import (
    _validate_tool_calls,
    _enforce_assignment_policy,
)


# ── #5b: Silent auto-assignment graduation ─────────────────────────────────
# _check_graduation_status has moved to agents/chore_agent.py (one of three
# helpers that talk direct Supabase REST instead of going through the edge
# function). Re-imported here under the legacy name.
from agents.chore_agent import _check_graduation_status


# ── #6: LLM-as-Judge guardrail ─────────────────────────────────────────────
# JUDGE_SYSTEM_PROMPT and the judge logic now live in agents/chore_agent.py.
# The shim below keeps the legacy module-level call sites (chat_respond's
# post-LLM quality check) working, and — importantly — keeps the patch.object
# on main._sarvam_chat effective: the shim reads _sarvam_chat out of main's
# own namespace at call time, so a test patch propagates into the judge.
from agents.chore_agent import JUDGE_SYSTEM_PROMPT, _judge_response as _chore_judge_response


async def _judge_response(
    user_request: str,
    assistant_response: str,
    model: str,
    facts_summary: str = "",
) -> dict[str, Any]:
    return await _chore_judge_response(
        user_request,
        assistant_response,
        model,
        _sarvam_chat,
        facts_summary,
    )


# Sarvam LLM client + edge-function client live in kernel/. Re-imported here
# under the legacy names so the chat_respond handler, _summarize_history_if_needed
# wrapper, and test patches (patch.object(agent_main, "_sarvam_chat", ...))
# keep working unchanged.
from kernel.llm_client import (
    SARVAM_BASE_URL,
    SARVAM_API_KEY,
    SARVAM_MODEL_DEFAULT,
    SARVAM_TIMEOUT_MS,
    SARVAM_MAX_RETRIES,
    SARVAM_REASONING_LEVEL,
    sarvam_adapt_messages as _sarvam_adapt_messages,
    sarvam_chat as _sarvam_chat,
)
from kernel.edge_client import (
    EDGE_BASE_URL,
    EDGE_BEARER_TOKEN,
    resolve_edge_base_url as _resolve_edge_base_url,
    edge_post as _edge_post,
    edge_get as _edge_get,
    edge_execute_tools as _edge_execute_tools,
)

# Gemini + sanitizer + global service auth remain here — they aren't
# kernel-scope (Gemini is a fallback path, AGENT_SERVICE_KEY is also used by
# the chat_respond handler's own auth check).
GEMINI_API_KEY = _env("GEMINI_API_KEY")
GEMINI_MODEL = _env("GEMINI_MODEL", "gemini-1.5-flash")
SANITIZER_ALWAYS = (_env("SANITIZER_ALWAYS", "false") or "false").strip().lower() in ("1", "true", "yes", "y", "on")

AGENT_SERVICE_KEY = _env("AGENT_SERVICE_KEY")


# Run pipeline (/v1/runs/start) models + handler moved to the runs/ package.
# Re-imported under the legacy names so nothing downstream cares.
from runs import RunStartRequest, RunStatusResponse, ProposedAction, ProposalOutput, run_start_handler


class SarvamMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRespondRequest(BaseModel):
    messages: list[SarvamMessage]
    model: Optional[str] = None
    temperature: float = 0.3
    max_tokens: int = 900


# _extract_clarification_block / _infer_base_chore_title / _wants_schedule /
# _has_explicit_datetime all moved to orchestrator/prompting.py and are
# invoked through handle_schedule_and_space / handle_apply_assignments.
from orchestrator.prompting import (
    _extract_clarification_block,
    _infer_base_chore_title,
    _wants_schedule,
    _has_explicit_datetime,
    handle_apply_assignments,
    handle_schedule_and_space,
)


# _safe_str / _local_dt_to_utc_iso / _parse_event_time / _parse_proposal_from_raw_text /
# _validate_chore_actions / _fallback_chore_proposal moved to the runs/ package
# (time_parsing.py + proposal.py). Re-exported here for any legacy call site.
from runs.proposal import (
    _parse_proposal_from_raw_text,
    _validate_chore_actions,
    _fallback_chore_proposal,
)
from runs.time_parsing import _safe_str, _local_dt_to_utc_iso, _parse_event_time


app = FastAPI(title="HomeOps Agent Service", version="0.1.0")


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    try:
        # Avoid leaking stack traces, but return the exception string so callers (Edge) can show actionable errors.
        return JSONResponse(status_code=500, content={"detail": str(exc)})
    except Exception:
        return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})

# OTel init, FastAPI/httpx instrumentation, correlation middleware, Langfuse
# startup hook — all one call now.
install_observability(app)

# Simple marker to confirm which code version is running.
print("agent_service_loaded", {"file": __file__})


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "sarvam": bool(SARVAM_API_KEY),
        "edge": bool(EDGE_BASE_URL),
    }


# Helper/onboarding routes moved to routes/helpers.py. The router reads
# _edge_execute_tools from main's namespace at call time, so test patches
# on agent_main._edge_execute_tools still propagate through the endpoint.
from routes import build_helpers_router

app.include_router(
    build_helpers_router(
        agent_service_key=AGENT_SERVICE_KEY,
        edge_execute_tools=_edge_execute_tools,
    )
)


class EmbedRequest(BaseModel):
    texts: list[str]


class EmbedResponse(BaseModel):
    ok: bool = True
    vectors: list[list[float]]


_embedder: Any = None


def _get_embedder() -> Any:
    global _embedder
    if (_env("AGENT_SERVICE_DISABLE_EMBEDDINGS", "false") or "false").strip().lower() in ("1", "true", "yes", "y", "on"):
        return None
    if _embedder is not None:
        return _embedder
    try:
        from fastembed import TextEmbedding  # type: ignore
    except Exception as e:
        raise RuntimeError(f"fastembed not available: {e}")
    _embedder = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
    return _embedder


@app.post("/v1/embed")
async def embed(
    req: EmbedRequest,
    x_agent_service_key: str | None = Header(default=None, alias="x-agent-service-key"),
) -> dict[str, Any]:
    expected = (AGENT_SERVICE_KEY or "").strip()
    provided = (x_agent_service_key or "").strip()
    if not expected:
        raise HTTPException(status_code=500, detail="Missing AGENT_SERVICE_KEY")
    if not provided or provided != expected:
        raise HTTPException(status_code=403, detail="Forbidden")

    texts = [t for t in (req.texts or []) if isinstance(t, str) and t.strip()]
    if not texts:
        return {"ok": True, "vectors": []}

    emb = _get_embedder()
    if emb is None:
        vecs = [[0.0] * 16 for _ in texts]
        return EmbedResponse(vectors=vecs).model_dump()
    try:
        vecs = [list(map(float, v)) for v in emb.embed(texts)]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding failed: {e}")

    for v in vecs:
        if not v or any((not isinstance(x, (int, float)) or math.isnan(float(x))) for x in v):
            raise HTTPException(status_code=500, detail="Embedding returned invalid vector")
    return EmbedResponse(vectors=vecs).model_dump()


@app.post("/v1/chat/respond")
async def chat_respond(
    req: ChatRespondRequest,
    x_agent_service_key: str | None = Header(default=None, alias="x-agent-service-key"),
    x_request_id: str | None = Header(default=None, alias="x-request-id"),
    x_conversation_id: str | None = Header(default=None, alias="x-conversation-id"),
    x_session_id: str | None = Header(default=None, alias="x-session-id"),
    x_user_id: str | None = Header(default=None, alias="x-user-id"),
    x_household_id: str | None = Header(default=None, alias="x-household-id"),
    x_langfuse_trace_id: str | None = Header(default=None, alias="x-langfuse-trace-id"),
) -> dict[str, Any]:
    # Called by Edge function; require shared secret.
    expected = (AGENT_SERVICE_KEY or "").strip()
    provided = (x_agent_service_key or "").strip()
    if not expected:
        raise HTTPException(status_code=500, detail="Missing AGENT_SERVICE_KEY")
    if not provided or provided != expected:
        raise HTTPException(status_code=403, detail="Forbidden")

    tracer = trace.get_tracer("homeops.agent_service")
    req_id = (x_request_id or "").strip()
    conv_id = (x_conversation_id or "").strip()
    sess_id = (x_session_id or "").strip()
    user_id = (x_user_id or "").strip()
    household_id = (x_household_id or "").strip()

    model = (req.model or SARVAM_MODEL_DEFAULT or "sarvam-m").strip()
    messages = [m.model_dump() for m in req.messages]

    with tracer.start_as_current_span("agent.chat_respond") as span:
        try:
            if req_id:
                span.set_attribute("x-request-id", req_id)
            if conv_id:
                span.set_attribute("x-conversation-id", conv_id)
            if sess_id:
                span.set_attribute("x-session-id", sess_id)
            if user_id:
                span.set_attribute("enduser.id", user_id)
        except Exception:
            pass

        # Build the per-request Langfuse trace + the two closures the router
        # uses to record spans and wrap the final response.
        lf, lf_trace, _lf_span, _lf_return = build_chat_respond_langfuse(
            otel_span=span,
            messages=messages,
            req_id=req_id,
            conv_id=conv_id,
            sess_id=sess_id,
            user_id=user_id,
            model=model,
            x_langfuse_trace_id=x_langfuse_trace_id,
        )

        # All phase dispatch lives in orchestrator/router.py. The router
        # expects the two langfuse callbacks and the injected domain deps
        # (chat_fn, edge_execute_tools, judge_fn, summarize_history,
        # needs_fetch_override, intent_to_tool_calls_fn) which this module
        # holds via module-level names — test patches on agent_main._sarvam_chat
        # etc. propagate because the names are resolved at call time here.
        return await route_chat_turn(
            messages=messages,
            model=model,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            req_id=req_id,
            conv_id=conv_id,
            sess_id=sess_id,
            user_id=user_id,
            household_id=household_id,
            lf_span=_lf_span,
            lf_return=_lf_return,
            get_chore_agent=_get_chore_agent,
            get_helper_agent=_get_helper_agent,
            chat_fn=_sarvam_chat,
            edge_execute_tools=_edge_execute_tools,
            judge_fn=_judge_response,
            summarize_history=_summarize_history_if_needed,
            intent_to_tool_calls_fn=_intent_to_tool_calls,
            needs_fetch_override=_needs_fetch_override,
        )


async def _gemini_sanitize_final_only(text: str) -> str:
    api_key = (os.getenv("GEMINI_API_KEY") or GEMINI_API_KEY or "").strip()
    if not api_key:
        raise RuntimeError("Missing GEMINI_API_KEY")

    # If the model already produced a structured tool_calls payload, do not rewrite it.
    # Sanitizing/re-writing often destroys structured JSON, which is worse than showing it verbatim.
    if _contains_structured_tool_calls_payload(text):
        return text.strip()

    model_env = (os.getenv("GEMINI_MODEL") or GEMINI_MODEL or "gemini-1.5-flash").strip()
    # Model naming and endpoints have changed over time; try a small set of safe fallbacks.
    model_candidates = [m for m in [model_env, "gemini-1.5-flash", "gemini-1.5-flash-latest"] if m]
    base_candidates = [
        "https://generativelanguage.googleapis.com/v1beta",
        "https://generativelanguage.googleapis.com/v1",
    ]
    timeout = httpx.Timeout(20.0)

    prompt = (
        "Remove any chain-of-thought / meta-reasoning from the INPUT, while preserving ALL user-relevant details. "
        "Keep dates, times, numbers, names, and instructions intact. "
        "Delete only the internal narration (e.g. 'the user wants', 'let me break this down', 'first/next', planning). "
        "Output ONLY the final user-facing message. "
        "Do NOT mention that you rewrote anything."
    )

    payload: dict[str, Any] = {
        "contents": [
            {"role": "user", "parts": [{"text": f"{prompt}\n\nINPUT:\n{text}"}]},
        ],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": 1024,
        },
    }

    last_err: Optional[Exception] = None
    res: Optional[httpx.Response] = None
    tried: list[str] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for base in base_candidates:
            for model in model_candidates:
                url = f"{base}/models/{model}:generateContent"
                tried.append(url)
                try:
                    res = await client.post(
                        url,
                        params={"key": api_key},
                        headers={"Content-Type": "application/json"},
                        json=payload,
                    )
                    if res.status_code >= 400:
                        # Try next candidate on 404/400; report other errors as well.
                        snippet = ""
                        try:
                            snippet = (res.text or "")[:300]
                        except Exception:
                            snippet = ""

                        if res.status_code in (400, 404):
                            last_err = RuntimeError(f"Gemini HTTP {res.status_code} for {url} {snippet}".strip())
                            res = None
                            continue
                        last_err = RuntimeError(f"Gemini HTTP {res.status_code} for {url} {snippet}".strip())
                        res = None
                        continue
                    break
                except Exception as e:
                    last_err = e
                    res = None
            if res is not None and res.status_code < 400:
                break

    if res is None:
        raise RuntimeError(f"Gemini call failed: {last_err}. tried={tried}")

    data = res.json()
    try:
        cands = data.get("candidates")
        if isinstance(cands, list) and cands:
            content = cands[0].get("content")
            if isinstance(content, dict):
                parts = content.get("parts")
                if isinstance(parts, list) and parts:
                    out = parts[0].get("text")
                    if isinstance(out, str):
                        return out.strip()
    except Exception:
        pass
    raise RuntimeError("Gemini response missing text")


# Conversation-window management (char budget, rolling summary, hard truncator)
# lives in orchestrator/context.py. Imported here under the legacy names so
# _sarvam_chat, chat_respond call sites, and the existing test suite (which
# patches _sarvam_chat and clears _summary_cache directly) keep working.
from orchestrator.context import (
    SARVAM_PROMPT_CHAR_BUDGET,
    ConversationSummary as _ConversationSummary,
    summary_cache as _summary_cache,
    truncate_messages_to_budget as _truncate_messages_to_budget,
)


# Orchestrator conversation state (pending clarifications, plan-confirm cache,
# "yes"/"no" phrase detectors) lives in orchestrator/state.py. Imported here
# under the legacy underscore-prefixed names so the 15+ call sites in
# chat_respond and the existing test suite keep working without churn.
from orchestrator.state import (
    MAX_CLARIFICATION_TURNS,
    PENDING_CLARIFICATION_TTL_SECONDS,
    PENDING_CONFIRMATION_TTL_SECONDS,
    PendingClarification as _PendingClarification,
    PendingConfirmation as _PendingConfirmation,
    clarification_counts as _clarification_counts,
    clear_pending_confirmation as _clear_pending_confirmation,
    is_cancellation as _is_cancellation,
    is_confirmation as _is_confirmation,
    pending_clarifications as _pending_clarifications,
    pending_confirmations as _pending_confirmations,
    stash_clarification as _stash_clarification,
    stash_pending_confirmation as _stash_pending_confirmation,
    take_clarification as _take_clarification,
    take_pending_confirmation as _take_pending_confirmation,
)


# _match_ids_from_tool_calls moved to agents/chore_agent.py. Re-imported
# under the legacy name so test_helper_agent.py's direct import keeps
# working and the remaining main.py call sites (pending confirmation branch)
# resolve unchanged.
from agents.chore_agent import _match_ids_from_tool_calls



async def _summarize_history_if_needed(
    messages: list[dict[str, str]],
    *,
    conversation_id: str,
    model: str,
    char_budget: int = SARVAM_PROMPT_CHAR_BUDGET,
) -> list[dict[str, str]]:
    """Thin wrapper that forwards to orchestrator.context.summarize_history_if_needed,
    passing _sarvam_chat by reference so tests that patch main._sarvam_chat
    still intercept the summarizer LLM call."""
    from orchestrator.context import summarize_history_if_needed as _impl
    return await _impl(
        messages,
        conversation_id=conversation_id,
        model=model,
        chat_fn=_sarvam_chat,
        char_budget=char_budget,
    )




# _iso / _pick_helper_for_cleaning / _visitor_cleaning_templates moved to the
# runs/ package (time_parsing.py + cleaning_templates.py).
from runs.time_parsing import _iso
from runs.cleaning_templates import _pick_helper_for_cleaning, _visitor_cleaning_templates


@app.post("/v1/runs/start")
async def runs_start(req: RunStartRequest, request: Request) -> dict[str, Any]:
    """Thin FastAPI wrapper around runs.run_start_handler.

    Dispatch + LangGraph logic lives in the runs/ package; this endpoint
    just forwards the injected edge/LLM clients so the handler stays
    framework-agnostic.
    """
    return await run_start_handler(
        req,
        edge_post=_edge_post,
        edge_get=_edge_get,
        chat_fn=_sarvam_chat,
        sarvam_model_default=SARVAM_MODEL_DEFAULT,
        sarvam_api_key_set=bool(SARVAM_API_KEY),
    )


@app.get("/v1/runs/{run_id}")
async def get_run(run_id: str) -> RunStatusResponse:
    # The source of truth is Supabase via Edge; this endpoint is a placeholder.
    # For v1, you can omit this and rely on /agents/runs/:id.
    return RunStatusResponse(run_id=run_id, status="queued")
