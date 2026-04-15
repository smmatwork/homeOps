"""WhatsApp Business API adapters.

Three flavors of WhatsApp delivery:

- WhatsAppTapAdapter: single-button "tap ✅ to accept onboarding with
  default consents" message. Lowest-friction way for a helper to say yes
  without filling in a form. Writes default-consent rows on inbound tap.

- WhatsAppFormAdapter: sends a magic-link URL to the Stage 2 web page.
  The helper taps the link and fills in the structured form (full
  consent capture). Used when the owner wants rich data but the helper
  has a smartphone.

- WhatsAppVoiceAdapter: records and posts a voice-note prompt that the
  helper can reply to asynchronously with their own voice note. Useful
  for low-literacy helpers who prefer audio.

All three gate on WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID
being set. Missing → NOT_CONFIGURED → dispatcher falls through.

Real API calls are not implemented in this commit — adapters return
NOT_CONFIGURED when creds aren't set, and a permanent-failure stub when
they ARE set (so the dispatcher logs the attempt correctly). Actual
Meta Business API wiring happens in a follow-up commit once we have
sandbox credentials.
"""

from __future__ import annotations

from typing import Any, Optional

from .base import BaseAdapter


class _WhatsAppBase(BaseAdapter):
    """Shared env-gate logic for all three WhatsApp adapters."""

    def _whatsapp_creds(self) -> Optional[tuple[str, str]]:
        token = self._env("WHATSAPP_ACCESS_TOKEN")
        phone_id = self._env("WHATSAPP_PHONE_NUMBER_ID")
        if not token or not phone_id:
            return None
        return (token, phone_id)

    def _helper_has_whatsapp(self, helper: dict[str, Any]) -> bool:
        # In v1 we assume any helper with a phone number is reachable on
        # WhatsApp. A future iteration can store whatsapp_verified: bool
        # on the helpers table after a ping.
        return bool((helper.get("phone") or "").strip())


class WhatsAppTapAdapter(_WhatsAppBase):
    """Sends a one-tap accept button via WhatsApp interactive message."""

    name = "whatsapp_tap"

    async def deliver(self, helper, intent, invite=None):
        creds = self._whatsapp_creds()
        if creds is None:
            return self._not_configured(
                "WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID"
            )
        if not self._helper_has_whatsapp(helper):
            return self._helper_not_reachable("helper has no phone number on file")

        # Real Meta Business API call goes here. For v1 we stub the send
        # and surface NOT_CONFIGURED with a clear marker so the follow-up
        # work item is obvious.
        self._log.info(
            "whatsapp_tap would send: helper=%s intent=%s invite=%s",
            helper.get("id"), getattr(intent, "value", intent),
            (invite or {}).get("id"),
        )
        return self._not_configured(
            "WhatsAppTapAdapter HTTP send pending — see homeops.helper_module.plan.md P1.0a followup"
        )


class WhatsAppFormAdapter(_WhatsAppBase):
    """Sends a magic-link URL to the Stage 2 web form via WhatsApp text."""

    name = "whatsapp_form"

    async def deliver(self, helper, intent, invite=None):
        creds = self._whatsapp_creds()
        if creds is None:
            return self._not_configured(
                "WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID"
            )
        if not self._helper_has_whatsapp(helper):
            return self._helper_not_reachable("helper has no phone number on file")

        # The Stage 2 magic-link URL is built from the invite token.
        if invite is None or not invite.get("token"):
            return self._permanent("no invite token available for whatsapp_form")

        base_url = self._env("HELPER_MAGIC_LINK_BASE_URL", "https://app.homeops.local/h")
        magic_link = f"{base_url}/{invite['token']}"
        self._log.info(
            "whatsapp_form would send magic link: helper=%s url=%s",
            helper.get("id"), magic_link,
        )
        return self._not_configured(
            "WhatsAppFormAdapter HTTP send pending — see homeops.helper_module.plan.md P1.0a followup"
        )


class WhatsAppVoiceAdapter(_WhatsAppBase):
    """Sends a voice-note prompt via WhatsApp (async audio)."""

    name = "whatsapp_voice"

    async def deliver(self, helper, intent, invite=None):
        creds = self._whatsapp_creds()
        if creds is None:
            return self._not_configured(
                "WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID"
            )
        if not self._helper_has_whatsapp(helper):
            return self._helper_not_reachable("helper has no phone number on file")

        # Requires a TTS-produced audio file upload to WhatsApp + then a
        # media message referencing that upload. Stubbed in v1.
        self._log.info(
            "whatsapp_voice would send audio: helper=%s intent=%s",
            helper.get("id"), getattr(intent, "value", intent),
        )
        return self._not_configured(
            "WhatsAppVoiceAdapter TTS + upload pending — see homeops.helper_module.plan.md P1.0a followup"
        )
