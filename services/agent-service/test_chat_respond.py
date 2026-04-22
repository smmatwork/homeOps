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


class ChatRespondAnalyticsShortcutTests(unittest.TestCase):
    """Commit 6a: the "How many unassigned chores?" deterministic shortcut
    now dispatches through ChoreAgent.try_analytics_shortcut() before
    falling through to the legacy chain. Verifies: the shortcut fires for
    the right user text, the edge function is called with the
    count_chores RPC shape, and the response text matches the preserved
    legacy wording ("Total unassigned tasks: N.")."""

    def setUp(self):
        self.client = TestClient(agent_main.app)
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()
        orch_state.clarification_counts.clear()
        # Reset the lazy ChoreAgent singleton so mocks take effect even if
        # a previous test created it with an unpatched edge function.
        agent_main._chore_agent_instance = None

    def test_unassigned_count_routes_through_chore_agent(self):
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {"ok": True, "result": {"chore_count": 7}}

        conv_id = "test-conv-analytics-unassigned"
        with patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="How many unassigned chores are there?",
                conversation_id=conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        # Wording preserved byte-for-byte from the pre-migration handler.
        self.assertEqual(body.get("text"), "Total unassigned tasks: 7.")
        # The count_chores RPC was called with the unassigned=True filter.
        self.assertEqual(len(edge_calls), 1, "expected exactly one edge call for the shortcut")
        tc = edge_calls[0].get("tool_call") or {}
        self.assertEqual(tc.get("tool"), "query.rpc")
        self.assertEqual(tc.get("args", {}).get("name"), "count_chores")
        self.assertEqual(
            tc.get("args", {}).get("params", {}).get("p_filters", {}).get("unassigned"),
            True,
        )

    def test_status_breakdown_routes_through_chore_agent(self):
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {
                "ok": True,
                "result": {"result": [
                    {"status": "pending", "count": 4},
                    {"status": "completed", "count": 2},
                ]},
            }

        conv_id = "test-conv-analytics-status"
        with patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="show chores by status breakdown",
                conversation_id=conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        text = body.get("text") or ""
        self.assertIn("Chores by status", text)
        self.assertIn("- pending: 4", text)
        self.assertIn("- completed: 2", text)
        self.assertEqual(len(edge_calls), 1)
        tc = edge_calls[0].get("tool_call") or {}
        self.assertEqual(tc.get("args", {}).get("name"), "group_chores_by_status")

    def test_assignee_breakdown_routes_through_chore_agent(self):
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {
                "ok": True,
                "result": {"result": [
                    {"helper_name": "Rajesh", "count": 3},
                    {"helper_name": "Sunita", "count": 5},
                ]},
            }

        conv_id = "test-conv-analytics-assignee"
        with patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="show chores by helper",
                conversation_id=conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        text = body.get("text") or ""
        self.assertIn("Chores by assignee", text)
        self.assertIn("- Rajesh: 3", text)
        self.assertIn("- Sunita: 5", text)
        self.assertEqual(len(edge_calls), 1)
        tc = edge_calls[0].get("tool_call") or {}
        self.assertEqual(tc.get("args", {}).get("name"), "group_chores_by_assignee")

    def test_space_list_routes_through_chore_agent(self):
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {
                "ok": True,
                "result": {
                    "result": [
                        {"title": "Clean kitchen", "status": "pending"},
                        {"title": "Mop kitchen floor", "status": "completed"},
                    ]
                },
            }

        conv_id = "test-conv-analytics-spacelist"
        with patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="What chores do I have in Kitchen?",
                conversation_id=conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        text = body.get("text") or ""
        self.assertIn("Chores in Kitchen", text)
        self.assertIn("- Clean kitchen [pending]", text)
        self.assertIn("- Mop kitchen floor [completed]", text)
        self.assertEqual(len(edge_calls), 1)
        tc = edge_calls[0].get("tool_call") or {}
        self.assertEqual(tc.get("args", {}).get("name"), "list_chores_enriched")
        self.assertEqual(
            tc.get("args", {}).get("params", {}).get("p_filters", {}).get("space_query"),
            "Kitchen",
        )

    def test_list_assigned_to_name_routes_through_chore_agent(self):
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {
                "ok": True,
                "result": {
                    "match_type": "unique",
                    "result": [
                        {"title": "Mop kitchen", "status": "pending", "space": "Kitchen"},
                    ],
                },
            }

        conv_id = "test-conv-analytics-listassigned"
        with patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="what chores are assigned to Sunita",
                conversation_id=conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        text = body.get("text") or ""
        self.assertIn("Here are the chores assigned to Sunita", text)
        self.assertIn("- Mop kitchen [pending]", text)
        self.assertEqual(len(edge_calls), 1)
        tc = edge_calls[0].get("tool_call") or {}
        self.assertEqual(tc.get("args", {}).get("name"), "list_chores_enriched")
        self.assertEqual(
            tc.get("args", {}).get("params", {}).get("p_filters", {}).get("helper_query"),
            "Sunita",
        )

    def test_count_assigned_to_name_unique_match(self):
        async def edge(payload, *, user_id):
            return {
                "ok": True,
                "result": [{"match_type": "unique", "chore_count": 3, "helper_name": "Rajesh"}],
            }

        with patch.object(agent_main, "_edge_execute_tools", side_effect=edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="how many chores are assigned to Rajesh?",
                conversation_id="test-conv-count-unique",
            )

        body = res.json()
        self.assertEqual(body.get("text"), "There are 3 chores assigned to Rajesh.")

    def test_count_assigned_to_name_none_match(self):
        async def edge(payload, *, user_id):
            return {"ok": True, "result": [{"match_type": "none"}]}

        with patch.object(agent_main, "_edge_execute_tools", side_effect=edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="how many chores are assigned to Ghost?",
                conversation_id="test-conv-count-none",
            )

        body = res.json()
        self.assertIn("couldn't find a helper named 'Ghost'", body.get("text") or "")

    def test_count_assigned_to_name_ambiguous_match(self):
        async def edge(payload, *, user_id):
            return {
                "ok": True,
                "result": [{
                    "match_type": "ambiguous",
                    "candidates": ["Raj", "Rajiv", "Rajesh"],
                }],
            }

        with patch.object(agent_main, "_edge_execute_tools", side_effect=edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="how many chores are assigned to Raj?",
                conversation_id="test-conv-count-ambig",
            )

        body = res.json()
        text = body.get("text") or ""
        self.assertIn("multiple helpers matching 'Raj'", text)
        self.assertIn("Raj, Rajiv, Rajesh", text)

    def test_list_assigned_to_name_none_helper_message(self):
        """Branch: match_type == 'none_helper' — handler returns a
        'couldn't find a helper matching' message verbatim."""

        async def empty_edge(payload, *, user_id):
            return {"ok": True, "result": {"match_type": "none_helper", "result": []}}

        with patch.object(agent_main, "_edge_execute_tools", side_effect=empty_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="what chores are assigned to NoSuchPerson",
                conversation_id="test-conv-analytics-nohelper",
            )

        body = res.json()
        self.assertIn("couldn't find a helper matching 'NoSuchPerson'", body.get("text") or "")

    def test_total_pending_count_routes_through_chore_agent(self):
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {"ok": True, "result": {"chore_count": 12}}

        conv_id = "test-conv-analytics-pending"
        with patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(
                self.client,
                user_text="What's the total number of pending chores?",
                conversation_id=conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        self.assertEqual(body.get("text"), "Total pending tasks: 12.")
        self.assertEqual(len(edge_calls), 1)
        tc = edge_calls[0].get("tool_call") or {}
        self.assertEqual(tc.get("args", {}).get("name"), "count_chores")
        self.assertEqual(
            tc.get("args", {}).get("params", {}).get("p_filters", {}).get("status"),
            "pending",
        )


class ChatRespondSummarizerPathTests(unittest.TestCase):
    """Gap 1: exercise summarize_history_if_needed under char-budget pressure.

    The handler calls orchestrator.context.summarize_history_if_needed before
    the main LLM turn. If the accumulated conversation exceeds
    SARVAM_PROMPT_CHAR_BUDGET (default 17000) AND a conversation_id is
    provided, the summarizer fires: one Sarvam call to fold old turns into
    a rolling summary, then the main turn proceeds with a smaller prompt.

    The chat_fn is passed by reference from main.py to the context module at
    call time, so patching main._sarvam_chat intercepts both the summarizer
    LLM and the main LLM turns. We assert at least two calls and that the
    first one carries the summarizer-flavored system prompt.
    """

    def setUp(self):
        self.client = TestClient(agent_main.app)
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()
        orch_state.clarification_counts.clear()
        # Summary cache is per-conversation; wipe so each test starts fresh.
        from orchestrator.context import summary_cache
        summary_cache.clear()

    def test_long_history_triggers_summarizer_llm_call(self):
        # Build messages well over the 17k char budget: one big system prompt
        # plus six alternating user/assistant turns of ~3k chars each.
        big_block = "x" * 3000
        history: list[dict[str, Any]] = [
            {"role": "system", "content": "You are a helpful assistant. " + ("y" * 2500)},
            {"role": "user", "content": "old request 1: " + big_block},
            {"role": "assistant", "content": "old reply 1: " + big_block},
            {"role": "user", "content": "old request 2: " + big_block},
            {"role": "assistant", "content": "old reply 2: " + big_block},
            {"role": "user", "content": "old request 3: " + big_block},
            {"role": "assistant", "content": "old reply 3: " + big_block},
        ]

        call_log: list[dict[str, Any]] = []

        async def counting_sarvam(*, messages, model, temperature, max_tokens):
            call_log.append({"messages": messages, "model": model, "temperature": temperature})
            # Return summarizer-shaped text if we detect the summarizer prompt,
            # otherwise return a final_text envelope.
            sys0 = messages[0].get("content", "") if messages else ""
            if "summarizing a conversation" in sys0.lower():
                return "User asked a few questions about household management."
            return '{"final_text": "Acknowledged.", "tool_calls": []}'

        conv_id = "test-conv-summarizer-1"
        with patch.object(agent_main, "_sarvam_chat", side_effect=counting_sarvam), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_edge_execute_tools", side_effect=_fake_edge_noop):
            res = _post_respond(
                self.client,
                user_text="latest question after a lot of history",
                conversation_id=conv_id,
                extra_messages=history,
            )

        self.assertEqual(res.status_code, 200, res.text)
        self.assertGreaterEqual(
            len(call_log),
            2,
            f"expected >=2 Sarvam calls (summarizer + main), got {len(call_log)}",
        )
        # First call should be the summarizer — its system prompt mentions summarization.
        summarizer_calls = [
            c for c in call_log
            if c["messages"] and "summarizing a conversation" in c["messages"][0].get("content", "").lower()
        ]
        self.assertGreaterEqual(
            len(summarizer_calls),
            1,
            "expected at least one summarizer-shaped Sarvam call",
        )


class ChatRespondClarificationRoundtripTests(unittest.TestCase):
    """Gap 2: user's freeform reply is substituted into the original failed
    match_text, and a fresh plan-preview is stashed for the substituted intent.

    This state-machine path is subtle: when a previous turn asked "which
    bathroom?" and stashed a PendingClarification, the next user message is
    treated as the clarification value (not a new request). The handler
    substitutes it into every original intent whose match_text matches the
    recorded failed term, re-runs _intent_to_tool_calls, and stashes the
    resulting plan as a new PendingConfirmation.
    """

    def setUp(self):
        self.client = TestClient(agent_main.app)
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()
        orch_state.clarification_counts.clear()
        self.conv_id = "test-conv-clarify-1"

    def _stash_clarification(self) -> ExtractedIntent:
        original = ExtractedIntent(
            action="update",
            entity="chore",
            match_text="bathroom",  # ambiguous — multiple matches in household
            match_field="space",
            update_field="cadence",
            update_value="weekly",
            bulk=True,
            confidence=1.0,
        )
        orch_state.pending_clarifications[self.conv_id] = orch_state.PendingClarification(
            original_intents=[original],
            failed_match_text="bathroom",
            question_type="space_not_found",
            expires_at=time.monotonic() + 60,
        )
        return original

    def test_clarification_reply_substitutes_and_stashes_new_preview(self):
        self._stash_clarification()
        substitution_seen: list[str] = []

        async def fake_intent_to_tool_calls(intent, facts_section, *, household_id, user_id):
            # Capture what match_text the handler used after substitution.
            substitution_seen.append(intent.match_text)
            return [
                {
                    "id": "tc_post_clar_1",
                    "tool": "db.update",
                    "args": {
                        "table": "chores",
                        "id": "33333333-3333-3333-3333-333333333333",
                        "patch": {"cadence": "weekly"},
                    },
                    "reason": "update: set cadence = 'weekly' on 'Mop Guest Bathroom'",
                }
            ]

        with patch.object(agent_main, "_intent_to_tool_calls", side_effect=fake_intent_to_tool_calls), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text), \
             patch.object(agent_main, "_edge_execute_tools", side_effect=_fake_edge_noop):
            res = _post_respond(
                self.client,
                user_text="guest bathroom",
                conversation_id=self.conv_id,
            )

        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(
            substitution_seen,
            ["guest bathroom"],
            "handler must substitute the user's reply into the failed match_text",
        )
        # Clarification has been consumed (take semantics).
        self.assertNotIn(self.conv_id, orch_state.pending_clarifications)
        # A fresh confirmation must be stashed for the substituted intent.
        self.assertIn(
            self.conv_id,
            orch_state.pending_confirmations,
            "handler should stash a new PendingConfirmation after substitution",
        )
        stashed = orch_state.pending_confirmations[self.conv_id]
        self.assertEqual(stashed.intent.match_text, "guest bathroom")
        # Response must be a plan preview, not executed yet.
        body = res.json()
        self.assertIs(body.get("ok"), True)
        text = body.get("text") or ""
        self.assertRegex(text.lower(), r"\byes\b")


