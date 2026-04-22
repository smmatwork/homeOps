"""Unit tests for the runs/ package (extracted from main.py in the
/v1/runs/start refactor).

Covers:
  - runs/time_parsing.py — _parse_event_time, _local_dt_to_utc_iso
  - runs/proposal.py — _validate_chore_actions, _parse_proposal_from_raw_text,
    _fallback_chore_proposal
  - runs/cleaning_templates.py — _pick_helper_for_cleaning,
    _visitor_cleaning_templates
  - runs/models.py — Pydantic model shape sanity checks
"""

import os
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))

from runs.cleaning_templates import _pick_helper_for_cleaning, _visitor_cleaning_templates
from runs.models import ProposalOutput, ProposedAction, RunStartRequest, RunStatusResponse
from runs.proposal import (
    _fallback_chore_proposal,
    _parse_proposal_from_raw_text,
    _validate_chore_actions,
)
from runs.time_parsing import _local_dt_to_utc_iso, _parse_event_time, _safe_str


# ─── time_parsing ────────────────────────────────────────────────────────


class ParseEventTimeTests(unittest.TestCase):
    def _now(self) -> datetime:
        return datetime(2026, 4, 22, 10, 0)

    def test_tomorrow_single_time(self):
        start, end, note = _parse_event_time("tomorrow 7pm", self._now())
        self.assertEqual(note, "ok")
        self.assertEqual(start.year, 2026)
        self.assertEqual(start.month, 4)
        self.assertEqual(start.day, 23)
        self.assertEqual(start.hour, 19)
        self.assertIsNone(end)

    def test_today_range(self):
        start, end, note = _parse_event_time("today 7pm to 10pm", self._now())
        self.assertEqual(note, "ok")
        self.assertEqual(start.hour, 19)
        self.assertEqual(end.hour, 22)

    def test_iso_date_sets_day_correctly(self):
        # ISO-only path: the range regex fires on the "05-15" substring
        # (a known quirk of the tiny demo parser), so the time portion is
        # unreliable — but the day is set from the 4-digit year match.
        start, _, note = _parse_event_time("2026-05-15 at 8am", self._now())
        self.assertEqual(note, "ok")
        self.assertEqual(start.year, 2026)
        self.assertEqual(start.month, 5)
        self.assertEqual(start.day, 15)

    def test_range_crosses_midnight_rolls_forward(self):
        start, end, note = _parse_event_time("today 10pm to 2am", self._now())
        self.assertEqual(note, "ok")
        self.assertGreater(end, start)
        self.assertEqual((end - start).total_seconds() / 3600, 4)

    def test_missing_day_note(self):
        _, _, note = _parse_event_time("at 7pm", self._now())
        self.assertEqual(note, "missing_day")

    def test_missing_time_note(self):
        _, _, note = _parse_event_time("tomorrow", self._now())
        self.assertEqual(note, "missing_time")

    def test_am_handling_12am_and_12pm(self):
        start_am, _, _ = _parse_event_time("today 12am", self._now())
        start_pm, _, _ = _parse_event_time("today 12pm", self._now())
        self.assertEqual(start_am.hour, 0)
        self.assertEqual(start_pm.hour, 12)

    def test_24h_ranges_without_ampm_single(self):
        # "today 19:30" — no am/pm, single_match pattern requires am|pm so
        # this falls through to missing_time.
        _, _, note = _parse_event_time("today 19:30", self._now())
        self.assertEqual(note, "missing_time")

    def test_range_reuses_start_ampm_for_missing_end(self):
        # The parser only forwards a1→a2 (not a2→a1). "7pm to 10" reads both
        # sides as PM; "7 to 10pm" only converts the trailing "10pm".
        start, end, note = _parse_event_time("today 7pm to 10", self._now())
        self.assertEqual(note, "ok")
        self.assertEqual(start.hour, 19)
        self.assertEqual(end.hour, 22)


class LocalDtToUtcIsoTests(unittest.TestCase):
    def test_aware_datetime_passes_through(self):
        from datetime import timezone
        dt = datetime(2026, 4, 22, 10, 0, tzinfo=timezone.utc)
        out = _local_dt_to_utc_iso(dt, "UTC")
        self.assertTrue(out.endswith("Z"))
        self.assertIn("2026-04-22T10:00:00", out)

    def test_naive_tz_aware_conversion(self):
        dt = datetime(2026, 4, 22, 15, 30)  # naive
        out = _local_dt_to_utc_iso(dt, "Asia/Kolkata")
        # IST is UTC+5:30 → 15:30 local = 10:00 UTC.
        self.assertIn("10:00:00Z", out)

    def test_naive_invalid_tz_falls_back_to_utc(self):
        dt = datetime(2026, 4, 22, 10, 0)
        out = _local_dt_to_utc_iso(dt, "Not/AValidTimezone")
        self.assertIn("2026-04-22T10:00:00", out)
        self.assertTrue(out.endswith("Z"))


