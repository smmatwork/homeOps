"""Orchestrator-owned conversation state: pending clarifications and
plan-confirm-execute confirmations.

Two pluggable backends live here behind a common async interface:

  - InProcessPendingStore (default): module-level dicts keyed by
    conversation_id. Fast and allocation-free — but a service restart
    mid-conversation loses every pending reply, which is the P0 gap
    flagged in the architecture audit.

  - SupabasePendingStore: calls the agent_stash_* / agent_take_* /
    agent_clear_* RPCs introduced in migration 20260422100000. Survives
    agent-service restarts because the state sits in Postgres with a
    TTL-based expiration sweep on each take.

The active backend is picked at import time from AGENT_PENDING_STORE
(`memory`, `""` → InProcess; `supabase` → Supabase). Callers use the
module-level async helpers (`stash_pending_confirmation`, etc.) — they
delegate to the active backend transparently.

The dataclass shapes (PendingClarification, PendingConfirmation) are
unchanged; the Supabase backend hydrates them from the RPC JSONB payload.

Tests can swap the backend via `use_in_process_store_for_tests()`.
"""

from __future__ import annotations

import dataclasses
import logging
import os
import re
import time
from dataclasses import asdict, dataclass
from typing import Any, Protocol

import httpx

from orchestrator.intent import ExtractedIntent


# ── TTLs ─────────────────────────────────────────────────────────────────────

PENDING_CLARIFICATION_TTL_SECONDS = 300

# Use .strip() before the `or` so whitespace-only env values fall back to the
# default. Pre-refactor main.py used a helper (_env) that stripped internally;
# os.environ.get returns "   " unchanged, and "   " is truthy, so a naive
# `get(...) or default` skips the fallback and int() crashes.
PENDING_CONFIRMATION_TTL_SECONDS = int(
    (os.environ.get("AGENT_PENDING_CONFIRMATION_TTL_SECONDS") or "").strip() or "300"
)

# Max clarification back-and-forths before the orchestrator gives up and
# suggests the UI.
MAX_CLARIFICATION_TURNS = 3


# ── State types ──────────────────────────────────────────────────────────────

@dataclass
class PendingClarification:
    """Stashed context when the agent asked for clarification.

    When the router later sees the user's reply, it substitutes the reply into
    the original intents' match_text and re-runs tool-call generation.
    """

    original_intents: list[ExtractedIntent]
    failed_match_text: str  # the term that didn't match
    question_type: str  # "space_not_found", "helper_not_found", "ambiguous"
    expires_at: float


@dataclass
class PendingConfirmation:
    """Stashed tool-call plan awaiting user confirmation ("yes" / "no")."""

    intent: ExtractedIntent
    match_ids: list[tuple[str, str]]  # (id, title)
    tool_calls: list[dict[str, Any]]
    expires_at: float  # monotonic deadline; see time.monotonic()

    # Sync-followup state (None for a regular confirmation).
    # When set, the user is being asked whether to also update the OTHER field
    # after a successful description/title update.
    #   yes → run tool_calls (precomputed mirror updates).
    #   no → cancel.
    #   freeform → treat the reply as the new value for sync_field and execute
    #              fresh tool calls against sync_chore_ids.
    sync_field: str | None = None
    sync_chore_ids: list[str] | None = None
    sync_default_value: str | None = None


# ── In-process state (module-level dicts) ────────────────────────────────────
# Kept exposed for backward-compat: a couple of tests poke them directly and
# the in-process backend's `pending_confirmations` attribute is still the
# source of truth for callers who read/write the pending object after stash
# (e.g. the sync-followup flow patches `sync_field` on the stashed entry).

pending_clarifications: dict[str, PendingClarification] = {}
pending_confirmations: dict[str, PendingConfirmation] = {}
clarification_counts: dict[str, int] = {}


# ── Pending store protocol + implementations ─────────────────────────────────

_logger = logging.getLogger("homeops.orchestrator.state")


