"""Unit tests for orchestrator/state.py's pluggable pending store.

Two backends live behind the same async interface:

  - InProcessPendingStore: module-level dicts (default)
  - SupabasePendingStore: calls agent_stash_* / agent_take_* RPCs via REST

Tests here cover:
  - InProcessPendingStore round-trip + TTL + empty-conv-id rejection
  - SupabasePendingStore via a fake httpx transport (no real network)
  - _build_default_store env-var selection + fallback when Supabase creds
    are missing
  - _intent_from_jsonb round-trip
  - _first_row shape normalization
  - Module-level async API delegates to the active store
"""

import os
import sys
import time
import unittest
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import httpx

from orchestrator import state as orch_state
from orchestrator.intent import ExtractedIntent
from orchestrator.state import (
    InProcessPendingStore,
    PendingClarification,
    PendingConfirmation,
    SupabasePendingStore,
    _build_default_store,
    _first_row,
    _intent_from_jsonb,
    use_in_process_store_for_tests,
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


class InProcessPendingStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        orch_state.pending_confirmations.clear()
        orch_state.pending_clarifications.clear()

    async def test_stash_take_confirmation_roundtrip(self):
        store = InProcessPendingStore()
        await store.stash_confirmation("c1", _intent(), [("id1", "T")], [{"tool": "db.update"}])
        taken = await store.take_confirmation("c1")
        self.assertIsNotNone(taken)
        assert taken is not None
        self.assertEqual(taken.match_ids, [("id1", "T")])
        self.assertEqual(taken.tool_calls, [{"tool": "db.update"}])

    async def test_take_confirmation_after_pop_returns_none(self):
        store = InProcessPendingStore()
        await store.stash_confirmation("c1", _intent(), [], [])
        await store.take_confirmation("c1")
        # Second take: gone.
        self.assertIsNone(await store.take_confirmation("c1"))

    async def test_take_confirmation_respects_ttl(self):
        store = InProcessPendingStore()
        await store.stash_confirmation("c2", _intent(), [], [])
        orch_state.pending_confirmations["c2"].expires_at = time.monotonic() - 1
        self.assertIsNone(await store.take_confirmation("c2"))

    async def test_take_confirmation_empty_conv_id(self):
        store = InProcessPendingStore()
        self.assertIsNone(await store.take_confirmation(""))

    async def test_clear_confirmation_is_idempotent(self):
        store = InProcessPendingStore()
        await store.clear_confirmation("no-such-conv")  # must not raise
        await store.stash_confirmation("c3", _intent(), [], [])
        await store.clear_confirmation("c3")
        self.assertIsNone(await store.take_confirmation("c3"))

    async def test_stash_take_clarification_roundtrip(self):
        store = InProcessPendingStore()
        await store.stash_clarification("c1", [_intent()], "foo", "space_not_found")
        taken = await store.take_clarification("c1")
        self.assertIsNotNone(taken)
        assert taken is not None
        self.assertEqual(taken.failed_match_text, "foo")
        self.assertEqual(taken.question_type, "space_not_found")

    async def test_take_clarification_after_pop_returns_none(self):
        store = InProcessPendingStore()
        await store.stash_clarification("c1", [_intent()], "x", "y")
        await store.take_clarification("c1")
        self.assertIsNone(await store.take_clarification("c1"))


class SupabasePendingStoreTests(unittest.IsolatedAsyncioTestCase):
    """Drive SupabasePendingStore against a fake httpx transport so no
    real Supabase hits. We assert payload shape, hydration, and graceful
    failure handling.
    """

    def _make_store(self, transport: httpx.MockTransport) -> SupabasePendingStore:
        store = SupabasePendingStore(base_url="https://fake.supabase.co", service_key="sk")
        # Monkeypatch httpx.AsyncClient constructor to pin the transport.
        # We do this through `store._rpc` by patching httpx.AsyncClient at
        # the module level.
        return store

    async def test_stash_confirmation_sends_rpc_payload(self):
        captured: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["headers"] = dict(request.headers)
            captured["json"] = json_from(request)
            return httpx.Response(200, json=None)

        transport = httpx.MockTransport(handler)
        _real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient", lambda *a, **kw: _real_client(transport=transport)):
            store = self._make_store(transport)
            await store.stash_confirmation(
                "c1",
                _intent(match_text="bath"),
                [("id1", "Bath")],
                [{"tool": "db.update", "args": {}}],
            )

        self.assertIn("agent_stash_confirmation", captured["url"])
        self.assertEqual(captured["headers"]["authorization"], "Bearer sk")
        body = captured["json"]
        self.assertEqual(body["p_conversation_id"], "c1")
        self.assertEqual(body["p_intent"]["match_text"], "bath")
        self.assertEqual(body["p_match_ids"], [["id1", "Bath"]])
        self.assertEqual(len(body["p_tool_calls"]), 1)

    async def test_take_confirmation_hydrates_row(self):
        row = {
            "intent": {
                "action": "update", "entity": "chore", "match_text": "k",
                "match_field": None, "update_field": "description",
                "update_value": "X", "bulk": False, "confidence": 0.9,
            },
            "match_ids": [["id1", "Kitchen"]],
            "tool_calls": [{"tool": "db.update"}],
            "sync_field": None,
            "sync_chore_ids": None,
            "sync_default_value": None,
        }

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[row])

        transport = httpx.MockTransport(handler)
        _real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient", lambda *a, **kw: _real_client(transport=transport)):
            store = self._make_store(transport)
            taken = await store.take_confirmation("c1")

        self.assertIsNotNone(taken)
        assert taken is not None
        self.assertEqual(taken.match_ids, [("id1", "Kitchen")])
        self.assertEqual(taken.tool_calls, [{"tool": "db.update"}])
        self.assertEqual(taken.intent.match_text, "k")

    async def test_take_confirmation_empty_result(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[])

        transport = httpx.MockTransport(handler)
        _real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient", lambda *a, **kw: _real_client(transport=transport)):
            store = self._make_store(transport)
            self.assertIsNone(await store.take_confirmation("c1"))

    async def test_take_confirmation_on_5xx_returns_none(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="unavailable")

        transport = httpx.MockTransport(handler)
        _real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient", lambda *a, **kw: _real_client(transport=transport)):
            store = self._make_store(transport)
            self.assertIsNone(await store.take_confirmation("c1"))

    async def test_stash_clarification_sends_rpc_payload(self):
        captured: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["json"] = json_from(request)
            return httpx.Response(200, json=None)

        transport = httpx.MockTransport(handler)
        _real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient", lambda *a, **kw: _real_client(transport=transport)):
            store = self._make_store(transport)
            await store.stash_clarification("c1", [_intent()], "bath", "space_not_found")

        self.assertIn("agent_stash_clarification", captured["url"])
        body = captured["json"]
        self.assertEqual(body["p_failed_match_text"], "bath")
        self.assertEqual(body["p_question_type"], "space_not_found")
        self.assertEqual(len(body["p_original_intents"]), 1)

    async def test_take_clarification_hydrates_row(self):
        row = {
            "original_intents": [{
                "action": "update", "entity": "chore", "match_text": "bath",
                "match_field": None, "update_field": None, "update_value": None,
                "bulk": False, "confidence": 0.9,
            }],
            "failed_match_text": "bath",
            "question_type": "space_not_found",
        }

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[row])

        transport = httpx.MockTransport(handler)
        _real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient", lambda *a, **kw: _real_client(transport=transport)):
            store = self._make_store(transport)
            taken = await store.take_clarification("c1")

        self.assertIsNotNone(taken)
        assert taken is not None
        self.assertEqual(taken.failed_match_text, "bath")
        self.assertEqual(len(taken.original_intents), 1)

    async def test_empty_conv_id_no_http_calls(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=None)

        transport = httpx.MockTransport(handler)
        _real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient", lambda *a, **kw: _real_client(transport=transport)):
            store = self._make_store(transport)
            await store.stash_confirmation("", _intent(), [], [])
            await store.clear_confirmation("")
            self.assertIsNone(await store.take_confirmation(""))
            self.assertIsNone(await store.take_clarification(""))
            await store.stash_clarification("", [_intent()], "x", "y")
        self.assertEqual(calls["n"], 0)


