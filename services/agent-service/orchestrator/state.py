"""Orchestrator-owned conversation state: pending clarifications and
plan-confirm-execute confirmations.

This is the state that spans turns in a single conversation — the router owns
it, not the domain agents. Agents produce a clarification request or a tool
plan; the router stashes it here, shows the preview to the user, and retrieves
it again when the user replies with "yes" (confirm) or free text (clarify).

Current implementation is in-process dicts keyed by conversation_id with a TTL
sweep on take(). This is the P0 gap flagged in the architecture audit: a
service restart mid-conversation orphans the user's reply. Making this
DB-backed later is a single-file change — swap the dict operations for
agent_pending_confirmations table reads/writes behind the same function
signatures.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

from orchestrator.intent import ExtractedIntent


# ── TTLs ─────────────────────────────────────────────────────────────────────

PENDING_CLARIFICATION_TTL_SECONDS = 300

PENDING_CONFIRMATION_TTL_SECONDS = int(
    os.environ.get("AGENT_PENDING_CONFIRMATION_TTL_SECONDS", "300") or "300"
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


# ── In-process state (dicts keyed by conversation_id) ────────────────────────
# Exposed as module attributes so tests can clear/poke them directly. When
# this module swaps to a DB-backed store, these module-level dicts will be
# replaced by a thin repository object with the same public functions.

pending_clarifications: dict[str, PendingClarification] = {}
pending_confirmations: dict[str, PendingConfirmation] = {}
clarification_counts: dict[str, int] = {}


# ── Clarification API ────────────────────────────────────────────────────────

def stash_clarification(
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


def take_clarification(conversation_id: str) -> PendingClarification | None:
    """Pop and return the stashed clarification for this conversation, or None
    if missing/expired."""
    if not conversation_id:
        return None
    pending = pending_clarifications.pop(conversation_id, None)
    if pending is None:
        return None
    if time.monotonic() > pending.expires_at:
        return None
    return pending


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


def stash_pending_confirmation(
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


def take_pending_confirmation(conversation_id: str) -> PendingConfirmation | None:
    """Pop and return the non-expired pending confirmation for this
    conversation, or None if missing/expired."""
    if not conversation_id:
        return None
    pending = pending_confirmations.pop(conversation_id, None)
    if pending is None:
        return None
    if pending.expires_at < time.monotonic():
        return None
    return pending


def clear_pending_confirmation(conversation_id: str) -> None:
    if conversation_id:
        pending_confirmations.pop(conversation_id, None)


__all__ = [
    "PENDING_CLARIFICATION_TTL_SECONDS",
    "PENDING_CONFIRMATION_TTL_SECONDS",
    "MAX_CLARIFICATION_TURNS",
    "PendingClarification",
    "PendingConfirmation",
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
]