class ChatRespondSyncFollowupTests(unittest.TestCase):
    """Gap 3: the sync-followup confirmation branch in the pending-confirmation
    state machine. After a description update succeeds, the handler may offer
    to mirror the new value into the title (or vice versa). That stash sets
    `sync_field` and branches on the user's reply: yes/no/freeform.
    """

    def setUp(self):
        self.client = TestClient(agent_main.app)
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()
        orch_state.clarification_counts.clear()
        self.conv_id = "test-conv-sync-1"
        self.chore_id = "44444444-4444-4444-4444-444444444444"

    def _stash_sync(self) -> list[dict[str, Any]]:
        tool_calls = [
            {
                "id": "tc_sync_pre_1",
                "tool": "db.update",
                "args": {
                    "table": "chores",
                    "id": self.chore_id,
                    "patch": {"title": "Arrange clothes or books"},
                },
                "reason": "sync mirror: set title to match description",
            }
        ]
        orch_state.pending_confirmations[self.conv_id] = orch_state.PendingConfirmation(
            intent=ExtractedIntent(
                action="update",
                entity="chore",
                match_text="toy sweep",
                match_field="title",
                update_field="description",
                update_value="Arrange clothes or books",
                bulk=False,
                confidence=1.0,
            ),
            match_ids=[(self.chore_id, "Toy Sweep")],
            tool_calls=tool_calls,
            expires_at=time.monotonic() + 60,
            sync_field="title",
            sync_chore_ids=[self.chore_id],
            sync_default_value="Arrange clothes or books",
        )
        return tool_calls

    def test_sync_yes_executes_stashed_mirror(self):
        stashed = self._stash_sync()
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {"ok": True, "result": {"updated": True}}

        with patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(self.client, user_text="yes", conversation_id=self.conv_id)

        self.assertEqual(res.status_code, 200, res.text)
        # The precomputed mirror update must have been sent to the edge.
        self.assertGreaterEqual(len(edge_calls), 1, "expected edge call for sync mirror")
        forwarded = edge_calls[0].get("tool_call") or {}
        self.assertEqual(forwarded.get("tool"), "db.update")
        self.assertEqual(forwarded.get("args", {}).get("id"), stashed[0]["args"]["id"])
        self.assertEqual(forwarded.get("args", {}).get("patch", {}).get("title"), "Arrange clothes or books")
        # Response must confirm the sync happened.
        body = res.json()
        self.assertIs(body.get("ok"), True)
        self.assertIn("title", (body.get("text") or "").lower())

    def test_sync_no_cancels_without_edge_call(self):
        self._stash_sync()

        async def edge_must_not_fire(payload, *, user_id):
            raise AssertionError("edge_execute_tools must NOT fire on cancellation")

        with patch.object(agent_main, "_edge_execute_tools", side_effect=edge_must_not_fire), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(self.client, user_text="no", conversation_id=self.conv_id)

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIs(body.get("ok"), True)
        text = (body.get("text") or "").lower()
        self.assertIn("title", text)
        self.assertIn("as-is", text)

    def test_sync_freeform_uses_reply_as_new_value(self):
        self._stash_sync()
        edge_calls: list[dict[str, Any]] = []

        async def capture_edge(payload, *, user_id):
            edge_calls.append(payload)
            return {"ok": True, "result": {"updated": True}}

        freeform_reply = "Mop the floors"
        with patch.object(agent_main, "_edge_execute_tools", side_effect=capture_edge), \
             patch.object(agent_main, "_build_facts_section", side_effect=_fake_build_facts_empty), \
             patch.object(agent_main, "_sarvam_chat", side_effect=_fake_sarvam_final_text):
            res = _post_respond(self.client, user_text=freeform_reply, conversation_id=self.conv_id)

        self.assertEqual(res.status_code, 200, res.text)
        self.assertGreaterEqual(len(edge_calls), 1, "expected freeform-sync edge call")
        forwarded = edge_calls[0].get("tool_call") or {}
        self.assertEqual(forwarded.get("tool"), "db.update")
        self.assertEqual(forwarded.get("args", {}).get("id"), self.chore_id)
        self.assertEqual(
            forwarded.get("args", {}).get("patch", {}).get("title"),
            freeform_reply,
            "freeform reply must be used verbatim as the new sync_field value",
        )


if __name__ == "__main__":
    unittest.main()
