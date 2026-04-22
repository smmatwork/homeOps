import os
import sys
import unittest
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import main as agent_main
from main import (
    _deterministic_trim_chain_of_thought,
    _extract_assignment_suggestions,
    _extract_assign_or_create_chore,
    _extract_complete_chore_by_query,
    _extract_reassign_or_unassign_chore,
    _format_confirmation_preview,
    _is_cancellation,
    _is_confirmation,
    _looks_like_chain_of_thought,
    _match_ids_from_tool_calls,
    _parse_chores_from_facts,
    _resolve_chore_match_ids,
    _resolve_chore_match_ids_via_rpc,
    _split_match_keywords,
    _stash_pending_confirmation,
    _summarize_history_if_needed,
    _take_pending_confirmation,
    _truncate_messages_to_budget,
)
from main import ExtractedIntent

# Post-refactor shims: the intent cascade and Helper Agent live in their own
# modules now, but the tests were written against the legacy private names in
# main.py. Re-expose the new entry points under the old names so existing
# test bodies keep working without behavior changes.
from orchestrator.intent import extract_intent_regex as _extract_intent_regex

_helper_agent_for_tests = agent_main._get_helper_agent()
_is_helper_intent = _helper_agent_for_tests.is_intent
_parse_helper_agent_payload = _helper_agent_for_tests._parse_payload


class HelperAgentContractTests(unittest.TestCase):
    def test_is_helper_intent_true_for_helper_terms(self):
        msgs = [{"role": "user", "content": "Add a helper named Sunita"}]
        self.assertTrue(_is_helper_intent(msgs))

    def test_is_helper_intent_true_for_feedback(self):
        msgs = [{"role": "user", "content": "Give feedback rating 5 for my cleaner"}]
        self.assertTrue(_is_helper_intent(msgs))

    def test_is_helper_intent_false_for_general_chat(self):
        msgs = [{"role": "user", "content": "What is the weather?"}]
        self.assertFalse(_is_helper_intent(msgs))

    def test_is_helper_intent_false_for_analytics_assigned_to(self):
        msgs = [{"role": "user", "content": "How many chores are assigned to Rajesh?"}]
        self.assertFalse(_is_helper_intent(msgs))

    def test_is_helper_intent_false_for_analytics_assigned_to_cook(self):
        msgs = [{"role": "user", "content": "How many chores are assigned to the cook"}]
        self.assertFalse(_is_helper_intent(msgs))

    def test_is_helper_intent_false_for_assign_chore_to_named_person(self):
        msgs = [{"role": "user", "content": "Assign a chore to the Cook to cook chicken biryani tomorrow"}]
        self.assertFalse(_is_helper_intent(msgs))

    def test_extract_assign_or_create_chore_parses_helper_task_when(self):
        out = _extract_assign_or_create_chore("Assign a chore to the cook to make chick biryani tomorrow")
        self.assertIsNotNone(out)
        self.assertEqual(out["helper_query"], "cook")
        self.assertEqual(out["task"], "make chick biryani")
        self.assertEqual(out["when"], "tomorrow")

    def test_extract_complete_chore_by_query_parses_query(self):
        out = _extract_complete_chore_by_query("Mark clean kitchen as done")
        self.assertIsNotNone(out)
        self.assertEqual(out["query"], "clean kitchen")

    def test_extract_reassign_or_unassign_chore_parses_reassign(self):
        out = _extract_reassign_or_unassign_chore("Assign clean kitchen to Rajesh")
        self.assertIsNotNone(out)
        self.assertEqual(out["chore_query"], "clean kitchen")
        self.assertEqual(out["helper_query"], "rajesh")

    def test_extract_reassign_or_unassign_chore_parses_unassign(self):
        out = _extract_reassign_or_unassign_chore("Unassign clean kitchen")
        self.assertIsNotNone(out)
        self.assertEqual(out["chore_query"], "clean kitchen")
        self.assertIsNone(out["helper_query"])

    def test_parse_helper_agent_payload_accepts_clarifications_only(self):
        payload = """{
          \"clarifications\": [
            {\"key\": \"helper\", \"question\": \"Which helper?\", \"options\": [\"A\", \"B\"], \"allowMultiple\": false}
          ],
          \"tool_calls\": [],
          \"user_summary\": \"Need helper selection.\"
        }"""
        out = _parse_helper_agent_payload(payload)
        self.assertIsNotNone(out)
        self.assertEqual(len(out["clarifications"]), 1)
        self.assertEqual(out["clarifications"][0]["key"], "helper")
        self.assertEqual(out["tool_calls"], [])

    def test_parse_helper_agent_payload_rejects_tool_calls_when_clarifications_exist(self):
        payload = """{
          \"clarifications\": [
            {\"key\": \"helper\", \"question\": \"Which helper?\", \"options\": [\"A\"], \"allowMultiple\": false}
          ],
          \"tool_calls\": [
            {\"id\": \"tc_1\", \"tool\": \"db.select\", \"args\": {\"table\": \"helpers\", \"limit\": 5}}
          ],
          \"user_summary\": \"Need helper selection.\"
        }"""
        out = _parse_helper_agent_payload(payload)
        self.assertIsNone(out)

    def test_parse_helper_agent_payload_accepts_tool_calls(self):
        payload = """{
          \"clarifications\": [],
          \"tool_calls\": [
            {
              \"id\": \"tc_1\",
              \"tool\": \"db.select\",
              \"args\": {\"table\": \"helpers\", \"limit\": 5},
              \"reason\": \"Fetch helpers\"
            },
            {
              \"id\": \"tc_2\",
              \"tool\": \"db.update\",
              \"args\": {\"table\": \"chores\", \"id\": \"c1\", \"patch\": {\"helper_id\": \"h1\"}},
              \"reason\": \"Assign chore\"
            }
          ],
          \"user_summary\": \"I will fetch helpers and assign the chore.\"
        }"""
        out = _parse_helper_agent_payload(payload)
        self.assertIsNotNone(out)
        self.assertEqual(len(out["tool_calls"]), 2)

    def test_parse_helper_agent_payload_rejects_legacy_update_shape(self):
        payload = """{
          \"clarifications\": [],
          \"tool_calls\": [
            {
              \"id\": \"tc_1\",
              \"tool\": \"db.update\",
              \"args\": {\"table\": \"chores\", \"where\": {\"id\": \"c1\"}, \"updates\": {\"helper_id\": \"h1\"}}
            }
          ],
          \"user_summary\": \"Assigning\"
        }"""
        out = _parse_helper_agent_payload(payload)
        self.assertIsNone(out)

    def test_extract_assignment_suggestions_parses_numbered_lines(self):
        msgs = [
            {
                "role": "assistant",
                "content": (
                    "1. Clean kitchen (2026-04-01T07:05:00+00:00) → Cook\n"
                    "2. Clean master bathroom (2026-04-04T07:00:00+00:00) → Rajesh\n"
                    "- clean living room (2026-04-01T07:10:00+00:00) → Sunita\n"
                ),
            },
            {"role": "user", "content": "Create these assignments"},
        ]
        out = _extract_assignment_suggestions(msgs)
        self.assertEqual(
            out,
            [
                {"title": "Clean kitchen", "due_at": "2026-04-01T07:05:00+00:00", "helper_name": "Cook"},
                {"title": "Clean master bathroom", "due_at": "2026-04-04T07:00:00+00:00", "helper_name": "Rajesh"},
                {"title": "clean living room", "due_at": "2026-04-01T07:10:00+00:00", "helper_name": "Sunita"},
            ],
        )


