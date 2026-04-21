"""Edge-function HTTP client.

Four public async functions for talking to the Supabase edge function:
  - `edge_post(path, payload)`   — fire-and-forget POST (no body expected back).
  - `edge_get(path, params)`     — GET with JSON response.
  - `edge_execute_tools(payload, *, user_id)` — POST to /tools/execute, the
    write path the orchestrator uses to commit agent decisions.
  - `resolve_edge_base_url()`    — rewrite host.docker.internal for local dev.

Auth: `x-agent-service-key` header, value read from env at call time via
`_current_agent_service_key()`. AGENT_SERVICE_KEY is NOT moved here because
the same value is also consulted by the HTTP auth check in the /v1/chat/respond
handler itself — it's global service-auth config, not edge-client scope.

Env vars resolved at import:
  - EDGE_BASE_URL         — base URL of the Supabase edge function
  - EDGE_BEARER_TOKEN     — optional OAuth bearer for the edge gateway
"""

from __future__ import annotations

import os
from typing import Any, Optional
from urllib.parse import urlencode

import httpx


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


EDGE_BASE_URL = _env("EDGE_BASE_URL")
EDGE_BEARER_TOKEN = _env("EDGE_BEARER_TOKEN")


def _current_agent_service_key() -> str:
    """Read AGENT_SERVICE_KEY from env at call time.

    The value is stable across the process lifetime but we read fresh anyway
    so tests can mutate it without forcing a module reload.
    """
    return (os.getenv("AGENT_SERVICE_KEY") or "").strip()


def resolve_edge_base_url() -> str:
    """Rewrite host.docker.internal → 127.0.0.1 when the agent runs on the host.

    EDGE_BASE_URL is usually set to host.docker.internal for containerized
    deploys, but local dev runs uvicorn on the host where that hostname
    doesn't resolve. Substituting at call time matches the pattern
    used by orchestrator.facts for Supabase REST.
    """
    base = (EDGE_BASE_URL or "").strip()
    if "host.docker.internal" not in base:
        return base
    import urllib.parse
    parsed = urllib.parse.urlparse(base)
    new_host = "127.0.0.1"
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{new_host}{port}{parsed.path}"


async def edge_post(path: str, payload: dict[str, Any]) -> None:
    if not EDGE_BASE_URL:
        raise RuntimeError("Missing EDGE_BASE_URL")
    agent_key = _current_agent_service_key()
    if not agent_key:
        raise RuntimeError("Missing AGENT_SERVICE_KEY")

    url = f"{EDGE_BASE_URL.rstrip('/')}{path}"
    headers = {
        "x-agent-service-key": agent_key,
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


async def edge_execute_tools(payload: dict[str, Any], *, user_id: str) -> Any:
    if not EDGE_BASE_URL:
        raise RuntimeError("Missing EDGE_BASE_URL")
    agent_key = _current_agent_service_key()
    if not agent_key:
        raise RuntimeError("Missing AGENT_SERVICE_KEY")

    url = f"{resolve_edge_base_url().rstrip('/')}/tools/execute"
    headers = {
        "x-agent-service-key": agent_key,
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


async def edge_get(path: str, params: dict[str, str]) -> Any:
    if not EDGE_BASE_URL:
        raise RuntimeError("Missing EDGE_BASE_URL")
    agent_key = _current_agent_service_key()
    if not agent_key:
        raise RuntimeError("Missing AGENT_SERVICE_KEY")

    qs = urlencode(params)
    url = f"{resolve_edge_base_url().rstrip('/')}{path}{'?' if qs else ''}{qs}"
    headers = {
        "x-agent-service-key": agent_key,
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


__all__ = [
    "EDGE_BASE_URL",
    "EDGE_BEARER_TOKEN",
    "resolve_edge_base_url",
    "edge_post",
    "edge_get",
    "edge_execute_tools",
]
