"""Unit tests for agents/chore_agent.py — the pieces that weren't covered by
the pre-refactor test_helper_agent.py suite.

Focus areas:
  - Phase 6f hallucination-override detectors (_needs_*_fetch_override +
    _needs_fetch_override composed OR)
  - Chore formatters (_format_plan_preview / _format_execution_result /
    _format_no_match_with_suggestions / _format_rpc_reassign_result)
  - FACTS helpers (_extract_spaces_from_facts)
  - Tool-call validators (_validate_tool_calls, _enforce_assignment_policy)
  - LLM-as-Judge (_judge_response with injected chat_fn)
  - Semantic match (_semantic_match_chores with injected get_embedder)
  - count/status detectors that cover the detector-registry's remaining edge
    cases
"""

import os
import sys
import unittest
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from agents.chore_agent import (
    JUDGE_SYSTEM_PROMPT,
    _enforce_assignment_policy,
    _extract_spaces_from_facts,
    _format_confirmation_preview,
    _format_execution_result,
    _format_no_match_with_suggestions,
    _format_plan_preview,
    _format_rpc_reassign_result,
    _judge_response,
    _needs_chores_fetch_override,
    _needs_fetch_override,
    _needs_helpers_fetch_override,
    _needs_spaces_fetch_override,
    _semantic_match_chores,
    _validate_tool_calls,
    _wants_assignee_breakdown,
    _wants_status_breakdown,
    _wants_total_pending_count,
    _wants_unassigned_count,
)
from orchestrator.intent import ExtractedIntent


# ─── Phase 6f hallucination-override detectors ─────────────────────────────


class NeedsHelpersFetchOverrideTests(unittest.TestCase):
    def test_empty_text_returns_false(self):
        self.assertFalse(_needs_helpers_fetch_override(""))
        self.assertFalse(_needs_helpers_fetch_override("   "))

    def test_triggers_on_available_cleaners_phrase(self):
        self.assertTrue(_needs_helpers_fetch_override("Here are available cleaners: ..."))

    def test_triggers_on_available_helpers_phrase(self):
        self.assertTrue(_needs_helpers_fetch_override("Available helpers in your household"))

    def test_triggers_on_numbered_list_with_cleaners(self):
        text = "Cleaners in your home:\n1. Alice\n2. Bob"
        self.assertTrue(_needs_helpers_fetch_override(text))

    def test_triggers_on_assigned_to_name(self):
        self.assertTrue(_needs_helpers_fetch_override("The task is assigned to Sunita"))

    def test_triggers_on_will_receive_the_task(self):
        self.assertTrue(_needs_helpers_fetch_override("Rajesh will receive the task shortly"))

    def test_triggers_on_proper_noun_plus_assignment(self):
        self.assertTrue(_needs_helpers_fetch_override("Rajesh will receive your chore"))

    def test_does_not_trigger_when_structured_tool_calls_present(self):
        text = '```json\n{"tool_calls": [{"id": "tc_1", "tool": "db.select", "args": {"table": "helpers"}}]}\n```'
        self.assertFalse(_needs_helpers_fetch_override(text))

    def test_does_not_trigger_on_generic_text(self):
        self.assertFalse(_needs_helpers_fetch_override("I can help with that. What date and time?"))


class NeedsChoresFetchOverrideTests(unittest.TestCase):
    def test_empty_returns_false(self):
        self.assertFalse(_needs_chores_fetch_override(""))

    def test_triggers_on_here_are_your_chores(self):
        self.assertTrue(_needs_chores_fetch_override("Here are your chores:\n- Clean kitchen"))

    def test_triggers_on_numbered_chore_list(self):
        text = "You have these chores:\n1. Clean kitchen\n2. Mop bathroom"
        self.assertTrue(_needs_chores_fetch_override(text))

    def test_does_not_trigger_on_structured_tool_calls(self):
        text = '```json\n{"tool_calls": [{"id": "tc", "tool": "query.rpc", "args": {"name": "count_chores"}}]}\n```'
        self.assertFalse(_needs_chores_fetch_override(text))

    def test_does_not_trigger_on_single_chore_mention(self):
        self.assertFalse(_needs_chores_fetch_override("I can help you with that chore."))


