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

from opentelemetry import trace  # type: ignore
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter  # type: ignore
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor  # type: ignore
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor  # type: ignore
from opentelemetry.sdk.resources import Resource  # type: ignore
from opentelemetry.sdk.trace import TracerProvider  # type: ignore
from opentelemetry.sdk.trace.export import BatchSpanProcessor  # type: ignore

try:
    from langfuse import Langfuse  # type: ignore
except Exception as e:  # pragma: no cover
    Langfuse = None  # type: ignore
    logging.warning(f"Langfuse import failed: {str(e)}")

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
from orchestrator.confirmation import handle_pending_confirmation
from orchestrator.prompt_builder import build_system_prompt_augmentation
from orchestrator.llm_loop import run_llm_loop


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


_log_request_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_request_id", default="")
_log_conversation_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_conversation_id", default="")
_log_trace_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_trace_id", default="")
_log_user_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_user_id", default="")
_log_session_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_session_id", default="")

_old_factory = logging.getLogRecordFactory()
def _record_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
    record = _old_factory(*args, **kwargs)
    try:
        record.request_id = _log_request_id.get() or "-"
    except Exception:
        record.request_id = "-"
    try:
        record.conversation_id = _log_conversation_id.get() or "-"
    except Exception:
        record.conversation_id = "-"
    try:
        record.trace_id = _log_trace_id.get() or "-"
    except Exception:
        record.trace_id = "-"
    try:
        record.user_id = _log_user_id.get() or "-"
    except Exception:
        record.user_id = "-"
    try:
        record.session_id = _log_session_id.get() or "-"
    except Exception:
        record.session_id = "-"
    return record
logging.setLogRecordFactory(_record_factory)

class _CorrelationFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.request_id = _log_request_id.get() or "-"
        except Exception:
            record.request_id = "-"
        try:
            record.conversation_id = _log_conversation_id.get() or "-"
        except Exception:
            record.conversation_id = "-"
        try:
            record.trace_id = _log_trace_id.get() or "-"
        except Exception:
            record.trace_id = "-"
        try:
            record.user_id = _log_user_id.get() or "-"
        except Exception:
            record.user_id = "-"
        try:
            record.session_id = _log_session_id.get() or "-"
        except Exception:
            record.session_id = "-"
        return True


_logger = logging.getLogger("homeops.agent_service")
if not _logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s request_id=%(request_id)s conversation_id=%(conversation_id)s session_id=%(session_id)s user_id=%(user_id)s trace_id=%(trace_id)s %(message)s"
        )
    )
    handler.addFilter(_CorrelationFilter())
    _logger.addHandler(handler)
    _logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
_logger.propagate = True


_otel_inited = False
_langfuse_client: Any = None
_langfuse_init_logged = False


def _init_otel() -> None:
    global _otel_inited
    if _otel_inited:
        return
    _otel_inited = True

    endpoint = _env("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return

    headers_raw = (_env("OTEL_EXPORTER_OTLP_HEADERS", "") or "").strip()
    headers: dict[str, str] = {}
    for part in [p.strip() for p in headers_raw.split(",") if p.strip()]:
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if k and v:
            headers[k] = v

    service_name = (_env("OTEL_SERVICE_NAME", "homeops-agent-service") or "homeops-agent-service").strip()
    env_name = (_env("HOMEOPS_ENV") or _env("ENVIRONMENT") or _env("DEPLOYMENT_ENVIRONMENT") or "").strip()
    resource = Resource.create({"service.name": service_name, "deployment.environment": env_name})

    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint, headers=headers or None)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)


def _init_langfuse() -> Any:
    """
    Initialize and return the Langfuse client with thread safety
    
    Returns:
        Langfuse client instance or None if not configured
    """
    global _langfuse_client
    global _langfuse_init_logged
    if _langfuse_client is not None:
        return _langfuse_client
    if Langfuse is None:
        _langfuse_client = None
        if not _langfuse_init_logged:
            _langfuse_init_logged = True
            try:
                _logger.info("langfuse_disabled", extra={"reason": "langfuse_package_missing"})
            except Exception:
                pass
        return None

    public_key = (_env("LANGFUSE_PUBLIC_KEY") or "").strip()
    secret_key = (_env("LANGFUSE_SECRET_KEY") or "").strip()
    host = (_env("LANGFUSE_HOST") or "https://cloud.langfuse.com").strip()
    if not public_key or not secret_key:
        _logger.debug("Langfuse disabled: Missing required API keys")
        _langfuse_client = None
        return None
    if not host:
        _logger.warning("Langfuse using default host URL")
        host = "https://cloud.langfuse.com"
        _langfuse_client = None
        if not _langfuse_init_logged:
            _langfuse_init_logged = True
            try:
                _logger.info(
                    "langfuse_disabled",
                    extra={
                        "reason": "missing_keys",
                        "has_public_key": bool(public_key),
                        "has_secret_key": bool(secret_key),
                        "host": host,
                    },
                )
            except Exception:
                pass
        return None

    kwargs: dict[str, Any] = {"public_key": public_key, "secret_key": secret_key}
    if host:
        kwargs["host"] = host
    try:
        _langfuse_client = Langfuse(**kwargs)
        if not _langfuse_init_logged:
            _logger.info(f"Langfuse initialized with endpoint: {host}")
            _langfuse_init_logged = True
            try:
                _logger.info("langfuse_enabled", extra={"host": host or "(default)"})
            except Exception:
                pass
    except Exception as e:
        _langfuse_client = None
        if not _langfuse_init_logged:
            _langfuse_init_logged = True
        try:
            _logger.exception("langfuse_init_failed", extra={"host": host, "error": str(e)})
        except Exception:
            pass
    return _langfuse_client


# _extract_assignment_suggestions / _normalize_space_token /
# _infer_spaces_from_user_text moved to orchestrator/prompting.py (they're
# only used by the prompting phase). Re-imported so the existing test
# import `from main import _extract_assignment_suggestions` stays green.
from orchestrator.prompting import (
    _extract_assignment_suggestions,
    _normalize_space_token,
    _infer_spaces_from_user_text,
)


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
    # Also catch numbered lists that mention cleaners/helpers.
    if ("cleaner" in s or "cleaners" in s or "helper" in s or "helpers" in s) and re.search(r"\n\s*\d+\.", s):
        return True

    # Catch hallucinated assignments like:
    # "Rajesh will receive the task" / "Assigned to Sunita" etc.
    # If the model is naming a person as the assignee without having fetched helpers, force a helpers select.
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


def _helpers_select_tool_call_json(tool_call_id: str = "tc_helpers_1") -> str:
    payload = {
        "tool_calls": [
            {
                "id": tool_call_id,
                "tool": "db.select",
                "args": {
                    "table": "helpers",
                    "limit": 25,
                },
                "reason": "Fetch real helpers/cleaners from the database before listing any names.",
            }
        ]
    }
    return "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"


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


class RunStartRequest(BaseModel):
    run_id: str
    household_id: str
    graph_key: str
    trigger: str = "chat"
    input: dict[str, Any] = Field(default_factory=dict)
    mode: Literal["propose", "commit"] = "propose"


class RunStatusResponse(BaseModel):
    ok: bool = True
    run_id: str
    status: Literal["queued", "running", "succeeded", "failed", "canceled"]
    output: Optional[dict[str, Any]] = None
    error: Optional[str] = None


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


class ProposedAction(BaseModel):
    id: str
    tool: Literal["db.insert", "db.update", "db.delete"]
    args: dict[str, Any]
    reason: Optional[str] = None


class ProposalOutput(BaseModel):
    mode: Literal["propose"] = "propose"
    version: str = "proposal_v1"
    confirm_text: str
    proposed_actions: list[ProposedAction]


def _safe_str(v: Any) -> str:
    try:
        return str(v)
    except Exception:
        return ""