class PendingStore(Protocol):
    """Minimal async interface the orchestrator relies on. Both backends
    implement the same shape; swap via AGENT_PENDING_STORE.
    """

    async def stash_confirmation(
        self,
        conversation_id: str,
        intent: ExtractedIntent,
        match_ids: list[tuple[str, str]],
        tool_calls: list[dict[str, Any]],
    ) -> None: ...

    async def take_confirmation(
        self, conversation_id: str
    ) -> PendingConfirmation | None: ...

    async def clear_confirmation(self, conversation_id: str) -> None: ...

    async def stash_clarification(
        self,
        conversation_id: str,
        original_intents: list[ExtractedIntent],
        failed_match_text: str,
        question_type: str,
    ) -> None: ...

    async def take_clarification(
        self, conversation_id: str
    ) -> PendingClarification | None: ...


class InProcessPendingStore:
    """Module-level dict backend — fast, simple, loses state on restart.

    Kept as the default because 100% of the existing test suite runs against
    it and the local dev loop doesn't need the DB hop.
    """

    async def stash_confirmation(
        self,
        conversation_id: str,
        intent: ExtractedIntent,
        match_ids: list[tuple[str, str]],
        tool_calls: list[dict[str, Any]],
    ) -> None:
        pending_confirmations[conversation_id] = PendingConfirmation(
            intent=intent,
            match_ids=list(match_ids),
            tool_calls=list(tool_calls),
            expires_at=time.monotonic() + PENDING_CONFIRMATION_TTL_SECONDS,
        )

    async def take_confirmation(
        self, conversation_id: str
    ) -> PendingConfirmation | None:
        if not conversation_id:
            return None
        pending = pending_confirmations.pop(conversation_id, None)
        if pending is None:
            return None
        if pending.expires_at < time.monotonic():
            return None
        return pending

    async def clear_confirmation(self, conversation_id: str) -> None:
        if conversation_id:
            pending_confirmations.pop(conversation_id, None)

    async def stash_clarification(
        self,
        conversation_id: str,
        original_intents: list[ExtractedIntent],
        failed_match_text: str,
        question_type: str,
    ) -> None:
        pending_clarifications[conversation_id] = PendingClarification(
            original_intents=list(original_intents),
            failed_match_text=failed_match_text,
            question_type=question_type,
            expires_at=time.monotonic() + PENDING_CLARIFICATION_TTL_SECONDS,
        )

    async def take_clarification(
        self, conversation_id: str
    ) -> PendingClarification | None:
        if not conversation_id:
            return None
        pending = pending_clarifications.pop(conversation_id, None)
        if pending is None:
            return None
        if time.monotonic() > pending.expires_at:
            return None
        return pending