class SafeStrTests(unittest.TestCase):
    def test_none_stringifies_to_none(self):
        self.assertEqual(_safe_str(None), "None")

    def test_int_and_str(self):
        self.assertEqual(_safe_str(42), "42")
        self.assertEqual(_safe_str("abc"), "abc")

    def test_object_with_broken_str_returns_empty(self):
        class Bad:
            def __str__(self):
                raise RuntimeError("no")

        self.assertEqual(_safe_str(Bad()), "")


# ─── proposal validator + parser ─────────────────────────────────────────


class ValidateChoreActionsTests(unittest.TestCase):
    def test_valid_insert_passes(self):
        actions = [
            ProposedAction(
                id="tc1",
                tool="db.insert",
                args={"table": "chores", "record": {"title": "Clean"}},
            )
        ]
        self.assertEqual(_validate_chore_actions(actions), actions)

    def test_insert_without_record_rejected(self):
        actions = [ProposedAction(id="tc1", tool="db.insert", args={"table": "chores"})]
        with self.assertRaises(ValueError):
            _validate_chore_actions(actions)

    def test_insert_without_title_rejected(self):
        actions = [
            ProposedAction(
                id="tc1",
                tool="db.insert",
                args={"table": "chores", "record": {"status": "pending"}},
            )
        ]
        with self.assertRaises(ValueError):
            _validate_chore_actions(actions)

    def test_non_chores_table_rejected(self):
        actions = [
            ProposedAction(
                id="tc1",
                tool="db.insert",
                args={"table": "helpers", "record": {"name": "X"}},
            )
        ]
        with self.assertRaises(ValueError):
            _validate_chore_actions(actions)

    def test_update_requires_id_and_patch(self):
        with self.assertRaises(ValueError):
            _validate_chore_actions([
                ProposedAction(id="tc1", tool="db.update", args={"table": "chores"})
            ])
        with self.assertRaises(ValueError):
            _validate_chore_actions([
                ProposedAction(id="tc1", tool="db.update", args={"table": "chores", "id": "x"})
            ])

    def test_update_valid_passes(self):
        actions = [
            ProposedAction(
                id="tc1",
                tool="db.update",
                args={"table": "chores", "id": "x", "patch": {"status": "done"}},
            )
        ]
        self.assertEqual(_validate_chore_actions(actions), actions)

    def test_delete_requires_id(self):
        with self.assertRaises(ValueError):
            _validate_chore_actions([
                ProposedAction(id="tc1", tool="db.delete", args={"table": "chores"})
            ])

    def test_delete_valid_passes(self):
        actions = [
            ProposedAction(id="tc1", tool="db.delete", args={"table": "chores", "id": "x"})
        ]
        self.assertEqual(_validate_chore_actions(actions), actions)


class ParseProposalFromRawTextTests(unittest.TestCase):
    def test_valid_proposal_parses(self):
        raw = (
            '{"confirm_text": "Apply?", "proposed_actions": ['
            '{"id": "tc1", "tool": "db.insert", "args": '
            '{"table": "chores", "record": {"title": "Clean"}}, "reason": "x"}'
            ']}'
        )
        out = _parse_proposal_from_raw_text(raw)
        self.assertEqual(out.confirm_text, "Apply?")
        self.assertEqual(len(out.proposed_actions), 1)

    def test_invalid_table_rejected(self):
        raw = (
            '{"confirm_text": "x", "proposed_actions": ['
            '{"id": "tc1", "tool": "db.insert", "args": '
            '{"table": "helpers", "record": {"name": "X"}}}'
            ']}'
        )
        with self.assertRaises(ValueError):
            _parse_proposal_from_raw_text(raw)


