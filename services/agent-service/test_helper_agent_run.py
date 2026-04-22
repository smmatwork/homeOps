"""Unit tests for HelperAgent.run(ctx) — the new AgentContext-taking method
that returns an AgentResult. Covers the three output shapes
(clarifications, tool_calls, user_summary fallback) and the _invoke repair
retry path. The test_helper_agent.py suite covers is_intent + _parse_payload
already; this file extends with the new contract.
"""

import os
import sys
import unittest
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))

from agents.base import AgentContext, AgentResult
from agents.helper_agent import HelperAgent


def _make_ctx(messages: list[dict[str, Any]], *, model: str = "sarvam-m") -> AgentContext:
    async def _noop_chat(**_):
        return ""

    async def _noop_edge(*args, **kwargs):
        return {"ok": True}

    return AgentContext(
        messages=messages,
        model=model,
        temperature=0.0,
        max_tokens=512,
        req_id="",
        conv_id="c1",
        sess_id="",
        user_id="u1",
        household_id="h1",
        pending_key="c1",
        last_user_text=messages[-1].get("content", "") if messages else "",
        facts_section="",
        is_onboarding=False,
        chat_fn=_noop_chat,
        edge_execute_tools=_noop_edge,
        lf_span=lambda *a, **kw: None,
    )


def _make_agent(chat_fn) -> HelperAgent:
    """Build a HelperAgent that talks through the supplied chat_fn."""
    from orchestrator.parsing import (
        _extract_json_candidate,
        _safe_json_loads,
        _validate_tool_calls_list,
    )
    return HelperAgent(
        chat_fn=chat_fn,
        extract_json_candidate=_extract_json_candidate,
        safe_json_loads=_safe_json_loads,
        validate_tool_calls_list=_validate_tool_calls_list,
    )


class HelperAgentRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_clarifications_returned_as_markdown_text(self):
        async def fake_chat(**_):
            return (
                '{"clarifications": ['
                '{"key": "channel", "question": "Which channel?", '
                '"options": ["whatsapp", "sms"], "allowMultiple": false}'
                '], "tool_calls": [], "user_summary": ""}'
            )

        agent = _make_agent(fake_chat)
        result = await agent.run(_make_ctx([{"role": "user", "content": "Add helper"}]))
        self.assertIsInstance(result, AgentResult)
        self.assertEqual(result.kind, "text")
        self.assertIn("Which channel?", result.text or "")
        self.assertIn("whatsapp", result.text or "")
        self.assertIn("sms", result.text or "")

    async def test_tool_calls_returned_as_fenced_json_and_populated_field(self):
        async def fake_chat(**_):
            return (
                '{"clarifications": [], "tool_calls": ['
                '{"id": "tc1", "tool": "db.insert", "args": '
                '{"table": "helpers", "record": {"name": "Roopa"}}}'
                '], "user_summary": "Adding Roopa"}'
            )

        agent = _make_agent(fake_chat)
        result = await agent.run(_make_ctx([{"role": "user", "content": "add helper"}]))
        self.assertEqual(result.kind, "text")
        self.assertIsInstance(result.tool_calls, list)
        assert result.tool_calls is not None
        self.assertEqual(len(result.tool_calls), 1)
        self.assertEqual(result.tool_calls[0]["tool"], "db.insert")
        self.assertIn("```json", result.text or "")
        self.assertIn("db.insert", result.text or "")

    async def test_user_summary_fallback_when_no_clarifications_or_tool_calls(self):
        async def fake_chat(**_):
            return '{"clarifications": [], "tool_calls": [], "user_summary": "I can help with helpers"}'

        agent = _make_agent(fake_chat)
        result = await agent.run(_make_ctx([{"role": "user", "content": "hi"}]))
        self.assertEqual(result.kind, "text")
        self.assertEqual(result.text, "I can help with helpers")
        self.assertIsNone(result.tool_calls)

    async def test_empty_user_summary_falls_back_to_default(self):
        async def fake_chat(**_):
            return '{"clarifications": [], "tool_calls": [], "user_summary": ""}'

        agent = _make_agent(fake_chat)
        result = await agent.run(_make_ctx([{"role": "user", "content": "hi"}]))
        self.assertEqual(result.kind, "text")
        self.assertEqual(result.text, "What would you like to do?")

    async def test_unparseable_llm_output_returns_generic_prompt(self):
        async def fake_chat(**_):
            # Both the initial call and repair will return garbage.
            return "total nonsense no json here"

        agent = _make_agent(fake_chat)
        result = await agent.run(_make_ctx([{"role": "user", "content": "Anything"}]))
        self.assertEqual(result.kind, "text")
        self.assertIn("help manage helpers", (result.text or "").lower())

    async def test_repair_attempt_recovers_from_malformed_first_response(self):
        call_count = {"n": 0}

        async def fake_chat(**_):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return "garbage wrapping {not-json}"
            return '{"clarifications": [], "tool_calls": [], "user_summary": "Recovered"}'

        agent = _make_agent(fake_chat)
        result = await agent.run(_make_ctx([{"role": "user", "content": "foo"}]))
        self.assertEqual(result.kind, "text")
        self.assertEqual(result.text, "Recovered")
        self.assertEqual(call_count["n"], 2, "should call chat_fn twice: initial + repair")

    async def test_invariant_clarifications_and_tool_calls_cannot_both_be_present(self):
        # When the LLM violates the invariant, the parser rejects the payload
        # and falls back to the repair attempt (which still fails below),
        # ending in the generic text fallback.
        async def fake_chat(**_):
            return (
                '{"clarifications": [{"key": "a", "question": "?", "allowMultiple": false}], '
                '"tool_calls": [{"id": "t", "tool": "db.select", "args": {"table": "helpers"}}], '
                '"user_summary": ""}'
            )

        agent = _make_agent(fake_chat)
        result = await agent.run(_make_ctx([{"role": "user", "content": "x"}]))
        # The fallback message fires because _parse_payload returned None for
        # both the initial and the repair attempts.
        self.assertEqual(result.kind, "text")
        self.assertIn("help manage helpers", (result.text or "").lower())

    async def test_system_prompt_appended_to_existing_system_message(self):
        captured: dict[str, Any] = {}

        async def fake_chat(*, messages, **_):
            captured.setdefault("calls", []).append(list(messages))
            return '{"clarifications": [], "tool_calls": [], "user_summary": "ok"}'

        agent = _make_agent(fake_chat)
        messages = [
            {"role": "system", "content": "Base system prompt."},
            {"role": "user", "content": "Add helper"},
        ]
        await agent.run(_make_ctx(messages))
        first_call_msgs = captured["calls"][0]
        # First message should still be the system prompt with the Helper
        # Agent clause appended.
        self.assertEqual(first_call_msgs[0]["role"], "system")
        self.assertIn("Base system prompt", first_call_msgs[0]["content"])
        self.assertIn("Helper Agent", first_call_msgs[0]["content"])

    async def test_adds_system_prompt_when_none_exists(self):
        captured: dict[str, Any] = {}

        async def fake_chat(*, messages, **_):
            captured.setdefault("calls", []).append(list(messages))
            return '{"clarifications": [], "tool_calls": [], "user_summary": "ok"}'

        agent = _make_agent(fake_chat)
        messages = [{"role": "user", "content": "Add helper"}]
        await agent.run(_make_ctx(messages))
        first_call_msgs = captured["calls"][0]
        self.assertEqual(first_call_msgs[0]["role"], "system")
        self.assertIn("Helper Agent", first_call_msgs[0]["content"])


if __name__ == "__main__":
    unittest.main()
