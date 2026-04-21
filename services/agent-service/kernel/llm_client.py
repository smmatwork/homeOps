"""Sarvam LLM client.

Single public async function: `sarvam_chat(*, messages, model, temperature,
max_tokens)` returning the assistant's text. Handles:

  - SARVAM_API_KEY resolution (with call-time env re-read to survive dotenv
    reloads during a long-running process).
  - Message shape normalization via `sarvam_adapt_messages` (system-first,
    alternating user/assistant, consecutive-same-role merging).
  - Hard character-budget truncation via orchestrator.context. This is the
    one unusual direction in the import DAG (kernel → orchestrator) — we
    accept it because every LLM call has to apply the same context-budget
    safety net and putting the truncator inside the kernel means every
    caller gets it automatically.
  - OTEL span per call attempt, labeled `llm.sarvam.chat`.
  - Retry policy: SARVAM_MAX_RETRIES attempts, timeout SARVAM_TIMEOUT_MS.
  - Chain-of-thought scrubbing on the returned string via `_strip_think_blocks`.

Test patching: code paths that want to intercept this (integration tests,
fold_summary tests) should patch `main._sarvam_chat` because it's imported
into main.py as an alias and looked up at call time — patching this module
directly ALSO works but requires the caller to be using the kernel import.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx
from opentelemetry import trace  # type: ignore

from orchestrator.context import truncate_messages_to_budget
from orchestrator.parsing import _strip_think_blocks


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    """Strip-then-fallback env reader (matches main.py's helper)."""
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


# ── Sarvam config (module-level, read once at import) ────────────────────────
# Values are read from env at import; the chat function also re-reads
# SARVAM_API_KEY at call time to survive late dotenv loads.

SARVAM_BASE_URL = _env("SARVAM_BASE_URL", "https://api.sarvam.ai")
SARVAM_API_KEY = _env("SARVAM_API_KEY")
SARVAM_MODEL_DEFAULT = _env("SARVAM_MODEL_DEFAULT", "sarvam-m")
SARVAM_TIMEOUT_MS = int((os.environ.get("SARVAM_TIMEOUT_MS") or "").strip() or "20000")
SARVAM_MAX_RETRIES = int((os.environ.get("SARVAM_MAX_RETRIES") or "").strip() or "2")
SARVAM_REASONING_LEVEL = _env("SARVAM_REASONING_LEVEL", "")


def sarvam_adapt_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Normalize messages to satisfy Sarvam constraints.

    Enforced:
      - At most one system message, first; multiple get merged with blank line.
      - User/assistant turns alternate, starting with user. Leading assistant
        turns are dropped; consecutive same-role turns are merged.
      - Empty/whitespace-only content is dropped.
      - Non-str content is dropped.
      - If no user turns survived, a minimal "Hello" user turn is injected so
        downstream code never sees an empty payload.
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

    non_sys: list[dict[str, str]] = []
    for item in non_sys_raw:
        if not non_sys and item["role"] == "assistant":
            continue
        if non_sys and non_sys[-1]["role"] == item["role"]:
            non_sys[-1]["content"] = (non_sys[-1]["content"].rstrip() + "\n\n" + item["content"].lstrip()).strip()
            continue
        non_sys.append(item)

    if not non_sys or non_sys[0]["role"] != "user":
        non_sys.insert(0, {"role": "user", "content": "Hello"})

    out: list[dict[str, str]] = []
    if sys_parts:
        out.append({"role": "system", "content": "\n\n".join(sys_parts)})
    out.extend(non_sys)
    return out


async def sarvam_chat(
    *,
    messages: list[dict[str, str]],
    model: str,
    temperature: float = 0.3,
    max_tokens: int = 512,
) -> str:
    """Make a Sarvam chat completion call and return the assistant's text.

    Raises RuntimeError on missing API key, HTTP 4xx/5xx, or missing response
    text. All transient errors are retried up to SARVAM_MAX_RETRIES times.
    """
    # Re-read at call time to survive late dotenv loads.
    api_key = (os.getenv("SARVAM_API_KEY") or SARVAM_API_KEY or "").strip()
    if not api_key:
        raise RuntimeError("Missing SARVAM_API_KEY")

    url = f"{(SARVAM_BASE_URL or '').rstrip('/')}/v1/chat/completions"
    timeout = httpx.Timeout(SARVAM_TIMEOUT_MS / 1000.0)

    messages = sarvam_adapt_messages(messages)
    messages = truncate_messages_to_budget(messages)

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

                async with httpx.AsyncClient(timeout=timeout) as client:
                    res = await client.post(
                        url,
                        headers={
                            "API-Subscription-Key": api_key,
                            "api-subscription-key": api_key,
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json",
                        },
                        json=payload,
                    )
            if res.status_code >= 400:
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
                        # api_key_len + first 6 chars help debug which key
                        # variant is being rejected (prod vs staging vs dev)
                        # without exposing the full secret. Safe for logs.
                        "api_key_len": len(api_key),
                        "api_key_prefix": api_key[:6],
                        "response_prefix": (res.text or "")[:500],
                    },
                )
                raise RuntimeError(f"Sarvam call failed {res.status_code}: {res.text}")

            data = res.json()

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


__all__ = [
    "SARVAM_BASE_URL",
    "SARVAM_API_KEY",
    "SARVAM_MODEL_DEFAULT",
    "SARVAM_TIMEOUT_MS",
    "SARVAM_MAX_RETRIES",
    "SARVAM_REASONING_LEVEL",
    "sarvam_adapt_messages",
    "sarvam_chat",
]
