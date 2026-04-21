"""Integration smoke tests for POST /v1/chat/respond.

These boot the FastAPI app via TestClient, mock the LLM and Edge-function
calls, and assert high-level response shapes for four control-flow branches:

  1. plain text reply (LLM fast-path, no tool calls)
  2. pending-confirmation "yes" replay (state-machine path)
  3. helper-agent route (HelperAgent.is_intent + HelperAgent.run)
  4. structured-extraction plan preview (chore domain, stash + preview)

Purpose: safety net for the in-flight router/chore-agent extraction. The
handler is 1770 lines of subtle state and has had zero end-to-end coverage
until now. Each subsequent refactor commit (router extraction, chore agent
extraction) must keep these four branches green.

Mock surface is kept minimal: _sarvam_chat, _edge_execute_tools, and
_build_facts_section are mocked. Regex parsers, intent classification,
state management, and response formatters run for real — they're what
we're validating.
"""

import asyncio
import os
import sys
import time
import unittest
from typing import Any
from unittest.mock import patch


# We seed env vars before `import main` for cases where no local .env exists
# (CI, fresh clones). But main.py calls load_dotenv(override=True) which means
# the repo's .env wins over whatever we set here. Rather than fight that, we
# read the resolved AGENT_SERVICE_KEY back out of the imported module below
# and feed it to the test headers — keeps tests working both locally and in
# CI without caring what's in .env.
os.environ.setdefault("AGENT_SERVICE_KEY", "test-agent-service-key")
os.environ.setdefault("SARVAM_API_KEY", "test-sarvam-key")
os.environ.setdefault("AGENT_SERVICE_DISABLE_EMBEDDINGS", "true")

sys.path.insert(0, os.path.dirname(__file__))

import main as agent_main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from orchestrator import state as orch_state  # noqa: E402
from orchestrator.intent import ExtractedIntent  # noqa: E402


_RESOLVED_AGENT_SERVICE_KEY = (agent_main.AGENT_SERVICE_KEY or "").strip()

_AUTH_HEADERS = {
    "x-agent-service-key": _RESOLVED_AGENT_SERVICE_KEY,
    "x-user-id": "00000000-0000-0000-0000-0000000000a1",
    "x-household-id": "00000000-0000-0000-0000-0000000000b1",
}


def _post_respond(
    client: TestClient,
    *,
    user_text: str,
    conversation_id: str,
    extra_messages: list[dict[str, Any]] | None = None,
) -> Any:
    """POST /v1/chat/respond with a minimal body + auth headers."""
    messages: list[dict[str, Any]] = list(extra_messages or [])
    messages.append({"role": "user", "content": user_text})
    headers = dict(_AUTH_HEADERS)
    headers["x-conversation-id"] = conversation_id
    return client.post(
        "/v1/chat/respond",
        headers=headers,
        json={
            "messages": messages,
            "model": "sarvam-m",
            "temperature": 0.0,
            "max_tokens": 256,
        },
    )


async def _fake_sarvam_final_text(*, messages, model, temperature, max_tokens):
    """Mock _sarvam_chat returning a strict-JSON final_text reply. The handler
    parses this shape when the response is expected to be a direct answer."""
    return '{"final_text": "Hello! How can I help you today?", "tool_calls": []}'


async def _fake_edge_noop(payload, *, user_id):
    """Mock _edge_execute_tools with a benign success response. Used for
    the confirmation-replay path where the handler executes stashed tool
    calls but we don't want to hit the real edge function."""
    return {"ok": True, "result": {"updated": True}}


async def _fake_build_facts_empty(household_id, user_id=""):
    """Mock FACTS to avoid Supabase REST calls in tests."""
    return ""