class NeedsSpacesFetchOverrideTests(unittest.TestCase):
    def test_triggers_on_rooms_in_your_home(self):
        self.assertTrue(_needs_spaces_fetch_override("The rooms in your home include:\n- Kitchen"))

    def test_triggers_on_here_are_your_rooms(self):
        self.assertTrue(_needs_spaces_fetch_override("Here are your rooms: Kitchen, Bedroom"))

    def test_does_not_trigger_on_empty(self):
        self.assertFalse(_needs_spaces_fetch_override(""))

    def test_does_not_trigger_when_tool_calls_present(self):
        text = '```json\n{"tool_calls": [{"id": "tc", "tool": "query.rpc", "args": {}}]}\n```\nrooms in your home'
        self.assertFalse(_needs_spaces_fetch_override(text))


class NeedsFetchOverrideComposedTests(unittest.TestCase):
    def test_returns_true_if_any_detector_fires(self):
        self.assertTrue(_needs_fetch_override("Here are available cleaners:\n1. Alice"))
        self.assertTrue(_needs_fetch_override("Here are your chores:\n- Clean"))
        self.assertTrue(_needs_fetch_override("The rooms in your home are"))

    def test_returns_false_if_none_fire(self):
        self.assertFalse(_needs_fetch_override("I can help with that."))
        self.assertFalse(_needs_fetch_override(""))


# ─── Chore-domain formatters ───────────────────────────────────────────────


class FormatPlanPreviewTests(unittest.TestCase):
    def _intent(self, **overrides: Any) -> ExtractedIntent:
        base = {
            "action": "update",
            "entity": "chore",
            "match_text": "kitchen",
            "match_field": None,
            "update_field": "description",
            "update_value": "Clean counters",
            "bulk": False,
            "confidence": 0.9,
        }
        base.update(overrides)
        return ExtractedIntent(**base)

    def test_single_intent_preview(self):
        intent = self._intent()
        out = _format_plan_preview([intent], match_ids=[("id1", "Kitchen Sweep")])
        self.assertIn("Here's my plan", out)
        self.assertIn("kitchen", out.lower())
        self.assertIn("Kitchen Sweep", out)
        self.assertIn("yes", out.lower())
        self.assertIn("no", out.lower())

    def test_add_space_intent_format(self):
        intent = self._intent(action="add_space", match_text="Guest Bathroom")
        out = _format_plan_preview([intent], match_ids=[])
        self.assertIn("Add", out)
        self.assertIn("Guest Bathroom", out)

    def test_reassign_intent_includes_helper(self):
        intent = self._intent(action="reassign", update_value="Roopa")
        out = _format_plan_preview([intent], match_ids=[])
        self.assertIn("Assign", out)
        self.assertIn("Roopa", out)

    def test_many_match_ids_truncates_preview(self):
        intent = self._intent()
        match_ids = [(f"id{i}", f"Chore {i}") for i in range(15)]
        out = _format_plan_preview([intent], match_ids=match_ids)
        self.assertIn("+5 more", out)


class FormatExecutionResultTests(unittest.TestCase):
    def _intent(self, **overrides: Any) -> ExtractedIntent:
        base = {
            "action": "update",
            "entity": "chore",
            "match_text": "kitchen",
            "match_field": None,
            "update_field": "description",
            "update_value": "Clean",
            "bulk": False,
            "confidence": 0.9,
        }
        base.update(overrides)
        return ExtractedIntent(**base)

    def test_single_update_success(self):
        intent = self._intent()
        results = [{"ok": True, "result": None}]
        tool_calls = [{"tool": "db.update", "args": {}}]
        out = _format_execution_result(results, tool_calls, [intent], intent, facts="")
        self.assertIn("Done", out)
        self.assertIn("description", out)

    def test_all_errors_returns_error(self):
        intent = self._intent()
        results = [{"ok": False, "error": "database unreachable"}]
        tool_calls = [{"tool": "db.update", "args": {}}]
        out = _format_execution_result(results, tool_calls, [intent], intent, facts="")
        self.assertIn("Error", out)
        self.assertIn("database unreachable", out)


