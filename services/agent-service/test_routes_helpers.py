"""Unit tests for routes/helpers.py — the dispatch_invite endpoint.

Covers auth + the happy path where the channel dispatcher returns success.
The channel adapters are lazy-imported inside the endpoint, so we patch
them at the modules they live in.
"""

import os
import sys
import unittest
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import build_helpers_router


def _build_test_client(
    *,
    agent_service_key: str | None = "test-key",
    edge_execute_tools=None,
) -> TestClient:
    if edge_execute_tools is None:
        async def edge_execute_tools(*args, **kwargs):  # type: ignore[no-redef]
            return {"ok": True}

    app = FastAPI()
    app.include_router(
        build_helpers_router(
            agent_service_key=agent_service_key,
            edge_execute_tools=edge_execute_tools,
        )
    )
    return TestClient(app)


class DispatchInviteAuthTests(unittest.TestCase):
    def test_missing_key_returns_403(self):
        client = _build_test_client(agent_service_key="expected-key")
        resp = client.post(
            "/v1/helpers/dispatch-invite",
            json={
                "helper_id": "h1",
                "helper_name": "Alice",
                "magic_link_url": "https://x/invite",
                "household_id": "hh1",
            },
        )
        self.assertEqual(resp.status_code, 403)

    def test_wrong_key_returns_403(self):
        client = _build_test_client(agent_service_key="expected-key")
        resp = client.post(
            "/v1/helpers/dispatch-invite",
            headers={"x-agent-service-key": "wrong-key"},
            json={
                "helper_id": "h1",
                "helper_name": "Alice",
                "magic_link_url": "https://x/invite",
                "household_id": "hh1",
            },
        )
        self.assertEqual(resp.status_code, 403)

    def test_unconfigured_key_rejects_all_requests(self):
        client = _build_test_client(agent_service_key=None)
        resp = client.post(
            "/v1/helpers/dispatch-invite",
            headers={"x-agent-service-key": "anything"},
            json={
                "helper_id": "h1",
                "helper_name": "Alice",
                "magic_link_url": "https://x/invite",
                "household_id": "hh1",
            },
        )
        self.assertEqual(resp.status_code, 403)


class DispatchInviteRequestSchemaTests(unittest.TestCase):
    def test_request_body_schema_rejects_missing_fields(self):
        client = _build_test_client(agent_service_key="k")
        resp = client.post(
            "/v1/helpers/dispatch-invite",
            headers={"x-agent-service-key": "k"},
            json={"helper_id": "h1"},
        )
        self.assertEqual(resp.status_code, 422)

    def test_router_mounted_at_expected_path(self):
        client = _build_test_client(agent_service_key="k")
        # Unsupported methods should return 405 (or 404), not 401.
        resp = client.get("/v1/helpers/dispatch-invite")
        self.assertIn(resp.status_code, (404, 405))


class DispatchInviteHappyPathTests(unittest.TestCase):
    def test_successful_dispatch_returns_channel_and_attempts(self):
        client = _build_test_client(agent_service_key="k")

        fake_result = MagicMock()
        fake_result.success = True
        fake_result.final_channel = "whatsapp"
        fake_result.attempts = [MagicMock(), MagicMock()]  # 2 attempts

        fake_dispatcher = MagicMock()
        fake_dispatcher.initiate_outreach = AsyncMock(return_value=fake_result)

        with patch("channel_dispatcher.ChannelDispatcher", return_value=fake_dispatcher) as dispatcher_cls:
            resp = client.post(
                "/v1/helpers/dispatch-invite",
                headers={"x-agent-service-key": "k"},
                json={
                    "helper_id": "h1",
                    "helper_name": "Alice",
                    "helper_phone": "+911234567890",
                    "channel_chain": ["whatsapp", "sms", "web"],
                    "magic_link_url": "https://x/invite",
                    "household_id": "hh1",
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["channel"], "whatsapp")
        self.assertEqual(body["attempts"], 2)
        self.assertEqual(fake_dispatcher.initiate_outreach.await_count, 1)
        # Dispatcher got constructed with the full registry (voice, sms,
        # web, whatsapp_* variants + the "whatsapp" alias we add for the
        # client-friendly default chain).
        dispatcher_cls.assert_called_once()
        adapters_arg = dispatcher_cls.call_args.kwargs.get("adapters")
        self.assertIn("whatsapp", adapters_arg)
        self.assertIn("sms", adapters_arg)
        self.assertIn("web", adapters_arg)

    def test_failure_propagates_success_false(self):
        client = _build_test_client(agent_service_key="k")

        fake_result = MagicMock()
        fake_result.success = False
        fake_result.final_channel = None
        fake_result.attempts = []

        fake_dispatcher = MagicMock()
        fake_dispatcher.initiate_outreach = AsyncMock(return_value=fake_result)

        with patch("channel_dispatcher.ChannelDispatcher", return_value=fake_dispatcher):
            resp = client.post(
                "/v1/helpers/dispatch-invite",
                headers={"x-agent-service-key": "k"},
                json={
                    "helper_id": "h1",
                    "helper_name": "Alice",
                    "magic_link_url": "https://x/invite",
                    "household_id": "hh1",
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["attempts"], 0)


if __name__ == "__main__":
    unittest.main()