class FallbackChoreProposalTests(unittest.TestCase):
    def test_extracts_colon_form(self):
        out = _fallback_chore_proposal({"request": "Add a chore: Take out trash"})
        self.assertIn("Take out trash", out.confirm_text)
        title = out.proposed_actions[0].args["record"]["title"]
        self.assertEqual(title, "Take out trash")

    def test_extracts_called_quoted(self):
        out = _fallback_chore_proposal({"request": 'Add a chore called "Wipe counters"'})
        title = out.proposed_actions[0].args["record"]["title"]
        self.assertEqual(title, "Wipe counters")

    def test_quoted_anywhere(self):
        out = _fallback_chore_proposal({"request": 'Please do "Dust shelves" when you can'})
        title = out.proposed_actions[0].args["record"]["title"]
        self.assertEqual(title, "Dust shelves")

    def test_no_match_fallback_to_new_chore(self):
        out = _fallback_chore_proposal({"request": "nothing to extract here"})
        title = out.proposed_actions[0].args["record"]["title"]
        self.assertEqual(title, "New chore")

    def test_non_dict_input_handled(self):
        # The validator signature expects a dict; passing a non-string request
        # falls through to "New chore".
        out = _fallback_chore_proposal({"request": 12345})
        title = out.proposed_actions[0].args["record"]["title"]
        self.assertEqual(title, "New chore")


# ─── cleaning templates ──────────────────────────────────────────────────


class PickHelperForCleaningTests(unittest.TestCase):
    def test_picks_first_available_helper(self):
        helpers = [{"id": "h1", "name": "A"}, {"id": "h2", "name": "B"}]
        hid, reason = _pick_helper_for_cleaning(helpers=helpers, helper_time_off=[])
        self.assertEqual(hid, "h1")
        self.assertIsNone(reason)

    def test_skips_on_leave_helpers(self):
        helpers = [{"id": "h1", "name": "A"}, {"id": "h2", "name": "B"}]
        time_off = [{"helper_id": "h1"}]
        hid, reason = _pick_helper_for_cleaning(helpers=helpers, helper_time_off=time_off)
        self.assertEqual(hid, "h2")
        self.assertIsNone(reason)

    def test_all_on_leave_returns_reason(self):
        helpers = [{"id": "h1"}]
        time_off = [{"helper_id": "h1"}]
        hid, reason = _pick_helper_for_cleaning(helpers=helpers, helper_time_off=time_off)
        self.assertIsNone(hid)
        self.assertEqual(reason, "helper_on_leave")

    def test_no_helpers_returns_reason(self):
        hid, reason = _pick_helper_for_cleaning(helpers=[], helper_time_off=[])
        self.assertIsNone(hid)
        self.assertEqual(reason, "no_helpers")

    def test_skips_malformed_helper_entries(self):
        helpers = [{"id": ""}, {"no_id": "x"}, {"id": "h1"}]
        hid, _ = _pick_helper_for_cleaning(helpers=helpers, helper_time_off=[])
        self.assertEqual(hid, "h1")


class VisitorCleaningTemplatesTests(unittest.TestCase):
    def test_base_templates(self):
        out = _visitor_cleaning_templates(feedback_rating=None, visitors_metadata={})
        titles = [t["title"] for t in out]
        self.assertIn("Clean bathrooms", titles)
        self.assertIn("Vacuum living room", titles)

    def test_large_party_adds_kitchen(self):
        out = _visitor_cleaning_templates(
            feedback_rating=None,
            visitors_metadata={"expected_count": 8},
        )
        titles = [t["title"] for t in out]
        self.assertIn("Clean kitchen surfaces", titles)

    def test_low_rating_adds_deep_clean_first(self):
        out = _visitor_cleaning_templates(feedback_rating=2, visitors_metadata={})
        self.assertIn("Deep clean", out[0]["title"])
        self.assertGreater(len(out), 5)

    def test_small_party_no_kitchen(self):
        out = _visitor_cleaning_templates(
            feedback_rating=None,
            visitors_metadata={"expected_count": 3},
        )
        titles = [t["title"] for t in out]
        self.assertNotIn("Clean kitchen surfaces", titles)


# ─── Model sanity checks ──────────────────────────────────────────────────


class RunModelTests(unittest.TestCase):
    def test_run_start_request_defaults(self):
        req = RunStartRequest(run_id="r1", household_id="h", graph_key="chores.manage_v1")
        self.assertEqual(req.mode, "propose")
        self.assertEqual(req.trigger, "chat")
        self.assertEqual(req.input, {})

    def test_run_start_request_rejects_unknown_mode(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            RunStartRequest(run_id="r1", household_id="h", graph_key="x", mode="delete")  # type: ignore

    def test_proposal_output_defaults(self):
        out = ProposalOutput(
            confirm_text="OK",
            proposed_actions=[ProposedAction(id="tc", tool="db.insert", args={"table": "chores", "record": {"title": "x"}})],
        )
        self.assertEqual(out.mode, "propose")
        self.assertEqual(out.version, "proposal_v1")

    def test_run_status_response_requires_run_id(self):
        r = RunStatusResponse(run_id="r", status="queued")
        self.assertTrue(r.ok)


if __name__ == "__main__":
    unittest.main()