class FormatNoMatchWithSuggestionsTests(unittest.TestCase):
    def test_no_facts_returns_generic_clarification(self):
        out = _format_no_match_with_suggestions("guest bathroom", facts="")
        self.assertIn("guest bathroom", out)
        self.assertIn("home profile", out.lower())

    def test_with_facts_lists_similar_spaces(self):
        facts = "Spaces: Kitchen, Living Room, Master Bathroom, Guest Bathroom, Bedroom"
        out = _format_no_match_with_suggestions("bath", facts=facts)
        self.assertIn("Master Bathroom", out)

    def test_with_facts_lists_all_if_no_similar(self):
        facts = "Spaces: Kitchen, Living Room, Bedroom"
        out = _format_no_match_with_suggestions("xyz", facts=facts)
        self.assertIn("Kitchen", out)
        self.assertIn("Living Room", out)


class FormatRpcReassignResultTests(unittest.TestCase):
    def _intent(self, **overrides: Any) -> ExtractedIntent:
        base = {
            "action": "reassign",
            "entity": "chore",
            "match_text": "kitchen",
            "match_field": None,
            "update_field": None,
            "update_value": "Roopa",
            "bulk": False,
            "confidence": 0.9,
        }
        base.update(overrides)
        return ExtractedIntent(**base)

    def test_bulk_reassigned(self):
        intent = self._intent(bulk=True)
        results = [
            {
                "ok": True,
                "result": [{"action": "reassigned", "reassigned_count": 3, "helper_name": "Roopa", "chore_titles": ["A", "B", "C"]}],
            }
        ]
        out = _format_rpc_reassign_result(results, intent)
        self.assertIsNotNone(out)
        self.assertIn("3", out)
        self.assertIn("Roopa", out)

    def test_single_reassign(self):
        intent = self._intent()
        results = [{"ok": True, "result": [{"action": "reassigned", "chore_title": "Kitchen sweep", "helper_name": "Roopa"}]}]
        out = _format_rpc_reassign_result(results, intent)
        self.assertIsNotNone(out)
        self.assertIn("Kitchen sweep", out)
        self.assertIn("Roopa", out)

    def test_unassigned(self):
        intent = self._intent(update_value=None)
        results = [{"ok": True, "result": [{"action": "unassigned", "chore_title": "Kitchen sweep"}]}]
        out = _format_rpc_reassign_result(results, intent)
        self.assertIsNotNone(out)
        self.assertIn("Unassigned", out)
        self.assertIn("Kitchen sweep", out)

    def test_clarify_chore_lists_candidates(self):
        intent = self._intent()
        results = [
            {
                "ok": True,
                "result": [
                    {
                        "action": "clarify_chore",
                        "chore_candidates": [{"title": "Kitchen sweep"}, {"title": "Kitchen deep clean"}],
                    }
                ],
            }
        ]
        out = _format_rpc_reassign_result(results, intent)
        self.assertIsNotNone(out)
        self.assertIn("Kitchen sweep", out)
        self.assertIn("Kitchen deep clean", out)

    def test_clarify_helper_lists_candidates(self):
        intent = self._intent(update_value="R")
        results = [
            {
                "ok": True,
                "result": [
                    {
                        "action": "clarify_helper",
                        "helper_candidates": [{"name": "Roopa"}, {"name": "Ramesh"}],
                    }
                ],
            }
        ]
        out = _format_rpc_reassign_result(results, intent)
        self.assertIsNotNone(out)
        self.assertIn("Roopa", out)
        self.assertIn("Ramesh", out)

    def test_none_found_returns_fallback(self):
        intent = self._intent()
        results = [{"ok": True, "result": [{"action": "none_found"}]}]
        out = _format_rpc_reassign_result(results, intent, facts="Spaces: Kitchen")
        self.assertIsNotNone(out)
        self.assertIn("kitchen", out.lower())

    def test_add_space_added(self):
        intent = self._intent(action="add_space", match_text="Study")
        results = [{"ok": True, "result": [{"action": "added", "display_name": "Study", "total_spaces": 6}]}]
        out = _format_rpc_reassign_result(results, intent)
        self.assertIsNotNone(out)
        self.assertIn("Study", out)
        self.assertIn("6", out)

    def test_add_space_already_exists(self):
        intent = self._intent(action="add_space", match_text="Kitchen")
        results = [{"ok": True, "result": [{"action": "already_exists", "display_name": "Kitchen"}]}]
        out = _format_rpc_reassign_result(results, intent)
        self.assertIsNotNone(out)
        self.assertIn("Kitchen", out)
        self.assertIn("already exists", out.lower())

    def test_unrecognized_action_returns_none(self):
        intent = self._intent()
        results = [{"ok": True, "result": [{"action": "something_unknown"}]}]
        out = _format_rpc_reassign_result(results, intent)
        self.assertIsNone(out)


