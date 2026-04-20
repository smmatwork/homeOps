"""WhatsApp Business API adapters.

Three flavors of WhatsApp delivery:

- WhatsAppTapAdapter: single-button "tap to accept onboarding with
  default consents" message. Lowest-friction way for a helper to say yes
  without filling in a form.

- WhatsAppFormAdapter: sends a magic-link URL to the Stage 2 web page.
  The helper taps the link and fills in the structured form (full
  consent capture). Used when the owner wants rich data but the helper
  has a smartphone.

- WhatsAppVoiceAdapter: records and posts a voice-note prompt that the
  helper can reply to asynchronously with their own voice note. Useful
  for low-literacy helpers who prefer audio.

All three gate on WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID
being set. Missing → NOT_CONFIGURED → dispatcher falls through.

Uses Meta Cloud API (v19.0) for message delivery.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from .base import BaseAdapter

_WA_API_VERSION = "v19.0"


class _WhatsAppBase(BaseAdapter):
    """Shared env-gate logic and HTTP helpers for all three WhatsApp adapters."""

    def _whatsapp_creds(self) -> Optional[tuple[str, str]]:
        token = self._env("WHATSAPP_ACCESS_TOKEN")
        phone_id = self._env("WHATSAPP_PHONE_NUMBER_ID")
        if not token or not phone_id:
            return None
        return (token, phone_id)

    def _helper_has_whatsapp(self, helper: dict[str, Any]) -> bool:
        return bool((helper.get("phone") or "").strip())

    def _format_phone(self, phone: str) -> str:
        """Normalize phone to E.164 format for WhatsApp API.
        Strips spaces/dashes, ensures leading country code."""
        cleaned = phone.strip().replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
        # Indian numbers: if starts with 0, replace with 91
        if cleaned.startswith("0") and len(cleaned) == 11:
            cleaned = "91" + cleaned[1:]
        # If no country code (10 digits), assume India
        if len(cleaned) == 10 and cleaned[0] in "6789":
            cleaned = "91" + cleaned
        # Strip leading +
        if cleaned.startswith("+"):
            cleaned = cleaned[1:]
        return cleaned

    async def _send_whatsapp_message(
        self,
        access_token: str,
        phone_number_id: str,
        to_phone: str,
        payload: dict[str, Any],
    ):
        """Send a message via Meta Cloud API. Returns (success, response_data)."""
        url = f"https://graph.facebook.com/{_WA_API_VERSION}/{phone_number_id}/messages"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }
        body = {
            "messaging_product": "whatsapp",
            "to": self._format_phone(to_phone),
            **payload,
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
                r = await client.post(url, headers=headers, json=body)
                data = r.json() if r.status_code < 500 else {}
                if r.status_code == 200 or r.status_code == 201:
                    msg_id = None
                    messages = data.get("messages", [])
                    if messages and isinstance(messages, list):
                        msg_id = messages[0].get("id")
                    return self._success(provider_message_id=msg_id)
                elif r.status_code == 401 or r.status_code == 403:
                    return self._permanent(f"WhatsApp auth failed: {r.status_code}")
                else:
                    error_msg = json.dumps(data.get("error", {}))[:200] if data else str(r.status_code)
                    return self._transient(f"WhatsApp API error: {error_msg}", retry_after_seconds=60)
        except httpx.TimeoutException:
            return self._transient("WhatsApp API timeout", retry_after_seconds=120)
        except Exception as e:
            return self._transient(f"WhatsApp send failed: {str(e)[:200]}", retry_after_seconds=120)


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

        token, phone_id = creds
        helper_name = helper.get("name", "")
        intent_val = getattr(intent, "value", str(intent))

        # Build interactive button message
        if intent_val == "stage2_onboarding":
            body_text = (
                f"Hi {helper_name}! You've been added to a HomeOps household. "
                f"Tap the button below to accept with default settings, or "
                f"ignore this message to decline."
            )
            button_text = "Accept"
        elif intent_val == "daily_checkin":
            body_text = f"Good morning {helper_name}! Tap to confirm you're starting today's tasks."
            button_text = "I'm here"
        else:
            body_text = f"Hi {helper_name}, you have a new notification from HomeOps."
            button_text = "OK"

        payload = {
            "type": "interactive",
            "interactive": {
                "type": "button",
                "body": {"text": body_text},
                "action": {
                    "buttons": [
                        {
                            "type": "reply",
                            "reply": {
                                "id": f"homeops_{intent_val}_{(invite or {}).get('id', 'none')}",
                                "title": button_text,
                            },
                        }
                    ],
                },
            },
        }

        self._log.info(
            "whatsapp_tap sending: helper=%s intent=%s",
            helper.get("id"), intent_val,
        )
        return await self._send_whatsapp_message(
            token, phone_id, helper.get("phone", ""), payload,
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

        if invite is None or not invite.get("token"):
            return self._permanent("no invite token available for whatsapp_form")

        token, phone_id = creds
        base_url = self._env("HELPER_MAGIC_LINK_BASE_URL", "https://app.homeops.local/h")
        magic_link = f"{base_url}/{invite['token']}"
        helper_name = helper.get("name", "")

        payload = {
            "type": "text",
            "text": {
                "preview_url": True,
                "body": (
                    f"Hi {helper_name}! You've been added to a HomeOps household.\n\n"
                    f"Please tap the link below to complete your profile "
                    f"(takes ~2 minutes):\n\n"
                    f"{magic_link}\n\n"
                    f"You can set your preferred language, communication channel, "
                    f"and privacy preferences."
                ),
            },
        }

        self._log.info(
            "whatsapp_form sending magic link: helper=%s url=%s",
            helper.get("id"), magic_link,
        )
        return await self._send_whatsapp_message(
            token, phone_id, helper.get("phone", ""), payload,
        )


class WhatsAppVoiceAdapter(_WhatsAppBase):
    """Sends a voice-note prompt via WhatsApp (async audio).

    Falls back to a text message with emoji for now — full TTS + audio
    upload will be added when Sarvam TTS integration is ready.
    """

    name = "whatsapp_voice"

    async def deliver(self, helper, intent, invite=None):
        creds = self._whatsapp_creds()
        if creds is None:
            return self._not_configured(
                "WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID"
            )
        if not self._helper_has_whatsapp(helper):
            return self._helper_not_reachable("helper has no phone number on file")

        token, phone_id = creds
        helper_name = helper.get("name", "")
        intent_val = getattr(intent, "value", str(intent))

        # Fallback: send text with voice-note emoji until TTS is wired
        if intent_val == "daily_checkin":
            body = f"Good morning {helper_name}! Please send a photo or voice note when you finish today's tasks."
        elif intent_val == "stage2_onboarding":
            base_url = self._env("HELPER_MAGIC_LINK_BASE_URL", "https://app.homeops.local/h")
            token_str = (invite or {}).get("token", "")
            body = f"Hi {helper_name}! Please complete your profile: {base_url}/{token_str}"
        else:
            body = f"Hi {helper_name}, you have a notification from HomeOps."

        payload = {
            "type": "text",
            "text": {"body": body},
        }

        self._log.info(
            "whatsapp_voice sending (text fallback): helper=%s intent=%s",
            helper.get("id"), intent_val,
        )
        return await self._send_whatsapp_message(
            token, phone_id, helper.get("phone", ""), payload,
        )


class WhatsAppProxyAdapter(_WhatsAppBase):
    """Sends the helper's pending task list to a proxy number when the
    helper's primary WhatsApp is unreachable.

    Use case: the helper's phone is off, broken, or out of data. The
    household has a proxy contact (landline attendant, family member,
    building security desk) who can relay the information verbally.

    The proxy number is read from:
    1. helper["proxy_phone"] — per-helper override
    2. HELPER_PROXY_PHONE env var — household-wide fallback
    """

    name = "whatsapp_proxy"

    async def deliver(self, helper, intent, invite=None):
        creds = self._whatsapp_creds()
        if creds is None:
            return self._not_configured(
                "WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID"
            )

        proxy_phone = (helper.get("proxy_phone") or "").strip()
        if not proxy_phone:
            proxy_phone = self._env("HELPER_PROXY_PHONE")
        if not proxy_phone:
            return self._helper_not_reachable(
                "no proxy phone configured (helper.proxy_phone or HELPER_PROXY_PHONE env)"
            )

        token, phone_id = creds
        helper_name = helper.get("name", "Helper")
        intent_val = getattr(intent, "value", str(intent))

        # Build a relay-friendly message for the proxy contact
        if intent_val == "daily_checkin":
            body = (
                f"[HomeOps Proxy Message]\n\n"
                f"Please relay to {helper_name}:\n"
                f"Good morning! Please confirm you are starting today's tasks. "
                f"Send a photo or thumbs-up when done."
            )
        elif intent_val == "stage2_onboarding":
            base_url = self._env(
                "HELPER_MAGIC_LINK_BASE_URL", "https://app.homeops.local/h"
            )
            token_str = (invite or {}).get("token", "")
            body = (
                f"[HomeOps Proxy Message]\n\n"
                f"Please relay to {helper_name}:\n"
                f"You have been added to a HomeOps household. "
                f"Please complete your profile at:\n{base_url}/{token_str}"
            )
        elif intent_val == "reminder":
            # Include pending task list if available in invite metadata
            tasks = (invite or {}).get("pending_tasks", [])
            task_lines = "\n".join(
                f"  - {t}" for t in tasks[:10]
            ) if tasks else "  (see the HomeOps app for details)"
            body = (
                f"[HomeOps Proxy Message]\n\n"
                f"Please relay to {helper_name}:\n"
                f"Pending tasks for today:\n{task_lines}"
            )
        else:
            body = (
                f"[HomeOps Proxy Message]\n\n"
                f"Please relay to {helper_name}:\n"
                f"You have a notification from HomeOps. "
                f"Please check the app or contact the household."
            )

        payload = {
            "type": "text",
            "text": {"body": body},
        }

        self._log.info(
            "whatsapp_proxy sending to proxy=%s for helper=%s intent=%s",
            proxy_phone, helper.get("id"), intent_val,
        )
        return await self._send_whatsapp_message(
            token, phone_id, proxy_phone, payload,
        )