def json_from(request: httpx.Request) -> Any:
    import json
    return json.loads(request.content.decode("utf-8"))


class BuildDefaultStoreTests(unittest.TestCase):
    def setUp(self):
        # Save + clear any env contamination from other tests.
        self._saved = {
            k: os.environ.get(k)
            for k in ("AGENT_PENDING_STORE", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY")
        }
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_default_is_in_process(self):
        store = _build_default_store()
        self.assertIsInstance(store, InProcessPendingStore)

    def test_memory_alias_is_in_process(self):
        os.environ["AGENT_PENDING_STORE"] = "memory"
        store = _build_default_store()
        self.assertIsInstance(store, InProcessPendingStore)

    def test_supabase_without_creds_falls_back(self):
        os.environ["AGENT_PENDING_STORE"] = "supabase"
        # No SUPABASE_URL or SERVICE_ROLE_KEY.
        store = _build_default_store()
        self.assertIsInstance(store, InProcessPendingStore)

    def test_supabase_with_creds_builds_supabase_store(self):
        os.environ["AGENT_PENDING_STORE"] = "supabase"
        os.environ["SUPABASE_URL"] = "https://fake.supabase.co"
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "sk"
        store = _build_default_store()
        self.assertIsInstance(store, SupabasePendingStore)


class IntentFromJsonbTests(unittest.TestCase):
    def test_full_round_trip(self):
        original = _intent(match_text="bath", bulk=True)
        from dataclasses import asdict
        out = _intent_from_jsonb(asdict(original))
        self.assertEqual(out, original)

    def test_drops_unknown_fields(self):
        out = _intent_from_jsonb({
            "action": "update", "entity": "chore", "match_text": "k",
            "match_field": None, "update_field": None, "update_value": None,
            "bulk": False, "confidence": 0.9,
            "extra_field_from_future_migration": "ignored",
        })
        self.assertEqual(out.match_text, "k")


class FirstRowTests(unittest.TestCase):
    def test_list_of_rows_returns_first(self):
        self.assertEqual(_first_row([{"a": 1}, {"a": 2}]), {"a": 1})

    def test_empty_list_returns_none(self):
        self.assertIsNone(_first_row([]))

    def test_dict_is_returned_as_is(self):
        self.assertEqual(_first_row({"a": 1}), {"a": 1})

    def test_none_returns_none(self):
        self.assertIsNone(_first_row(None))

    def test_bare_non_dict_returns_none(self):
        self.assertIsNone(_first_row("string"))
        self.assertIsNone(_first_row(42))


class ModuleLevelApiDelegationTests(unittest.IsolatedAsyncioTestCase):
    """The async module-level helpers (stash_pending_confirmation, etc.)
    delegate to whichever store is active. Install a custom store and
    verify the helpers forward calls correctly.
    """

    async def test_module_helpers_forward_to_active_store(self):
        # Use the test helper to reset to in-process.
        use_in_process_store_for_tests()

        await orch_state.stash_pending_confirmation(
            conversation_id="c1",
            intent=_intent(),
            match_ids=[("id1", "T")],
            tool_calls=[],
        )
        taken = await orch_state.take_pending_confirmation("c1")
        self.assertIsNotNone(taken)

    async def test_set_store_hot_swap(self):
        calls: list[str] = []

        class RecordingStore:
            async def stash_confirmation(self, *a, **k):
                calls.append("stash_confirmation")

            async def take_confirmation(self, *a, **k):
                calls.append("take_confirmation")
                return None

            async def clear_confirmation(self, *a, **k):
                calls.append("clear_confirmation")

            async def stash_clarification(self, *a, **k):
                calls.append("stash_clarification")

            async def take_clarification(self, *a, **k):
                calls.append("take_clarification")
                return None

        original = orch_state._store
        orch_state.set_store(RecordingStore())
        try:
            await orch_state.stash_pending_confirmation("c1", _intent(), [], [])
            await orch_state.take_pending_confirmation("c1")
            await orch_state.clear_pending_confirmation("c1")
            await orch_state.stash_clarification("c1", [_intent()], "x", "y")
            await orch_state.take_clarification("c1")
        finally:
            orch_state.set_store(original)

        self.assertEqual(
            calls,
            [
                "stash_confirmation",
                "take_confirmation",
                "clear_confirmation",
                "stash_clarification",
                "take_clarification",
            ],
        )


if __name__ == "__main__":
    unittest.main()
