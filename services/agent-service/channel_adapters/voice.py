"""VoiceAdapter — outbound voice call flow for helper outreach.

Architecture:

    ┌──────────────┐   ┌──────────────────────┐   ┌─────────────────┐
    │  Dispatcher  │──▶│  VoiceAdapter        │──▶│  Telephony API  │
    └──────────────┘   │                      │   │  (Twilio /       │
                       │  Dialog brain:       │   │   Exotel /       │
                       │  _sarvam_chat()      │   │   Knowlarity)    │
                       │                      │   └─────────────────┘
                       │  Speech I/O:         │
                       │  Sarvam STT/TTS      │   ┌─────────────────┐
                       │                      │──▶│  Sarvam STT/TTS │
                       └──────────────────────┘   └─────────────────┘

Per the plan, the agreed approach is:
- Reuse the existing `_sarvam_chat` integration from main.py as the
  dialog backbone. Every turn of the conversation is a chat completion:
  we give it the transcript so far, it returns the next thing the voice
  agent should say, plus a structured flag indicating whether we've
  captured all required consents yet.
- STT/TTS + telephony are behind an env gate. If the required credentials
  aren't present (TELEPHONY_PROVIDER + SARVAM_VOICE_API_KEY), the adapter
  returns `NOT_CONFIGURED` and the dispatcher falls through to the next
  channel in the helper's chain.
- The dialog manager itself is production-quality. We can run it against
  a fake "typed" transcript in tests without any real audio, and it
  produces the same consent-capture decisions as a real call would.

This adapter does NOT implement the actual telephony handoff in this
commit — that's a separate piece because it needs real provider
credentials. The dialog manager, prompt registry, and consent parsing
are all real and testable today.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from .base import BaseAdapter


# ── Dialog state machine ───────────────────────────────────────────────


# System prompt for the Sarvam dialog brain. Kept compact: voice turns
# are short by nature, and we want the LLM to produce exactly one
# response per turn, not multi-paragraph essays.
VOICE_DIALOG_SYSTEM_PROMPT = """You are the HomeOps voice agent making a call to a household helper on behalf of a family.

RULES:
- Speak in the helper's preferred language. Default to English if unknown.
- One short sentence per turn. No paragraphs. No lists.
- Ask yes/no questions whenever possible.
- If the helper gives an unclear answer, ask ONE clarifying question. Never more.
- Be respectful and warm. The helper is a person, not a record.

OUTPUT FORMAT:
Return EXACTLY this JSON object each turn:
{
  "speak": "<one short sentence to speak aloud>",
  "expects_response": true/false,
  "consents_captured": {
    "id_verification": true/false/null,
    "vision_capture": true/false/null,
    "multi_household_coord": true/false/null,
    "call_recording": true/false/null
  },
  "preferred_language": "<language code or null>",
  "done": true/false
}

