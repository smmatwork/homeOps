"""`/v1/helpers/*` endpoints — helper onboarding dispatch.

Lives here instead of main.py so main.py is just startup + chat/runs/embed.
The router is built with injected deps (edge client + shared auth key) so
this module has no dependency on main.py's module-level globals.
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel


EdgeExecuteFn = Callable[..., Awaitable[Any]]


class DispatchInviteRequest(BaseModel):
    helper_id: str
    helper_name: str
    helper_phone: str | None = None
    channel_chain: list[str] = ["whatsapp", "sms", "web"]
    magic_link_url: str
    household_id: str


def build_helpers_router(
    *,
    agent_service_key: str | None,
    edge_execute_tools: EdgeExecuteFn,
) -> APIRouter:
    """Build the `/v1/helpers/*` router with its auth + edge deps bound.

    `agent_service_key` is checked against the `x-agent-service-key` header
    exactly like the other protected endpoints; `edge_execute_tools` is the
    same module-level callable used elsewhere (readable through the shim
    so test patches on `agent_main._edge_execute_tools` still propagate).
    """
    router = APIRouter()
    expected_key = (agent_service_key or "").strip()

    @router.post("/v1/helpers/dispatch-invite")
    async def dispatch_invite(
        req: DispatchInviteRequest,
        x_agent_service_key: str | None = Header(default=None, alias="x-agent-service-key"),
    ) -> dict[str, Any]:
        """Send a helper onboarding magic link via the channel dispatcher."""
        provided = (x_agent_service_key or "").strip()
        if not expected_key or not provided or provided != expected_key:
            raise HTTPException(status_code=403, detail="Forbidden")

        # Lazy imports — channel adapters pull in optional deps that may
        # not be available in every runtime (e.g. during tests).
        from channel_dispatcher import ChannelDispatcher, OutreachIntent
        from channel_adapters import (
            WhatsAppTapAdapter,
            build_default_registry,
        )

        # Build from the canonical registry (voice / sms / web / whatsapp_*
        # variants) plus a "whatsapp" alias so the default client-supplied
        # channel_chain=["whatsapp", "sms", "web"] resolves without forcing
        # callers to pick a specific WhatsApp variant.
        adapters = build_default_registry(whatsapp=WhatsAppTapAdapter())

        async def persist_attempt(attempt: Any) -> None:
            """Best-effort persist to helper_outreach_attempts via edge."""
            try:
                await edge_execute_tools(
                    {
                        "household_id": req.household_id,
                        "tool_call": {
                            "id": f"outreach_{req.helper_id}_{int(time.time())}",
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

    return router


__all__ = ["build_helpers_router", "DispatchInviteRequest"]
