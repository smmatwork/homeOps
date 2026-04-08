import os
import json
import re
import uuid
import math
import logging
import contextvars
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

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

try:
    from langfuse import Langfuse  # type: ignore
except Exception:  # pragma: no cover
    Langfuse = None  # type: ignore

try:
    from dotenv import load_dotenv  # type: ignore

    _env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(dotenv_path=_env_path, override=True)
except Exception:
    pass


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


_logger = logging.getLogger("homeops.agent_service")
if not _logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s request_id=%(request_id)s conversation_id=%(conversation_id)s session_id=%(session_id)s user_id=%(user_id)s trace_id=%(trace_id)s %(message)s"
        )
    )
    _logger.addHandler(handler)
    _logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    _logger.addFilter(_CorrelationFilter())
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
    host = (_env("LANGFUSE_HOST") or "").strip()
    if not public_key or not secret_key:
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


def _strip_think_blocks(text: str) -> str:
    # Remove common chain-of-thought wrappers returned by some chat models.
    s = text or ""
    try:
        s = re.sub(r"<think>.*?</think>\s*", "", s, flags=re.DOTALL | re.IGNORECASE)
        s = re.sub(r"<analysis>.*?</analysis>\s*", "", s, flags=re.DOTALL | re.IGNORECASE)
        s = re.sub(r"^\s*(thinking|thought|analysis|reasoning)\s*:\s*", "", s, flags=re.IGNORECASE)
    except Exception:
        pass
    return s.strip()


def _deterministic_trim_chain_of_thought(text: str) -> str:
    s = _strip_think_blocks(text)
    if not s:
        return s

    lower = s.lower()
    if not _looks_like_chain_of_thought(lower):
        return s

    # Strategy:
    # 1) If there are multiple paragraphs, drop earlier paragraphs that look like meta reasoning.
    # 2) Remove common reasoning lead-in sentences.
    # 3) As a last deterministic resort, keep the last paragraph.
    parts = [p.strip() for p in re.split(r"\n\s*\n", s) if p.strip()]
    if len(parts) >= 2:
        kept: list[str] = []
        for p in parts:
            if _looks_like_chain_of_thought(p):
                continue
            kept.append(p)
        if kept:
            s = "\n\n".join(kept).strip()

    # Remove common meta-reasoning sentence prefixes.
    lines = [ln.strip() for ln in s.splitlines()]
    drop_prefixes = (
        "okay, the user",
        "the user wants",
        "the user asked",
        "the user hasn't",
        "the user has not",
        "the latest user message",
        "the user's last message",
        "looking back,",
        "wait,",
        "wait ",
        "but wait,",
        "but wait ",
        "let me break this down",
        "let me think",
        "first,",
        "next,",
        "now, i need to",
        "i need to",
        "here's my plan",
        "here is my plan",
        "alternatively,",
        "alternatively ",
        "maybe the system",
        "maybe this",
        "issues:",
    )
    while lines:
        head = lines[0].lower().lstrip("- ").strip()
        if any(head.startswith(p) for p in drop_prefixes):
            lines.pop(0)
            continue
        break
    s2 = "\n".join(lines).strip()

    if s2 and not _looks_like_chain_of_thought(s2):
        return s2

    # Final deterministic fallback: keep last paragraph.
    if parts:
        last = parts[-1].strip()
        if last:
            return last
    return s2 or s


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
    after = re.split(r"[\n,;]|\s+and\s+|\s+with\s+|\s+in\s+|\s+for\s+", after, maxsplit=1)[0].strip()
    if not after or len(after) > 80:
        return ""
    return after


def _try_normalize_tool_calls_block(text: str) -> str:
    """If text contains a tool_calls JSON payload, normalize it to a well-formed fenced ```json block.

    This prevents UI issues when the model emits an opening ```json fence without a closing fence or
    otherwise malformed wrapping that causes parsing/rendering to fail.
    """

    raw = (text or "").strip()
    if not raw:
        return raw

    # Fast check before doing any heavier parsing.
    lowered = raw.lower()
    if "tool_calls" not in lowered:
        return raw

    obj: Any = None
    try:
        obj = _safe_json_loads(raw)
    except Exception:
        obj = None
    if not isinstance(obj, dict):
        return raw

    tc = obj.get("tool_calls")
    if not isinstance(tc, list) or not tc:
        return raw
    for t in tc:
        if not isinstance(t, dict):
            return raw
        if not isinstance(t.get("id"), str) or not str(t.get("id") or "").strip():
            return raw
        if t.get("tool") not in ("db.select", "db.insert", "db.update", "db.delete", "query.rpc"):
            return raw
        args = t.get("args")
        if not isinstance(args, dict):
            return raw

    normalized = json.dumps(obj, ensure_ascii=False, indent=2)
    return f"```json\n{normalized}\n```"


def _contains_structured_tool_calls_payload(text: str) -> bool:
    """Return True only when the text contains an actual tool_calls JSON payload.

    We must NOT treat casual mentions of the word 'tool_calls' as structured payload, otherwise
    sanitizer rewrites get skipped and chain-of-thought can leak.
    """
    raw = (text or "").strip()
    if not raw:
        return False

    # Fast check before doing any heavier parsing.
    lowered = raw.lower()
    if "tool_calls" not in lowered:
        return False

    try:
        obj = _safe_json_loads(raw)
    except Exception:
        obj = None
    return isinstance(obj, dict) and isinstance(obj.get("tool_calls"), list) and len(obj.get("tool_calls") or []) > 0


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


