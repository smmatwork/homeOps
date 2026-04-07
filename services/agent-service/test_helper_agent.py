import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from main import (
    _extract_assignment_suggestions,
    _extract_assign_or_create_chore,
    _extract_complete_chore_by_query,
    _extract_reassign_or_unassign_chore,
    _is_helper_intent,
    _parse_helper_agent_payload,
)


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


if __name__ == "__main__":
    unittest.main()