class ChatRespondAuthTests(unittest.TestCase):
    """Thin tests to pin down the auth envelope before we refactor it."""

    def setUp(self):
        self.client = TestClient(agent_main.app)

    def test_missing_auth_key_returns_403(self):
        res = self.client.post(
            "/v1/chat/respond",
            json={"messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(res.status_code, 403)

    def test_wrong_auth_key_returns_403(self):
        res = self.client.post(
            "/v1/chat/respond",
            headers={"x-agent-service-key": "not-the-right-key"},
            json={"messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(res.status_code, 403)


class ChatRespondPlainTextTests(unittest.TestCase):
    """Branch 1: plain text LLM reply, no tool calls, no pending state."""

    def setUp(self):
        self.client = TestClient(agent_main.app)
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()
        orch_state.clarification_counts.clear()

    def test_hi_returns_text_reply(self):
        conv_id = "test-conv-plaintext-1"
        with patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_edge_execute_tools", side_effect=_fake_edge_noop):
            res = _post_respond(self.client, user_text="hi there", conversation_id=conv_id)

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True, body)
        text = body.get("text")
        self.assertIsInstance(text, str)
        self.assertGreater(len(text or ""), 0, "expected a non-empty text reply")
        # No tool calls should have been emitted on this path.
        self.assertNotIn("tool_calls", body)


class ChatRespondConfirmationReplayTests(unittest.TestCase):
    """Branch 2: user replies "yes" to a previously-stashed plan preview.

    The handler should pop the pending confirmation, execute its tool_calls
    via the edge function, and return a success message. Exercises the
    most subtle part of the state machine.
    """

    def setUp(self):
        self.client = TestClient(agent_main.app)
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()
        orch_state.clarification_counts.clear()
        self.conv_id = "test-conv-confirm-1"

    def _stash_fake_confirmation(self) -> list[dict[str, Any]]:
        tool_calls = [
            {
                "id": "tc_fake_1",
                "tool": "db.update",
                "args": {
                    "table": "chores",
                    "id": "11111111-1111-1111-1111-111111111111",
                    "patch": {"description": "Tidy clothes"},
                },
                "reason": "update: set description = 'Tidy clothes' on 'Toy Sweep'",
            }
        ]
        orch_state.pending_confirmations[self.conv_id] = orch_state.PendingConfirmation(
            intent=ExtractedIntent(
                action="update",
                entity="chore",
                match_text="toy sweep",
                match_field="title",
                update_field="description",
                update_value="Tidy clothes",
                bulk=False,
                confidence=1.0,
            ),
            match_ids=[("11111111-1111-1111-1111-111111111111", "Toy Sweep")],
            tool_calls=tool_calls,
            expires_at=time.monotonic() + 60,
        )
        return tool_calls

    def test_yes_executes_stashed_tool_calls(self):
        stashed = self._stash_fake_confirmation()
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append({"payload": payload, "user_id": user_id})
            return {"ok": True, "result": {"updated": True}}

        with patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge):
            res = _post_respond(self.client, user_text="yes", conversation_id=self.conv_id)

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        # The stashed tool call must have been forwarded to the edge function.
        self.assertGreaterEqual(len(edge_calls), 1, "expected edge execution for stashed tool_calls")
        forwarded = edge_calls[0]["payload"].get("tool_call") or {}
        self.assertEqual(forwarded.get("tool"), "db.update")
        self.assertEqual(forwarded.get("args", {}).get("id"), stashed[0]["args"]["id"])
        # Confirmation must be consumed (take semantics).
        self.assertNotIn(self.conv_id, orch_state.pending_confirmations)


class ChatRespondHelperRouteTests(unittest.TestCase):
    """Branch 3: helper-management message routes to HelperAgent and the
    handler returns the agent's payload verbatim (modulo response envelope).
    """

    def setUp(self):
        self.client = TestClient(agent_main.app)
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()
        orch_state.clarification_counts.clear()

    def test_add_helper_routes_to_helper_agent(self):
        # Reset lazy singleton so our patch takes effect.
        agent_main._helper_agent_instance = None

        captured_calls: list[dict[str, Any]] = []

        async def fake_helper_run(*, messages, model, temperature, max_tokens):
            captured_calls.append({"messages": messages, "model": model})
            return {
                "clarifications": [],
                "tool_calls": [
                    {
                        "id": "tc_helper_1",
                        "tool": "db.insert",
                        "args": {"table": "helpers", "record": {"name": "Sunita", "type": "cleaner"}},
                        "reason": "Create helper Sunita",
                    }
                ],
                "user_summary": "I'll add Sunita as a cleaner.",
            }

        conv_id = "test-conv-helper-1"
        with patch("agents.helper_agent.HelperAgent.run", side_effect=fake_helper_run), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text), \
             patch.object(agent_main, "_edge_execute_tools", side_effect=_fake_edge_noop):
            res = _post_respond(
                self.client,
                user_text="Add a new cleaner named Sunita",
                conversation_id=conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(len(captured_calls), 1, "HelperAgent.run must be invoked exactly once")
        body = res.json()
        self.assertIs(body.get("ok"), True)
        # Helper agent output is surfaced via either tool_calls or text; shape
        # is intentionally loose so the router/helper contract can evolve.
        self.assertTrue(
            body.get("tool_calls") or body.get("text") or body.get("user_summary"),
            f"expected a helper-agent payload in response, got {body}",
        )


class ChatRespondPlanPreviewTests(unittest.TestCase):
    """Branch 4: update phrasing → structured extraction → _intent_to_tool_calls
    returns tool calls → handler stashes a confirmation and returns a preview.

    This exercises the "deterministic plan-confirm-execute" path that's the
    heart of the chore agent and the primary source of safety against
    confidently-wrong LLM actions.
    """

    def setUp(self):
        self.client = TestClient(agent_main.app)
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()
        orch_state.clarification_counts.clear()
        self.conv_id = "test-conv-preview-1"

    def test_update_description_shows_preview_and_stashes(self):
        async def fake_intent_to_tool_calls(intent, facts_section, *, household_id, user_id):
            return [
                {
                    "id": "tc_update_1",
                    "tool": "db.update",
                    "args": {
                        "table": "chores",
                        "id": "22222222-2222-2222-2222-222222222222",
                        "patch": {"description": "Arrange clothes or books"},
                    },
                    "reason": "update: set description = 'Arrange clothes or books' on 'Toy Sweep'",
                }
            ]

        with patch.object(agent_main, "_intent_to_tool_calls", side_effect=fake_intent_to_tool_calls), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text), \
             patch.object(agent_main, "_edge_execute_tools", side_effect=_fake_edge_noop):
            res = _post_respond(
                self.client,
                user_text="Change the description of toy sweep to 'Arrange clothes or books'",
                conversation_id=self.conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        text = body.get("text") or ""
        # Preview text must prompt for confirmation; exact wording is owned
        # by _format_plan_preview and may evolve, so match loosely.
        self.assertRegex(text.lower(), r"\byes\b", "preview text should instruct user to reply yes")
        self.assertRegex(text.lower(), r"\b(no|cancel)\b", "preview text should include a cancel option")
        # The confirmation must have been stashed for the subsequent "yes" turn.
        self.assertIn(
            self.conv_id,
            orch_state.pending_confirmations,
            "handler should stash a PendingConfirmation keyed by conversation_id",
        )


if __name__ == "__main__":
    unittest.main()