def _local_dt_to_utc_iso(local_dt: datetime, tz_name: str) -> str:
    """Convert a *local wall clock* datetime into a UTC ISO string.

    If local_dt is naive, interpret it in tz_name using zoneinfo (DST-safe).
    If zoneinfo isn't available or tz_name is invalid, fall back to treating naive as UTC.
    """

    if local_dt.tzinfo is not None:
        return local_dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    tz = (tz_name or "").strip() or "UTC"
    if ZoneInfo is None:
        return local_dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")

    try:
        zi = ZoneInfo(tz)
    except Exception:
        zi = ZoneInfo("UTC")

    # Attach timezone info. For ambiguous times (DST fall-back), fold defaults to 0.
    aware = local_dt.replace(tzinfo=zi)
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_event_time(text: str, now_local: datetime) -> tuple[Optional[datetime], Optional[datetime], str]:
    """Very small parser for demos: handles 'tomorrow 7pm', 'today 6pm', 'YYYY-MM-DD HH:MM', optional 'to' end time.

    Returns (start_local_dt, end_local_dt, note)
    """
    raw = text.strip()
    lower = raw.lower()

    # Extract range like "7pm to 10pm".
    range_match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*(?:to|\-|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", lower)
    single_match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", lower)

    day = None
    if "tomorrow" in lower:
        day = now_local.date() + timedelta(days=1)
    elif "today" in lower:
        day = now_local.date()
    else:
        iso_day = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", lower)
        if iso_day:
            try:
                day = date(int(iso_day.group(1)), int(iso_day.group(2)), int(iso_day.group(3)))
            except Exception:
                day = None

    def to_24h(h: int, m: int, ampm: Optional[str]) -> tuple[int, int]:
        if ampm:
            if ampm == "pm" and h != 12:
                h += 12
            if ampm == "am" and h == 12:
                h = 0
        return h, m

    if not day:
        return None, None, "missing_day"

    if range_match:
        h1 = int(range_match.group(1))
        m1 = int(range_match.group(2) or "0")
        a1 = range_match.group(3)
        h2 = int(range_match.group(4))
        m2 = int(range_match.group(5) or "0")
        a2 = range_match.group(6) or a1
        hh1, mm1 = to_24h(h1, m1, a1)
        hh2, mm2 = to_24h(h2, m2, a2)
        start = datetime(day.year, day.month, day.day, hh1, mm1)
        end = datetime(day.year, day.month, day.day, hh2, mm2)
        if end <= start:
            end = end + timedelta(days=1)
        return start, end, "ok"

    if single_match:
        h = int(single_match.group(1))
        m = int(single_match.group(2) or "0")
        a = single_match.group(3)
        hh, mm = to_24h(h, m, a)
        start = datetime(day.year, day.month, day.day, hh, mm)
        return start, None, "ok"

    return None, None, "missing_time"


def _parse_proposal_from_raw_text(raw_text: str) -> ProposalOutput:
    data = _safe_json_loads(raw_text)
    proposal = ProposalOutput.model_validate(data)
    proposal.proposed_actions = _validate_chore_actions(proposal.proposed_actions)
    return proposal


def _validate_chore_actions(actions: list[ProposedAction]) -> list[ProposedAction]:
    out: list[ProposedAction] = []
    for a in actions:
        table = str(a.args.get("table", "")).strip()
        if table != "chores":
            raise ValueError("Only 'chores' table actions are allowed")
        if a.tool == "db.insert":
            record = a.args.get("record")
            if not isinstance(record, dict):
                raise ValueError("db.insert requires args.record")
            title = record.get("title")
            if not isinstance(title, str) or not title.strip():
                raise ValueError("Chore insert requires record.title")
        if a.tool == "db.update":
            if not isinstance(a.args.get("id"), str) or not str(a.args.get("id")).strip():
                raise ValueError("db.update requires args.id")
            patch = a.args.get("patch")
            if not isinstance(patch, dict):
                raise ValueError("db.update requires args.patch")
        if a.tool == "db.delete":
            if not isinstance(a.args.get("id"), str) or not str(a.args.get("id")).strip():
                raise ValueError("db.delete requires args.id")
        out.append(a)
    return out


def _fallback_chore_proposal(user_input: dict[str, Any]) -> ProposalOutput:
    req = user_input.get("request")
    text = req if isinstance(req, str) else ""
    title = ""

    # Common patterns:
    # - "Add a chore: Take out trash. ..."
    # - "Add a chore called \"Take out trash\""
    # - Quoted title anywhere in the request.
    m = re.search(r"add\s+a\s+chore\s*:\s*([^\.\n\r]+)", text, re.IGNORECASE)
    if m:
        title = m.group(1).strip().strip('"')
    if not title:
        m = re.search(r"add\s+a\s+chore\s+called\s+\"([^\"]+)\"", text, re.IGNORECASE)
        if m:
            title = m.group(1).strip()
    if not title:
        m = re.search(r"\"([^\"]{3,100})\"", text)
        if m:
            title = m.group(1).strip()
    if not title:
        m = re.search(r"add\s+a\s+chore\s*:\s*([^,\n\r]+)", text, re.IGNORECASE)
        if m:
            title = m.group(1).strip().strip('"')
    if not title:
        title = "New chore"

    action = ProposedAction(
        id=f"tc_{uuid.uuid4().hex}",
        tool="db.insert",
        args={"table": "chores", "record": {"title": title}},
        reason=f"Fallback proposal (LLM did not return valid JSON). extracted_title={title}",
    )
    return ProposalOutput(
        confirm_text=f"I can add the chore '{title}'. Do you want me to apply this change?",
        proposed_actions=[action],
    )


app = FastAPI(title="HomeOps Agent Service", version="0.1.0")


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    try:
        # Avoid leaking stack traces, but return the exception string so callers (Edge) can show actionable errors.
        return JSONResponse(status_code=500, content={"detail": str(exc)})
    except Exception:
        return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})

_init_otel()
try:
    HTTPXClientInstrumentor().instrument()
except Exception:
    pass
try:
    FastAPIInstrumentor.instrument_app(app)
except Exception:
    pass


@app.on_event("startup")
async def _startup_observability_init() -> None:
    # Trigger Langfuse init once at startup so we can see enable/disable status in logs.
    try:
        _init_langfuse()
    except Exception:
        pass


@app.middleware("http")
async def _otel_correlation_middleware(request: Request, call_next):
    token_req = None
    token_conv = None
    token_trace = None
    token_user = None
    token_sess = None
    try:
        span = trace.get_current_span()
        if span is not None:
            req_id = (request.headers.get("x-request-id") or "").strip()
            conv_id = (request.headers.get("x-conversation-id") or "").strip()
            sess_id = (request.headers.get("x-session-id") or "").strip()
            user_id = (request.headers.get("x-user-id") or "").strip()
            if req_id:
                span.set_attribute("x-request-id", req_id)
            if conv_id:
                span.set_attribute("x-conversation-id", conv_id)
            if sess_id:
                span.set_attribute("x-session-id", sess_id)
            if user_id:
                span.set_attribute("enduser.id", user_id)

            try:
                token_req = _log_request_id.set(req_id)
            except Exception:
                token_req = None
            try:
                token_conv = _log_conversation_id.set(conv_id)
            except Exception:
                token_conv = None
            try:
                token_sess = _log_session_id.set(sess_id)
            except Exception:
                token_sess = None
            try:
                ctx = getattr(span, "get_span_context", lambda: None)()
                tid = getattr(ctx, "trace_id", 0) or 0
                trace_hex = f"{tid:032x}" if isinstance(tid, int) and tid else ""
                token_trace = _log_trace_id.set(trace_hex)
            except Exception:
                token_trace = None
            try:
                token_user = _log_user_id.set(user_id)
            except Exception:
                token_user = None
    except Exception:
        pass
    try:
        resp = await call_next(request)
        try:
            _logger.info("http_request", extra={"method": request.method, "path": request.url.path, "status_code": getattr(resp, "status_code", None)})
        except Exception:
            pass
        return resp
    finally:
        try:
            if token_req is not None:
                _log_request_id.reset(token_req)
        except Exception:
            pass
        try:
            if token_conv is not None:
                _log_conversation_id.reset(token_conv)
        except Exception:
            pass
        try:
            if token_trace is not None:
                _log_trace_id.reset(token_trace)
        except Exception:
            pass
        try:
            if token_user is not None:
                _log_user_id.reset(token_user)
        except Exception:
            pass
        try:
            if token_sess is not None:
                _log_session_id.reset(token_sess)
        except Exception:
            pass