class SplitMatchKeywordsTests(unittest.TestCase):
    def test_splits_on_and(self):
        self.assertEqual(_split_match_keywords("toy and clutter sweep"), ["toy", "clutter sweep"])

    def test_splits_on_or(self):
        self.assertEqual(_split_match_keywords("books or magazines"), ["books", "magazines"])

    def test_splits_on_comma_and_slash(self):
        self.assertEqual(_split_match_keywords("toys, books / clothes"), ["toys", "books", "clothes"])

    def test_drops_stopwords(self):
        self.assertEqual(_split_match_keywords("the toy and the clutter"), ["toy", "clutter"])

    def test_dedupes_case_insensitive(self):
        self.assertEqual(_split_match_keywords("Toy and toy"), ["Toy"])

    def test_empty_input(self):
        self.assertEqual(_split_match_keywords(""), [])
        self.assertEqual(_split_match_keywords("   "), [])

    def test_single_keyword_unchanged(self):
        self.assertEqual(_split_match_keywords("kitchen cleaning"), ["kitchen cleaning"])


class ParseChoresFromFactsTests(unittest.TestCase):
    def test_parses_chores_with_descriptions(self):
        facts = (
            "FACTS:\n"
            "Helpers:\n"
            "  - Rajesh (id=11111111-1111-1111-1111-111111111111, type=cleaner)\n"
            "Chores (showing 2):\n"
            '  - "Tidy Kids Room" (id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa, status=pending, space=Kids, cadence=weekly, desc="Pick up scattered toys")\n'
            '  - "Sweep Balcony" (id=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb, status=pending, space=Balcony, cadence=daily)\n'
        )
        chores = _parse_chores_from_facts(facts)
        self.assertEqual(len(chores), 2)
        self.assertEqual(chores[0]["title"], "Tidy Kids Room")
        self.assertEqual(chores[0]["description"], "Pick up scattered toys")
        self.assertEqual(chores[1]["title"], "Sweep Balcony")
        self.assertEqual(chores[1]["description"], "")

    def test_ignores_non_chore_lines(self):
        # Helper line has a quoted name pattern but no uuid+desc shape.
        facts = "Helpers:\n  - Rajesh (id=11111111-1111-1111-1111-111111111111, type=cleaner)\n"
        self.assertEqual(_parse_chores_from_facts(facts), [])


