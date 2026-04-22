"""OpenTelemetry + Langfuse observability setup.

Owns every runtime observability concern:

  - `_log_*` contextvars that propagate request_id / conversation_id /
    trace_id / user_id / session_id through logs without having to
    plumb them into every log call.
  - `_CorrelationFilter` + `_record_factory` that inject those values
    into every LogRecord.
  - `_logger` — the `homeops.agent_service` logger everyone uses.
  - `_init_otel` — lazy OTLP exporter init from env.
  - `_init_langfuse` — singleton Langfuse client init with idempotent
    "disabled/enabled" logging.
  - `install_observability(app)` — one-call setup the app entry point
    uses to wire the middleware + instrument httpx/FastAPI.
  - `build_chat_respond_langfuse(...)` — chat_respond-specific helper
    that returns the per-request `(lf, lf_trace, lf_span, lf_return)`
    closures without requiring the endpoint to know the shape of the
    Langfuse SDK.

All state is module-global (matches the pre-refactor main.py behaviour;
OTel/Langfuse SDKs expect singletons).
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
from datetime import datetime
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request

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


# ── Correlation contextvars ──────────────────────────────────────────────────

_log_request_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_request_id", default="")
_log_conversation_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_conversation_id", default="")
_log_trace_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_trace_id", default="")
_log_user_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_user_id", default="")
_log_session_id: contextvars.ContextVar[str] = contextvars.ContextVar("homeops_session_id", default="")


def _env(name: str, default: str | None = None) -> str | None:
    """Whitespace-tolerant env lookup (same behaviour as main._env)."""
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


# ── Log record factory + correlation filter ──────────────────────────────────

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


# ── Module logger ────────────────────────────────────────────────────────────

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


# ── OTel + Langfuse init ─────────────────────────────────────────────────────

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
    """Return the Langfuse client singleton, initializing on first call.

    Returns None when Langfuse isn't installed or the required env vars
    are missing. Logs enable/disable status exactly once so startup logs
    don't fill up with duplicate messages.
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


# ── Correlation middleware ───────────────────────────────────────────────────

MiddlewareCallNext = Callable[[Request], Awaitable[Any]]


async def _otel_correlation_middleware(request: Request, call_next: MiddlewareCallNext) -> Any:
    """ASGI middleware: copy correlation headers into the current OTel span +
    bind them to contextvars for the duration of the request. Also logs one
    `http_request` line on response.
    """
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


def install_observability(app: FastAPI) -> None:
    """One-call observability setup: init OTel, instrument httpx + FastAPI,
    register the correlation middleware, and add a startup hook that does
    a one-shot Langfuse init so enable/disable status surfaces in the logs.
    """
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
        try:
            _init_langfuse()
        except Exception:
            pass

    app.middleware("http")(_otel_correlation_middleware)


# ── chat_respond Langfuse trace builder ──────────────────────────────────────


def _langfuse_flush(lf_client: Any) -> None:
    if lf_client is None:
        return
    try:
        if hasattr(lf_client, "flush"):
            lf_client.flush()
    except Exception:
        pass


def _langfuse_safe_update(
    trace_obj: Any,
    *,
    output: Any | None = None,
    status: str | None = None,
) -> None:
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
    """Shrink a messages list for safe Langfuse input logging — last 12
    messages, content truncated to 2000 chars, non-string content
    JSON-encoded.
    """
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


LfSpanFn = Callable[..., None]
LfReturnFn = Callable[[dict[str, Any]], dict[str, Any]]


def build_chat_respond_langfuse(
    *,
    otel_span: Any,
    messages: list[dict[str, Any]],
    req_id: str,
    conv_id: str,
    sess_id: str,
    user_id: str,
    model: str,
    x_langfuse_trace_id: str | None,
) -> tuple[Any, Any, LfSpanFn, LfReturnFn]:
    """Build the per-request Langfuse trace + the two closures chat_respond's
    router needs.

    Returns (lf, lf_trace, lf_span, lf_return):
      - lf       — the Langfuse client (or None if disabled)
      - lf_trace — the active trace object (or None)
      - lf_span  — callable to record a named span under the trace
      - lf_return — wraps the final response dict, flushes Langfuse,
                    returns the dict unchanged (so call sites read naturally)
    """
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
                    "otel_trace_id": f"{otel_span.get_span_context().trace_id:032x}",
                },
            }
            incoming_trace_id = (x_langfuse_trace_id or "").strip() if isinstance(x_langfuse_trace_id, str) else ""
            if incoming_trace_id:
                trace_kwargs.update({
                    "id": incoming_trace_id,
                    "metadata": {
                        "service": "agent-service",
                        "timestamp": datetime.utcnow().isoformat(),
                        "version": _env("APP_VERSION", "unknown"),
                    },
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

    def lf_span(
        name: str,
        *,
        input: Any | None = None,
        output: Any | None = None,
        status_message: str | None = None,
        level: Any | None = None,
    ) -> None:
        if lf is None or lf_trace_id is None:
            return
        try:
            sp = lf.span(name=name, trace_id=str(lf_trace_id), input=input, level=level)
            sp.end(output=output, status_message=status_message)
        except Exception:
            return

    def lf_return(out: dict[str, Any]) -> dict[str, Any]:
        _langfuse_safe_update(lf_trace, output=out, status="success")
        _langfuse_flush(lf)
        return out

    return lf, lf_trace, lf_span, lf_return


__all__ = [
    "_log_request_id",
    "_log_conversation_id",
    "_log_trace_id",
    "_log_user_id",
    "_log_session_id",
    "_logger",
    "_init_otel",
    "_init_langfuse",
    "install_observability",
    "build_chat_respond_langfuse",
    "_otel_correlation_middleware",
]
