"""SMS adapter — plain text with a callback number.

SMS is the lowest-bandwidth fallback in the default channel chain. The
message is short, in the helper's preferred language when possible, and
includes a callback number the helper can dial to reach the voice flow.

Gates on SMS_PROVIDER + SMS_API_KEY env vars. Missing → NOT_CONFIGURED.
"""

from __future__ import annotations

from typing import Any

from .base import BaseAdapter


SMS_TEMPLATES_EN = {
    "stage2_onboarding": (
        "Hi {name}, {household} has added you on HomeOps. "
        "Call us at {callback} to complete onboarding. Thank you!"
    ),
    "daily_checkin": "Hi {name}, please reply YES when today's tasks are done.",
    "reminder": "Hi {name}, a quick reminder from HomeOps for {household}.",
    "reassignment_consent": (
        "Hi {name}, {household} wants to reassign a task to you today. "
        "Call {callback} to confirm."
    ),
}


class SMSAdapter(BaseAdapter):
    name = "sms"

    async def deliver(self, helper, intent, invite=None):
        provider = self._env("SMS_PROVIDER").lower()
        if provider not in ("twilio", "exotel", "knowlarity", "plivo"):
            return self._not_configured(
                "SMS_PROVIDER (expected one of twilio|exotel|knowlarity|plivo)"
            )
        if not self._env("SMS_API_KEY"):
            return self._not_configured("SMS_API_KEY")

        phone = (helper.get("phone") or "").strip()
        if not phone:
            return self._helper_not_reachable("helper has no phone number on file")

        callback = self._env("SMS_CALLBACK_NUMBER", "+1XXXXXXXXXX")
        intent_value = getattr(intent, "value", str(intent))
        template = SMS_TEMPLATES_EN.get(intent_value, SMS_TEMPLATES_EN["reminder"])
        message = template.format(
            name=helper.get("name") or "there",
            household=helper.get("household_name") or "the family",
            callback=callback,
        )
        self._log.info(
            "sms would send: helper=%s intent=%s message=%r",
            helper.get("id"), intent_value, message,
        )
        return self._not_configured(
            "SMSAdapter HTTP send pending — see homeops.helper_module.plan.md P1.0a followup"
        )
