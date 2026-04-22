"""Unit tests for kernel/observability.py.

Covers the pieces of the observability extraction that run without
actually talking to Langfuse or OTLP: the no-op behaviour when Langfuse
is disabled, the input-payload shrinker, the middleware contextvar
bookkeeping, and the _env whitespace helper.
"""

import os
import sys
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

from kernel.observability import (
    _env,
    _langfuse_flush,
    _langfuse_input_payload,
    _langfuse_safe_update,
    build_chat_respond_langfuse,
)


class EnvHelperTests(unittest.TestCase):
    def test_missing_var_returns_default(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HOMEOPS_TEST_VAR", None)
            self.assertEqual(_env("HOMEOPS_TEST_VAR", "default"), "default")
            self.assertIsNone(_env("HOMEOPS_TEST_VAR"))

    def test_whitespace_only_treated_as_missing(self):
        with patch.dict(os.environ, {"HOMEOPS_TEST_VAR": "   "}):
            self.assertEqual(_env("HOMEOPS_TEST_VAR", "default"), "default")

    def test_trimmed_value_returned(self):
        with patch.dict(os.environ, {"HOMEOPS_TEST_VAR": "  value  "}):
            self.assertEqual(_env("HOMEOPS_TEST_VAR"), "value")


class LangfuseFlushTests(unittest.TestCase):
    def test_none_client_noop(self):
        # Should not raise.
        _langfuse_flush(None)

    def test_client_without_flush_method_noop(self):
        _langfuse_flush(object())

    def test_client_flush_called(self):
        client = MagicMock()
        _langfuse_flush(client)
        client.flush.assert_called_once()

    def test_flush_exception_swallowed(self):
        client = MagicMock()
        client.flush.side_effect = RuntimeError("down")
        _langfuse_flush(client)  # must not raise


class LangfuseSafeUpdateTests(unittest.TestCase):
    def test_none_trace_noop(self):
        _langfuse_safe_update(None, output={"x": 1})

    def test_update_called_with_payload(self):
        trace_obj = MagicMock()
        _langfuse_safe_update(trace_obj, output={"x": 1}, status="success")
        trace_obj.update.assert_called_once_with(output={"x": 1}, status="success")

    def test_empty_payload_skips_update(self):
        trace_obj = MagicMock()
        _langfuse_safe_update(trace_obj)  # no output, no status
        trace_obj.update.assert_not_called()

    def test_update_exception_swallowed(self):
        trace_obj = MagicMock()
        trace_obj.update.side_effect = RuntimeError("boom")
        _langfuse_safe_update(trace_obj, output={"x": 1})  # must not raise


class LangfuseInputPayloadTests(unittest.TestCase):
    def test_takes_only_last_12_messages(self):
        messages = [{"role": "user", "content": f"msg {i}"} for i in range(20)]
        payload = _langfuse_input_payload(messages)
        self.assertEqual(len(payload["messages"]), 12)
        self.assertEqual(payload["messages"][0]["content"], "msg 8")
        self.assertEqual(payload["messages"][-1]["content"], "msg 19")

    def test_truncates_long_content_to_2000_chars(self):
        big = "x" * 5000
        payload = _langfuse_input_payload([{"role": "user", "content": big}])
        self.assertEqual(len(payload["messages"][0]["content"]), 2000)

    def test_non_string_content_is_json_encoded(self):
        payload = _langfuse_input_payload([{"role": "user", "content": {"nested": True}}])
        self.assertIn("nested", payload["messages"][0]["content"])

    def test_none_content_becomes_empty_string(self):
        payload = _langfuse_input_payload([{"role": "user", "content": None}])
        self.assertEqual(payload["messages"][0]["content"], "")

    def test_skips_non_dict_entries(self):
        payload = _langfuse_input_payload([
            {"role": "user", "content": "valid"},
            "bogus",
            123,
        ])
        self.assertEqual(len(payload["messages"]), 1)


class BuildChatRespondLangfuseTests(unittest.TestCase):
    """When Langfuse is disabled (no env vars), build_chat_respond_langfuse
    returns (None, None, no-op span fn, pass-through return fn). The
    closures must behave correctly even with no client — that's what keeps
    chat_respond working in local/test runs.
    """

    def _make_otel_span(self) -> Any:
        span = MagicMock()
        ctx = MagicMock()
        ctx.trace_id = 0xDEADBEEF
        span.get_span_context.return_value = ctx
        return span

    def test_returns_none_closures_when_langfuse_not_configured(self):
        with patch("kernel.observability._init_langfuse", return_value=None):
            lf, lf_trace, lf_span, lf_return = build_chat_respond_langfuse(
                otel_span=self._make_otel_span(),
                messages=[{"role": "user", "content": "hi"}],
                req_id="r",
                conv_id="c",
                sess_id="s",
                user_id="u",
                model="sarvam-m",
                x_langfuse_trace_id=None,
            )
        self.assertIsNone(lf)
        self.assertIsNone(lf_trace)
        # lf_span is callable and no-ops when lf is None.
        lf_span("test.span", input={"a": 1}, output={"b": 2})
        # lf_return passes the dict through unchanged.
        out = {"ok": True, "text": "hello"}
        self.assertEqual(lf_return(out), out)

    def test_lf_span_records_when_trace_active(self):
        fake_client = MagicMock()
        fake_trace = MagicMock()
        fake_trace.id = "trace-123"
        fake_client.trace.return_value = fake_trace

        with patch("kernel.observability._init_langfuse", return_value=fake_client):
            _, _, lf_span, lf_return = build_chat_respond_langfuse(
                otel_span=self._make_otel_span(),
                messages=[{"role": "user", "content": "hi"}],
                req_id="r",
                conv_id="c",
                sess_id="s",
                user_id="u",
                model="sarvam-m",
                x_langfuse_trace_id=None,
            )

        lf_span("orchestrator.test", input={"a": 1}, output={"b": 2})
        self.assertEqual(fake_client.span.call_count, 1)

    def test_lf_return_updates_and_flushes_trace(self):
        fake_client = MagicMock()
        fake_trace = MagicMock()
        fake_trace.id = "trace-123"
        fake_client.trace.return_value = fake_trace

        with patch("kernel.observability._init_langfuse", return_value=fake_client):
            _, _, _, lf_return = build_chat_respond_langfuse(
                otel_span=self._make_otel_span(),
                messages=[{"role": "user", "content": "hi"}],
                req_id="r",
                conv_id="c",
                sess_id="s",
                user_id="u",
                model="sarvam-m",
                x_langfuse_trace_id=None,
            )

        out = {"ok": True, "text": "done"}
        returned = lf_return(out)
        self.assertEqual(returned, out)
        fake_trace.update.assert_called_once_with(output=out, status="success")
        fake_client.flush.assert_called_once()

    def test_incoming_trace_id_overrides_new_trace(self):
        fake_client = MagicMock()
        fake_client.trace.return_value = MagicMock(id="incoming-id")

        with patch("kernel.observability._init_langfuse", return_value=fake_client):
            build_chat_respond_langfuse(
                otel_span=self._make_otel_span(),
                messages=[{"role": "user", "content": "hi"}],
                req_id="r",
                conv_id="c",
                sess_id="s",
                user_id="u",
                model="sarvam-m",
                x_langfuse_trace_id="external-trace-id",
            )

        # trace() got called with `id=` argument (enhanced linking).
        kwargs = fake_client.trace.call_args.kwargs
        self.assertEqual(kwargs.get("id"), "external-trace-id")

    def test_trace_creation_exception_returns_none(self):
        fake_client = MagicMock()
        fake_client.trace.side_effect = RuntimeError("api down")

        with patch("kernel.observability._init_langfuse", return_value=fake_client):
            lf, lf_trace, lf_span, lf_return = build_chat_respond_langfuse(
                otel_span=self._make_otel_span(),
                messages=[{"role": "user", "content": "hi"}],
                req_id="r",
                conv_id="c",
                sess_id="s",
                user_id="u",
                model="sarvam-m",
                x_langfuse_trace_id=None,
            )

        self.assertIsNone(lf)
        self.assertIsNone(lf_trace)
        # Closures still safe to call.
        lf_span("x")
        self.assertEqual(lf_return({"x": 1}), {"x": 1})


if __name__ == "__main__":
    unittest.main()
