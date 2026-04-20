"""Channel dispatcher for helper outreach (Phase 1.0a).

Routes outreach attempts (onboarding, check-in, balance inquiry, etc.) to
the helper's preferred channel chain. Walks the chain until one adapter
succeeds, records every attempt in `helper_outreach_attempts`, and falls
through on permanent failures.

Design notes:
- The dispatcher is transport-agnostic. Adapters implement the real
  provider calls (Sarvam voice, WhatsApp Business API, Twilio/Exotel
  SMS, etc.). Adapters that lack credentials return
  `DeliveryResult(success=False, failure_kind="not_configured")` so the
  dispatcher skips them gracefully.
- Every attempt is persisted to `helper_outreach_attempts` regardless of
  outcome. The 3-month TTL cleanup (shipped in migration
  20260415300000) keeps the table bounded.
- Retry scheduling is handled by the caller, not the dispatcher.
  `DeliveryResult.retry_after` is advisory — the caller is expected to
  reschedule via `helper_outreach_attempts.next_retry_at`.
"""

from __future__ import annotations

import enum
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Protocol


# ── Types ───────────────────────────────────────────────────────────────


class OutreachIntent(str, enum.Enum):
    """Why the system is reaching out to the helper.

    Matches the `intent` column on `helper_outreach_attempts`. Adding a
    new intent requires a migration to extend the check constraint.
    """

    STAGE2_ONBOARDING = "stage2_onboarding"
    DAILY_CHECKIN = "daily_checkin"
    BALANCE_INQUIRY = "balance_inquiry"
    REASSIGNMENT_CONSENT = "reassignment_consent"
    SCHEDULE_CHANGE_CONSENT = "schedule_change_consent"
    REMINDER = "reminder"
    PATTERN_ELICITATION_FOLLOWUP = "pattern_elicitation_followup"


class FailureKind(str, enum.Enum):
    """Why an adapter failed to deliver. Drives dispatcher fall-through."""

    # Transient — retry the same adapter later.
    TRANSIENT = "transient"
    # Permanent for this adapter — skip and try the next channel.
    PERMANENT = "permanent"
    # Adapter can't even attempt delivery (missing credentials, disabled).
    NOT_CONFIGURED = "not_configured"
    # Helper data is invalid for this channel (no phone, no WhatsApp, etc.).
    HELPER_NOT_REACHABLE = "helper_not_reachable"


@dataclass
class DeliveryResult:
    """What an adapter's `deliver()` returns."""

    success: bool
    channel: str
    # On success, a provider-side identifier for the attempt.
    provider_message_id: Optional[str] = None
    # On failure, the kind + a human-readable reason.
    failure_kind: Optional[FailureKind] = None
    failure_reason: Optional[str] = None
    # Suggested retry delay (for TRANSIENT failures only).
    retry_after: Optional[timedelta] = None
    # Structured details the caller can persist on the attempt row.
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ChannelAttempt:
    """A single channel attempt, ready to be persisted to
    `helper_outreach_attempts`."""

    helper_id: str
    household_id: str
    intent: OutreachIntent
    direction: str  # 'outbound' | 'inbound'
    channel_used: str
    invite_id: Optional[str] = None
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    ended_at: Optional[datetime] = None
    status: str = "in_progress"
    language_detected: Optional[str] = None
    recording_url: Optional[str] = None
    transcript_summary: Optional[str] = None
    consents_captured: Optional[dict[str, Any]] = None
    retry_count: int = 0
    next_retry_at: Optional[datetime] = None
    failure_reason: Optional[str] = None


@dataclass
class OutreachResult:
    """What `ChannelDispatcher.initiate_outreach()` returns."""

    success: bool
    attempts: list[ChannelAttempt]
    final_channel: Optional[str] = None
    final_reason: Optional[str] = None


# ── Adapter protocol ────────────────────────────────────────────────────


