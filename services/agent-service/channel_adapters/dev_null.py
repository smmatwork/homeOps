"""DevNullAdapter — always succeeds, logs only.

Used by tests and local dev environments that haven't configured any
real channel providers. Every `deliver()` call records a structured log
line and returns `success=True` with a synthetic provider_message_id.

This adapter is NOT included in `build_default_registry()` — tests
inject it explicitly via the `overrides` kwarg.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from .base import BaseAdapter


class DevNullAdapter(BaseAdapter):
    name = "dev_null"

    def __init__(self, *, always_fail: bool = False, failure_kind: Optional[str] = None) -> None:
        super().__init__()
        self.always_fail = always_fail
        self.failure_kind = failure_kind
        self.calls: list[dict[str, Any]] = []

    async def deliver(self, helper, intent, invite=None):
        record = {
            "helper_id": helper.get("id"),
            "intent": intent.value if hasattr(intent, "value") else str(intent),
            "invite_id": (invite or {}).get("id"),
        }
        self.calls.append(record)
        self._log.debug("dev_null delivery: %s", record)

        if self.always_fail:
            from channel_dispatcher import FailureKind
            if self.failure_kind == "transient":
                return self._transient("dev_null simulated transient failure", retry_after_seconds=60)
            if self.failure_kind == "permanent":
                return self._permanent("dev_null simulated permanent failure")
            if self.failure_kind == "helper_not_reachable":
                return self._helper_not_reachable("dev_null simulated not reachable")
            return self._not_configured("dev_null simulated not configured")

        return self._success(
            provider_message_id=f"devnull_{uuid.uuid4().hex[:12]}",
            language_detected=helper.get("preferred_language") or "en",
            transcript_summary=f"[dev_null] {intent.value if hasattr(intent,'value') else intent} delivered to helper {helper.get('id')}",
        )