# Simple marker to confirm which code version is running.
print("agent_service_loaded", {"file": __file__})


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "sarvam": bool(SARVAM_API_KEY),
        "edge": bool(EDGE_BASE_URL),
    }


class DispatchInviteRequest(BaseModel):
    helper_id: str
    helper_name: str
    helper_phone: str | None = None
    channel_chain: list[str] = ["whatsapp", "sms", "web"]
    magic_link_url: str
    household_id: str


@app.post("/v1/helpers/dispatch-invite")
async def dispatch_invite(
    req: DispatchInviteRequest,
    x_agent_service_key: str | None = Header(default=None, alias="x-agent-service-key"),
) -> dict[str, Any]:
    """Send a helper onboarding magic link via the channel dispatcher."""
    expected = (AGENT_SERVICE_KEY or "").strip()
    provided = (x_agent_service_key or "").strip()
    if not expected or not provided or provided != expected:
        raise HTTPException(status_code=403, detail="Forbidden")

    from channel_dispatcher import ChannelDispatcher, OutreachIntent
    from channel_adapters.whatsapp import WhatsAppAdapter
    from channel_adapters.sms import SmsAdapter
    from channel_adapters.web import WebAdapter

    adapters = {
        "whatsapp": WhatsAppAdapter(),
        "sms": SmsAdapter(),
        "web": WebAdapter(),
    }

    async def persist_attempt(attempt: Any) -> None:
        """Best-effort persist to helper_outreach_attempts via edge."""
        try:
            await _edge_execute_tools(
                {
                    "household_id": req.household_id,
                    "tool_call": {
                        "id": f"outreach_{req.helper_id}_{int(__import__('time').time())}",
                        "tool": "db.insert",
                        "args": {
                            "table": "helper_outreach_attempts",
                            "record": {
                                "helper_id": req.helper_id,
                                "household_id": req.household_id,
                                "channel": getattr(attempt, "channel", "unknown"),
                                "status": getattr(attempt, "status", "unknown"),
                                "intent": "stage2_onboarding",
                            },
                        },
                        "reason": "Persist outreach attempt",
                    },
                },
                user_id=None,
            )
        except Exception:
            pass  # best-effort

    dispatcher = ChannelDispatcher(adapters=adapters, persist_attempt=persist_attempt)

    helper = {
        "id": req.helper_id,
        "name": req.helper_name,
        "phone": req.helper_phone,
        "channel_preferences": req.channel_chain,
    }

    invite = {
        "magic_link_url": req.magic_link_url,
        "household_id": req.household_id,
    }

    result = await dispatcher.initiate_outreach(
        helper=helper,
        intent=OutreachIntent.STAGE2_ONBOARDING,
        invite=invite,
    )

    return {
        "ok": result.success,
        "channel": result.final_channel,
        "attempts": len(result.attempts),
    }


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

    def _langfuse_flush(lf_client: Any) -> None:
        if lf_client is None:
            return
        try:
            if hasattr(lf_client, "flush"):
                lf_client.flush()
        except Exception:
            pass

    def _langfuse_safe_update(trace_obj: Any, *, output: Any | None = None, status: str | None = None) -> None:
        if trace_obj is None:
            return
        try:
            if hasattr(trace_obj, "update"):
                payload: dict[str, Any] = {}
                if output is not None:
                    payload["output"] = output
                if status is not None:
                    payload["status"] = status
                if payload:
                    trace_obj.update(**payload)
        except Exception:
            pass

    def _langfuse_input_payload(msgs: list[dict[str, Any]]) -> dict[str, Any]:
        # Keep payload small and avoid accidentally sending huge content blobs.
        out_msgs: list[dict[str, Any]] = []
        for m in msgs[-12:]:
            if not isinstance(m, dict):
                continue
            role = str(m.get("role") or "")
            content = m.get("content")
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False) if content is not None else ""
            out_msgs.append({"role": role, "content": content[:2000]})
        return {"messages": out_msgs}

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

        lf = None
        lf_trace = None
        try:
            lf = _init_langfuse()
            if lf is not None:
                trace_kwargs: dict[str, Any] = {
                    "name": "agent.chat_respond",
                    "input": _langfuse_input_payload(messages),
                    "metadata": {
                        "conversation_id": conv_id,
                        "session_id": sess_id,
                        "request_id": req_id,
                        "user_id": user_id,
                        "model": model,
                        "otel_trace_id": f"{span.get_span_context().trace_id:032x}",
                    },
                }
                incoming_trace_id = (x_langfuse_trace_id or "").strip() if isinstance(x_langfuse_trace_id, str) else ""
                if incoming_trace_id:
                    # Enhanced trace linking with service context
                    trace_kwargs.update({
                        "id": incoming_trace_id,
                        "metadata": {
                            "service": "agent-service",
                            "timestamp": datetime.utcnow().isoformat(),
                            "version": _env("APP_VERSION", "unknown")
                        }
                    })
                try:
                    lf_trace = lf.trace(**trace_kwargs)
                except TypeError:
                    trace_kwargs.pop("id", None)
                    lf_trace = lf.trace(**trace_kwargs)
        except Exception:
            lf = None
            lf_trace = None

        lf_trace_id = None
        try:
            lf_trace_id = getattr(lf_trace, "id", None) if lf_trace is not None else None
        except Exception:
            lf_trace_id = None

        def _lf_span(name: str, *, input: Any | None = None, output: Any | None = None, status_message: str | None = None, level: Any | None = None) -> None:
            if lf is None or lf_trace_id is None:
                return
            try:
                sp = lf.span(name=name, trace_id=str(lf_trace_id), input=input, level=level)
                sp.end(output=output, status_message=status_message)
            except Exception:
                return

        def _lf_return(out: dict[str, Any]) -> dict[str, Any]:
            _langfuse_safe_update(lf_trace, output=out, status="success")
            _langfuse_flush(lf)
            return out

        last_user = ""
        for m in reversed(messages or []):
            if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                last_user = str(m.get("content") or "").strip()
                break

        # ── Pending confirmation (must run BEFORE any agent routing) ──
        # If the user is replying yes/no to a preview shown last turn,
        # short-circuit and execute (or cancel). Runs at the very top of
        # the request so neither the helper-agent nor orchestrator paths
        # can intercept "yes" first.
        pending_key = conv_id or (
            f"fallback:{user_id}:{household_id}" if user_id and household_id else ""
        )

        # Initialize facts_section early so it's available in the confirmation
        # handler (build it lazily only once we need it for formatting).
        facts_section = ""

        # ── Pending-confirmation branch (sync followup / accept / cancel) ──
        # Full flow extracted to orchestrator/confirmation.py. The handler
        # returns final response text to return, or None to signal "no
        # pending stashed" OR "user typed freeform" — in which case we
        # continue to the normal routing below.
        _pending_response = await handle_pending_confirmation(
            pending_key=pending_key,
            last_user=last_user,
            conv_id=conv_id,
            user_id=user_id,
            household_id=household_id,
            facts_section=facts_section,
            edge_execute_tools=_edge_execute_tools,
            lf_span=_lf_span,
        )
        if _pending_response is not None:
            return _lf_return({"ok": True, "text": _pending_response})

        # Detect onboarding mode early — skip helper-agent routing entirely.
        _early_onboarding = False
        if messages and isinstance(messages[0], dict):
            _sys0 = str(messages[0].get("content") or "")
            _early_onboarding = "ONBOARDING FLOW" in _sys0

        helper_intent = False if _early_onboarding else _get_helper_agent().is_intent(messages)
        _lf_span(
            "orchestrator.intent_route",
            input={"last_user": last_user[:600], "onboarding": _early_onboarding},
            output={"helper_intent": bool(helper_intent)},
        )
        try:
            dbg_raw = (os.environ.get("DEBUG_INTENT_ROUTING") or "").strip().lower()
            dbg = dbg_raw in {"1", "true", "yes", "y", "on"}
            if dbg:
                last_user = ""
                for m in reversed(messages or []):
                    if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                        last_user = str(m.get("content") or "").strip()
                        break
                _lf_span(
                    "orchestrator.intent_route",
                    input={"last_user": last_user[:600]},
                    output={"helper_intent": bool(helper_intent)},
                )
        except Exception:
            pass
        try:
            dbg_raw = (os.environ.get("DEBUG_INTENT_ROUTING") or "").strip().lower()
            dbg = dbg_raw in {"1", "true", "yes", "y", "on"}
            if dbg:
                last_user = ""
                for m in reversed(messages or []):
                    if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                        last_user = str(m.get("content") or "").strip()
                        break
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

        # ChoreAgent analytics shortcut dispatch — all 7 phase-6 analytics
        # shortcuts now live inside ChoreAgent.try_analytics_shortcut.
        # If the method returns kind="defer" we fall through to the rest
        # of the chore-domain flow (phases 7+).
        _chore_ctx = AgentContext(
            messages=messages,
            model=model,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            req_id=req_id,
            conv_id=conv_id,
            sess_id=sess_id,
            user_id=user_id,
            household_id=household_id,
            pending_key=pending_key,
            last_user_text=last_user,
            facts_section=facts_section,
            is_onboarding=_early_onboarding,
            chat_fn=_sarvam_chat,
            edge_execute_tools=_edge_execute_tools,
            lf_span=_lf_span,
        )
        _chore_result = await _get_chore_agent().try_analytics_shortcut(_chore_ctx)
        if _chore_result.kind != "defer":
            _lf_span(
                "orchestrator.deterministic.chore_agent_shortcut",
                output={"agent_result_kind": _chore_result.kind},
            )
            return _lf_return({"ok": True, "text": _chore_result.text or ""})

        if helper_intent:
            _lf_span(
                "orchestrator.route.helper_agent",
                output={"routed": True},
            )
            helper = await _get_helper_agent().run(
                messages=messages,
                model=model,
                temperature=req.temperature,
                max_tokens=req.max_tokens,
            )
            if helper is None:
                out = {"ok": True, "text": "I can help manage helpers. What exactly would you like to do?"}
                return _lf_return(out)

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
                return _lf_return({"ok": True, "text": _deterministic_trim_chain_of_thought("\n".join(lines).strip()) or "What would you like to do?"})

            if isinstance(tool_calls, list) and tool_calls:
                payload = {"tool_calls": tool_calls}
                return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

            safe_summary = _deterministic_trim_chain_of_thought(user_summary or "")
            return _lf_return({"ok": True, "text": safe_summary or "What would you like to do?"})

        # ── Orchestrator (manager loop) ─────────────────────────────────────────
        # Extract the latest user message once for the downstream phases.
        latest_user_text = ""
        for m in reversed(messages):
            if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                latest_user_text = str(m.get("content") or "").strip()
                break

        # ── apply_chore_assignments shortcut ──
        # "yes" / "create these assignments" → parse the previously-suggested
        # list and emit a single apply_chore_assignments RPC.
        _apply_resp = handle_apply_assignments(messages, latest_user_text, lf_span=_lf_span)
        if _apply_resp is not None:
            return _lf_return({"ok": True, "text": _apply_resp})

        # Phase 6b deterministic actions (assign/complete/reassign) — all
        # three regex-parsed shortcuts live in ChoreAgent. Rebuild ctx here
        # because last_user_text differs from `last_user` earlier in the
        # handler (this is the `latest_user_text` variant computed after
        # helper-agent dispatch).
        _chore_ctx_b = AgentContext(
            messages=messages,
            model=model,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            req_id=req_id,
            conv_id=conv_id,
            sess_id=sess_id,
            user_id=user_id,
            household_id=household_id,
            pending_key=pending_key,
            last_user_text=latest_user_text,
            facts_section=facts_section,
            is_onboarding=_early_onboarding,
            chat_fn=_sarvam_chat,
            edge_execute_tools=_edge_execute_tools,
            lf_span=_lf_span,
        )
        _chore_action = await _get_chore_agent().try_deterministic_action(_chore_ctx_b)
        if _chore_action.kind != "defer":
            _lf_span(
                "orchestrator.deterministic.chore_agent_action",
                output={"agent_result_kind": _chore_action.kind},
            )
            return _lf_return({"ok": True, "text": _chore_action.text or ""})

        # ── Schedule / space clarification + deterministic chore emission ──
        _schedule_resp = handle_schedule_and_space(messages, latest_user_text)
        if _schedule_resp is not None:
            return _lf_return({"ok": True, "text": _schedule_resp})

        # ── #1 + #2: FACTS injection + intent-specific instruction ────
        # Strict JSON output contract + FACTS block + classify_intent tailor
        # all moved to orchestrator/prompt_builder.py. The function takes the
        # incoming messages and returns (augmented_messages, facts_section,
        # intent_label) so downstream phases can validate IDs against FACTS
        # and telemetry can log the intent.
        last_user_text = ""
        for m in reversed(messages or []):
            if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                last_user_text = str(m["content"]).strip()
                break

        is_onboarding = False
        if messages and isinstance(messages[0], dict):
            sys_content = str(messages[0].get("content") or "")
            is_onboarding = "ONBOARDING FLOW" in sys_content

        messages, facts_section, intent = await build_system_prompt_augmentation(
            messages,
            household_id=household_id,
            user_id=user_id,
            last_user_text=last_user_text,
            is_onboarding=is_onboarding,
        )

        _lf_span(
            "orchestrator.hardening",
            input={"intent": intent, "facts_len": len(facts_section)},
        )

        # ── Phase 6d: pending-clarification + structured-extraction + plan-confirm-execute ──
        # The full flow (clarification substitution → re-run _intent_to_tool_calls
        # → stash confirmation → plan preview, or structured extraction → no-match
        # / plan-confirm-execute / immediate execute) now lives in
        # ChoreAgent.try_structured_extraction_flow. We build an AgentContext
        # so the method can reach ctx.chat_fn / ctx.edge_execute_tools / ctx.lf_span
        # and propagate test patches.
        _ctx_6d = AgentContext(
            messages=messages,
            model=model,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            req_id=req_id,
            conv_id=conv_id,
            sess_id=sess_id,
            user_id=user_id,
            household_id=household_id,
            pending_key=pending_key,
            last_user_text=last_user_text,
            facts_section=facts_section,
            is_onboarding=is_onboarding,
            chat_fn=_sarvam_chat,
            edge_execute_tools=_edge_execute_tools,
            lf_span=_lf_span,
        )
        _6d_result = await _get_chore_agent().try_structured_extraction_flow(
            _ctx_6d,
            intent_to_tool_calls_fn=_intent_to_tool_calls,
        )
        if _6d_result.kind == "text":
            return _lf_return({"ok": True, "text": _6d_result.text or ""})

        # ── Main LLM orchestrator loop ──
        # Everything from "prompt is augmented" through "final_text to
        # return" lives in orchestrator.llm_loop. Takes the augmented
        # messages, runs the initial LLM call + parse/repair/regen, the
        # tool-call validation/execution/followup/judge branch, the
        # final-text hallucination-override + guardrails + judge branch,
        # and returns the final text string.
        def _needs_fetch_override(t: str) -> bool:
            return (
                _needs_helpers_fetch_override(t)
                or _needs_chores_fetch_override(t)
                or _needs_spaces_fetch_override(t)
            )

        _final_text = await run_llm_loop(
            messages=messages,
            model=model,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            conv_id=conv_id,
            user_id=user_id,
            household_id=household_id,
            last_user_text=last_user_text,
            facts_section=facts_section,
            chat_fn=_sarvam_chat,
            edge_execute_tools=_edge_execute_tools,
            judge_fn=_judge_response,
            summarize_history=_summarize_history_if_needed,
            needs_fetch_override=_needs_fetch_override,
            lf_span=_lf_span,
        )
        return _lf_return({"ok": True, "text": _final_text})


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