class ResolveChoreMatchIdsTests(unittest.IsolatedAsyncioTestCase):
    CHORES = [
        {"id": "11111111-1111-1111-1111-111111111111", "title": "Tidy Kids Room", "description": "Pick up scattered toys"},
        {"id": "22222222-2222-2222-2222-222222222222", "title": "Living Room Declutter", "description": "Clear clutter sweep across coffee table"},
        {"id": "33333333-3333-3333-3333-333333333333", "title": "Sweep Balcony", "description": "Daily balcony broom"},
    ]

    async def test_substring_resolves_each_keyword(self):
        out = await _resolve_chore_match_ids("toy and clutter sweep", self.CHORES, bulk=True)
        ids = {cid for cid, _ in out}
        # "toy" matches the first chore's description; "clutter sweep" matches the second.
        self.assertIn("11111111-1111-1111-1111-111111111111", ids)
        self.assertIn("22222222-2222-2222-2222-222222222222", ids)
        self.assertNotIn("33333333-3333-3333-3333-333333333333", ids)

    async def test_non_bulk_returns_first_substring_match_only(self):
        out = await _resolve_chore_match_ids("toy and clutter sweep", self.CHORES, bulk=False)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0][0], "11111111-1111-1111-1111-111111111111")

    async def test_empty_inputs(self):
        self.assertEqual(await _resolve_chore_match_ids("", self.CHORES, bulk=True), [])
        self.assertEqual(await _resolve_chore_match_ids("toy", [], bulk=True), [])

    async def test_no_semantic_fallback_for_substring_miss(self):
        # Regression: previously "toy and clutter sweep" would semantic-match
        # "Sweep Balcony", "Tidy Home Office", "Clean Dining Area", etc. since
        # BGE-small sees them as loosely cleaning-related. We now require
        # literal substring hits — with keyword splitting the phrase becomes
        # ["toy", "clutter sweep"] and neither is a substring of any title
        # or description below, so the result must be empty so the caller
        # can surface "no matches found".
        chores = [
            {"id": "a", "title": "Sweep Balcony", "description": "daily broom"},
            {"id": "b", "title": "Tidy Home Office", "description": "clear papers"},
            {"id": "c", "title": "Clean Dining Area", "description": "wipe table"},
        ]
        out = await _resolve_chore_match_ids("toy and clutter sweep", chores, bulk=True)
        self.assertEqual(out, [])

    async def test_substring_match_still_works_on_single_keyword(self):
        # Substring matching must still succeed when the literal keyword
        # does appear in the title or description.
        chores = [
            {"id": "a", "title": "Sweep Balcony", "description": "daily broom"},
            {"id": "b", "title": "Tidy Home Office", "description": "clear papers"},
        ]
        out = await _resolve_chore_match_ids("sweep", chores, bulk=True)
        ids = {cid for cid, _ in out}
        self.assertEqual(ids, {"a"})

    async def test_still_empty_when_no_keyword_matches_literally(self):
        chores = [
            {"id": "a", "title": "Water the plants", "description": "indoor pots"},
            {"id": "b", "title": "Garden upkeep", "description": "prune rose bush"},
        ]
        out = await _resolve_chore_match_ids("toy", chores, bulk=True)
        self.assertEqual(out, [])


class TruncateMessagesToBudgetTests(unittest.TestCase):
    def test_passthrough_when_under_budget(self):
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
            {"role": "user", "content": "now what?"},
        ]
        self.assertEqual(_truncate_messages_to_budget(msgs, char_budget=10000), msgs)

    def test_drops_oldest_history_when_over_budget(self):
        big = "x" * 1000
        msgs = [
            {"role": "system", "content": "S"},
            {"role": "user", "content": big},      # old turn
            {"role": "assistant", "content": big}, # old turn
            {"role": "user", "content": big},      # old turn
            {"role": "assistant", "content": big}, # old turn
            {"role": "user", "content": "final question"},
        ]
        out = _truncate_messages_to_budget(msgs, char_budget=1500)
        # System + final user message must remain.
        self.assertEqual(out[0]["role"], "system")
        self.assertEqual(out[-1]["content"], "final question")
        # Total chars should now be under budget.
        total = sum(len(m["content"]) + len(m["role"]) + 16 for m in out)
        self.assertLessEqual(total, 2500)
        # Some history was dropped.
        self.assertLess(len(out), len(msgs))

    def test_protects_final_user_even_if_over_budget(self):
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "x" * 5000},
        ]
        out = _truncate_messages_to_budget(msgs, char_budget=100)
        # Final user is preserved verbatim; system gets truncated.
        self.assertEqual(out[-1]["content"], "x" * 5000)
        self.assertEqual(out[-1]["role"], "user")


class SummarizeHistoryIfNeededTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Reset the in-process summary cache before each test.
        agent_main._summary_cache.clear()

    async def test_passthrough_when_under_budget(self):
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
            {"role": "user", "content": "now what?"},
        ]
        out = await _summarize_history_if_needed(
            msgs, conversation_id="conv-1", model="sarvam-m", char_budget=10000
        )
        self.assertEqual(out, msgs)

    async def test_no_conversation_id_passes_through(self):
        big = "x" * 5000
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": big},
            {"role": "assistant", "content": big},
            {"role": "user", "content": "final"},
        ]
        # No conversation_id → no caching → passthrough (truncator handles it later).
        out = await _summarize_history_if_needed(
            msgs, conversation_id="", model="sarvam-m", char_budget=1000
        )
        self.assertEqual(out, msgs)

    async def test_folds_old_turns_into_summary(self):
        big = "x" * 1000
        # 6 body turns; with KEEP_RECENT=4, the first 2 should be summarized.
        msgs = [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "old request 1: " + big},
            {"role": "assistant", "content": "old response 1: " + big},
            {"role": "user", "content": "old request 2"},
            {"role": "assistant", "content": "old response 2"},
            {"role": "user", "content": "recent request"},
            {"role": "assistant", "content": "recent response"},
        ]

        async def fake_chat(*, messages, model, temperature, max_tokens):
            # Verify the summarizer prompt was called with the right shape.
            assert messages[0]["role"] == "system"
            assert "summarizing" in messages[0]["content"].lower()
            assert "old request 1" in messages[1]["content"]
            return "User had 2 old exchanges about request 1 and 2."

        with patch.object(agent_main, "_sarvam_chat", side_effect=fake_chat):
            out = await _summarize_history_if_needed(
                msgs,
                conversation_id="conv-fold",
                model="sarvam-m",
                char_budget=1500,
            )

        # System message should now contain the summary note.
        self.assertEqual(out[0]["role"], "system")
        self.assertIn("Conversation summary so far", out[0]["content"])
        self.assertIn("old exchanges", out[0]["content"])
        # Last KEEP_RECENT turns kept verbatim. With KEEP_RECENT=4 the recent
        # window is the last 4 body turns.
        recent_contents = [m["content"] for m in out[-4:]]
        self.assertIn("recent request", recent_contents)
        self.assertIn("recent response", recent_contents)

    async def test_only_summarizes_delta_on_subsequent_calls(self):
        big = "x" * 2000
        msgs1 = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "old 1: " + big},
            {"role": "assistant", "content": "old 1 reply"},
            {"role": "user", "content": "old 2"},
            {"role": "assistant", "content": "old 2 reply"},
            {"role": "user", "content": "recent 1"},
            {"role": "assistant", "content": "recent 1 reply"},
        ]

        call_count = {"n": 0}
        seen_old_in_calls: list[bool] = []

        async def fake_chat(*, messages, model, temperature, max_tokens):
            call_count["n"] += 1
            user_msg = messages[1]["content"]
            seen_old_in_calls.append("old 1:" in user_msg)
            return f"summary-{call_count['n']}"

        with patch.object(agent_main, "_sarvam_chat", side_effect=fake_chat):
            await _summarize_history_if_needed(
                msgs1, conversation_id="conv-delta", model="sarvam-m", char_budget=1500
            )

            # Simulate a new turn arriving; total still over budget.
            msgs2 = msgs1 + [
                {"role": "user", "content": "recent 2"},
                {"role": "assistant", "content": "recent 2 reply"},
            ]
            await _summarize_history_if_needed(
                msgs2, conversation_id="conv-delta", model="sarvam-m", char_budget=1500
            )

        # First call summarizes the 2 oldest turns ("old 1", "old 1 reply").
        # Second call should ONLY fold the newly-aged-out turns (the original
        # "recent 1" pair), not re-fold "old 1".
        self.assertEqual(call_count["n"], 2)
        self.assertTrue(seen_old_in_calls[0])
        self.assertFalse(seen_old_in_calls[1])

    async def test_summarizer_failure_falls_back_to_messages(self):
        big = "x" * 1000
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "old: " + big},
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "r1"},
            {"role": "assistant", "content": "r1 reply"},
            {"role": "user", "content": "r2"},
            {"role": "assistant", "content": "r2 reply"},
        ]

        async def boom(*, messages, model, temperature, max_tokens):
            raise RuntimeError("provider down")

        with patch.object(agent_main, "_sarvam_chat", side_effect=boom):
            out = await _summarize_history_if_needed(
                msgs, conversation_id="conv-fail", model="sarvam-m", char_budget=1500
            )

        # Fold failed → cached summary stays empty → function returns the
        # original messages so the truncator fallback can still reduce them.
        self.assertEqual(out, msgs)


