"""Time-parsing helpers for the run pipeline.

The signals.capture_v1 graph needs to turn user text like "tomorrow 7pm"
into a timezone-aware UTC ISO string. These helpers handle the small set
of shapes observed in demo conversations; the LLM extractor covers more
robust cases.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

try:
    from zoneinfo import ZoneInfo  # py3.9+
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore


def _safe_str(v: Any) -> str:
    try:
        return str(v)
    except Exception:
        return ""


def _iso(dt: datetime) -> str:
    """Render any datetime as a UTC ISO string (no +00:00 normalization)."""
    return dt.astimezone(timezone.utc).isoformat()


def _local_dt_to_utc_iso(local_dt: datetime, tz_name: str) -> str:
    """Convert a *local wall clock* datetime into a UTC ISO string.

    If local_dt is naive, interpret it in tz_name using zoneinfo (DST-safe).
    If zoneinfo isn't available or tz_name is invalid, fall back to treating
    naive as UTC.
    """

    if local_dt.tzinfo is not None:
        return local_dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    tz = (tz_name or "").strip() or "UTC"
    if ZoneInfo is None:
        return local_dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")

    try:
        zi = ZoneInfo(tz)
    except Exception:
        zi = ZoneInfo("UTC")

    # Attach timezone info. For ambiguous times (DST fall-back), fold defaults to 0.
    aware = local_dt.replace(tzinfo=zi)
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_event_time(
    text: str,
    now_local: datetime,
) -> tuple[Optional[datetime], Optional[datetime], str]:
    """Very small parser for demos: handles 'tomorrow 7pm', 'today 6pm',
    'YYYY-MM-DD HH:MM', optional 'to' end time.

    Returns (start_local_dt, end_local_dt, note).
    """
    raw = text.strip()
    lower = raw.lower()

    # Extract range like "7pm to 10pm".
    range_match = re.search(
        r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*(?:to|\-|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b",
        lower,
    )
    single_match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", lower)

    day = None
    if "tomorrow" in lower:
        day = now_local.date() + timedelta(days=1)
    elif "today" in lower:
        day = now_local.date()
    else:
        iso_day = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", lower)
        if iso_day:
            try:
                day = date(int(iso_day.group(1)), int(iso_day.group(2)), int(iso_day.group(3)))
            except Exception:
                day = None

    def to_24h(h: int, m: int, ampm: Optional[str]) -> tuple[int, int]:
        if ampm:
            if ampm == "pm" and h != 12:
                h += 12
            if ampm == "am" and h == 12:
                h = 0
        return h, m

    if not day:
        return None, None, "missing_day"

    if range_match:
        h1 = int(range_match.group(1))
        m1 = int(range_match.group(2) or "0")
        a1 = range_match.group(3)
        h2 = int(range_match.group(4))
        m2 = int(range_match.group(5) or "0")
        a2 = range_match.group(6) or a1
        hh1, mm1 = to_24h(h1, m1, a1)
        hh2, mm2 = to_24h(h2, m2, a2)
        start = datetime(day.year, day.month, day.day, hh1, mm1)
        end = datetime(day.year, day.month, day.day, hh2, mm2)
        if end <= start:
            end = end + timedelta(days=1)
        return start, end, "ok"

    if single_match:
        h = int(single_match.group(1))
        m = int(single_match.group(2) or "0")
        a = single_match.group(3)
        hh, mm = to_24h(h, m, a)
        start = datetime(day.year, day.month, day.day, hh, mm)
        return start, None, "ok"

    return None, None, "missing_time"


__all__ = [
    "ZoneInfo",
    "_safe_str",
    "_iso",
    "_local_dt_to_utc_iso",
    "_parse_event_time",
]
