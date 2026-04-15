"""Base adapter with common helpers shared by all channel adapters."""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

# Late import inside methods to avoid a circular dependency with
# channel_dispatcher.py importing this package.


class BaseAdapter:
    """Shared functionality for all channel adapters.

    Subclasses override `name` and implement `deliver()`. This class
    provides:

    - `_env()` — env var reader with a default
    - `_log` — structured logger scoped to the adapter
    - `_not_configured()` — convenience factory for a `NOT_CONFIGURED`
      result when required credentials are missing
    - `_helper_reachable_for_channel()` — validates helper data for this
      channel (e.g. voice requires a phone number)
    """

    name: str = "base"

    def __init__(self) -> None:
        self._log = logging.getLogger(f"homeops.channel_adapter.{self.name}")

    @staticmethod
    def _env(key: str, default: str = "") -> str:
        return (os.environ.get(key) or default).strip()

    def _not_configured(self, missing: str):
        from channel_dispatcher import DeliveryResult, FailureKind
        return DeliveryResult(
            success=False,
            channel=self.name,
            failure_kind=FailureKind.NOT_CONFIGURED,
            failure_reason=f"missing configuration: {missing}",
        )

    def _helper_not_reachable(self, reason: str):
        from channel_dispatcher import DeliveryResult, FailureKind
        return DeliveryResult(
            success=False,
            channel=self.name,
            failure_kind=FailureKind.HELPER_NOT_REACHABLE,
            failure_reason=reason,
        )

    def _transient(self, reason: str, retry_after_seconds: int = 300):
        from channel_dispatcher import DeliveryResult, FailureKind
        from datetime import timedelta
        return DeliveryResult(
            success=False,
            channel=self.name,
            failure_kind=FailureKind.TRANSIENT,
            failure_reason=reason,
            retry_after=timedelta(seconds=retry_after_seconds),
        )

    def _permanent(self, reason: str):
        from channel_dispatcher import DeliveryResult, FailureKind
        return DeliveryResult(
            success=False,
            channel=self.name,
            failure_kind=FailureKind.PERMANENT,
            failure_reason=reason,
        )

    def _success(self, provider_message_id: Optional[str] = None, **metadata):
        from channel_dispatcher import DeliveryResult
        return DeliveryResult(
            success=True,
            channel=self.name,
            provider_message_id=provider_message_id,
            metadata=metadata,
        )

    async def deliver(
        self,
        helper: dict[str, Any],
        intent,  # OutreachIntent — avoid circular import
        invite: Optional[dict[str, Any]] = None,
    ):
        """Subclasses must override this."""
        return self._not_configured(f"{self.name}.deliver() not implemented")

    async def handle_inbound(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Default: passthrough. Subclasses override if they accept inbound."""
        return {"adapter": self.name, "payload": payload}