class SupabasePendingStore:
    """Postgres-backed backend via the agent_stash_* / agent_take_* /
    agent_clear_* RPCs (migration 20260422100000).

    Each call hits Supabase REST with the service-role key. Blocks on the
    event loop only for the HTTP round-trip (typically <50ms local); the
    RPCs themselves are single-row upsert/delete with an index-backed
    lookup on conversation_id.

    Falls back to `None` (no pending) on any transport / parse error so a
    Supabase outage degrades to "act like there's no stashed reply"
    instead of crashing the turn. Errors are logged — never raised.
    """

    def __init__(self, *, base_url: str, service_key: str, timeout_s: float = 5.0):
        self._base = base_url.rstrip("/")
        self._key = service_key
        self._timeout = timeout_s

    async def _rpc(self, name: str, params: dict[str, Any]) -> Any:
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
        }
        url = f"{self._base}/rest/v1/rpc/{name}"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self._timeout)) as client:
                r = await client.post(url, headers=headers, json=params)
            if r.status_code // 100 != 2:
                _logger.warning("pending store %s non-2xx: %s %s", name, r.status_code, r.text[:200])
                return None
            return r.json() if r.text else None
        except Exception as e:
            _logger.warning("pending store %s failed: %s", name, str(e)[:200])
            return None

    async def stash_confirmation(
        self,
        conversation_id: str,
        intent: ExtractedIntent,
        match_ids: list[tuple[str, str]],
        tool_calls: list[dict[str, Any]],
    ) -> None:
        if not conversation_id:
            return
        await self._rpc(
            "agent_stash_confirmation",
            {
                "p_conversation_id": conversation_id,
                "p_intent": asdict(intent),
                "p_match_ids": [list(t) for t in match_ids],
                "p_tool_calls": tool_calls,
                "p_ttl_seconds": PENDING_CONFIRMATION_TTL_SECONDS,
            },
        )

    async def take_confirmation(
        self, conversation_id: str
    ) -> PendingConfirmation | None:
        if not conversation_id:
            return None
        data = await self._rpc(
            "agent_take_confirmation",
            {"p_conversation_id": conversation_id},
        )
        row = _first_row(data)
        if row is None:
            return None
        try:
            intent = _intent_from_jsonb(row.get("intent") or {})
            match_ids = [(x[0], x[1]) for x in (row.get("match_ids") or []) if isinstance(x, list) and len(x) >= 2]
            tool_calls = list(row.get("tool_calls") or [])
            # The DB store doesn't hand back expires_at — the RPC already
            # filtered expired rows on the take, so set to "forever" here
            # from the in-process TTL clock's perspective.
            pending = PendingConfirmation(
                intent=intent,
                match_ids=match_ids,
                tool_calls=tool_calls,
                expires_at=time.monotonic() + PENDING_CONFIRMATION_TTL_SECONDS,
                sync_field=row.get("sync_field"),
                sync_chore_ids=row.get("sync_chore_ids"),
                sync_default_value=row.get("sync_default_value"),
            )
            return pending
        except Exception as e:
            _logger.warning("pending store: failed to hydrate confirmation: %s", e)
            return None

    async def clear_confirmation(self, conversation_id: str) -> None:
        if not conversation_id:
            return
        await self._rpc("agent_clear_confirmation", {"p_conversation_id": conversation_id})

    async def stash_clarification(
        self,
        conversation_id: str,
        original_intents: list[ExtractedIntent],
        failed_match_text: str,
        question_type: str,
    ) -> None:
        if not conversation_id:
            return
        await self._rpc(
            "agent_stash_clarification",
            {
                "p_conversation_id": conversation_id,
                "p_original_intents": [asdict(i) for i in original_intents],
                "p_failed_match_text": failed_match_text,
                "p_question_type": question_type,
                "p_ttl_seconds": PENDING_CLARIFICATION_TTL_SECONDS,
            },
        )

    async def take_clarification(
        self, conversation_id: str
    ) -> PendingClarification | None:
        if not conversation_id:
            return None
        data = await self._rpc(
            "agent_take_clarification",
            {"p_conversation_id": conversation_id},
        )
        row = _first_row(data)
        if row is None:
            return None
        try:
            intents = [_intent_from_jsonb(i) for i in (row.get("original_intents") or [])]
            return PendingClarification(
                original_intents=intents,
                failed_match_text=str(row.get("failed_match_text") or ""),
                question_type=str(row.get("question_type") or ""),
                expires_at=time.monotonic() + PENDING_CLARIFICATION_TTL_SECONDS,
            )
        except Exception as e:
            _logger.warning("pending store: failed to hydrate clarification: %s", e)
            return None


def _first_row(data: Any) -> dict[str, Any] | None:
    """Normalize Supabase RPC responses that may be wrapped as a single-row
    list or a bare object. Returns None when the result is empty."""
    if data is None:
        return None
    if isinstance(data, list):
        if not data:
            return None
        first = data[0]
        return first if isinstance(first, dict) else None
    if isinstance(data, dict):
        return data
    return None


def _intent_from_jsonb(payload: dict[str, Any]) -> ExtractedIntent:
    """Rebuild an ExtractedIntent from its JSONB dict form."""
    fields = {f.name for f in dataclasses.fields(ExtractedIntent)}
    kwargs = {k: v for k, v in payload.items() if k in fields}
    return ExtractedIntent(**kwargs)