def _extract_json_candidate(text: str) -> str | None:
    raw = _strip_think_blocks(text or "").strip()
    if not raw:
        return None

    # Prefer fenced json blocks.
    m = re.search(r"```json\s*([\s\S]*?)(?:\s*```|$)", raw, flags=re.IGNORECASE)
    if m and (m.group(1) or "").strip():
        return m.group(1).strip()

    # Otherwise try to extract the first balanced JSON object (robust to trailing text).
    first = raw.find("{")
    if first == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(first, len(raw)):
        ch = raw[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                cand = raw[first : i + 1].strip()
                return cand if cand.startswith("{") and cand.endswith("}") else None
    return None


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


def _validate_tool_calls_list(v: Any) -> list[dict[str, Any]] | None:
    if not isinstance(v, list):
        return None
    if len(v) == 0:
        return []
    out: list[dict[str, Any]] = []
    for item in v:
        if not isinstance(item, dict):
            return None
        tid = item.get("id")
        tool = item.get("tool")
        args = item.get("args")
        if not isinstance(tid, str) or not tid.strip():
            return None
        if tool not in ("db.select", "db.insert", "db.update", "db.delete", "query.rpc"):
            return None
        if not isinstance(args, dict):
            return None
        if tool == "query.rpc":
            name = args.get("name")
            params = args.get("params")
            if not isinstance(name, str) or not name.strip():
                return None
            if params is not None and not isinstance(params, dict):
                return None
        out.append({
            "id": tid,
            "tool": tool,
            "args": args,
            **({"reason": item.get("reason")} if isinstance(item.get("reason"), str) and item.get("reason").strip() else {}),
        })
    return out


def _actions_to_tool_calls(actions: Any) -> list[dict[str, Any]] | None:
    """Backward-compat: some models emit {"actions": [...]} instead of {"tool_calls": [...]}.

    Convert into our tool_calls schema so Edge can execute deterministically.
    """
    if not isinstance(actions, list) or len(actions) == 0:
        return None
    out: list[dict[str, Any]] = []
    for idx, a in enumerate(actions):
        if not isinstance(a, dict):
            return None
        typ = a.get("type")
        table = a.get("table")
        if not isinstance(typ, str) or not isinstance(table, str) or not table.strip():
            return None

        tool: str | None = None
        args: dict[str, Any] | None = None
        if typ == "select":
            tool = "db.select"
            cols = a.get("columns")
            if cols is None:
                cols = "*"
            args = {
                "table": table,
                "columns": cols,
            }
            if isinstance(a.get("where"), dict):
                args["where"] = a.get("where")
            if isinstance(a.get("limit"), int):
                args["limit"] = a.get("limit")
        elif typ == "create":
            tool = "db.insert"
            rec = a.get("record")
            if not isinstance(rec, dict):
                return None
            args = {"table": table, "record": rec}
        elif typ == "update":
            tool = "db.update"
            where = a.get("where")
            updates = a.get("updates")
            if not isinstance(where, dict) or not isinstance(updates, dict):
                return None
            legacy_id = where.get("id") if isinstance(where.get("id"), str) else None
            if not legacy_id or not legacy_id.strip():
                return None
            args = {"table": table, "id": legacy_id.strip(), "patch": updates}
        elif typ == "delete":
            tool = "db.delete"
            where = a.get("where")
            if not isinstance(where, dict):
                return None
            legacy_id = where.get("id") if isinstance(where.get("id"), str) else None
            if not legacy_id or not legacy_id.strip():
                return None
            args = {"table": table, "id": legacy_id.strip()}
        else:
            return None

        if tool is None or args is None:
            return None
        out.append({
            "id": str(a.get("id") or f"act_{idx+1}"),
            "tool": tool,
            "args": args,
            **({"reason": a.get("reason")} if isinstance(a.get("reason"), str) and a.get("reason").strip() else {}),
        })
    return out


def _parse_strict_llm_payload(text: str) -> dict[str, Any] | None:
    cand = _extract_json_candidate(text)
    if not cand:
        # If the model didn't return JSON at all, accept it as final text.
        # This prevents the UI from getting stuck in fallback loops.
        cleaned = _deterministic_trim_chain_of_thought(text or "").strip()
        if cleaned:
            return {"kind": "final_text", "final_text": cleaned}
        return None
    try:
        obj = _safe_json_loads(cand)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None

    # Allowed payloads:
    # 1) {"final_text": "..."}
    # 2) {"tool_calls": [ ... ]}
    if "final_text" in obj and isinstance(obj.get("final_text"), str) and obj.get("final_text").strip():
        return {"kind": "final_text", "final_text": _deterministic_trim_chain_of_thought(str(obj.get("final_text")))}

    tc = _validate_tool_calls_list(obj.get("tool_calls"))
    if tc is not None:
        return {"kind": "tool_calls", "tool_calls": tc}

    legacy = _actions_to_tool_calls(obj.get("actions"))
    if legacy is not None:
        return {"kind": "tool_calls", "tool_calls": legacy}
    return None


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


def _is_helper_intent(messages: list[dict[str, Any]]) -> bool:
    last_user = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last_user = str(m.get("content") or "").strip()
            break
    s = last_user.lower()
    if not s:
        return False

    # Analytics-style questions about chores (e.g., counts) should not route to the helper agent
    # just because they contain the substring "assign" (e.g., "assigned").
    if ("chore" in s or "chores" in s) and ("assign" in s):
        if ("how many" in s) or ("count" in s) or ("number of" in s) or ("total" in s):
            return False

    helper_terms = ("helper", "helpers", "cleaner", "cleaners", "maid", "househelp", "house help")
    helper_ops = ("time off", "leave", "vacation", "availability", "feedback", "rating", "reward", "bonus", "assign", "reassign", "unassign")
    if any(t in s for t in helper_terms):
        return True
    # Only treat chore assignment verbs as helper-management intent when the user explicitly
    # refers to helpers/cleaners. Otherwise, route to the chore orchestrator (e.g., "Assign a chore to Cook").
    if any(op in s for op in helper_ops) and ("chore" in s or "chores" in s) and any(t in s for t in helper_terms):
        return True
    return False


def _validate_edge_tool_call_args(item: dict[str, Any]) -> bool:
    tool = item.get("tool")
    args = item.get("args")
    if tool not in ("db.select", "db.insert", "db.update", "db.delete", "query.rpc"):
        return False
    if not isinstance(args, dict):
        return False

    if tool == "query.rpc":
        name = args.get("name")
        params = args.get("params")
        if not isinstance(name, str) or not name.strip():
            return False
        if params is not None and not isinstance(params, dict):
            return False
        return True

    table = args.get("table")
    if not isinstance(table, str) or not table.strip():
        return False

    if tool == "db.select":
        if "where" in args and not isinstance(args.get("where"), dict):
            return False
        if "limit" in args and not isinstance(args.get("limit"), int):
            return False
        return True
    if tool == "db.insert":
        return isinstance(args.get("record"), dict)
    if tool == "db.update":
        return isinstance(args.get("id"), str) and str(args.get("id") or "").strip() and isinstance(args.get("patch"), dict)
    if tool == "db.delete":
        return isinstance(args.get("id"), str) and str(args.get("id") or "").strip()
    return False


def _parse_helper_agent_payload(text: str) -> dict[str, Any] | None:
    cand = _extract_json_candidate(text)
    if not cand:
        return None
    try:
        obj = _safe_json_loads(cand)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None

    clarifications = obj.get("clarifications")
    tool_calls_raw = obj.get("tool_calls")
    user_summary = obj.get("user_summary")

    if clarifications is None:
        clarifications = []
    if not isinstance(clarifications, list):
        return None
    clarifications_clean: list[dict[str, Any]] = []
    for c in clarifications:
        if not isinstance(c, dict):
            return None
        key = c.get("key")
        question = c.get("question")
        allow_multiple = c.get("allowMultiple")
        options = c.get("options")
        if not isinstance(key, str) or not key.strip():
            return None
        if not isinstance(question, str) or not question.strip():
            return None
        if not isinstance(allow_multiple, bool):
            return None
        if options is not None:
            if not isinstance(options, list):
                return None
            if not all(isinstance(o, str) and o.strip() for o in options):
                return None
        clarifications_clean.append(
            {
                "key": key.strip(),
                "question": question.strip(),
                **({"options": [str(o).strip() for o in options if isinstance(o, str) and o.strip()]} if isinstance(options, list) else {}),
                "allowMultiple": allow_multiple,
            }
        )

    tool_calls: list[dict[str, Any]] = []
    if tool_calls_raw is not None:
        tc_validated = _validate_tool_calls_list(tool_calls_raw)
        if tc_validated is None:
            return None
        for item in tc_validated:
            if not _validate_edge_tool_call_args(item):
                return None
        tool_calls = tc_validated

    # Invariant: if clarifications exist, tool_calls must be empty.
    if clarifications_clean and tool_calls:
        return None

    if not isinstance(user_summary, str):
        user_summary = ""

    return {
        "clarifications": clarifications_clean,
        "tool_calls": tool_calls,
        "user_summary": user_summary.strip(),
    }


async def _run_helper_agent(
    *,
    messages: list[dict[str, Any]],
    model: str,
    temperature: float | None,
    max_tokens: int | None,
) -> dict[str, Any] | None:
    helper_clause = (
        "You are the Helper Agent for a home management app.\n"
        "Manage helpers (cleaners/maids), their time off, feedback, and rewards; and assign/unassign/reassign chores via chores.helper_id changes.\n\n"
        "CRITICAL INVARIANTS:\n"
        "- Never write to chore_helper_assignments directly. Assignment history is logged ONLY when chores.helper_id changes.\n"
        "- Rewards creation is admin-only (server enforces).\n"
        "- Never invent IDs or names. Fetch helpers/chores via db.select if needed.\n\n"
        "OUTPUT CONTRACT: Return ONLY JSON with EXACT keys: clarifications, tool_calls, user_summary.\n"
        "- clarifications: array of objects with keys {key, question, options, allowMultiple}. (may be empty).\n"
        "- tool_calls: array of tool calls (may be empty).\n"
        "- user_summary: short string.\n"
        "Rules: If clarifications is non-empty, tool_calls must be empty.\n\n"
        "Allowed tools: db.select, db.insert, db.update, db.delete.\n"
        "Tool call args shapes:\n"
        "- db.select: { table: string, columns?: string|array, where?: object, limit?: number }\n"
        "- db.insert: { table: string, record: object }\n"
        "- db.update: { table: string, id: string, patch: object }\n"
        "- db.delete: { table: string, id: string }\n"
        "Allowed tables: helpers, member_time_off, helper_feedback, helper_rewards, helper_reward_snapshots, chores.\n"
    )

    sarvam_messages: list[dict[str, str]] = []
    if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system" and isinstance(messages[0].get("content"), str):
        sarvam_messages.append({"role": "system", "content": str(messages[0]["content"]).rstrip() + "\n\n" + helper_clause})
        rest = messages[1:]
    else:
        sarvam_messages.append({"role": "system", "content": helper_clause.strip()})
        rest = messages

    for m in rest:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if isinstance(role, str) and isinstance(content, str):
            sarvam_messages.append({"role": role, "content": content})

    raw = await _sarvam_chat(
        messages=sarvam_messages,
        model=model,
        temperature=float(temperature) if isinstance(temperature, (int, float)) else 0.0,
        max_tokens=min(int(max_tokens or 768), 768),
    )
    parsed = _parse_helper_agent_payload(raw)
    if parsed is not None:
        return parsed

    # One repair attempt.
    repair = await _sarvam_chat(
        messages=[
            {
                "role": "system",
                "content": (
                    "Rewrite the INPUT into ONLY a single JSON object with EXACT keys: clarifications, tool_calls, user_summary. "
                    "Tool calls must use db.select/db.insert/db.update/db.delete with args shapes: "
                    "db.select={table,columns?,where?,limit?}; db.insert={table,record}; db.update={table,id,patch}; db.delete={table,id}."
                ),
            },
            {"role": "user", "content": str(raw)},
        ],
        model=model,
        temperature=0.0,
        max_tokens=min(int(max_tokens or 768), 768),
    )
    return _parse_helper_agent_payload(repair)


def _looks_like_chain_of_thought(text: str) -> bool:
    s = (text or "").strip().lower()
    if not s:
        return False
    # Heuristics for meta-reasoning that should never be user-visible.
    patterns = [
        r"\bokay,\s*the user\b",
        r"\bthe user (wants|asked|is asking)\b",
        r"\bthe user hasn\s*'\s*t\b",
        r"\bthe user has not\b",
        r"\bthe user hasn't confirmed\b",
        r"\bthe user's last message\b",
        r"\bthe latest user message\b",
        r"\blooking back\b",
        r"\bwait,\b",
        r"\bwait\s+no\b",
        r"\bbut wait,\b",
        r"\bbut wait\b",
        r"\blet me (think|break this down|figure|reason)\b",
        r"\bi need to\b",
        r"\bhere('?s)? (my|the) (plan|approach)\b",
        r"\bfirst,\b",
        r"\bnext,\b",
        r"\bnow, i need to\b",
        r"\bi should (add|do|create|return)\b",
        r"\bhowever,\b.*\bbut\b",
        r"\bin the current (query|context|scenario)\b",
        r"\baccording to the (history|rules)\b",
        r"\bthe assistant should\b",
        r"\bthe correct approach is\b",
    ]
    try:
        return any(re.search(p, s) for p in patterns)
    except Exception:
        return False


SARVAM_BASE_URL = _env("SARVAM_BASE_URL", "https://api.sarvam.ai")
SARVAM_API_KEY = _env("SARVAM_API_KEY")
SARVAM_MODEL_DEFAULT = _env("SARVAM_MODEL_DEFAULT", "sarvam-m")
SARVAM_TIMEOUT_MS = int(_env("SARVAM_TIMEOUT_MS", "20000") or "20000")
SARVAM_MAX_RETRIES = int(_env("SARVAM_MAX_RETRIES", "2") or "2")
# Prefer "final answer only" contract over model-provided reasoning modes.
# Some providers will surface meta-reasoning more often when a reasoning level is requested.
SARVAM_REASONING_LEVEL = _env("SARVAM_REASONING_LEVEL", "")

GEMINI_API_KEY = _env("GEMINI_API_KEY")
GEMINI_MODEL = _env("GEMINI_MODEL", "gemini-1.5-flash")
SANITIZER_ALWAYS = (_env("SANITIZER_ALWAYS", "false") or "false").strip().lower() in ("1", "true", "yes", "y", "on")

EDGE_BASE_URL = _env("EDGE_BASE_URL")
AGENT_SERVICE_KEY = _env("AGENT_SERVICE_KEY")
EDGE_BEARER_TOKEN = _env("EDGE_BEARER_TOKEN")


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


def _ensure_tool_reason(tc: dict[str, Any], reason: str) -> dict[str, Any]:
    if not isinstance(tc, dict):
        return tc
    if isinstance(tc.get("reason"), str) and str(tc.get("reason") or "").strip():
        return tc
    tc2 = dict(tc)
    tc2["reason"] = reason
    return tc2


def _try_parse_json_obj(text: str) -> dict[str, Any] | None:
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        return None
    return None


def _extract_clarification_block(messages: list[dict[str, str]]) -> dict[str, Any] | None:
    # Edge injects this block when it detects ambiguous bathrooms/balconies.
    # We parse it deterministically so the frontend can render a multi-select.
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


def _safe_json_loads(raw: str) -> Any:
    s = raw.strip()

    if "<think>" in s:
        s = re.sub(r"<think>[\s\S]*?</think>", "", s, flags=re.IGNORECASE).strip()
        if s.lower().startswith("<think>"):
            s = re.sub(r"^<think>[\s\S]*", "", s, flags=re.IGNORECASE).strip()

    m = re.search(r"<json>([\s\S]*?)</json>", s, flags=re.IGNORECASE)
    if m:
        candidate = m.group(1).strip()
        try:
            return json.loads(candidate)
        except Exception:
            pass

    if "```" in s:
        parts = s.split("```")
        for i in range(1, len(parts), 2):
            candidate = parts[i].strip()
            if candidate.startswith("json"):
                candidate = candidate[4:].strip()
            if candidate.startswith("{") and candidate.endswith("}"):
                try:
                    return json.loads(candidate)
                except Exception:
                    pass

    try:
        return json.loads(s)
    except Exception:
        pass

    start = s.find("{")
    end = s.rfind("}")
    if start >= 0 and end > start:
        candidate = s[start : end + 1]
        try:
            return json.loads(candidate)
        except Exception:
            pass

        try:
            cleaned = "\n".join([ln for ln in candidate.splitlines() if not ln.strip().startswith("//")])
            return json.loads(cleaned)
        except Exception:
            pass
    raise ValueError("Could not parse JSON")


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
                    # Best-effort linking with orchestrator trace id (supported by newer Langfuse SDKs).
                    trace_kwargs["id"] = incoming_trace_id
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

        helper_intent = _is_helper_intent(messages)
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

        # Deterministic analytics shortcut: "How many chores are assigned to <name>?"
        # Prefer the curated read-only RPC count_chores_assigned_to which accepts p_helper_name.
        try:
            helper_name = _extract_count_assigned_to_name(messages)
        except Exception:
            helper_name = ""
        if helper_name:
            _lf_span(
                "orchestrator.deterministic.count_chores_assigned_to",
                input={"helper_name": helper_name},
                output={"tool": "query.rpc", "name": "count_chores_assigned_to"},
            )
            payload = {
                "tool_calls": [
                    {
                        "id": "tc_count_chores_assigned_to_1",
                        "tool": "query.rpc",
                        "args": {"name": "count_chores_assigned_to", "params": {"p_helper_name": helper_name}},
                        "reason": "Count chores assigned to the specified helper.",
                    }
                ]
            }
            return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

        # Deterministic analytics shortcut (manager pattern): total number of pending tasks/chores.
        if _wants_unassigned_count(messages):
            if not household_id:
                return _lf_return({"ok": True, "text": "I need your household context to look up chores. Please reconnect your home and try again."})
            if not user_id:
                return _lf_return({"ok": True, "text": "I need your user context to look up chores. Please reconnect your home and try again."})

            tc = {
                "id": f"tc_{uuid.uuid4().hex}",
                "tool": "query.rpc",
                "args": {"name": "count_chores", "params": {"p_filters": {"unassigned": True}}},
                "reason": "Count unassigned chores in the household.",
            }
            out = await _edge_execute_tools({"household_id": household_id, "tool_call": tc}, user_id=user_id)
            if isinstance(out, dict) and out.get("ok") is False:
                err = out.get("error")
                msg = err.get("message") if isinstance(err, dict) else None
                msg2 = str(msg).strip() if isinstance(msg, str) else ""
                if msg2:
                    return _lf_return({"ok": True, "text": f"Tool error while counting unassigned tasks: {msg2}"})
                return _lf_return({"ok": True, "text": "Tool error while counting unassigned tasks."})

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

            if isinstance(chore_count, int):
                return _lf_return({"ok": True, "text": f"Total unassigned tasks: {chore_count}."})
            return _lf_return({"ok": True, "text": "There was an error retrieving the number of unassigned tasks. Please try again later."})

        if _wants_total_pending_count(messages):
            if not household_id:
                return _lf_return({"ok": True, "text": "I need your household context to look up chores. Please reconnect your home and try again."})
            if not user_id:
                return _lf_return({"ok": True, "text": "I need your user context to look up chores. Please reconnect your home and try again."})

            tc = {
                "id": f"tc_{uuid.uuid4().hex}",
                "tool": "query.rpc",
                "args": {
                    "name": "count_chores",
                    "params": {
                        "p_filters": {"status": "pending"},
                    },
                },
                "reason": "Count pending chores in the household.",
            }
            one_payload = {"household_id": household_id, "tool_call": tc}
            out = await _edge_execute_tools(one_payload, user_id=user_id)
            if isinstance(out, dict) and out.get("ok") is False:
                err = out.get("error")
                msg = err.get("message") if isinstance(err, dict) else None
                msg2 = str(msg).strip() if isinstance(msg, str) else ""
                if msg2:
                    return _lf_return({"ok": True, "text": f"Tool error while counting pending tasks: {msg2}"})
                return _lf_return({"ok": True, "text": "Tool error while counting pending tasks."})

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
            if isinstance(chore_count, int):
                return _lf_return({"ok": True, "text": f"Total pending tasks: {chore_count}."})
            return _lf_return({"ok": True, "text": "There was an error retrieving the total number of pending tasks. Please try again later."})

        # Deterministic analytics shortcut (manager pattern): breakdown by status.
        if _wants_status_breakdown(messages):
            if not household_id:
                return _lf_return({"ok": True, "text": "I need your household context to look up chores. Please reconnect your home and try again."})
            if not user_id:
                return _lf_return({"ok": True, "text": "I need your user context to look up chores. Please reconnect your home and try again."})

            tc = {
                "id": f"tc_{uuid.uuid4().hex}",
                "tool": "query.rpc",
                "args": {"name": "group_chores_by_status", "params": {"p_filters": {}}},
                "reason": "Group chores by status.",
            }
            out = await _edge_execute_tools({"household_id": household_id, "tool_call": tc}, user_id=user_id)
            if isinstance(out, dict) and out.get("ok") is False:
                err = out.get("error")
                msg = err.get("message") if isinstance(err, dict) else None
                msg2 = str(msg).strip() if isinstance(msg, str) else ""
                if msg2:
                    return _lf_return({"ok": True, "text": f"Tool error while grouping chores by status: {msg2}"})
                return _lf_return({"ok": True, "text": "Tool error while grouping chores by status."})

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
                return _lf_return({"ok": True, "text": "No chores found."})
            lines: list[str] = []
            for r in rows:
                if not isinstance(r, dict):
                    continue
                st = str(r.get("status") or "").strip()
                cnt = r.get("count")
                if st and isinstance(cnt, int):
                    lines.append(f"- {st}: {cnt}")
            if len(lines) <= 1:
                return _lf_return({"ok": True, "text": "Chores by status (only one status bucket found):\n" + "\n".join(lines)})
            return _lf_return({"ok": True, "text": "Chores by status:\n" + "\n".join(lines)})

        # Deterministic analytics shortcut (manager pattern): breakdown by assignee.
        if _wants_assignee_breakdown(messages):
            if not household_id:
                return _lf_return({"ok": True, "text": "I need your household context to look up chores. Please reconnect your home and try again."})
            if not user_id:
                return _lf_return({"ok": True, "text": "I need your user context to look up chores. Please reconnect your home and try again."})

            tc = {
                "id": f"tc_{uuid.uuid4().hex}",
                "tool": "query.rpc",
                "args": {"name": "group_chores_by_assignee", "params": {"p_filters": {}}},
                "reason": "Group chores by assignee.",
            }
            out = await _edge_execute_tools({"household_id": household_id, "tool_call": tc}, user_id=user_id)
            payload = out.get("result") if isinstance(out, dict) else None
            result = payload.get("result") if isinstance(payload, dict) else None
            rows = result if isinstance(result, list) else []
            if not rows:
                return _lf_return({"ok": True, "text": "No chores found."})
            lines = []
            for r in rows:
                if not isinstance(r, dict):
                    continue
                name = str(r.get("helper_name") or r.get("helper") or "").strip()
                cnt = r.get("count")
                if name and isinstance(cnt, int):
                    lines.append(f"- {name}: {cnt}")
            return _lf_return({"ok": True, "text": "Chores by assignee:\n" + "\n".join(lines)})

        # Deterministic analytics shortcut (manager pattern): list chores in a space.
        try:
            space_q = _extract_space_list_query(messages)
        except Exception:
            space_q = ""
        if space_q:
            if not household_id:
                return _lf_return({"ok": True, "text": "I need your household context to look up chores. Please reconnect your home and try again."})
            if not user_id:
                return _lf_return({"ok": True, "text": "I need your user context to look up chores. Please reconnect your home and try again."})

            tc = {
                "id": f"tc_{uuid.uuid4().hex}",
                "tool": "query.rpc",
                "args": {"name": "list_chores_enriched", "params": {"p_filters": {"space_query": space_q}, "p_limit": 25}},
                "reason": "List chores for a space.",
            }
            out = await _edge_execute_tools({"household_id": household_id, "tool_call": tc}, user_id=user_id)
            payload = out.get("result") if isinstance(out, dict) else None
            match_type = payload.get("match_type") if isinstance(payload, dict) else None
            if match_type == "ambiguous_space":
                return _lf_return({"ok": True, "text": "Which space did you mean?"})
            result = payload.get("result") if isinstance(payload, dict) else None
            chores = result if isinstance(result, list) else []
            if not chores:
                return _lf_return({"ok": True, "text": f"No chores found for {space_q}."})
            lines: list[str] = []
            for c0 in chores[:25]:
                if not isinstance(c0, dict):
                    continue
                title = str(c0.get("title") or "").strip()
                status = str(c0.get("status") or "").strip()
                if title and status:
                    lines.append(f"- {title} [{status}]")
                elif title:
                    lines.append(f"- {title}")
            return _lf_return({"ok": True, "text": f"Chores in {space_q}:\n" + "\n".join(lines)})

        # Deterministic analytics shortcut (manager pattern): list tasks/chores assigned to a helper.
        # Example: "tasks assigned to Sunita"
        try:
            list_name = _extract_list_assigned_to_name(messages)
        except Exception:
            list_name = ""
        if list_name:
            if not household_id:
                return _lf_return({"ok": True, "text": "I need your household context to look up chores. Please reconnect your home and try again."})
            if not user_id:
                return _lf_return({"ok": True, "text": "I need your user context to look up chores. Please reconnect your home and try again."})

            _lf_span(
                "orchestrator.deterministic.list_chores_assigned_to",
                input={"helper_query": list_name},
                output={"tool": "query.rpc", "name": "list_chores_enriched"},
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
            one_payload = {"household_id": household_id, "tool_call": tc}
            out = await _edge_execute_tools(one_payload, user_id=user_id)

            payload = out.get("result") if isinstance(out, dict) else None
            match_type = payload.get("match_type") if isinstance(payload, dict) else None
            result = payload.get("result") if isinstance(payload, dict) else None
            helper_candidates = payload.get("helper_candidates") if isinstance(payload, dict) else None

            if match_type == "ambiguous_helper" and helper_candidates:
                return _lf_return({"ok": True, "text": "Which helper did you mean? " + json.dumps(helper_candidates, ensure_ascii=False)})
            if match_type == "none_helper":
                return _lf_return({"ok": True, "text": f"I couldn't find a helper matching '{list_name}'."})

            chores = result if isinstance(result, list) else []
            if not chores:
                return _lf_return({"ok": True, "text": f"No chores are currently assigned to {list_name}."})

            lines: list[str] = []
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

            return _lf_return({"ok": True, "text": "Here are the chores assigned to " + list_name + ":\n" + "\n".join(lines)})

        if helper_intent:
            _lf_span(
                "orchestrator.route.helper_agent",
                output={"routed": True},
            )
            helper = await _run_helper_agent(
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
        # If Edge injected a CLARIFICATION NEEDED block, return a structured clarification
        # payload that the frontend can render (multi-select list).
        clarification_block = _extract_clarification_block(messages)

        # Check if the latest user message is a structured clarification response.
        latest_user_text = ""
        for m in reversed(messages):
            if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                latest_user_text = str(m.get("content") or "").strip()
                break

        # Deterministic shortcut: when the user confirms they want to apply a previously suggested
        # set of chore assignments, parse the suggestion list and emit a single RPC tool call.
        norm_user = re.sub(r"\s+", " ", (latest_user_text or "").strip().lower())
        norm_user = re.sub(r"[^a-z\s]", "", norm_user).strip()
        approval_phrases = (
            "yes",
            "y",
            "yeah",
            "yep",
            "ok",
            "okay",
            "sure",
            "go ahead",
            "proceed",
            "do it",
        )
        if norm_user in (
            "create these assignments",
            "crate these assignments",
            "create these assignment",
            "crate these assignment",
            "create the assignments",
            "crate the assignments",
            "create assignments",
            "apply these assignments",
        ) or norm_user in approval_phrases:
            assignments = _extract_assignment_suggestions(messages)
            if not assignments:
                if norm_user in approval_phrases:
                    # Approval with no parseable assignment list; fall back to a safe clarification.
                    return _lf_return({"ok": True, "text": "I can proceed, but I don't see an assignment list. Please paste the assignment list (Title (due_at) → Helper) and then say 'Create these assignments'."})
                return _lf_return({"ok": True, "text": "Please paste the assignment list (Title (due_at) → Helper) and then say 'Create these assignments'."})
            tool_calls = [
                {
                    "id": f"tc_{uuid.uuid4().hex}",
                    "tool": "query.rpc",
                    "args": {"name": "apply_chore_assignments", "params": {"p_assignments": assignments}},
                    "reason": "Apply the suggested helper assignments to existing chores by matching title + due_at and resolving helper names.",
                }
            ]
            payload = {"tool_calls": tool_calls}
            _lf_span(
                "orchestrator.deterministic.apply_assignments",
                input={"assignment_count": len(assignments)},
                output={"tool": "query.rpc", "name": "apply_chore_assignments"},
            )
            return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

        # Deterministic shortcut: "Assign a chore to <helper> to <task> tomorrow"
        # The UI executes tool calls one at a time without feeding tool results back into the agent,
        # so we use a single RPC that resolves helper + matches/creates chore server-side.
        assign_req = _extract_assign_or_create_chore(latest_user_text)
        if assign_req is not None:
            _lf_span(
                "orchestrator.deterministic.assign_or_create_chore",
                input={
                    "helper_query": str(assign_req.get("helper_query") or "")[:120],
                    "task": str(assign_req.get("task") or "")[:240],
                    "when": str(assign_req.get("when") or "")[:40],
                },
                output={"tool": "query.rpc", "name": "assign_or_create_chore"},
            )
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
            return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

        # Deterministic shortcut: complete a chore by title-ish query.
        complete_req = _extract_complete_chore_by_query(latest_user_text)
        if complete_req is not None:
            _lf_span(
                "orchestrator.deterministic.complete_chore_by_query",
                input={
                    "query": str(complete_req.get("query") or "")[:240],
                    "when": str(complete_req.get("when") or "")[:40],
                },
                output={"tool": "query.rpc", "name": "complete_chore_by_query"},
            )
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
            return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

        # Deterministic shortcut: reassign or unassign a chore by title-ish query.
        reassign_req = _extract_reassign_or_unassign_chore(latest_user_text)
        if reassign_req is not None:
            _lf_span(
                "orchestrator.deterministic.reassign_chore_by_query",
                input={
                    "chore_query": str(reassign_req.get("chore_query") or "")[:240],
                    "helper_query": str(reassign_req.get("helper_query") or "")[:120] if reassign_req.get("helper_query") is not None else None,
                    "when": str(reassign_req.get("when") or "")[:40],
                },
                output={"tool": "query.rpc", "name": "reassign_chore_by_query"},
            )
            tool_calls = [
                {
                    "id": f"tc_{uuid.uuid4().hex}",
                    "tool": "query.rpc",
                    "args": {
                        "name": "reassign_chore_by_query",
                        "params": {
                            "p_chore_query": str(reassign_req.get("chore_query") or ""),
                            "p_helper_query": (str(reassign_req.get("helper_query")) if reassign_req.get("helper_query") is not None else None),
                            "p_when": str(reassign_req.get("when") or "") or None,
                        },
                    },
                    "reason": "Find the best matching pending chore and reassign/unassign it (or ask for clarification if ambiguous).",
                }
            ]
            payload = {"tool_calls": tool_calls}
            return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

        clarification_response: dict[str, Any] | None = None
        if latest_user_text and latest_user_text.strip().startswith("{"):
            parsed_user_obj = _try_parse_json_obj(latest_user_text)
            if parsed_user_obj and isinstance(parsed_user_obj.get("clarification_response"), dict):
                clarification_response = parsed_user_obj.get("clarification_response")  # type: ignore

        wants_schedule = _wants_schedule(messages)
        has_datetime = _has_explicit_datetime(messages)

        # If schedule was requested but no explicit datetime was given, ask for it as a structured clarification.
        # We only do this for chore-ish intents so we don't interfere with unrelated chat.
        if wants_schedule and not has_datetime:
            # If the user already responded with a due_at, we can proceed.
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
                return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

        # If space selection is needed and we haven't received a response, request it via structured clarification.
        selected_spaces: list[str] = []
        if clarification_response:
            raw_spaces = clarification_response.get("spaces")
            if isinstance(raw_spaces, list):
                selected_spaces = [str(s).strip() for s in raw_spaces if isinstance(s, (str, int, float)) and str(s).strip()]
            elif isinstance(raw_spaces, str):
                selected_spaces = [s.strip() for s in raw_spaces.split(",") if s.strip()]

        if clarification_block and not selected_spaces:
            # If the user already mentioned a specific space (e.g., "master bathroom"), auto-select it.
            try:
                options = clarification_block.get("options")
                opts = options if isinstance(options, list) else []
                inferred = _infer_spaces_from_user_text([str(o) for o in opts], latest_user_text)
                if inferred:
                    selected_spaces = inferred
            except Exception:
                selected_spaces = selected_spaces

        if clarification_block and not selected_spaces:
            payload = {
                "clarification": {
                    **clarification_block,
                    "required": True,
                }
            }
            return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

        # If we have selected spaces (from clarification_response), emit deterministic chore tool calls.
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
                return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

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
            return _lf_return({"ok": True, "text": "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"})

        # Strict response contract (no heuristics): the model must output JSON ONLY.
        # This prevents chain-of-thought / meta drafting from ever being returned to the UI.
        final_only_clause = (
            "\n\nCRITICAL OUTPUT CONTRACT (must follow):\n"
            "Return ONLY a single JSON object and nothing else (no markdown, no prose).\n"
            "The JSON must be EXACTLY one of:\n"
            "1) {\"final_text\": <string>}\n"
            "2) {\"tool_calls\": [ {\"id\": <string>, \"tool\": \"db.select\"|\"db.insert\"|\"db.update\"|\"db.delete\"|\"query.rpc\", \"args\": <object>, \"reason\": <string optional>} ] }\n"
            "Rules:\n"
            "- Do NOT include analysis/reasoning/chain-of-thought.\n"
            "- If you need missing information, put the question in final_text.\n"
            "- Never invent helpers/chores/IDs; use provided FACTS or request tool_calls.\n"
            "- For analytics / reporting questions about chores/helpers/spaces (counts, grouping, listing), prefer query.rpc over db.select.\n"
            "- Tool call args MUST follow these shapes:\n"
            "  - db.select: {\"table\": <string>, \"columns\": <string or array>, \"where\": <object optional>, \"limit\": <number optional>}\n"
            "  - db.insert: {\"table\": <string>, \"record\": <object>}\n"
            "  - db.update: {\"table\": <string>, \"id\": <string>, \"patch\": <object>}\n"
            "  - db.delete: {\"table\": <string>, \"id\": <string>}\n"
            "  - query.rpc: {\"name\": <string>, \"params\": <object optional>}\n"
            "  - Allowlisted query.rpc names for analytics: resolve_helper, resolve_space, count_chores_assigned_to, count_chores, group_chores_by_status, group_chores_by_assignee, list_chores_enriched.\n"
            "  - For analytics RPCs, pass filters via params.p_filters (json object). Example: {\"name\":\"count_chores\", \"params\":{\"p_filters\":{\"status\":\"closed\"}}}.\n"
            "  - Allowlisted query.rpc names for writes: apply_chore_assignments, assign_or_create_chore, complete_chore_by_query, reassign_chore_by_query.\n"
            "- For creating chores: use db.insert with table=\"chores\" and put fields under record (e.g., title, due_at, helper_id, metadata).\n"
            "\nCanonical examples (follow structure exactly; do not copy IDs verbatim):\n"
            "A) Count pending chores:\n"
            "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"count_chores\",\"params\":{\"p_filters\":{\"status\":\"pending\"}}},\"reason\":\"Count pending chores.\"}]}\n"
            "B) Count unassigned chores:\n"
            "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"count_chores\",\"params\":{\"p_filters\":{\"unassigned\":true}}},\"reason\":\"Count unassigned chores.\"}]}\n"
            "C) Group chores by status:\n"
            "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"group_chores_by_status\",\"params\":{\"p_filters\":{}}},\"reason\":\"Group chores by status.\"}]}\n"
            "D) List chores in a space (example space query):\n"
            "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"list_chores_enriched\",\"params\":{\"p_filters\":{\"space_query\":\"Kitchen\"},\"p_limit\":25}},\"reason\":\"List chores for a space.\"}]}\n"
            "E) Complete a chore by text query:\n"
            "{\"tool_calls\":[{\"id\":\"tc_1\",\"tool\":\"query.rpc\",\"args\":{\"name\":\"complete_chore_by_query\",\"params\":{\"p_query\":\"mop kitchen\"}},\"reason\":\"Complete the matching chore.\"}]}\n"
        )

        if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
            c0 = messages[0].get("content")
            if isinstance(c0, str):
                messages[0]["content"] = c0.rstrip() + final_only_clause
        else:
            messages = [{"role": "system", "content": final_only_clause.strip()}] + messages

        async def _orchestrator_once(orchestrator_messages: list[dict[str, Any]]) -> dict[str, Any]:
            safe_msgs: list[dict[str, str]] = []
            for m in orchestrator_messages or []:
                if not isinstance(m, dict):
                    continue
                role = m.get("role")
                content = m.get("content")
                if isinstance(role, str) and isinstance(content, str):
                    safe_msgs.append({"role": role, "content": content})

            raw = await _sarvam_chat(
                messages=safe_msgs,
                model=model,
                temperature=float(req.temperature) if isinstance(req.temperature, (int, float)) else 0.0,
                max_tokens=int(req.max_tokens) if isinstance(req.max_tokens, int) else 900,
            )
            parsed_local = _parse_strict_llm_payload(raw)
            if parsed_local is None:
                cleaned = _deterministic_trim_chain_of_thought(raw or "").strip()
                return {"kind": "final_text", "final_text": cleaned}
            return parsed_local

        sarvam_messages: list[dict[str, str]] = []
        for m in messages or []:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            content = m.get("content")
            if isinstance(role, str) and isinstance(content, str):
                sarvam_messages.append({"role": role, "content": content})

        text = await _sarvam_chat(
            messages=sarvam_messages,
            model=model,
            temperature=float(req.temperature) if isinstance(req.temperature, (int, float)) else 0.0,
            max_tokens=int(req.max_tokens) if isinstance(req.max_tokens, int) else 900,
        )

        try:
            _lf_span(
                "orchestrator.llm.chat",
                input={
                    "model": model,
                    "temperature": float(req.temperature),
                    "max_tokens": int(req.max_tokens),
                    "message_count": len(messages or []),
                },
                output={"response_len": len(text) if isinstance(text, str) else None},
            )
        except Exception:
            pass

        if isinstance(text, str):
            print(
                "strict_schema_llm_raw",
                {
                    "len": len(text),
                    "prefix": text[:240],
                },
            )

        parsed = _parse_strict_llm_payload(text)
        if parsed is None:
            print(
                "strict_schema_parse_failed",
                {
                    "stage": "initial",
                },
            )
            # Repair once: ask the model to convert its output into the strict JSON schema.
            try:
                repair = await _sarvam_chat(
                    messages=[
                        {
                            "role": "system",
                            "content": (
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
                            ),
                        },
                        {"role": "user", "content": text},
                    ],
                    model=model,
                    temperature=0.0,
                    max_tokens=min(int(req.max_tokens or 512), 512),
                )
                parsed = _parse_strict_llm_payload(repair)
                if isinstance(repair, str):
                    print(
                        "strict_schema_llm_repair_raw",
                        {
                            "len": len(repair),
                            "prefix": repair[:240],
                        },
                    )
                if parsed is None:
                    print(
                        "strict_schema_parse_failed",
                        {
                            "stage": "repair",
                        },
                    )
            except Exception:
                parsed = None

        if parsed is None:
            # Regenerate once using the full conversation under the strict contract.
            # This is more reliable than attempting to "repair" an already-bad output.
            try:
                regen = await _sarvam_chat(
                    messages=messages,
                    model=model,
                    temperature=0.0,
                    max_tokens=min(int(req.max_tokens or 512), 512),
                )
                parsed = _parse_strict_llm_payload(regen)
                if isinstance(regen, str):
                    print(
                        "strict_schema_llm_regen_raw",
                        {
                            "len": len(regen),
                            "prefix": regen[:240],
                        },
                    )
                if parsed is None:
                    print(
                        "strict_schema_parse_failed",
                        {
                            "stage": "regen",
                        },
                    )
            except Exception:
                parsed = None

        if parsed is None:
            # Deterministic safe fallback with no invented entities.
            return _lf_return({"ok": True, "text": "I can help with that. What date and time should I use?"})

        # Manager pattern: if we get tool_calls, execute them via Edge, then run one more pass
        # with the tool results injected, and return final_text.
        if parsed.get("kind") == "tool_calls":
            tool_calls = parsed.get("tool_calls")
            if not isinstance(tool_calls, list) or not tool_calls:
                return _lf_return({"ok": True, "text": "I couldn't determine the next step. Please rephrase your request."})

            if not household_id:
                return _lf_return({"ok": True, "text": "I need your household context to run database tools. Please reconnect your home and try again."})
            if not user_id:
                return _lf_return({"ok": True, "text": "I need your user context to run database tools. Please reconnect your home and try again."})

            _lf_span(
                "orchestrator.tools.execute",
                input={"tool_calls": tool_calls},
            )
            # Execute tool calls sequentially via Edge tool executor.
            results: list[dict[str, Any]] = []
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                tool_name = str(tc.get("tool") or "").strip()
                tc = _ensure_tool_reason(tc, f"Execute {tool_name or 'tool'}.")
                one_payload = {
                    "household_id": household_id,
                    "tool_call": tc,
                }
                try:
                    out = await _edge_execute_tools(one_payload, user_id=user_id)
                except Exception as e:
                    out = {"ok": False, "error": str(e), "tool_call_id": tc.get("id")}
                results.append(out)
            tool_results = {"results": results}
            _lf_span(
                "orchestrator.tools.results",
                output={"results": tool_results},
            )

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
            return _lf_return({"ok": True, "text": final_text2})

        final_text = _deterministic_trim_chain_of_thought(str(parsed.get("final_text") or "").strip())

        # Guardrail: never claim a DB write happened unless we emitted tool_calls.
        # If the user intent is scheduling or chores, force a clarification/confirmation question.
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
            # If no explicit datetime was provided, ask for one.
            # (We do not attempt to parse dates here; the UI will prompt + convert.)
            if not re.search(r"\b\d{1,2}:\d{2}\b", lower_user) and not re.search(r"\b\d{4}-\d{2}-\d{2}\b", lower_user):
                return _lf_return({"ok": True, "text": "What date and time should I use?"})
            # Even if a datetime-like string exists, avoid claiming success without tool calls.
            return _lf_return({"ok": True, "text": "I can schedule this. Please confirm the exact bathrooms (or say 'all bathrooms') and the date/time."})

        if re.search(r"\b(scheduled|created|updated|deleted)\b", final_text.lower()):
            return _lf_return({"ok": True, "text": "I can do that, but I need your confirmation. Should I proceed?"})

        return _lf_return({"ok": True, "text": final_text})


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


async def _sarvam_chat(
    *,
    messages: list[dict[str, str]],
    model: str,
    temperature: float = 0.3,
    max_tokens: int = 512,
) -> str:
    # Read from env at call time to avoid stale module-level values if the process was started
    # before the .env changed.
    api_key = (os.getenv("SARVAM_API_KEY") or SARVAM_API_KEY or "").strip()
    if not api_key:
        raise RuntimeError("Missing SARVAM_API_KEY")

    url = f"{SARVAM_BASE_URL.rstrip('/')}/v1/chat/completions"
    timeout = httpx.Timeout(SARVAM_TIMEOUT_MS / 1000.0)

    messages = _sarvam_adapt_messages(messages)  # type: ignore[arg-type]

    last_err: Optional[Exception] = None
    for attempt in range(SARVAM_MAX_RETRIES + 1):
        try:
            tracer = trace.get_tracer("homeops.agent_service")
            with tracer.start_as_current_span("llm.sarvam.chat") as span:
                try:
                    span.set_attribute("llm.provider", "sarvam")
                    span.set_attribute("llm.model", model)
                    span.set_attribute("llm.attempt", attempt)
                except Exception:
                    pass

                payload: dict[str, Any] = {
                    "messages": messages,
                    "model": model,
                    "stream": False,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                }

                # NOTE: Sarvam payload validation has varied across versions.
                # Avoid sending experimental fields (e.g. reasoning_level) that can trigger HTTP 400.

                async with httpx.AsyncClient(timeout=timeout) as client:
                    res = await client.post(
                        url,
                        headers={
                            # Keep multiple common auth header variants for maximum compatibility.
                            "API-Subscription-Key": api_key,
                            "api-subscription-key": api_key,
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json",
                        },
                        json=payload,
                    )
            if res.status_code >= 400:
                # Log minimal debugging info without leaking the key.
                req_id = None
                err_code = None
                try:
                    j = res.json()
                    if isinstance(j, dict):
                        err = j.get("error")
                        if isinstance(err, dict):
                            req_id = err.get("request_id")
                            err_code = err.get("code")
                except Exception:
                    pass
                print(
                    "sarvam_chat_http_error",
                    {
                        "status": res.status_code,
                        "request_id": req_id,
                        "code": err_code,
                        "url": url,
                        "model": model,
                        "api_key_len": len(api_key),
                        "api_key_prefix": api_key[:6],
                        "response_prefix": (res.text or "")[:500],
                    },
                )

                raise RuntimeError(f"Sarvam call failed {res.status_code}: {res.text}")

            data = res.json()

            # Resilient extractor: prefer chat shape, fallback to completion shape
            text = None
            try:
                text = (
                    data.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content")
                )
            except Exception:
                text = None

            if not text:
                try:
                    text = data.get("choices", [{}])[0].get("text")
                except Exception:
                    text = None

            if not isinstance(text, str) or not text.strip():
                raise RuntimeError("Sarvam response missing text (choices[0].message.content or choices[0].text)")

            return _strip_think_blocks(str(text))

        except Exception as e:  # network/parse errors
            last_err = e
            if attempt >= SARVAM_MAX_RETRIES:
                break

    raise RuntimeError(f"Sarvam call failed: {last_err}")


async def _edge_post(path: str, payload: dict[str, Any]) -> None:
    if not EDGE_BASE_URL:
        raise RuntimeError("Missing EDGE_BASE_URL")
    if not AGENT_SERVICE_KEY:
        raise RuntimeError("Missing AGENT_SERVICE_KEY")

    url = f"{EDGE_BASE_URL.rstrip('/')}{path}"
    headers = {
        "x-agent-service-key": AGENT_SERVICE_KEY,
        "Content-Type": "application/json",
    }
    if EDGE_BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {EDGE_BEARER_TOKEN}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        res = await client.post(
            url,
            headers=headers,
            json=payload,
        )
    if res.status_code >= 400:
        raise RuntimeError(f"Edge writeback failed {res.status_code}: {res.text}")


async def _edge_execute_tools(payload: dict[str, Any], *, user_id: str) -> Any:
    if not EDGE_BASE_URL:
        raise RuntimeError("Missing EDGE_BASE_URL")
    if not AGENT_SERVICE_KEY:
        raise RuntimeError("Missing AGENT_SERVICE_KEY")

    url = f"{EDGE_BASE_URL.rstrip('/')}/tools/execute"
    headers = {
        "x-agent-service-key": AGENT_SERVICE_KEY,
        "Content-Type": "application/json",
    }
    if user_id:
        headers["x-user-id"] = user_id
    if EDGE_BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {EDGE_BEARER_TOKEN}"

    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0)) as client:
        res = await client.post(url, headers=headers, json=payload)
    if res.status_code >= 400:
        raise RuntimeError(f"Edge tools.execute failed {res.status_code}: {res.text}")
    try:
        return res.json()
    except Exception:
        raise RuntimeError("Edge tools.execute returned non-JSON")


async def _edge_get(path: str, params: dict[str, str]) -> Any:
    if not EDGE_BASE_URL:
        raise RuntimeError("Missing EDGE_BASE_URL")
    if not AGENT_SERVICE_KEY:
        raise RuntimeError("Missing AGENT_SERVICE_KEY")

    qs = urlencode(params)
    url = f"{EDGE_BASE_URL.rstrip('/')}{path}{'?' if qs else ''}{qs}"
    headers = {
        "x-agent-service-key": AGENT_SERVICE_KEY,
    }
    if EDGE_BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {EDGE_BEARER_TOKEN}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        res = await client.get(url, headers=headers)
    if res.status_code >= 400:
        raise RuntimeError(f"Edge read failed {res.status_code}: {res.text}")
    try:
        return res.json()
    except Exception:
        raise RuntimeError("Edge read returned non-JSON")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _sarvam_adapt_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Normalize messages to satisfy Sarvam constraints.

    Constraints enforced:
    - At most one system message, and it must be the first message.
    - User/assistant turns must alternate, starting with a user message.
    """

    sys_parts: list[str] = []
    non_sys_raw: list[dict[str, str]] = []

    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")

        if role == "system":
            if isinstance(content, str) and content.strip():
                sys_parts.append(content.strip())
            continue

        if role not in {"user", "assistant"}:
            continue
        if not isinstance(content, str):
            continue
        c = content.strip("\n")
        if not c.strip():
            continue
        non_sys_raw.append({"role": str(role), "content": c})

    # Sarvam constraint: turns must alternate user/assistant starting with user.
    # Normalize by dropping any leading assistant turns and merging consecutive same-role turns.
    non_sys: list[dict[str, str]] = []
    for item in non_sys_raw:
        if not non_sys and item["role"] == "assistant":
            continue
        if non_sys and non_sys[-1]["role"] == item["role"]:
            non_sys[-1]["content"] = (non_sys[-1]["content"].rstrip() + "\n\n" + item["content"].lstrip()).strip()
            continue
        non_sys.append(item)

    out: list[dict[str, str]] = []
    if sys_parts:
        out.append({"role": "system", "content": "\n\n".join(sys_parts)})
    out.extend(non_sys)
    return out


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