class ExtractIntentRegexTests(unittest.TestCase):
    def test_remove_description_with_replacement(self):
        # The exact prompt from the live debugging session.
        intent = _extract_intent_regex(
            "remove the description of toy and clutter sweep, instead mention arrange clothes or books"
        )
        self.assertIsNotNone(intent)
        assert intent is not None  # narrow for type-checker
        self.assertEqual(intent.action, "update")
        self.assertEqual(intent.update_field, "description")
        self.assertEqual(intent.match_text, "toy and clutter sweep")
        self.assertEqual(intent.update_value, "arrange clothes or books")
        self.assertTrue(intent.bulk)
        self.assertEqual(intent.confidence, 1.0)

    def test_change_description_to(self):
        intent = _extract_intent_regex(
            'Change the description of kitchen cleaning to "wipe counters and mop"'
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.update_field, "description")
        self.assertEqual(intent.match_text, "kitchen cleaning")
        self.assertIn("wipe counters", intent.update_value or "")

    def test_update_cadence(self):
        intent = _extract_intent_regex("update the cadence of lawn mowing to weekly")
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.update_field, "cadence")
        self.assertEqual(intent.match_text, "lawn mowing")
        self.assertEqual(intent.update_value, "weekly")

    def test_clear_description_no_replacement(self):
        intent = _extract_intent_regex("remove the description of kitchen cleaning")
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.update_field, "description")
        self.assertIsNone(intent.update_value)

    def test_strips_trailing_from_the_chores(self):
        intent = _extract_intent_regex(
            "remove the description of toy from the chores, instead mention arrange books"
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.match_text, "toy")
        self.assertEqual(intent.update_value, "arrange books")

    def test_no_match_for_unrelated(self):
        self.assertIsNone(_extract_intent_regex("how many chores are due today?"))
        self.assertIsNone(_extract_intent_regex("assign kitchen cleaning to Rajesh"))
        self.assertIsNone(_extract_intent_regex(""))


class TrimChainOfThoughtTests(unittest.TestCase):
    def test_strips_i_should_start_leak(self):
        # Real leak from a sarvam-m response on 2026-04-13.
        leak = (
            "I should start by querying the database for chores where the "
            "description includes \"toy\" or \"clutter sweep.\" Using a "
            "db.select with a where clause that checks the description field "
            "for those terms. The columns should include the id and "
            "description to identify which records to update."
        )
        self.assertTrue(_looks_like_chain_of_thought(leak.lower()))
        out = _deterministic_trim_chain_of_thought(leak)
        # After trimming, none of the meta-reasoning fragments remain.
        self.assertNotIn("I should start", out)
        self.assertNotIn("Using a db.select", out)

    def test_strips_step_numbered_reasoning(self):
        leak = "Step 1: query the database. Step 2: update the records."
        self.assertTrue(_looks_like_chain_of_thought(leak.lower()))

    def test_passes_through_normal_assistant_response(self):
        normal = "Done! Updated the description of \"Tidy Kids Room\" to \"arrange clothes\"."
        out = _deterministic_trim_chain_of_thought(normal)
        self.assertEqual(out, normal)


class ResolveChoreMatchIdsViaRpcTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_none_without_ids(self):
        out = await _resolve_chore_match_ids_via_rpc(
            household_id="", user_id="u", match_text="toy", bulk=True
        )
        self.assertIsNone(out)

    async def test_returns_empty_for_empty_keywords(self):
        # match_text only of stopwords/punctuation → keywords=[].
        out = await _resolve_chore_match_ids_via_rpc(
            household_id="h", user_id="u", match_text="   ", bulk=True
        )
        self.assertEqual(out, [])

    async def test_calls_rpc_with_split_keywords(self):
        captured: dict[str, Any] = {}

        async def fake_edge(payload, *, user_id):
            captured["payload"] = payload
            captured["user_id"] = user_id
            return {
                "ok": True,
                "result": [
                    {"id": "id-1", "title": "Tidy Kids Room", "match_score": 1},
                    {"id": "id-2", "title": "Clutter Sweep Daily", "match_score": 2},
                ],
            }

        with patch.object(agent_main, "_edge_execute_tools", side_effect=fake_edge):
            out = await _resolve_chore_match_ids_via_rpc(
                household_id="h",
                user_id="u",
                match_text="toy and clutter sweep",
                bulk=True,
            )

        self.assertEqual(out, [("id-1", "Tidy Kids Room"), ("id-2", "Clutter Sweep Daily")])
        tc = captured["payload"]["tool_call"]
        self.assertEqual(tc["tool"], "query.rpc")
        self.assertEqual(tc["args"]["name"], "find_chores_matching_keywords")
        self.assertEqual(tc["args"]["params"]["p_keywords"], ["toy", "clutter sweep"])
        self.assertEqual(captured["payload"]["household_id"], "h")
        self.assertEqual(captured["user_id"], "u")

    async def test_returns_none_on_edge_exception(self):
        async def boom(payload, *, user_id):
            raise RuntimeError("network down")

        with patch.object(agent_main, "_edge_execute_tools", side_effect=boom):
            out = await _resolve_chore_match_ids_via_rpc(
                household_id="h", user_id="u", match_text="toy", bulk=True
            )
        self.assertIsNone(out)

    async def test_returns_none_when_rpc_not_ok(self):
        async def err(payload, *, user_id):
            return {"ok": False, "error": "missing perms"}

        with patch.object(agent_main, "_edge_execute_tools", side_effect=err):
            out = await _resolve_chore_match_ids_via_rpc(
                household_id="h", user_id="u", match_text="toy", bulk=True
            )
        self.assertIsNone(out)

    async def test_returns_empty_for_no_matches(self):
        async def empty(payload, *, user_id):
            return {"ok": True, "result": []}

        with patch.object(agent_main, "_edge_execute_tools", side_effect=empty):
            out = await _resolve_chore_match_ids_via_rpc(
                household_id="h", user_id="u", match_text="toy", bulk=True
            )
        self.assertEqual(out, [])

    async def test_handles_single_row_unwrapped_to_object(self):
        # Regression: the edge function unwraps single-row arrays into a
        # bare object before returning. We must accept both shapes.
        async def single(payload, *, user_id):
            return {
                "ok": True,
                "result": {"id": "ce06b072", "title": "Toy and clutter sweep", "match_score": 2},
            }

        with patch.object(agent_main, "_edge_execute_tools", side_effect=single):
            out = await _resolve_chore_match_ids_via_rpc(
                household_id="h", user_id="u", match_text="toy", bulk=True
            )
        self.assertEqual(out, [("ce06b072", "Toy and clutter sweep")])

    async def test_truncates_to_one_for_non_bulk(self):
        async def two(payload, *, user_id):
            return {
                "ok": True,
                "result": [
                    {"id": "id-1", "title": "First"},
                    {"id": "id-2", "title": "Second"},
                ],
            }

        with patch.object(agent_main, "_edge_execute_tools", side_effect=two):
            out = await _resolve_chore_match_ids_via_rpc(
                household_id="h", user_id="u", match_text="x", bulk=False
            )
        self.assertEqual(out, [("id-1", "First")])


class PendingConfirmationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        agent_main._pending_confirmations.clear()

    def test_is_confirmation_accepts_common_phrasings(self):
        for phrase in ["yes", "Yes", "y", "yep", "yeah", "sure", "ok",
                       "okay", "confirm", "proceed", "go ahead", "do it"]:
            self.assertTrue(_is_confirmation(phrase), phrase)

    def test_is_confirmation_rejects_non_yes(self):
        for phrase in ["", "maybe", "show me the chores", "no", "cancel", "what?"]:
            self.assertFalse(_is_confirmation(phrase), phrase)

    def test_is_cancellation_accepts_common_phrasings(self):
        for phrase in ["no", "No", "nope", "cancel", "stop", "abort",
                       "nevermind", "never mind", "don't", "do not"]:
            self.assertTrue(_is_cancellation(phrase), phrase)

    def test_match_ids_from_tool_calls_parses_reason(self):
        tcs = [
            {
                "tool": "db.update",
                "args": {"table": "chores", "id": "11111111-1111-1111-1111-111111111111", "patch": {"description": "x"}},
                "reason": "update: set description = \"x\" on 'Tidy Kids Room'",
            },
            {
                "tool": "db.update",
                "args": {"table": "chores", "id": "22222222-2222-2222-2222-222222222222", "patch": {"description": "x"}},
                "reason": "update: set description = \"x\" on 'Sweep Balcony'",
            },
            # Non-update tool call should be ignored.
            {"tool": "db.select", "args": {}, "reason": "noise"},
        ]
        out = _match_ids_from_tool_calls(tcs)
        self.assertEqual(
            out,
            [
                ("11111111-1111-1111-1111-111111111111", "Tidy Kids Room"),
                ("22222222-2222-2222-2222-222222222222", "Sweep Balcony"),
            ],
        )

    def _make_intent(self) -> ExtractedIntent:
        return ExtractedIntent(
            action="update",
            entity="chore",
            match_text="toy",
            match_field="title",
            update_field="description",
            update_value="arrange clothes",
            bulk=True,
            confidence=1.0,
        )

    async def test_stash_and_take_roundtrip(self):
        intent = self._make_intent()
        match_ids = [("id-1", "Chore A"), ("id-2", "Chore B")]
        tool_calls = [{"tool": "db.update", "args": {"id": "id-1"}, "reason": "on 'Chore A'"}]
        await _stash_pending_confirmation("conv-1", intent, match_ids, tool_calls)

        taken = await _take_pending_confirmation("conv-1")
        self.assertIsNotNone(taken)
        assert taken is not None
        self.assertEqual(taken.match_ids, match_ids)
        self.assertEqual(taken.tool_calls, tool_calls)
        self.assertEqual(taken.intent.match_text, "toy")

        # Second take returns None (the first take popped it).
        self.assertIsNone(await _take_pending_confirmation("conv-1"))

    async def test_take_returns_none_when_expired(self):
        import time
        intent = self._make_intent()
        await _stash_pending_confirmation("conv-exp", intent, [("id", "T")], [])
        # Force-expire the entry in place.
        agent_main._pending_confirmations["conv-exp"].expires_at = time.monotonic() - 1
        self.assertIsNone(await _take_pending_confirmation("conv-exp"))

    async def test_take_returns_none_without_conv_id(self):
        self.assertIsNone(await _take_pending_confirmation(""))

    def test_format_preview_includes_count_and_titles(self):
        intent = self._make_intent()
        match_ids = [("id-1", "Tidy Kids Room"), ("id-2", "Laundry declutter")]
        preview = _format_confirmation_preview(intent, match_ids)
        self.assertIn("2 chore(s)", preview)
        self.assertIn("Tidy Kids Room", preview)
        self.assertIn("Laundry declutter", preview)
        self.assertIn("arrange clothes", preview)
        self.assertIn("yes", preview.lower())
        self.assertIn("no", preview.lower())

    def test_format_preview_truncates_over_25(self):
        intent = self._make_intent()
        match_ids = [(f"id-{i}", f"Chore {i}") for i in range(30)]
        preview = _format_confirmation_preview(intent, match_ids)
        self.assertIn("30 chore(s)", preview)
        self.assertIn("and 5 more", preview)