Set `done` to true ONLY when all required consent fields have been set (to true or false — null is not done) OR when the helper explicitly declines to proceed.
"""


# Required consent fields for Stage 2 onboarding. The dialog is complete
# when all of these have been set (true or false).
REQUIRED_CONSENTS_BY_INTENT = {
    "stage2_onboarding": [
        "id_verification",
        "vision_capture",
        "multi_household_coord",
        "call_recording",
    ],
    "daily_checkin": [],  # no consent capture needed
    "balance_inquiry": [],
    "reassignment_consent": [],
    "schedule_change_consent": [],
    "reminder": [],
    "pattern_elicitation_followup": [],
}


class VoiceAdapter(BaseAdapter):
    """Outbound voice adapter with a Sarvam-powered dialog brain."""

    name = "voice"

    def __init__(self, *, sarvam_chat_fn: Optional[Any] = None) -> None:
        super().__init__()
        # Dependency-inject the Sarvam chat function so tests can pass a
        # mock that returns scripted dialog turns. In production this is
        # the `_sarvam_chat` function from main.py.
        self._sarvam_chat_fn = sarvam_chat_fn

    async def deliver(self, helper, intent, invite=None):
        # Gate: check required env configuration.
        if not self._env("SARVAM_API_KEY"):
            return self._not_configured("SARVAM_API_KEY")
        telephony = self._env("TELEPHONY_PROVIDER").lower()
        if telephony not in ("twilio", "exotel", "knowlarity", "plivo"):
            return self._not_configured(
                "TELEPHONY_PROVIDER (expected one of twilio|exotel|knowlarity|plivo)"
            )

        phone = (helper.get("phone") or "").strip()
        if not phone:
            return self._helper_not_reachable("helper has no phone number on file")

        # Telephony send is not implemented in this commit. Return
        # NOT_CONFIGURED so the dispatcher falls through to the next
        # channel in the helper's chain. The dialog brain (below) is
        # production-ready and used by the inbound webhook path once
        # wired, and by tests today.
        return self._not_configured(
            "VoiceAdapter telephony bridge pending — see homeops.helper_module.plan.md P1.0a followup"
        )

    # ── Dialog brain (testable today, wired to real calls later) ──────

    async def run_dialog_turn(
        self,
        *,
        helper: dict[str, Any],
        intent,
        transcript_so_far: list[dict[str, str]],
        latest_helper_utterance: Optional[str] = None,
    ) -> dict[str, Any]:
        """Run one turn of the dialog manager.

        Inputs:
            helper: helper row (must have preferred_language if set)
            intent: OutreachIntent — drives which consents are required
            transcript_so_far: list of {role, content} turns already spoken
            latest_helper_utterance: what the helper just said (STT output)

        Returns:
            dict with keys: speak, expects_response, consents_captured,
            preferred_language, done. Parsed from the LLM's JSON output.
        """
        if self._sarvam_chat_fn is None:
            raise RuntimeError(
                "VoiceAdapter.run_dialog_turn: sarvam_chat_fn not injected. "
                "Construct with sarvam_chat_fn=_sarvam_chat from main.py."
            )

        intent_value = intent.value if hasattr(intent, "value") else str(intent)
        helper_name = helper.get("name") or "there"
        helper_lang = helper.get("preferred_language") or "en"
        household_name = helper.get("household_name") or "the family"
        required = REQUIRED_CONSENTS_BY_INTENT.get(intent_value, [])

        context_lines = [
            f"Helper name: {helper_name}",
            f"Preferred language: {helper_lang}",
            f"Household: {household_name}",
            f"Intent: {intent_value}",
            f"Required consents: {', '.join(required) if required else 'none'}",
        ]
        context_block = "\n".join(context_lines)

        messages = [
            {"role": "system", "content": VOICE_DIALOG_SYSTEM_PROMPT},
            {"role": "user", "content": f"CALL CONTEXT:\n{context_block}"},
        ]
        for turn in transcript_so_far:
            messages.append(turn)
        if latest_helper_utterance is not None:
            messages.append({"role": "user", "content": latest_helper_utterance})

        raw = await self._sarvam_chat_fn(
            messages=messages,
            model=self._env("SARVAM_MODEL_DEFAULT", "sarvam-m"),
            temperature=0.1,
            max_tokens=300,
        )

        return self._parse_dialog_turn(raw)

    @staticmethod
    def _parse_dialog_turn(raw: str) -> dict[str, Any]:
        """Extract the structured dialog-turn JSON from the LLM's response.

        Tolerant parser: the LLM may wrap the JSON in markdown fences or
        prepend chatter. We strip known wrappers and parse the first
        balanced JSON object we find. On any failure, return a minimal
        fallback so the call doesn't crash.
        """
        fallback = {
            "speak": "Sorry, I didn't catch that. Could you repeat?",
            "expects_response": True,
            "consents_captured": {},
            "preferred_language": None,
            "done": False,
        }

        if not isinstance(raw, str):
            return fallback

        text = raw.strip()
        # Strip common markdown fences.
        if text.startswith("```"):
            lines = text.splitlines()
            # drop the leading fence and optional language tag
            lines = lines[1:]
            # drop the trailing fence if present
            while lines and not lines[-1].strip():
                lines.pop()
            if lines and lines[-1].strip().startswith("```"):
                lines = lines[:-1]
            text = "\n".join(lines).strip()

        # Find the first balanced JSON object.
        start = text.find("{")
        if start == -1:
            return fallback
        depth = 0
        end = -1
        for i in range(start, len(text)):
            c = text[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        if end == -1:
            return fallback

        try:
            obj = json.loads(text[start:end])
        except Exception:
            return fallback

        if not isinstance(obj, dict):
            return fallback

        # Normalize fields with sensible defaults.
        return {
            "speak": str(obj.get("speak") or "").strip() or fallback["speak"],
            "expects_response": bool(obj.get("expects_response", True)),
            "consents_captured": obj.get("consents_captured") if isinstance(obj.get("consents_captured"), dict) else {},
            "preferred_language": obj.get("preferred_language") if isinstance(obj.get("preferred_language"), str) else None,
            "done": bool(obj.get("done", False)),
        }