def _build_default_store() -> PendingStore:
    """Select the active backend based on AGENT_PENDING_STORE.

    Values:
      - "supabase" → SupabasePendingStore (requires SUPABASE_URL +
        SUPABASE_SERVICE_ROLE_KEY). Falls back to InProcess with a
        warning if the creds are missing.
      - anything else (incl. empty / "memory") → InProcessPendingStore
    """
    mode = (os.environ.get("AGENT_PENDING_STORE") or "").strip().lower()
    if mode != "supabase":
        return InProcessPendingStore()

    base = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or ""
    ).strip()
    if not base or not key:
        _logger.warning(
            "AGENT_PENDING_STORE=supabase but SUPABASE_URL/SERVICE_ROLE_KEY missing — "
            "falling back to in-process store",
        )
        return InProcessPendingStore()
    return SupabasePendingStore(base_url=base, service_key=key)


_store: PendingStore = _build_default_store()


def use_in_process_store_for_tests() -> None:
    """Force the in-process backend. Useful in tests that want to assert
    state round-trips through the module-level dicts.
    """
    global _store
    _store = InProcessPendingStore()
    pending_confirmations.clear()
    pending_clarifications.clear()
    clarification_counts.clear()


def set_store(store: PendingStore) -> None:
    """Install a custom store (e.g. a test double)."""
    global _store
    _store = store


# ── Clarification API ────────────────────────────────────────────────────────

async def stash_clarification(
    conversation_id: str,
    original_intents: list[ExtractedIntent],
    failed_match_text: str,
    question_type: str,
) -> None:
    await _store.stash_clarification(
        conversation_id, original_intents, failed_match_text, question_type,
    )


async def take_clarification(conversation_id: str) -> PendingClarification | None:
    """Pop and return the stashed clarification for this conversation, or
    None if missing/expired."""
    return await _store.take_clarification(conversation_id)


# ── Confirmation API ─────────────────────────────────────────────────────────

_CONFIRM_RE = re.compile(
    r"^\s*(?:yes|y|yeah|yep|yup|sure|ok|okay|confirm|proceed|go\s*ahead|do\s*it|please\s+do)\b",
    re.IGNORECASE,
)
_CANCEL_RE = re.compile(
    r"^\s*(?:no|n|nope|cancel|stop|abort|nevermind|never\s*mind|don'?t|do\s*not)\b",
    re.IGNORECASE,
)


def is_confirmation(text: str) -> bool:
    return bool(_CONFIRM_RE.match(text or ""))


def is_cancellation(text: str) -> bool:
    return bool(_CANCEL_RE.match(text or ""))


async def stash_pending_confirmation(
    conversation_id: str,
    intent: ExtractedIntent,
    match_ids: list[tuple[str, str]],
    tool_calls: list[dict[str, Any]],
) -> None:
    await _store.stash_confirmation(
        conversation_id, intent, match_ids, tool_calls,
    )


async def take_pending_confirmation(
    conversation_id: str,
) -> PendingConfirmation | None:
    """Pop and return the non-expired pending confirmation for this
    conversation, or None if missing/expired."""
    return await _store.take_confirmation(conversation_id)


async def clear_pending_confirmation(conversation_id: str) -> None:
    await _store.clear_confirmation(conversation_id)


__all__ = [
    "PENDING_CLARIFICATION_TTL_SECONDS",
    "PENDING_CONFIRMATION_TTL_SECONDS",
    "MAX_CLARIFICATION_TURNS",
    "PendingClarification",
    "PendingConfirmation",
    "PendingStore",
    "InProcessPendingStore",
    "SupabasePendingStore",
    "pending_clarifications",
    "pending_confirmations",
    "clarification_counts",
    "stash_clarification",
    "take_clarification",
    "is_confirmation",
    "is_cancellation",
    "stash_pending_confirmation",
    "take_pending_confirmation",
    "clear_pending_confirmation",
    "use_in_process_store_for_tests",
    "set_store",
]
