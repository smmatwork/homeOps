"""Cleaning-plan template helpers used by chores.visitors_cleaning_v1.

`_visitor_cleaning_templates` builds the base task list (expanded for
larger parties and poor-rating feedback). `_pick_helper_for_cleaning`
chooses the first non-on-leave helper or returns a reason code the
planner can surface in the chore metadata.
"""

from __future__ import annotations

from typing import Any, Optional


def _pick_helper_for_cleaning(
    *,
    helpers: list[dict[str, Any]],
    helper_time_off: list[dict[str, Any]],
) -> tuple[Optional[str], Optional[str]]:
    on_leave: set[str] = set()
    for r in helper_time_off:
        hid = r.get("helper_id")
        if isinstance(hid, str) and hid.strip():
            on_leave.add(hid.strip())

    for h in helpers:
        hid = h.get("id")
        if isinstance(hid, str) and hid.strip() and hid not in on_leave:
            return hid, None
    if helpers:
        return None, "helper_on_leave"
    return None, "no_helpers"


def _visitor_cleaning_templates(
    *,
    feedback_rating: Optional[int],
    visitors_metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    # Minimal deterministic set; we can expand later with spaces/home profile.
    base: list[dict[str, Any]] = [
        {"title": "Clean bathrooms", "minutes": 45, "priority": 3, "tags": ["bathroom"]},
        {"title": "Vacuum living room", "minutes": 30, "priority": 2, "tags": ["living_room"]},
        {"title": "Dust common areas", "minutes": 20, "priority": 2, "tags": ["dusting"]},
        {"title": "Mop floors (common areas)", "minutes": 30, "priority": 2, "tags": ["floors"]},
        {"title": "Tidy entryway", "minutes": 10, "priority": 1, "tags": ["entry"]},
    ]

    expected_count = visitors_metadata.get("expected_count")
    if isinstance(expected_count, (int, float)) and expected_count >= 6:
        base.append({"title": "Clean kitchen surfaces", "minutes": 20, "priority": 2, "tags": ["kitchen"]})

    if feedback_rating is not None and feedback_rating <= 2:
        # When feedback is poor, add one extra deep-clean task.
        base.insert(
            0,
            {"title": "Deep clean bathrooms (scrub tiles + fixtures)", "minutes": 60, "priority": 3, "tags": ["bathroom", "deep_clean"]},
        )

    return base


__all__ = ["_pick_helper_for_cleaning", "_visitor_cleaning_templates"]