class ChannelDispatcherTests(unittest.IsolatedAsyncioTestCase):
    """P1.0a: ChannelDispatcher chain walking + attempt persistence."""

    def _make_helper(self, chain=None):
        return {
            "id": "helper-test-1",
            "household_id": "hh-test-1",
            "name": "Test Helper",
            "phone": "9999999999",
            "preferred_language": "en",
            "channel_preferences": chain or ["voice", "whatsapp_tap", "sms"],
        }

    async def _collect(self):
        """Returns a (persist_fn, store) pair for recording attempts."""
        store: list[dict] = []

        async def persist(attempt):
            store.append({
                "channel": attempt.channel_used,
                "status": attempt.status,
                "failure_reason": attempt.failure_reason,
            })

        return persist, store

    async def test_first_channel_success_short_circuits(self):
        from channel_dispatcher import ChannelDispatcher, OutreachIntent
        from channel_adapters import DevNullAdapter

        persist, store = await self._collect()
        registry = {
            "voice": DevNullAdapter(),
            "whatsapp_tap": DevNullAdapter(always_fail=True, failure_kind="permanent"),
            "sms": DevNullAdapter(always_fail=True, failure_kind="permanent"),
        }
        dispatcher = ChannelDispatcher(adapters=registry, persist_attempt=persist)

        result = await dispatcher.initiate_outreach(
            helper=self._make_helper(),
            intent=OutreachIntent.STAGE2_ONBOARDING,
        )
        self.assertTrue(result.success)
        self.assertEqual(result.final_channel, "voice")
        # Only one attempt persisted — the rest of the chain was never tried.
        self.assertEqual(len(store), 1)
        self.assertEqual(store[0]["channel"], "voice")
        self.assertEqual(store[0]["status"], "completed")

    async def test_walks_chain_on_permanent_failures(self):
        from channel_dispatcher import ChannelDispatcher, OutreachIntent
        from channel_adapters import DevNullAdapter

        persist, store = await self._collect()
        registry = {
            "voice": DevNullAdapter(always_fail=True, failure_kind="permanent"),
            "whatsapp_tap": DevNullAdapter(always_fail=True, failure_kind="not_configured"),
            "sms": DevNullAdapter(),
        }
        dispatcher = ChannelDispatcher(adapters=registry, persist_attempt=persist)

        result = await dispatcher.initiate_outreach(
            helper=self._make_helper(),
            intent=OutreachIntent.STAGE2_ONBOARDING,
        )
        self.assertTrue(result.success)
        self.assertEqual(result.final_channel, "sms")
        # Three attempts: voice fails, whatsapp_tap fails, sms succeeds.
        self.assertEqual([a["channel"] for a in store], ["voice", "whatsapp_tap", "sms"])
        self.assertEqual(store[0]["status"], "failed")
        self.assertEqual(store[1]["status"], "failed")
        self.assertEqual(store[2]["status"], "completed")

    async def test_transient_failure_stops_chain_and_schedules_retry(self):
        from channel_dispatcher import ChannelDispatcher, OutreachIntent
        from channel_adapters import DevNullAdapter

        persist, store = await self._collect()
        registry = {
            "voice": DevNullAdapter(always_fail=True, failure_kind="transient"),
            "whatsapp_tap": DevNullAdapter(),  # would succeed if reached
            "sms": DevNullAdapter(),
        }
        dispatcher = ChannelDispatcher(adapters=registry, persist_attempt=persist)

        result = await dispatcher.initiate_outreach(
            helper=self._make_helper(),
            intent=OutreachIntent.STAGE2_ONBOARDING,
        )
        self.assertFalse(result.success)
        self.assertEqual(result.final_channel, "voice")
        self.assertIn("transient", result.final_reason or "")
        # Transient failure stops the walk — whatsapp_tap is NOT attempted.
        self.assertEqual(len(store), 1)
        self.assertEqual(store[0]["status"], "retry_scheduled")

    async def test_exhausts_all_channels_when_none_work(self):
        from channel_dispatcher import ChannelDispatcher, OutreachIntent
        from channel_adapters import DevNullAdapter

        persist, store = await self._collect()
        registry = {
            "voice": DevNullAdapter(always_fail=True, failure_kind="permanent"),
            "sms": DevNullAdapter(always_fail=True, failure_kind="helper_not_reachable"),
        }
        dispatcher = ChannelDispatcher(adapters=registry, persist_attempt=persist)

        result = await dispatcher.initiate_outreach(
            helper=self._make_helper(chain=["voice", "sms"]),
            intent=OutreachIntent.STAGE2_ONBOARDING,
        )
        self.assertFalse(result.success)
        self.assertEqual(result.final_reason, "all_channels_exhausted")
        self.assertEqual(len(store), 2)

    async def test_missing_adapter_for_channel_is_skipped_gracefully(self):
        from channel_dispatcher import ChannelDispatcher, OutreachIntent
        from channel_adapters import DevNullAdapter

        persist, store = await self._collect()
        registry = {
            "sms": DevNullAdapter(),
        }
        dispatcher = ChannelDispatcher(adapters=registry, persist_attempt=persist)

        # helper chain includes "voice" which has no adapter registered;
        # dispatcher should skip it and fall through to sms.
        result = await dispatcher.initiate_outreach(
            helper=self._make_helper(chain=["voice", "sms"]),
            intent=OutreachIntent.STAGE2_ONBOARDING,
        )
        self.assertTrue(result.success)
        self.assertEqual(result.final_channel, "sms")
        # Two attempts persisted — the voice "no adapter" failure + sms success.
        self.assertEqual(len(store), 2)
        self.assertEqual(store[0]["channel"], "voice")
        self.assertEqual(store[0]["status"], "failed")
        self.assertIn("no adapter registered", store[0]["failure_reason"] or "")

    async def test_empty_channel_preferences_defaults_to_voice(self):
        from channel_dispatcher import ChannelDispatcher, OutreachIntent
        from channel_adapters import DevNullAdapter

        persist, store = await self._collect()
        registry = {"voice": DevNullAdapter()}
        dispatcher = ChannelDispatcher(adapters=registry, persist_attempt=persist)

        result = await dispatcher.initiate_outreach(
            helper=self._make_helper(chain=[]),
            intent=OutreachIntent.REMINDER,
        )
        self.assertTrue(result.success)
        self.assertEqual(result.final_channel, "voice")

    async def test_adapter_exception_is_caught_and_recorded(self):
        from channel_dispatcher import ChannelDispatcher, OutreachIntent
        from channel_adapters import DevNullAdapter

        class ExplodingAdapter(DevNullAdapter):
            name = "voice"

            async def deliver(self, helper, intent, invite=None):
                raise RuntimeError("boom")

        persist, store = await self._collect()
        registry = {
            "voice": ExplodingAdapter(),
            "sms": DevNullAdapter(),
        }
        dispatcher = ChannelDispatcher(adapters=registry, persist_attempt=persist)

        # Exception should be treated as TRANSIENT → dispatcher stops, retry scheduled.
        result = await dispatcher.initiate_outreach(
            helper=self._make_helper(chain=["voice", "sms"]),
            intent=OutreachIntent.STAGE2_ONBOARDING,
        )
        self.assertFalse(result.success)
        self.assertEqual(result.final_channel, "voice")
        self.assertEqual(len(store), 1)
        self.assertEqual(store[0]["status"], "retry_scheduled")
        self.assertIn("boom", store[0]["failure_reason"] or "")


