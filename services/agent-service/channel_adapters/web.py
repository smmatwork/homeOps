"""Web magic-link adapter.

Generates a URL to the Stage 2 web form and surfaces it for the owner
to share out-of-band with the helper (email, physical note, etc). This
is the backup path when all messaging channels fail or when the owner
explicitly wants to deliver the link themselves.

Unlike the messaging adapters, this one always "succeeds" in terms of
producing a URL — the delivery is the owner's responsibility, not
ours. We surface the URL in `metadata.magic_link_url` so the caller
can display it in the owner UI.
"""

from __future__ import annotations

from typing import Any

from .base import BaseAdapter


class WebMagicLinkAdapter(BaseAdapter):
    name = "web"

    async def deliver(self, helper, intent, invite=None):
        if invite is None or not invite.get("token"):
            return self._permanent("no invite token available for web magic link")

        base_url = self._env("HELPER_MAGIC_LINK_BASE_URL", "https://app.homeops.local/h")
        magic_link = f"{base_url}/{invite['token']}"

        self._log.info(
            "web magic link generated: helper=%s url=%s",
            helper.get("id"), magic_link,
        )

        return self._success(
            provider_message_id=f"web_{invite['token'][:12]}",
            transcript_summary=f"Magic link generated for helper {helper.get('id')}; owner must share out-of-band.",
            magic_link_url=magic_link,
        )