class ChannelAdapter(Protocol):
    """Transport implementation for one channel (voice, whatsapp_tap, ...).

    Adapters are stateless; credentials and configuration are read at
    construction time from env vars. An adapter that's missing required
    configuration should return `DeliveryResult(failure_kind=NOT_CONFIGURED)`
    instead of raising, so the dispatcher can skip it.
    """

    name: str

    async def deliver(
        self,
        helper: dict[str, Any],
        intent: OutreachIntent,
        invite: Optional[dict[str, Any]] = None,
    ) -> DeliveryResult:
        """Attempt to deliver an outreach to the helper via this channel."""
        ...

    async def handle_inbound(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Handle an inbound event from the provider (webhook payload).

        Returns a structured event dict the orchestrator can route.
        Default implementation: return a passthrough echo so adapters that
        don't accept inbound events can be identified.
        """
        ...


# ── Dispatcher ──────────────────────────────────────────────────────────


class ChannelDispatcher:
    """Walks a helper's `channel_preferences` chain until one succeeds.

    Usage:
        dispatcher = ChannelDispatcher(adapters={...}, persist_attempt=fn)
        result = await dispatcher.initiate_outreach(helper, intent)
        if not result.success:
            # fall back to manual notification or reschedule
    """

    def __init__(
        self,
        adapters: dict[str, ChannelAdapter],
        persist_attempt: Optional[Any] = None,
    ):
        self.adapters = adapters
        # `persist_attempt` is an async callable `(ChannelAttempt) -> None`
        # that writes to `helper_outreach_attempts`. Injected rather than
        # imported so tests can mock it without reaching Supabase.
        self._persist_attempt = persist_attempt
        self._log = logging.getLogger("homeops.channel_dispatcher")

    async def initiate_outreach(
        self,
        helper: dict[str, Any],
        intent: OutreachIntent,
        invite: Optional[dict[str, Any]] = None,
    ) -> OutreachResult:
        """Walk `helper['channel_preferences']` until one adapter succeeds.

        Every attempt is persisted via `persist_attempt`. On permanent or
        not_configured failures we immediately fall through to the next
        channel. On transient failures we return a retry_scheduled attempt
        and STOP walking — the caller reschedules via `next_retry_at`.
        """
        chain = helper.get("channel_preferences") or []
        if not chain:
            self._log.warning(
                "dispatcher: helper %s has empty channel_preferences; defaulting to ['voice']",
                helper.get("id"),
            )
            chain = ["voice"]

        attempts: list[ChannelAttempt] = []
        for channel in chain:
            adapter = self.adapters.get(channel)
            if adapter is None:
                # No adapter registered for this channel. Treat as not
                # configured and keep walking.
                attempt = self._build_attempt(
                    helper, intent, invite, channel, "failed",
                    failure_reason=f"no adapter registered for channel '{channel}'",
                )
                attempts.append(attempt)
                await self._safe_persist(attempt)
                continue

            # Call the adapter.
            try:
                result = await adapter.deliver(helper, intent, invite)
            except Exception as e:  # noqa: BLE001
                self._log.exception(
                    "dispatcher: adapter %s raised unexpectedly for helper %s intent %s",
                    channel, helper.get("id"), intent.value,
                )
                result = DeliveryResult(
                    success=False,
                    channel=channel,
                    failure_kind=FailureKind.TRANSIENT,
                    failure_reason=f"adapter exception: {type(e).__name__}: {e}",
                )

            attempt = self._attempt_from_result(helper, intent, invite, channel, result)
            attempts.append(attempt)
            await self._safe_persist(attempt)

            if result.success:
                return OutreachResult(
                    success=True,
                    attempts=attempts,
                    final_channel=channel,
                )

            if result.failure_kind == FailureKind.TRANSIENT:
                # Stop and let the caller reschedule this channel.
                return OutreachResult(
                    success=False,
                    attempts=attempts,
                    final_channel=channel,
                    final_reason=f"transient: {result.failure_reason or 'unknown'}",
                )

            # PERMANENT / NOT_CONFIGURED / HELPER_NOT_REACHABLE → next channel
            continue

        return OutreachResult(
            success=False,
            attempts=attempts,
            final_reason="all_channels_exhausted",
        )

    # ── Internal helpers ────────────────────────────────────────────────

    def _build_attempt(
        self,
        helper: dict[str, Any],
        intent: OutreachIntent,
        invite: Optional[dict[str, Any]],
        channel: str,
        status: str,
        failure_reason: Optional[str] = None,
    ) -> ChannelAttempt:
        return ChannelAttempt(
            helper_id=str(helper.get("id") or ""),
            household_id=str(helper.get("household_id") or ""),
            intent=intent,
            direction="outbound",
            channel_used=channel,
            invite_id=str(invite["id"]) if invite and invite.get("id") else None,
            status=status,
            failure_reason=failure_reason,
        )

    def _attempt_from_result(
        self,
        helper: dict[str, Any],
        intent: OutreachIntent,
        invite: Optional[dict[str, Any]],
        chain_channel: str,
        result: DeliveryResult,
    ) -> ChannelAttempt:
        # Use the chain position (what the helper's preferences asked
        # for), not result.channel (what the adapter internally calls
        # itself). This matters when tests substitute a DevNullAdapter
        # for the real adapter — the attempt row should still record
        # "voice" or whatever the chain position was, not "dev_null".
        attempt = self._build_attempt(
            helper, intent, invite, chain_channel,
            status="completed" if result.success else self._failure_status(result.failure_kind),
            failure_reason=result.failure_reason,
        )
        attempt.ended_at = datetime.now(timezone.utc)
        if result.retry_after is not None:
            attempt.next_retry_at = datetime.now(timezone.utc) + result.retry_after
            attempt.status = "retry_scheduled"
        # Pull structured fields the adapter wants persisted.
        meta = result.metadata or {}
        if "language_detected" in meta:
            attempt.language_detected = meta.get("language_detected")
        if "recording_url" in meta:
            attempt.recording_url = meta.get("recording_url")
        if "transcript_summary" in meta:
            attempt.transcript_summary = meta.get("transcript_summary")
        if "consents_captured" in meta:
            attempt.consents_captured = meta.get("consents_captured")
        return attempt

    @staticmethod
    def _failure_status(kind: Optional[FailureKind]) -> str:
        if kind == FailureKind.TRANSIENT:
            return "retry_scheduled"
        if kind == FailureKind.HELPER_NOT_REACHABLE:
            return "no_answer"
        return "failed"

    async def _safe_persist(self, attempt: ChannelAttempt) -> None:
        if self._persist_attempt is None:
            return
        try:
            await self._persist_attempt(attempt)
        except Exception as e:  # noqa: BLE001
            self._log.exception(
                "dispatcher: persist_attempt failed for helper %s channel %s: %s",
                attempt.helper_id, attempt.channel_used, e,
            )
