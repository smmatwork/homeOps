"""Unit tests for the orchestrator phase modules extracted from chat_respond.

Covers:
  - orchestrator.confirmation.handle_pending_confirmation — sync / accept
    / cancel / freeform / no-pending branches
  - orchestrator.prompting.handle_apply_assignments — approval phrase
    gating, fenced-JSON output shape
  - orchestrator.prompting.handle_schedule_and_space — schedule
    clarification, space_selection clarification, selected_spaces →
    db.insert tool_calls
  - orchestrator.prompting parser helpers (_extract_clarification_block,
    _infer_base_chore_title, _infer_spaces_from_user_text, _wants_schedule,
    _has_explicit_datetime)
  - orchestrator.prompt_builder.build_system_prompt_augmentation — normal
    vs onboarding mode, FACTS injection, no-mutation of input messages
  - orchestrator.llm_loop._extract_known_entity_ids — FACTS section
    bucketing into (chores, helpers, persons) sets
"""

import asyncio
import json
import os
import sys
import unittest
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from orchestrator import state as orch_state
from orchestrator.confirmation import handle_pending_confirmation
from orchestrator.intent import ExtractedIntent
from orchestrator.llm_loop import _extract_known_entity_ids
from orchestrator.prompt_builder import (
    FINAL_ONLY_CLAUSE,
    ONBOARDING_OUTPUT_GUARD,
    build_system_prompt_augmentation,
)
from orchestrator.prompting import (
    _extract_clarification_block,
    _has_explicit_datetime,
    _infer_base_chore_title,
    _infer_spaces_from_user_text,
    _normalize_space_token,
    _wants_schedule,
    handle_apply_assignments,
    handle_schedule_and_space,
)


def _intent(**overrides: Any) -> ExtractedIntent:
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


# ─── orchestrator.confirmation ─────────────────────────────────────────────


class HandlePendingConfirmationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        orch_state.pending_confirmations.clear()
        orch_state.clarification_counts.clear()

    async def _noop_edge(self, *args, **kwargs):
        return {"ok": True}

    async def test_no_pending_returns_none(self):
        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="yes",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=self._noop_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNone(result)

    async def test_empty_last_user_returns_none(self):
        orch_state.stash_pending_confirmation(
            conversation_id="c1", intent=_intent(), match_ids=[], tool_calls=[],
        )
        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=self._noop_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNone(result)

    async def test_accept_executes_and_formats_result(self):
        orch_state.stash_pending_confirmation(
            conversation_id="c1",
            intent=_intent(),
            match_ids=[("id1", "Kitchen")],
            tool_calls=[{"id": "tc1", "tool": "db.update", "args": {"table": "chores", "id": "id1", "patch": {"description": "X"}}}],
        )
        edge_calls: list[dict] = []

        async def fake_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {"ok": True}

        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="yes",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=fake_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertEqual(len(edge_calls), 1)
        self.assertNotIn("c1", orch_state.pending_confirmations)

    async def test_cancel_returns_clarification_text_within_budget(self):
        orch_state.stash_pending_confirmation(
            conversation_id="c1",
            intent=_intent(match_text="bathroom chores"),
            match_ids=[],
            tool_calls=[],
        )
        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="no",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=self._noop_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertIn("bathroom chores", result)

    async def test_cancel_after_budget_exhausted_guides_to_ui(self):
        # Set clarification counter to one less than max so the next cancel
        # pushes it over.
        orch_state.clarification_counts["c1"] = orch_state.MAX_CLARIFICATION_TURNS - 1
        orch_state.stash_pending_confirmation(
            conversation_id="c1", intent=_intent(), match_ids=[], tool_calls=[],
        )
        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="no",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=self._noop_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertIn("Optimize workload", result)
        # Counter reset after budget exhausted.
        self.assertNotIn("c1", orch_state.clarification_counts)

    async def test_freeform_reply_consumes_pending_returns_none(self):
        orch_state.stash_pending_confirmation(
            conversation_id="c1", intent=_intent(), match_ids=[], tool_calls=[],
        )
        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="actually let me rephrase",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=self._noop_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNone(result)
        # Pending is consumed.
        self.assertNotIn("c1", orch_state.pending_confirmations)

    async def test_sync_followup_cancel_returns_leave_message(self):
        orch_state.stash_pending_confirmation(
            conversation_id="c1", intent=_intent(), match_ids=[], tool_calls=[],
        )
        pending = orch_state.pending_confirmations["c1"]
        pending.sync_field = "title"
        pending.sync_chore_ids = ["id1"]
        pending.sync_default_value = "new"

        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="no",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=self._noop_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertIn("title", result.lower())
        self.assertIn("as-is", result.lower())

    async def test_sync_followup_accept_executes_mirror(self):
        orch_state.stash_pending_confirmation(
            conversation_id="c1",
            intent=_intent(update_field="description"),
            match_ids=[("id1", "Kitchen")],
            tool_calls=[{"id": "tc1", "tool": "db.update", "args": {"table": "chores", "id": "id1", "patch": {"title": "new"}}}],
        )
        pending = orch_state.pending_confirmations["c1"]
        pending.sync_field = "title"
        pending.sync_chore_ids = ["id1"]
        pending.sync_default_value = "new"

        async def fake_edge(payload, *, user_id):
            return {"ok": True, "result": {"id": "id1"}}

        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="yes",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=fake_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertIn("Done", result)

    async def test_sync_followup_freeform_treated_as_new_value(self):
        orch_state.stash_pending_confirmation(
            conversation_id="c1",
            intent=_intent(update_field="description"),
            match_ids=[("id1", "Kitchen")],
            tool_calls=[],
        )
        pending = orch_state.pending_confirmations["c1"]
        pending.sync_field = "title"
        pending.sync_chore_ids = ["id1"]
        pending.sync_default_value = "old"

        async def fake_edge(payload, *, user_id):
            return {"ok": True, "result": {"id": "id1"}}

        result = await handle_pending_confirmation(
            pending_key="c1",
            last_user="My new title",
            conv_id="c1",
            user_id="u",
            household_id="h",
            facts_section="",
            edge_execute_tools=fake_edge,
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertIn("My new title", result)


# ─── orchestrator.prompting — handlers ────────────────────────────────────


class HandleApplyAssignmentsTests(unittest.TestCase):
    def test_non_approval_returns_none(self):
        result = handle_apply_assignments(
            messages=[{"role": "user", "content": "hi"}],
            latest_user_text="hi",
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNone(result)

    def test_approval_without_assignments_prompts_for_list(self):
        result = handle_apply_assignments(
            messages=[{"role": "user", "content": "yes"}],
            latest_user_text="yes",
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertIn("paste the assignment list", result)

    def test_trigger_phrase_without_assignments_prompts_for_list(self):
        result = handle_apply_assignments(
            messages=[{"role": "user", "content": "create these assignments"}],
            latest_user_text="create these assignments",
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertIn("paste", result.lower())

    def test_approval_with_assignment_list_emits_rpc(self):
        msgs = [
            {
                "role": "assistant",
                "content": "1. Clean kitchen (2026-04-01T07:05:00+00:00) → Cook",
            },
            {"role": "user", "content": "yes"},
        ]
        result = handle_apply_assignments(
            messages=msgs,
            latest_user_text="yes",
            lf_span=lambda *a, **kw: None,
        )
        self.assertIsNotNone(result)
        self.assertIn("```json", result)
        self.assertIn("apply_chore_assignments", result)


class HandleScheduleAndSpaceTests(unittest.TestCase):
    def test_wants_schedule_without_datetime_asks(self):
        messages = [{"role": "user", "content": "Schedule a cleaning"}]
        result = handle_schedule_and_space(messages, latest_user_text="Schedule a cleaning")
        self.assertIsNotNone(result)
        self.assertIn("schedule", result.lower())

    def test_unscheduled_no_clarification_returns_none(self):
        messages = [{"role": "user", "content": "Just chat with me"}]
        result = handle_schedule_and_space(messages, latest_user_text="Just chat with me")
        self.assertIsNone(result)

    def test_clarification_block_with_no_spaces_returns_payload(self):
        sys_content = (
            "CLARIFICATION NEEDED (critical):\n"
            "Which bathroom do you mean?\n"
            "Options:\n"
            "- Master Bathroom\n"
            "- Guest Bathroom\n"
        )
        messages = [
            {"role": "system", "content": sys_content},
            {"role": "user", "content": "clean the bathroom"},
        ]
        result = handle_schedule_and_space(messages, latest_user_text="clean the bathroom")
        # The user didn't mention a specific bathroom, so the clarification
        # fires (or the inference picks one). Both outcomes are valid — we
        # just ensure something is returned.
        self.assertIsNotNone(result)

    def test_clarification_response_selected_spaces_emits_db_insert(self):
        messages = [
            {"role": "user", "content": "clean up"},
            {
                "role": "user",
                "content": '{"clarification_response": {"spaces": ["Master Bathroom"], "due_at": "2026-04-22T18:00:00Z"}}',
            },
        ]
        latest = messages[-1]["content"]
        result = handle_schedule_and_space(messages, latest_user_text=latest)
        self.assertIsNotNone(result)
        self.assertIn("```json", result)
        self.assertIn("db.insert", result)
        self.assertIn("Master Bathroom", result)


class ExtractClarificationBlockTests(unittest.TestCase):
    def test_returns_none_when_no_system_block(self):
        msgs = [{"role": "user", "content": "hi"}]
        self.assertIsNone(_extract_clarification_block(msgs))

    def test_parses_options_from_system_block(self):
        sys_content = (
            "CLARIFICATION NEEDED (critical):\n"
            "Which bathroom?\n"
            "Options:\n"
            "- Master Bathroom\n"
            "- Guest Bathroom\n"
        )
        msgs = [{"role": "system", "content": sys_content}]
        block = _extract_clarification_block(msgs)
        self.assertIsNotNone(block)
        self.assertEqual(block["kind"], "space_selection")
        self.assertIn("Master Bathroom", block["options"])
        self.assertIn("Guest Bathroom", block["options"])

    def test_returns_none_when_no_options(self):
        sys_content = "CLARIFICATION NEEDED (critical):\nNo options listed"
        msgs = [{"role": "system", "content": sys_content}]
        self.assertIsNone(_extract_clarification_block(msgs))


class InferSpacesFromUserTextTests(unittest.TestCase):
    def test_direct_substring_match(self):
        out = _infer_spaces_from_user_text(["Master Bathroom", "Guest Bathroom"], "the master bathroom please")
        self.assertEqual(out, ["Master Bathroom"])

    def test_ambiguous_returns_empty(self):
        out = _infer_spaces_from_user_text(["Master Bathroom", "Guest Bathroom"], "any bathroom")
        self.assertEqual(out, [])

    def test_alias_master_primary_main(self):
        out = _infer_spaces_from_user_text(["Master Bathroom", "Guest Bathroom"], "primary bathroom")
        self.assertEqual(out, ["Master Bathroom"])

    def test_empty_user_text_returns_empty(self):
        out = _infer_spaces_from_user_text(["A"], "")
        self.assertEqual(out, [])

    def test_no_options_returns_empty(self):
        out = _infer_spaces_from_user_text([], "any text")
        self.assertEqual(out, [])


class InferBaseChoreTitleTests(unittest.TestCase):
    def test_deep_clean(self):
        msgs = [{"role": "user", "content": "I want a deep clean"}]
        self.assertEqual(_infer_base_chore_title(msgs), "Deep clean")

    def test_clean(self):
        msgs = [{"role": "user", "content": "Please clean the kitchen"}]
        self.assertEqual(_infer_base_chore_title(msgs), "Clean")

    def test_schedule(self):
        msgs = [{"role": "user", "content": "Schedule something"}]
        self.assertEqual(_infer_base_chore_title(msgs), "Scheduled chore")

    def test_fallback_generic_chore(self):
        msgs = [{"role": "user", "content": "Make a task"}]
        self.assertEqual(_infer_base_chore_title(msgs), "Chore")

    def test_no_user_message_returns_default(self):
        msgs: list[dict] = []
        self.assertEqual(_infer_base_chore_title(msgs), "Chore")


class WantsScheduleAndHasDateTimeTests(unittest.TestCase):
    def test_wants_schedule_detects_variants(self):
        for text in ["schedule this", "book a cleaning", "plan for tomorrow", "set up a reminder"]:
            with self.subTest(text=text):
                self.assertTrue(_wants_schedule([{"role": "user", "content": text}]))

    def test_does_not_want_schedule_without_trigger(self):
        self.assertFalse(_wants_schedule([{"role": "user", "content": "hello there"}]))

    def test_has_explicit_datetime_hh_mm(self):
        self.assertTrue(_has_explicit_datetime([{"role": "user", "content": "at 19:30"}]))

    def test_has_explicit_datetime_iso(self):
        self.assertTrue(_has_explicit_datetime([{"role": "user", "content": "on 2026-05-01"}]))

    def test_has_explicit_datetime_today_tomorrow(self):
        self.assertTrue(_has_explicit_datetime([{"role": "user", "content": "tomorrow please"}]))
        self.assertTrue(_has_explicit_datetime([{"role": "user", "content": "today"}]))

    def test_no_datetime(self):
        self.assertFalse(_has_explicit_datetime([{"role": "user", "content": "sometime later"}]))


class NormalizeSpaceTokenTests(unittest.TestCase):
    def test_lowercases_and_strips_punctuation(self):
        self.assertEqual(_normalize_space_token("Master Bathroom!"), "master bathroom")

    def test_empty_returns_empty(self):
        self.assertEqual(_normalize_space_token(""), "")


# ─── orchestrator.prompt_builder ──────────────────────────────────────────


class BuildSystemPromptAugmentationTests(unittest.IsolatedAsyncioTestCase):
    async def test_normal_mode_appends_final_only_clause(self):
        messages = [{"role": "system", "content": "Base prompt"}, {"role": "user", "content": "hi"}]

        with patch(
            "orchestrator.prompt_builder._build_facts_section",
            side_effect=self._fake_facts(""),
        ):
            out_msgs, facts, intent = await build_system_prompt_augmentation(
                messages,
                household_id="h",
                user_id="u",
                last_user_text="hi",
                is_onboarding=False,
            )

        self.assertIn("CRITICAL OUTPUT CONTRACT", out_msgs[0]["content"])
        self.assertEqual(facts, "")

    async def test_onboarding_mode_uses_onboarding_guard(self):
        messages = [
            {"role": "system", "content": "ONBOARDING FLOW"},
            {"role": "user", "content": "hi"},
        ]

        with patch("orchestrator.prompt_builder._build_facts_section", side_effect=self._fake_facts("")):
            out_msgs, _, _ = await build_system_prompt_augmentation(
                messages,
                household_id="h",
                user_id="u",
                last_user_text="hi",
                is_onboarding=True,
            )

        self.assertIn("ONBOARDING", out_msgs[0]["content"])
        self.assertIn("OUTPUT GUARD", out_msgs[0]["content"])
        self.assertNotIn("CRITICAL OUTPUT CONTRACT", out_msgs[0]["content"])

    async def test_facts_section_appended_to_system(self):
        messages = [{"role": "system", "content": "Base"}, {"role": "user", "content": "hi"}]

        with patch(
            "orchestrator.prompt_builder._build_facts_section",
            side_effect=self._fake_facts("Helpers:\n- Alice (id=h1)"),
        ):
            out_msgs, facts, _ = await build_system_prompt_augmentation(
                messages,
                household_id="h",
                user_id="u",
                last_user_text="hi",
                is_onboarding=False,
            )

        self.assertIn("Helpers", out_msgs[0]["content"])
        self.assertIn("Alice", out_msgs[0]["content"])
        self.assertIn("Helpers", facts)

    async def test_no_system_message_prepends_one(self):
        messages = [{"role": "user", "content": "hi"}]

        with patch("orchestrator.prompt_builder._build_facts_section", side_effect=self._fake_facts("")):
            out_msgs, _, _ = await build_system_prompt_augmentation(
                messages,
                household_id="h",
                user_id="u",
                last_user_text="hi",
                is_onboarding=False,
            )

        self.assertEqual(out_msgs[0]["role"], "system")
        self.assertEqual(out_msgs[1]["role"], "user")

    async def test_original_messages_list_not_mutated(self):
        original = [{"role": "system", "content": "Base"}, {"role": "user", "content": "hi"}]
        snapshot_content = original[0]["content"]

        with patch("orchestrator.prompt_builder._build_facts_section", side_effect=self._fake_facts("")):
            await build_system_prompt_augmentation(
                original,
                household_id="h",
                user_id="u",
                last_user_text="hi",
                is_onboarding=False,
            )

        # The caller's system message content should be untouched.
        self.assertEqual(original[0]["content"], snapshot_content)

    async def test_final_only_clause_has_required_contract(self):
        # Spot-check some invariants the router + llm_loop rely on.
        self.assertIn("final_text", FINAL_ONLY_CLAUSE)
        self.assertIn("tool_calls", FINAL_ONLY_CLAUSE)
        self.assertIn("apply_assignment_decision", FINAL_ONLY_CLAUSE)
        self.assertIn("count_chores", FINAL_ONLY_CLAUSE)

    async def test_onboarding_guard_forbids_meta_commentary(self):
        self.assertIn("chain-of-thought", ONBOARDING_OUTPUT_GUARD)
        self.assertIn("NEVER ask", ONBOARDING_OUTPUT_GUARD)

    def _fake_facts(self, facts: str):
        async def _f(*args, **kwargs):
            return facts

        return _f


# ─── orchestrator.llm_loop — entity ID extraction ────────────────────────


class ExtractKnownEntityIdsTests(unittest.TestCase):
    def test_extracts_chore_ids_under_chores_header(self):
        facts = """\
Chores:
- "Kitchen sweep" (id=11111111-1111-1111-1111-111111111111)
- "Bathroom mop" (id=22222222-2222-2222-2222-222222222222)
"""
        chores, helpers, persons = _extract_known_entity_ids(facts)
        self.assertEqual(
            chores,
            {"11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"},
        )
        self.assertEqual(helpers, set())
        self.assertEqual(persons, set())

    def test_extracts_helper_ids_under_helpers_header(self):
        facts = """\
Helpers:
- Alice (id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)
"""
        chores, helpers, persons = _extract_known_entity_ids(facts)
        self.assertEqual(chores, set())
        self.assertEqual(helpers, {"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"})
        self.assertEqual(persons, set())

    def test_extracts_person_ids_under_people_header(self):
        facts = """\
People:
- Sunil (id=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb)
"""
        _, _, persons = _extract_known_entity_ids(facts)
        self.assertEqual(persons, {"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"})

    def test_mixed_sections_bucketed_correctly(self):
        facts = """\
Helpers:
- Alice (id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)
Chores:
- "Task" (id=11111111-1111-1111-1111-111111111111)
People:
- Sunil (id=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb)
Spaces:
- Kitchen
"""
        chores, helpers, persons = _extract_known_entity_ids(facts)
        self.assertEqual(chores, {"11111111-1111-1111-1111-111111111111"})
        self.assertEqual(helpers, {"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"})
        self.assertEqual(persons, {"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"})

    def test_ids_outside_any_header_fallback_to_both_sets(self):
        # When an ID appears before any section header, we conservatively add
        # it to both chores + helpers so hallucination detection still fires.
        facts = "Orphaned: (id=11111111-1111-1111-1111-111111111111)"
        chores, helpers, persons = _extract_known_entity_ids(facts)
        self.assertIn("11111111-1111-1111-1111-111111111111", chores)
        self.assertIn("11111111-1111-1111-1111-111111111111", helpers)

    def test_empty_facts_returns_empty_sets(self):
        chores, helpers, persons = _extract_known_entity_ids("")
        self.assertEqual(chores, set())
        self.assertEqual(helpers, set())
        self.assertEqual(persons, set())


if __name__ == "__main__":
    unittest.main()