class ChannelAdapterConfigTests(unittest.IsolatedAsyncioTestCase):
    """P1.0a: adapters surface NOT_CONFIGURED when env vars are missing."""

    async def test_voice_adapter_not_configured_without_sarvam_key(self):
        from channel_adapters import VoiceAdapter
        from channel_dispatcher import FailureKind, OutreachIntent

        # Explicitly clear env so test is hermetic.
        with patch.dict(os.environ, {}, clear=False):
            for key in ("SARVAM_API_KEY", "TELEPHONY_PROVIDER"):
                os.environ.pop(key, None)
            adapter = VoiceAdapter()
            result = await adapter.deliver(
                helper={"id": "h", "phone": "999"},
                intent=OutreachIntent.STAGE2_ONBOARDING,
            )
        self.assertFalse(result.success)
        self.assertEqual(result.failure_kind, FailureKind.NOT_CONFIGURED)
        self.assertIn("SARVAM_API_KEY", result.failure_reason or "")

    async def test_voice_adapter_helper_without_phone(self):
        from channel_adapters import VoiceAdapter
        from channel_dispatcher import FailureKind, OutreachIntent

        with patch.dict(os.environ, {
            "SARVAM_API_KEY": "test",
            "TELEPHONY_PROVIDER": "twilio",
        }):
            adapter = VoiceAdapter()
            result = await adapter.deliver(
                helper={"id": "h", "phone": ""},
                intent=OutreachIntent.STAGE2_ONBOARDING,
            )
        self.assertFalse(result.success)
        self.assertEqual(result.failure_kind, FailureKind.HELPER_NOT_REACHABLE)

    async def test_whatsapp_tap_not_configured_without_creds(self):
        from channel_adapters import WhatsAppTapAdapter
        from channel_dispatcher import FailureKind, OutreachIntent

        with patch.dict(os.environ, {}, clear=False):
            for key in ("WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"):
                os.environ.pop(key, None)
            adapter = WhatsAppTapAdapter()
            result = await adapter.deliver(
                helper={"id": "h", "phone": "999"},
                intent=OutreachIntent.STAGE2_ONBOARDING,
            )
        self.assertFalse(result.success)
        self.assertEqual(result.failure_kind, FailureKind.NOT_CONFIGURED)

    async def test_sms_adapter_not_configured_without_provider(self):
        from channel_adapters import SMSAdapter
        from channel_dispatcher import FailureKind, OutreachIntent

        with patch.dict(os.environ, {}, clear=False):
            for key in ("SMS_PROVIDER", "SMS_API_KEY"):
                os.environ.pop(key, None)
            adapter = SMSAdapter()
            result = await adapter.deliver(
                helper={"id": "h", "phone": "999"},
                intent=OutreachIntent.REMINDER,
            )
        self.assertFalse(result.success)
        self.assertEqual(result.failure_kind, FailureKind.NOT_CONFIGURED)

    async def test_web_adapter_succeeds_when_invite_has_token(self):
        from channel_adapters import WebMagicLinkAdapter
        from channel_dispatcher import OutreachIntent

        adapter = WebMagicLinkAdapter()
        result = await adapter.deliver(
            helper={"id": "h"},
            intent=OutreachIntent.STAGE2_ONBOARDING,
            invite={"id": "inv1", "token": "tok_abc123def456"},
        )
        self.assertTrue(result.success)
        self.assertIn("magic_link_url", result.metadata)
        self.assertIn("tok_abc123def456", result.metadata["magic_link_url"])

    async def test_web_adapter_fails_without_invite_token(self):
        from channel_adapters import WebMagicLinkAdapter
        from channel_dispatcher import FailureKind, OutreachIntent

        adapter = WebMagicLinkAdapter()
        result = await adapter.deliver(
            helper={"id": "h"},
            intent=OutreachIntent.STAGE2_ONBOARDING,
            invite=None,
        )
        self.assertFalse(result.success)
        self.assertEqual(result.failure_kind, FailureKind.PERMANENT)


class VoiceDialogBrainTests(unittest.IsolatedAsyncioTestCase):
    """P1.0a: VoiceAdapter dialog manager parses Sarvam responses correctly."""

    async def test_parse_clean_json_response(self):
        from channel_adapters import VoiceAdapter

        raw = '{"speak": "Hi Sunita, is this a good time?", "expects_response": true, "consents_captured": {"id_verification": null, "vision_capture": null, "multi_household_coord": null, "call_recording": null}, "preferred_language": "en", "done": false}'
        parsed = VoiceAdapter._parse_dialog_turn(raw)
        self.assertEqual(parsed["speak"], "Hi Sunita, is this a good time?")
        self.assertTrue(parsed["expects_response"])
        self.assertFalse(parsed["done"])
        self.assertEqual(parsed["preferred_language"], "en")

    async def test_parse_json_wrapped_in_markdown_fence(self):
        from channel_adapters import VoiceAdapter

        raw = '```json\n{"speak": "Got it, thanks.", "expects_response": false, "done": true}\n```'
        parsed = VoiceAdapter._parse_dialog_turn(raw)
        self.assertEqual(parsed["speak"], "Got it, thanks.")
        self.assertFalse(parsed["expects_response"])
        self.assertTrue(parsed["done"])

    async def test_parse_json_with_preamble(self):
        from channel_adapters import VoiceAdapter

        raw = 'Here is the turn:\n{"speak": "Okay.", "done": true}'
        parsed = VoiceAdapter._parse_dialog_turn(raw)
        self.assertEqual(parsed["speak"], "Okay.")
        self.assertTrue(parsed["done"])

    async def test_parse_fallback_on_unparseable_response(self):
        from channel_adapters import VoiceAdapter

        raw = "This is not JSON at all, sorry."
        parsed = VoiceAdapter._parse_dialog_turn(raw)
        self.assertIn("didn't catch that", parsed["speak"])
        self.assertTrue(parsed["expects_response"])
        self.assertFalse(parsed["done"])

    async def test_run_dialog_turn_reuses_sarvam_chat(self):
        from channel_adapters import VoiceAdapter
        from channel_dispatcher import OutreachIntent

        call_log = []

        async def fake_sarvam_chat(*, messages, model, temperature, max_tokens):
            call_log.append({"messages": messages, "model": model})
            return '{"speak": "Hi there, may I ask a few questions?", "expects_response": true, "done": false}'

        adapter = VoiceAdapter(sarvam_chat_fn=fake_sarvam_chat)
        parsed = await adapter.run_dialog_turn(
            helper={"name": "Sunita", "preferred_language": "kn"},
            intent=OutreachIntent.STAGE2_ONBOARDING,
            transcript_so_far=[],
            latest_helper_utterance=None,
        )
        self.assertEqual(len(call_log), 1)
        self.assertEqual(parsed["speak"], "Hi there, may I ask a few questions?")
        # System prompt must mention voice-agent instructions.
        sys_msg = call_log[0]["messages"][0]
        self.assertEqual(sys_msg["role"], "system")
        self.assertIn("voice agent", sys_msg["content"].lower())

    async def test_run_dialog_turn_raises_without_sarvam_fn(self):
        from channel_adapters import VoiceAdapter
        from channel_dispatcher import OutreachIntent

        adapter = VoiceAdapter()  # no sarvam_chat_fn injected
        with self.assertRaises(RuntimeError):
            await adapter.run_dialog_turn(
                helper={"name": "x"},
                intent=OutreachIntent.STAGE2_ONBOARDING,
                transcript_so_far=[],
            )


if __name__ == "__main__":
    unittest.main()
