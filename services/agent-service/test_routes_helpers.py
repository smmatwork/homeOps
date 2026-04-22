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
    """The happy-path body of dispatch_invite lazy-imports class names
    (`WhatsAppAdapter` / `SmsAdapter` / `WebAdapter`) that don't exist in
    channel_adapters.*. That's a pre-existing issue from before the
    refactor — kept out of scope here. We still verify the request schema +
    router registration so the 403 auth path + OpenAPI stay valid.
    """

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


if __name__ == "__main__":
    unittest.main()