class FormatConfirmationPreviewTests(unittest.TestCase):
    def test_includes_action_verb_for_update_field(self):
        intent = ExtractedIntent(
            action="update", entity="chore", match_text="bathroom",
            match_field=None, update_field="cadence", update_value="weekly",
            bulk=True, confidence=0.9,
        )
        out = _format_confirmation_preview(intent, match_ids=[("id1", "Bathroom mopping")])
        self.assertIn("bathroom", out)
        self.assertIn("cadence", out)
        self.assertIn("weekly", out)
        self.assertIn("Bathroom mopping", out)

    def test_clear_field_when_value_is_none(self):
        intent = ExtractedIntent(
            action="update", entity="chore", match_text="kitchen",
            match_field=None, update_field="description", update_value=None,
            bulk=False, confidence=0.9,
        )
        out = _format_confirmation_preview(intent, match_ids=[("id1", "Kitchen")])
        self.assertIn("clear", out.lower())


class ExtractSpacesFromFactsTests(unittest.TestCase):
    def test_extracts_all_when_no_keyword(self):
        facts = "Spaces: Kitchen, Living Room, Bedroom"
        out = _extract_spaces_from_facts(facts)
        self.assertEqual(set(out), {"Kitchen", "Living Room", "Bedroom"})

    def test_filters_by_keyword_case_insensitive(self):
        facts = "Spaces: Kitchen, Living Room, Master Bathroom, Guest Bathroom"
        out = _extract_spaces_from_facts(facts, keyword="bath")
        self.assertIn("Master Bathroom", out)
        self.assertIn("Guest Bathroom", out)
        self.assertNotIn("Kitchen", out)

    def test_handles_rooms_header_alternative(self):
        facts = "Rooms: Kitchen, Bedroom"
        out = _extract_spaces_from_facts(facts)
        self.assertEqual(set(out), {"Kitchen", "Bedroom"})

    def test_no_matches_returns_empty(self):
        facts = "Nothing relevant here"
        out = _extract_spaces_from_facts(facts)
        self.assertEqual(out, [])


# ─── Tool-call validators + policy ─────────────────────────────────────────


class ValidateToolCallsTests(unittest.TestCase):
    def test_unknown_chore_id_reports_error(self):
        tcs = [{"tool": "db.update", "args": {"table": "chores", "id": "fake-id", "patch": {}}}]
        errors = _validate_tool_calls(tcs, {"real-id"}, set(), None)
        self.assertEqual(len(errors), 1)
        self.assertIn("chore", errors[0])

    def test_known_chore_id_passes(self):
        tcs = [{"tool": "db.update", "args": {"table": "chores", "id": "real-id", "patch": {}}}]
        errors = _validate_tool_calls(tcs, {"real-id"}, set(), None)
        self.assertEqual(errors, [])

    def test_unknown_helper_id_reports_error(self):
        tcs = [{"tool": "db.update", "args": {"table": "helpers", "id": "fake", "patch": {}}}]
        errors = _validate_tool_calls(tcs, set(), {"real"}, None)
        self.assertEqual(len(errors), 1)
        self.assertIn("helper", errors[0])

    def test_unknown_person_assignment_reports_error(self):
        tcs = [
            {
                "tool": "db.update",
                "args": {
                    "table": "chores",
                    "id": "real-chore",
                    "patch": {"assignee_person_id": "fake-person"},
                },
            }
        ]
        errors = _validate_tool_calls(tcs, {"real-chore"}, set(), {"real-person"})
        self.assertEqual(len(errors), 1)
        self.assertIn("person", errors[0])

    def test_db_delete_unknown_chore_reports_error(self):
        tcs = [{"tool": "db.delete", "args": {"table": "chores", "id": "fake"}}]
        errors = _validate_tool_calls(tcs, {"real"}, set(), None)
        self.assertEqual(len(errors), 1)

    def test_rpc_unknown_helper_id_reports(self):
        tcs = [{"tool": "query.rpc", "args": {"name": "x", "params": {"p_helper_id": "fake"}}}]
        errors = _validate_tool_calls(tcs, set(), {"real-helper"}, {"real-person"})
        self.assertEqual(len(errors), 1)

    def test_rpc_helper_id_matches_person_passes(self):
        tcs = [{"tool": "query.rpc", "args": {"name": "x", "params": {"p_helper_id": "shared-id"}}}]
        errors = _validate_tool_calls(tcs, set(), {"real-helper"}, {"shared-id"})
        self.assertEqual(errors, [])

    def test_empty_sets_skips_validation(self):
        # When no known IDs provided, we don't reject anything (permissive).
        tcs = [{"tool": "db.update", "args": {"table": "chores", "id": "anything", "patch": {}}}]
        errors = _validate_tool_calls(tcs, set(), set(), None)
        self.assertEqual(errors, [])

    def test_non_dict_entries_skipped(self):
        tcs = ["not a dict", {"tool": "db.update", "args": {"table": "chores", "id": "real", "patch": {}}}]
        errors = _validate_tool_calls(tcs, {"real"}, set(), None)
        self.assertEqual(errors, [])


