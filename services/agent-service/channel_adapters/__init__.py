"""Channel adapters for helper outreach.

Each adapter implements `ChannelAdapter` (see ../channel_dispatcher.py)
for exactly one transport. Adapters that lack configuration return
`DeliveryResult(failure_kind=NOT_CONFIGURED)` so the dispatcher can skip
them gracefully without raising.

Package layout:

    channel_adapters/
      __init__.py          — this file; exposes build_default_registry()
      base.py              — BaseAdapter with common helpers
      voice.py             — VoiceAdapter (Sarvam-based dialog manager)
      whatsapp.py          — WhatsAppTap, WhatsAppForm, WhatsAppVoice
      sms.py               — SMSAdapter
      web.py               — WebMagicLinkAdapter
      dev_null.py          — DevNullAdapter for tests (always succeeds)
"""

from .base import BaseAdapter
from .dev_null import DevNullAdapter
from .sms import SMSAdapter
from .voice import VoiceAdapter
from .web import WebMagicLinkAdapter
from .whatsapp import (
    WhatsAppFormAdapter,
    WhatsAppProxyAdapter,
    WhatsAppTapAdapter,
    WhatsAppVoiceAdapter,
)


def build_default_registry(**overrides) -> dict[str, object]:
    """Build the default channel → adapter registry.

    Adapters read their configuration from env vars at construction.
    Missing credentials are not an error; the adapter will surface
    `NOT_CONFIGURED` at delivery time.

    `overrides` lets tests inject mock adapters by channel name, e.g.
        build_default_registry(voice=MockVoiceAdapter())
    """
    registry: dict[str, object] = {
        "voice": VoiceAdapter(),
        "whatsapp_voice": WhatsAppVoiceAdapter(),
        "whatsapp_tap": WhatsAppTapAdapter(),
        "whatsapp_form": WhatsAppFormAdapter(),
        "whatsapp_proxy": WhatsAppProxyAdapter(),
        "web": WebMagicLinkAdapter(),
        "sms": SMSAdapter(),
    }
    registry.update(overrides)
    return registry


__all__ = [
    "BaseAdapter",
    "DevNullAdapter",
    "SMSAdapter",
    "VoiceAdapter",
    "WebMagicLinkAdapter",
    "WhatsAppFormAdapter",
    "WhatsAppProxyAdapter",
    "WhatsAppTapAdapter",
    "WhatsAppVoiceAdapter",
    "build_default_registry",
]