def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()




def _pick_helper_for_cleaning(
    *,
    helpers: list[dict[str, Any]],
    helper_time_off: list[dict[str, Any]],
) -> tuple[Optional[str], Optional[str]]:
    on_leave: set[str] = set()
    for r in helper_time_off:
        hid = r.get("helper_id")
        if isinstance(hid, str) and hid.strip():
            on_leave.add(hid.strip())

    for h in helpers:
        hid = h.get("id")
        if isinstance(hid, str) and hid.strip() and hid not in on_leave:
            return hid, None
    if helpers:
        return None, "helper_on_leave"
    return None, "no_helpers"


def _visitor_cleaning_templates(
    *,
    feedback_rating: Optional[int],
    visitors_metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    # Minimal deterministic set; we can expand later with spaces/home profile.
    base: list[dict[str, Any]] = [
        {"title": "Clean bathrooms", "minutes": 45, "priority": 3, "tags": ["bathroom"]},
        {"title": "Vacuum living room", "minutes": 30, "priority": 2, "tags": ["living_room"]},
        {"title": "Dust common areas", "minutes": 20, "priority": 2, "tags": ["dusting"]},
        {"title": "Mop floors (common areas)", "minutes": 30, "priority": 2, "tags": ["floors"]},
        {"title": "Tidy entryway", "minutes": 10, "priority": 1, "tags": ["entry"]},
    ]

    expected_count = visitors_metadata.get("expected_count")
    if isinstance(expected_count, (int, float)) and expected_count >= 6:
        base.append({"title": "Clean kitchen surfaces", "minutes": 20, "priority": 2, "tags": ["kitchen"]})

    if feedback_rating is not None and feedback_rating <= 2:
        # When feedback is poor, add one extra deep-clean task.
        base.insert(0, {"title": "Deep clean bathrooms (scrub tiles + fixtures)", "minutes": 60, "priority": 3, "tags": ["bathroom", "deep_clean"]})

    return base


@app.post("/v1/runs/start")
async def runs_start(req: RunStartRequest, request: Request) -> dict[str, Any]:
    try:
        if req.mode != "propose":
            raise RuntimeError("agent-service only supports mode=propose")

        await _edge_post(
            "/agents/runs/events/append",
            {
                "run_id": req.run_id,
                "node_key": "runner",
                "level": "info",
                "event_type": "run_started",
                "payload": {
                    "graph_key": req.graph_key,
                    "trigger": req.trigger,
                    "mode": req.mode,
                },
            },
        )

        await _edge_post(
            "/agents/runs/update",
            {
                "run_id": req.run_id,
                "status": "running",
                "started_at": datetime.now(timezone.utc).isoformat(),
            },
        )

        graph_key = req.graph_key.strip()
        if not (graph_key == "chores.manage_v1" or graph_key.startswith("chores.") or graph_key.startswith("signals.")):
            raise RuntimeError("Unsupported graph_key")

        if graph_key == "chores.visitors_cleaning_v1":
            state: dict[str, Any] = {
                "input": req.input,
                "signals": None,
                "plan_items": [],
                "actions": [],
                "confirm_text": "",
                "llm_advice": "",
            }

            async def fetch_signals_node(s: dict[str, Any]) -> dict[str, Any]:
                data = await _edge_get(
                    "/agents/signals/chores-v1",
                    {
                        "household_id": req.household_id,
                        "window_hours": "48",
                    },
                )
                try:
                    await _edge_post(
                        "/agents/runs/events/append",
                        {
                            "run_id": req.run_id,
                            "node_key": "signals",
                            "level": "info",
                            "event_type": "signals_snapshot",
                            "payload": {
                                "has_visitors": bool(data.get("visitors_event")),
                                "has_feedback": bool(data.get("cleaning_feedback")),
                                "helpers_count": len(data.get("helpers") or []),
                                "time_off_count": len(data.get("helper_time_off") or []),
                            },
                        },
                    )
                except Exception:
                    pass
                return {"signals": data}

            async def compute_plan_node(s: dict[str, Any]) -> dict[str, Any]:
                signals = s.get("signals") if isinstance(s.get("signals"), dict) else {}
                visitors = signals.get("visitors_event") if isinstance(signals.get("visitors_event"), dict) else None
                feedback = signals.get("cleaning_feedback") if isinstance(signals.get("cleaning_feedback"), dict) else None
                helpers = signals.get("helpers") if isinstance(signals.get("helpers"), list) else []
                time_off = signals.get("helper_time_off") if isinstance(signals.get("helper_time_off"), list) else []

                if not visitors:
                    # If there is no visitor event in the window, return an empty proposal.
                    return {
                        "plan_items": [],
                        "confirm_text": "No visitor events found in the next 48 hours, so I won't add any cleaning chores.",
                    }

                start_at = visitors.get("start_at")
                if not isinstance(start_at, str) or not start_at.strip():
                    return {
                        "plan_items": [],
                        "confirm_text": "Visitor event is missing a start time, so I won't add any cleaning chores.",
                    }

                try:
                    visitor_dt = datetime.fromisoformat(start_at.replace("Z", "+00:00"))
                except Exception:
                    visitor_dt = datetime.now(timezone.utc)

                due_dt = visitor_dt - timedelta(hours=6)  # 6 hours before visitors
                due_at = _iso(due_dt)

                rating: Optional[int] = None
                if feedback and isinstance(feedback.get("rating"), (int, float)):
                    rating = int(feedback.get("rating"))
                visitors_meta = visitors.get("metadata") if isinstance(visitors.get("metadata"), dict) else {}

                helper_id, helper_unassigned_reason = _pick_helper_for_cleaning(
                    helpers=helpers,
                    helper_time_off=time_off,
                )

                templates = _visitor_cleaning_templates(
                    feedback_rating=rating,
                    visitors_metadata=visitors_meta,
                )

                plan_items: list[dict[str, Any]] = []
                for t in templates:
                    meta: dict[str, Any] = {
                        "category": "cleaning",
                        "source": "visitors_cleaning_v1",
                        "event_id": visitors.get("id"),
                        "planned_minutes": t.get("minutes"),
                        "tags": t.get("tags"),
                        "helper_unassigned_reason": helper_unassigned_reason,
                        "rationale": "Visitors arriving soon; prep cleaning.",
                    }
                    plan_items.append(
                        {
                            "title": t.get("title"),
                            "priority": t.get("priority", 1),
                            "due_at": due_at,
                            "helper_id": helper_id,
                            "metadata": meta,
                        }
                    )

                preview = [p.get("title") for p in plan_items][:10]
                try:
                    await _edge_post(
                        "/agents/runs/events/append",
                        {
                            "run_id": req.run_id,
                            "node_key": "planner",
                            "level": "info",
                            "event_type": "plan_preview",
                            "payload": {"count": len(plan_items), "titles": preview, "due_at": due_at},
                        },
                    )
                except Exception:
                    pass

                confirm = f"I can add {len(plan_items)} visitor-prep cleaning chores due before {start_at}. Do you want me to propose these chores?"
                return {"plan_items": plan_items, "confirm_text": confirm}

            async def llm_advice_node(s: dict[str, Any]) -> dict[str, Any]:
                plan_items = s.get("plan_items") if isinstance(s.get("plan_items"), list) else []
                signals = s.get("signals") if isinstance(s.get("signals"), dict) else {}
                visitors = signals.get("visitors_event") if isinstance(signals.get("visitors_event"), dict) else None
                feedback = signals.get("cleaning_feedback") if isinstance(signals.get("cleaning_feedback"), dict) else None
                if not visitors or not plan_items:
                    # Explicitly carry forward plan_items/confirm_text so downstream nodes never lose them.
                    confirm_text = s.get("confirm_text") if isinstance(s.get("confirm_text"), str) else ""
                    return {"llm_advice": "", "plan_items": plan_items, "confirm_text": confirm_text}

                prompt = (
                    "You are a home ops cleaning advisor. "
                    "Given an upcoming visitors event and a draft visitor-prep cleaning plan, provide concise advice only. "
                    "Do NOT output JSON. Do NOT propose tool calls. "
                    "Return 3-6 short bullets: (a) missing tasks if any, (b) priority tweaks if needed, (c) a short rationale summary." 
                )
                user_text = f"Visitors event: {visitors}\nLast cleaning feedback: {feedback}\nDraft plan titles: {[p.get('title') for p in plan_items]}"
                advice = await _sarvam_chat(
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": user_text},
                    ],
                    model=SARVAM_MODEL_DEFAULT,
                    temperature=0.2,
                    max_tokens=300,
                )
                advice = advice.strip()
                try:
                    await _edge_post(
                        "/agents/runs/events/append",
                        {
                            "run_id": req.run_id,
                            "node_key": "advisor",
                            "level": "info",
                            "event_type": "llm_advice",
                            "payload": {"model": SARVAM_MODEL_DEFAULT, "text_preview": advice[:800]},
                        },
                    )
                except Exception:
                    pass
                confirm_text = s.get("confirm_text") if isinstance(s.get("confirm_text"), str) else ""
                return {"llm_advice": advice, "plan_items": plan_items, "confirm_text": confirm_text}

            async def compile_actions_node(s: dict[str, Any]) -> dict[str, Any]:
                plan_items = s.get("plan_items") if isinstance(s.get("plan_items"), list) else []
                if not plan_items:
                    return {"actions": [], "confirm_text": s.get("confirm_text") or "No chores to propose."}

                try:
                    await _edge_post(
                        "/agents/runs/events/append",
                        {
                            "run_id": req.run_id,
                            "node_key": "compile",
                            "level": "info",
                            "event_type": "compile_inputs",
                            "payload": {
                                "plan_items_count": len(plan_items),
                                "first_item_keys": list(plan_items[0].keys()) if isinstance(plan_items[0], dict) else None,
                            },
                        },
                    )
                except Exception:
                    pass

                llm_advice = s.get("llm_advice") if isinstance(s.get("llm_advice"), str) else ""
                actions: list[ProposedAction] = []
                for i, p in enumerate(plan_items):
                    if not isinstance(p, dict):
                        continue

                    title = p.get("title")
                    if title is None:
                        continue

                    if not isinstance(title, str):
                        try:
                            title = str(title)
                        except Exception:
                            continue

                    if not title.strip():
                        continue
                    record: dict[str, Any] = {
                        "title": title.strip(),
                        "status": "pending",
                        "due_at": p.get("due_at"),
                        "priority": p.get("priority"),
                        "metadata": p.get("metadata"),
                    }

                    helper_id_val = p.get("helper_id")
                    if isinstance(helper_id_val, str) and helper_id_val.strip():
                        record["helper_id"] = helper_id_val.strip()
                    reason = "Visitor-prep cleaning plan."
                    if llm_advice:
                        reason = f"{reason} Advisor notes: {llm_advice[:220]}"
                    actions.append(
                        ProposedAction(
                            id=f"chores_visitors_cleaning_{i}_{uuid.uuid4().hex}",
                            tool="db.insert",
                            args={"table": "chores", "record": record},
                            reason=reason,
                        )
                    )

                try:
                    await _edge_post(
                        "/agents/runs/events/append",
                        {
                            "run_id": req.run_id,
                            "node_key": "compile",
                            "level": "info",
                            "event_type": "compile_outputs",
                            "payload": {"actions_count": len(actions)},
                        },
                    )
                except Exception:
                    pass

                confirm_text = s.get("confirm_text") if isinstance(s.get("confirm_text"), str) else "Do you want me to propose these chores?"
                if llm_advice:
                    confirm_text = f"{confirm_text}\n\nAdvisor notes:\n{llm_advice}".strip()

                return {"actions": actions, "confirm_text": confirm_text}

            g = StateGraph(dict)
            g.add_node("signals", fetch_signals_node)
            g.add_node("planner", compute_plan_node)
            g.add_node("advisor", llm_advice_node)
            g.add_node("compile", compile_actions_node)
            g.set_entry_point("signals")
            g.add_edge("signals", "planner")
            g.add_edge("planner", "advisor")
            g.add_edge("advisor", "compile")
            g.add_edge("compile", END)
            compiled = g.compile()

            result = await compiled.ainvoke(state)
            proposed_actions = result.get("actions")
            confirm_text = result.get("confirm_text")

            if not isinstance(proposed_actions, list):
                raise RuntimeError("Invalid proposal actions")
            if not isinstance(confirm_text, str):
                confirm_text = "Do you want me to apply these chore changes?"

            output = ProposalOutput(confirm_text=confirm_text, proposed_actions=proposed_actions)

            await _edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "runner",
                    "level": "info",
                    "event_type": "proposed_actions_created",
                    "payload": {"count": len(output.proposed_actions)},
                },
            )

            await _edge_post(
                "/agents/runs/update",
                {
                    "run_id": req.run_id,
                    "status": "succeeded",
                    "ended_at": datetime.now(timezone.utc).isoformat(),
                    "output": output.model_dump(),
                },
            )

            await _edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "runner",
                    "level": "info",
                    "event_type": "awaiting_user_confirmation",
                    "payload": {"mode": "propose"},
                },
            )

            await _edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "runner",
                    "level": "info",
                    "event_type": "run_completed",
                    "payload": {"status": "succeeded"},
                },
            )

            return {"ok": True, "run_id": req.run_id}

        if graph_key == "signals.capture_v1":
            state: dict[str, Any] = {
                "input": req.input,
                "timezone": "Asia/Kolkata",
                "actions": [],
                "confirm_text": "",
            }

            async def fetch_timezone_node(s: dict[str, Any]) -> dict[str, Any]:
                tz = "Asia/Kolkata"
                try:
                    data = await _edge_get(
                        "/agents/household/timezone",
                        {
                            "household_id": req.household_id,
                        },
                    )
                    if isinstance(data, dict) and isinstance(data.get("timezone"), str) and data.get("timezone").strip():
                        tz = data.get("timezone").strip()
                except Exception:
                    tz = "Asia/Kolkata"
                # Preserve input so downstream nodes can read chat text.
                return {"timezone": tz, "input": s.get("input")}

            async def parse_and_compile_node(s: dict[str, Any]) -> dict[str, Any]:
                tz = s.get("timezone") if isinstance(s.get("timezone"), str) else "Asia/Kolkata"

                inp = s.get("input") if isinstance(s.get("input"), dict) else {}
                text = ""
                for k in ("text", "message", "user_text", "prompt"):
                    v = inp.get(k)
                    if isinstance(v, str) and v.strip():
                        text = v.strip()
                        break
                if not text:
                    return {"actions": [], "confirm_text": "I didn't receive any text to record. Please describe the event or feedback."}

                lower = text.lower()
                actions: list[ProposedAction] = []

                if SARVAM_API_KEY:
                    now_utc = datetime.now(timezone.utc)
                    if ZoneInfo is not None:
                        try:
                            now_local = now_utc.astimezone(ZoneInfo(tz)).replace(tzinfo=None)
                        except Exception:
                            now_local = now_utc.astimezone(timezone.utc).replace(tzinfo=None)
                    else:
                        now_local = now_utc.astimezone(timezone.utc).replace(tzinfo=None)
                    schema_prompt = (
                        "You extract household signals from chat into strict JSON. "
                        "Return ONLY a <json> object.</json> block. "
                        "If no signal is present, return {\"kind\":\"none\"}. "
                        "Supported kinds: household_event, cleaning_feedback. "
                        "For household_event, return: {"
                        "\"kind\":\"household_event\",\"type\":string,\"start_local\":string,\"end_local\":string|null,\"title\":string|null,\"notes\":string|null,\"expected_count\":number|null,\"spaces\":array<string>|null}. "
                        "For cleaning_feedback, return: {\"kind\":\"cleaning_feedback\",\"rating\":number,\"notes\":string|null,\"areas\":object|array|null}. "
                        "Interpret relative dates like 'day after tomorrow' using the provided now_local. "
                        "Time can be 24h like 19:31. "
                        "start_local/end_local must be in format YYYY-MM-DDTHH:MM (no timezone). "
                        "If the user mentions visiting/staying/guests, map to household_event type 'visitors'."
                    )
                    user_ctx = f"timezone={tz}; now_local={now_local.strftime('%Y-%m-%dT%H:%M')}; text={text}"
                    try:
                        raw = await _sarvam_chat(
                            messages=[
                                {"role": "system", "content": schema_prompt},
                                {"role": "user", "content": user_ctx},
                            ],
                            model=SARVAM_MODEL_DEFAULT,
                            temperature=0.0,
                            max_tokens=450,
                        )
                        parsed = _safe_json_loads(raw)
                        if isinstance(parsed, dict) and parsed.get("kind") == "household_event":
                            start_local_raw = parsed.get("start_local")
                            end_local_raw = parsed.get("end_local")
                            if isinstance(start_local_raw, str) and start_local_raw.strip():
                                try:
                                    start_local = datetime.fromisoformat(start_local_raw.strip())
                                except Exception:
                                    start_local = None
                            else:
                                start_local = None
                            if isinstance(end_local_raw, str) and end_local_raw.strip():
                                try:
                                    end_local = datetime.fromisoformat(end_local_raw.strip())
                                except Exception:
                                    end_local = None
                            else:
                                end_local = None

                            if start_local is not None:
                                start_at = _local_dt_to_utc_iso(start_local, tz)
                                end_at = _local_dt_to_utc_iso(end_local, tz) if end_local is not None else None
                                meta: dict[str, Any] = {
                                    "source": "chat",
                                    "timezone_used": tz,
                                    "raw_text": text,
                                }
                                title = parsed.get("title")
                                if isinstance(title, str) and title.strip():
                                    meta["title"] = title.strip()
                                notes = parsed.get("notes")
                                if isinstance(notes, str) and notes.strip():
                                    meta["notes"] = notes.strip()
                                expected_count = parsed.get("expected_count")
                                if isinstance(expected_count, (int, float)):
                                    meta["expected_count"] = int(expected_count)
                                spaces = parsed.get("spaces")
                                if isinstance(spaces, list):
                                    cleaned_spaces = [str(x).strip() for x in spaces if isinstance(x, (str, int, float)) and str(x).strip()]
                                    if cleaned_spaces:
                                        meta["spaces"] = cleaned_spaces

                                ev_type = parsed.get("type")
                                if not isinstance(ev_type, str) or not ev_type.strip():
                                    ev_type = "visitors"

                                rec2: dict[str, Any] = {
                                    "type": ev_type.strip(),
                                    "start_at": start_at,
                                    "end_at": end_at,
                                    "metadata": meta,
                                }
                                actions.append(
                                    ProposedAction(
                                        id=f"signals_household_event_{uuid.uuid4().hex}",
                                        tool="db.insert",
                                        args={"table": "household_events", "record": rec2},
                                        reason="Record household event from chat.",
                                    )
                                )

                        if isinstance(parsed, dict) and parsed.get("kind") == "cleaning_feedback":
                            rating = parsed.get("rating")
                            if isinstance(rating, (int, float)):
                                r_int = int(rating)
                                if 1 <= r_int <= 5:
                                    rec: dict[str, Any] = {
                                        "rating": r_int,
                                        "notes": parsed.get("notes") if isinstance(parsed.get("notes"), str) else text,
                                        "areas": parsed.get("areas"),
                                        "metadata": {
                                            "source": "chat",
                                            "timezone_used": tz,
                                            "raw_text": text,
                                        },
                                    }
                                    actions.append(
                                        ProposedAction(
                                            id=f"signals_cleaning_feedback_{uuid.uuid4().hex}",
                                            tool="db.insert",
                                            args={"table": "cleaning_feedback", "record": rec},
                                            reason="Record cleaning feedback from chat.",
                                        )
                                    )
                    except Exception:
                        pass

                # Cleaning feedback capture.
                rating: Optional[int] = None
                m = re.search(r"\b([1-5])\s*/\s*5\b", lower)
                if m:
                    rating = int(m.group(1))
                if rating is None:
                    m2 = re.search(r"\brating\s*[:=]?\s*([1-5])\b", lower)
                    if m2:
                        rating = int(m2.group(1))

                if rating is not None and ("clean" in lower or "cleaning" in lower or "feedback" in lower or "house" in lower):
                    rec: dict[str, Any] = {
                        "rating": rating,
                        "notes": text,
                        "areas": None,
                        "metadata": {
                            "source": "chat",
                            "timezone_used": tz,
                            "raw_text": text,
                        },
                    }
                    actions.append(
                        ProposedAction(
                            id=f"signals_cleaning_feedback_{uuid.uuid4().hex}",
                            tool="db.insert",
                            args={"table": "cleaning_feedback", "record": rec},
                            reason="Record cleaning feedback from chat.",
                        )
                    )

                # Household event capture (visitors by default if user mentions guests/visitors).
                if any(w in lower for w in ("visitor", "visitors", "guest", "guests", "people coming", "coming over")):
                    now_utc = datetime.now(timezone.utc)
                    if ZoneInfo is not None:
                        try:
                            now_local = now_utc.astimezone(ZoneInfo(tz)).replace(tzinfo=None)
                        except Exception:
                            now_local = now_utc.astimezone(timezone.utc).replace(tzinfo=None)
                    else:
                        now_local = now_utc.astimezone(timezone.utc).replace(tzinfo=None)
                    start_local, end_local, note = _parse_event_time(text, now_local=now_local)
                    if start_local is None:
                        return {
                            "actions": actions,
                            "confirm_text": "I can record this visitors event, but I need a date/time. Try: 'Visitors tomorrow 7pm to 10pm'.",
                        }
                    start_at = _local_dt_to_utc_iso(start_local, tz)
                    end_at = _local_dt_to_utc_iso(end_local, tz) if end_local else None
                    meta: dict[str, Any] = {
                        "source": "chat",
                        "timezone_used": tz,
                        "raw_text": text,
                        "parse_note": note,
                    }
                    rec2: dict[str, Any] = {
                        "type": "visitors",
                        "start_at": start_at,
                        "end_at": end_at,
                        "metadata": meta,
                    }
                    actions.append(
                        ProposedAction(
                            id=f"signals_household_event_{uuid.uuid4().hex}",
                            tool="db.insert",
                            args={"table": "household_events", "record": rec2},
                            reason="Record household event from chat.",
                        )
                    )

                if not actions:
                    return {
                        "actions": [],
                        "confirm_text": "I can record (a) visitors/events or (b) cleaning feedback. Try: 'Visitors tomorrow 7pm to 10pm' or 'Cleaning feedback 3/5: bathrooms ok'.",
                    }

                confirm = "I can record this as a household signal. Do you want me to propose these changes?"
                return {"actions": actions, "confirm_text": confirm}

            g = StateGraph(dict)
            g.add_node("tz", fetch_timezone_node)
            g.add_node("parse", parse_and_compile_node)
            g.set_entry_point("tz")
            g.add_edge("tz", "parse")
            g.add_edge("parse", END)
            compiled = g.compile()

            result = await compiled.ainvoke(state)
            proposed_actions = result.get("actions")
            confirm_text = result.get("confirm_text")
            if not isinstance(proposed_actions, list):
                raise RuntimeError("Invalid proposal actions")
            if not isinstance(confirm_text, str):
                confirm_text = "Do you want me to apply these changes?"

            output = ProposalOutput(confirm_text=confirm_text, proposed_actions=proposed_actions)

            await _edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "runner",
                    "level": "info",
                    "event_type": "proposed_actions_created",
                    "payload": {"count": len(output.proposed_actions)},
                },
            )

            await _edge_post(
                "/agents/runs/update",
                {
                    "run_id": req.run_id,
                    "status": "succeeded",
                    "ended_at": datetime.now(timezone.utc).isoformat(),
                    "output": output.model_dump(),
                },
            )

            await _edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "runner",
                    "level": "info",
                    "event_type": "awaiting_user_confirmation",
                    "payload": {"mode": "propose"},
                },
            )

            await _edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "runner",
                    "level": "info",
                    "event_type": "run_completed",
                    "payload": {"status": "succeeded"},
                },
            )

            return {"ok": True, "run_id": req.run_id}

        state: dict[str, Any] = {
            "input": req.input,
            "raw_text": "",
            "actions": [],
        }

        async def planner_node(s: dict[str, Any]) -> dict[str, Any]:
            prompt = (
                "You are a home operations assistant focused on chores. "
                "Generate a proposal ONLY (no execution). "
                "Return JSON ONLY. Do not include <think> tags, markdown, code fences, or commentary. "
                "Your entire response MUST be exactly one <json>...</json> block and nothing else. "
                "Inside <json>, return ONE JSON object only. "
                "The JSON object must have keys: proposed_actions (array), confirm_text (string). "
                "Each proposed action must have keys: id (string), tool (one of db.insert/db.update/db.delete), args (object), reason (string optional). "
                "Allowed table is ONLY 'chores'. "
                "For db.insert args must include: {table:'chores', record:{title:string, status?:string, due_at?:string, helper_id?:string, user_id?:string}}. "
                "For db.update args must include: {table:'chores', id:string, patch:{...}}. "
                "For db.delete args must include: {table:'chores', id:string}."
            )
            user_text = f"Input: {s.get('input', {})}"
            text = await _sarvam_chat(
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": user_text},
                ],
                model=SARVAM_MODEL_DEFAULT,
                temperature=0.2,
                max_tokens=700,
            )

            try:
                await _edge_post(
                    "/agents/runs/events/append",
                    {
                        "run_id": req.run_id,
                        "node_key": "planner",
                        "level": "info",
                        "event_type": "llm_raw_preview",
                        "payload": {
                            "model": SARVAM_MODEL_DEFAULT,
                            "text_preview": text[:500],
                        },
                    },
                )
            except Exception:
                pass

            return {"raw_text": text}

        async def parse_and_validate_node(s: dict[str, Any]) -> dict[str, Any]:
            raw_text = str(s.get("raw_text", ""))
            try:
                proposal = _parse_proposal_from_raw_text(raw_text)
            except Exception as e:
                # Second-pass formatter: force strict extraction by requiring <json>...</json>
                try:
                    formatter_prompt = (
                        "You are a formatter. Output ONLY a <json>...</json> block and nothing else. "
                        "Do not include <think> tags, markdown, code fences, or commentary. "
                        "Inside <json>, output ONE JSON object with keys: proposed_actions (array), confirm_text (string). "
                        "Each proposed action must have keys: id (string), tool (db.insert/db.update/db.delete), args (object), reason (string optional). "
                        "Allowed table is ONLY 'chores'."
                    )
                    formatted = await _sarvam_chat(
                        messages=[
                            {"role": "system", "content": formatter_prompt},
                            {"role": "user", "content": f"Rewrite the following into the required <json> block:\n\n{raw_text}"},
                        ],
                        model=SARVAM_MODEL_DEFAULT,
                        temperature=0.0,
                        max_tokens=450,
                    )

                    try:
                        await _edge_post(
                            "/agents/runs/events/append",
                            {
                                "run_id": req.run_id,
                                "node_key": "formatter",
                                "level": "info",
                                "event_type": "llm_formatter_preview",
                                "payload": {
                                    "model": SARVAM_MODEL_DEFAULT,
                                    "text_preview": formatted[:500],
                                },
                            },
                        )
                    except Exception:
                        pass

                    proposal2 = _parse_proposal_from_raw_text(formatted)
                    return {"actions": proposal2.proposed_actions, "confirm_text": proposal2.confirm_text}
                except Exception:
                    pass

                input_obj = s.get("input") if isinstance(s.get("input"), dict) else {}
                # LangGraph state should retain the original input, but if it doesn't,
                # fall back to the authoritative request input from the run start request.
                if (not isinstance(input_obj.get("request"), str) or not str(input_obj.get("request")).strip()) and isinstance(req.input, dict):
                    input_obj = req.input

                fallback = _fallback_chore_proposal(input_obj)
                try:
                    req_preview = ""
                    if isinstance(input_obj, dict) and isinstance(input_obj.get("request"), str):
                        req_preview = str(input_obj.get("request"))[:200]

                    await _edge_post(
                        "/agents/runs/events/append",
                        {
                            "run_id": req.run_id,
                            "node_key": "validate",
                            "level": "warn",
                            "event_type": "guardrail_triggered",
                            "payload": {
                                "kind": "llm_non_json_fallback",
                                "error": str(e),
                                "request_preview": req_preview,
                                "input_keys": list(input_obj.keys()) if isinstance(input_obj, dict) else None,
                                "extracted_title": fallback.proposed_actions[0].args.get("record", {}).get("title")
                                if fallback.proposed_actions and isinstance(fallback.proposed_actions[0].args.get("record"), dict)
                                else None,
                            },
                        },
                    )
                except Exception:
                    pass
                return {"actions": fallback.proposed_actions, "confirm_text": fallback.confirm_text}
            return {"actions": proposal.proposed_actions, "confirm_text": proposal.confirm_text}

        g = StateGraph(dict)
        g.add_node("planner", planner_node)
        g.add_node("validate", parse_and_validate_node)
        g.set_entry_point("planner")
        g.add_edge("planner", "validate")
        g.add_edge("validate", END)
        compiled = g.compile()

        await _edge_post(
            "/agents/runs/events/append",
            {
                "run_id": req.run_id,
                "node_key": "graph",
                "level": "info",
                "event_type": "node_started",
                "payload": {"node": "planner"},
            },
        )

        result = await compiled.ainvoke(state)

        await _edge_post(
            "/agents/runs/events/append",
            {
                "run_id": req.run_id,
                "node_key": "graph",
                "level": "info",
                "event_type": "node_completed",
                "payload": {"node": "planner"},
            },
        )

        proposed_actions = result.get("actions")
        confirm_text = result.get("confirm_text")
        if not isinstance(proposed_actions, list):
            raise RuntimeError("Invalid proposal actions")
        if not isinstance(confirm_text, str):
            confirm_text = "Do you want me to apply these chore changes?"

        output = ProposalOutput(confirm_text=confirm_text, proposed_actions=proposed_actions)

        await _edge_post(
            "/agents/runs/events/append",
            {
                "run_id": req.run_id,
                "node_key": "runner",
                "level": "info",
                "event_type": "proposed_actions_created",
                "payload": {"count": len(output.proposed_actions)},
            },
        )

        await _edge_post(
            "/agents/runs/update",
            {
                "run_id": req.run_id,
                "status": "succeeded",
                "ended_at": datetime.now(timezone.utc).isoformat(),
                "output": output.model_dump(),
            },
        )

        await _edge_post(
            "/agents/runs/events/append",
            {
                "run_id": req.run_id,
                "node_key": "runner",
                "level": "info",
                "event_type": "awaiting_user_confirmation",
                "payload": {"mode": "propose"},
            },
        )

        await _edge_post(
            "/agents/runs/events/append",
            {
                "run_id": req.run_id,
                "node_key": "runner",
                "level": "info",
                "event_type": "run_completed",
                "payload": {"status": "succeeded"},
            },
        )

        return {"ok": True, "run_id": req.run_id}

    except Exception as e:
        try:
            await _edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "runner",
                    "level": "error",
                    "event_type": "runner_error",
                    "payload": {
                        "error": str(e),
                    },
                },
            )
        except Exception:
            pass
        # Best-effort mark failed
        try:
            await _edge_post(
                "/agents/runs/update",
                {
                    "run_id": req.run_id,
                    "status": "failed",
                    "ended_at": datetime.now(timezone.utc).isoformat(),
                    "error": str(e),
                },
            )
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/v1/runs/{run_id}")
async def get_run(run_id: str) -> RunStatusResponse:
    # The source of truth is Supabase via Edge; this endpoint is a placeholder.
    # For v1, you can omit this and rely on /agents/runs/:id.
    return RunStatusResponse(run_id=run_id, status="queued")