class EnforceAssignmentPolicyTests(unittest.TestCase):
    def test_both_helper_and_person_returns_warning(self):
        tcs = [
            {
                "tool": "db.update",
                "args": {
                    "table": "chores",
                    "id": "x",
                    "patch": {"helper_id": "h1", "assignee_person_id": "p1"},
                },
            }
        ]
        warnings = _enforce_assignment_policy(tcs)
        self.assertEqual(len(warnings), 1)
        self.assertIn("Cannot assign", warnings[0])

    def test_helper_only_is_clean(self):
        tcs = [
            {
                "tool": "db.update",
                "args": {"table": "chores", "id": "x", "patch": {"helper_id": "h1"}},
            }
        ]
        warnings = _enforce_assignment_policy(tcs)
        self.assertEqual(warnings, [])

    def test_both_null_is_clean(self):
        tcs = [
            {
                "tool": "db.update",
                "args": {
                    "table": "chores",
                    "id": "x",
                    "patch": {"helper_id": None, "assignee_person_id": None},
                },
            }
        ]
        warnings = _enforce_assignment_policy(tcs)
        self.assertEqual(warnings, [])


# ─── LLM-as-Judge ────────────────────────────────────────────────────────


class JudgeResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_valid_json_returned_directly(self):
        async def fake_chat(**_):
            return '{"pass": true, "reason": "Looks good"}'

        out = await _judge_response("do X", "done X", "model", fake_chat, facts_summary="")
        self.assertTrue(out["pass"])
        self.assertEqual(out["reason"], "Looks good")

    async def test_json_in_markdown_fence_is_parsed(self):
        async def fake_chat(**_):
            return '```json\n{"pass": false, "reason": "hallucinated"}\n```'

        out = await _judge_response("q", "a", "model", fake_chat)
        self.assertFalse(out["pass"])

    async def test_chat_exception_returns_failure_with_error(self):
        async def boom(**_):
            raise RuntimeError("network down")

        out = await _judge_response("q", "a", "model", boom)
        self.assertFalse(out["pass"])
        self.assertIn("network down", out["reason"])

    async def test_unparseable_returns_failure(self):
        async def fake_chat(**_):
            return "I can't parse this"

        out = await _judge_response("q", "a", "model", fake_chat)
        self.assertFalse(out["pass"])
        self.assertIn("parse", out["reason"])

    async def test_facts_summary_is_included(self):
        captured: dict[str, Any] = {}

        async def fake_chat(*, messages, **_):
            captured["messages"] = messages
            return '{"pass": true}'

        await _judge_response("q", "a", "model", fake_chat, facts_summary="FACTS HERE")
        user_msg = captured["messages"][1]["content"]
        self.assertIn("FACTS HERE", user_msg)
        self.assertIn("KNOWN FACTS", user_msg)

    def test_judge_prompt_mentions_fatal_severity(self):
        # Quick regression on the system prompt text so callers relying on
        # severity='fatal' / failure_type routing notice if the string changes.
        self.assertIn("fatal", JUDGE_SYSTEM_PROMPT)
        self.assertIn("intent_mismatch", JUDGE_SYSTEM_PROMPT)


# ─── Semantic match ───────────────────────────────────────────────────────


class SemanticMatchChoresTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_keywords_returns_empty(self):
        out = await _semantic_match_chores([], [{"id": "x", "title": "Y", "description": ""}], get_embedder=lambda: None)
        self.assertEqual(out, [])

    async def test_no_chores_returns_empty(self):
        out = await _semantic_match_chores(["kitchen"], [], get_embedder=lambda: None)
        self.assertEqual(out, [])

    async def test_embedder_unavailable_returns_empty(self):
        def raise_on_get():
            raise RuntimeError("fastembed not installed")

        out = await _semantic_match_chores(
            ["kitchen"], [{"id": "x", "title": "Kitchen sweep", "description": ""}],
            get_embedder=raise_on_get,
        )
        self.assertEqual(out, [])

    async def test_embedder_none_returns_empty(self):
        out = await _semantic_match_chores(
            ["kitchen"], [{"id": "x", "title": "K", "description": ""}],
            get_embedder=lambda: None,
        )
        self.assertEqual(out, [])


# ─── Additional detector regression tests ────────────────────────────────


class AnalyticsDetectorEdgeCaseTests(unittest.TestCase):
    def test_unassigned_count_requires_counting_phrase(self):
        # "Are there unassigned tasks?" is an analytics question but doesn't
        # use the "how many / count / total" phrasing we require.
        self.assertFalse(_wants_unassigned_count([{"role": "user", "content": "Are there unassigned tasks?"}]))

    def test_unassigned_count_requires_task_or_chore(self):
        self.assertFalse(_wants_unassigned_count([{"role": "user", "content": "How many unassigned things are there?"}]))

    def test_total_pending_count_detects_various_phrasings(self):
        cases = [
            "How many pending chores do I have?",
            "Total pending tasks?",
            "Count of pending chores?",
        ]
        for text in cases:
            with self.subTest(text=text):
                self.assertTrue(_wants_total_pending_count([{"role": "user", "content": text}]))

    def test_status_breakdown_triggers(self):
        cases = [
            "Show me chores by status",
            "Give me a status breakdown for tasks",
        ]
        for text in cases:
            with self.subTest(text=text):
                self.assertTrue(_wants_status_breakdown([{"role": "user", "content": text}]))

    def test_status_breakdown_does_not_trigger_without_status_word(self):
        self.assertFalse(_wants_status_breakdown([{"role": "user", "content": "Give me a breakdown of chores"}]))

    def test_assignee_breakdown_triggers(self):
        self.assertTrue(_wants_assignee_breakdown([{"role": "user", "content": "Show chores by helper"}]))
        self.assertTrue(_wants_assignee_breakdown([{"role": "user", "content": "Give me an assignee breakdown of tasks"}]))

    def test_empty_messages_returns_false(self):
        self.assertFalse(_wants_unassigned_count([]))
        self.assertFalse(_wants_status_breakdown([]))


class ExtractSpaceListQueryGuardTests(unittest.TestCase):
    """Regression tests for the "chores in <space>" shortcut regex that
    greedily matched natural-sentence "for" and captured entire user
    questions as space names (root cause of the 2026-04-22 mis-route).
    """

    def _extract(self, text: str) -> str:
        from agents.chore_agent import _extract_space_list_query
        return _extract_space_list_query([{"role": "user", "content": text}])

    def test_list_chores_in_space_still_matches(self):
        self.assertEqual(self._extract("Show me the chores in Kitchen"), "Kitchen")
        self.assertEqual(self._extract("list chores for Master Bathroom"), "Master Bathroom")

    def test_reschedule_request_is_not_space_query(self):
        # The bug report: user said "reschedule all lower priority tasks"
        # → must not be treated as "chores in <space>"
        self.assertEqual(
            self._extract("for the chores for Roopa can we reschedule all lower priority tasks that are assigned weekly to bi-weekly frequency"),
            "",
        )

    def test_reassign_request_is_not_space_query(self):
        self.assertEqual(self._extract("reassign all the bathroom chores to Roopa"), "")

    def test_update_request_is_not_space_query(self):
        self.assertEqual(self._extract("change the description of kitchen chores to wipe counters"), "")

    def test_clean_verb_in_message_disables_shortcut(self):
        # "Schedule a cleaning" is an action, not a list query.
        self.assertEqual(self._extract("schedule a deep clean for the living room chores"), "")

    def test_no_chore_word_returns_empty(self):
        self.assertEqual(self._extract("tell me in Kitchen"), "")

    def test_empty_messages(self):
        self.assertEqual(self._extract(""), "")


if __name__ == "__main__":
    unittest.main()
