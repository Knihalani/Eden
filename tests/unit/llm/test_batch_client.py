"""Unit tests for AnthropicBatchClient (OOM W4-3 / L12).

Covers:
  - BatchClientDisabledError when api_key is empty.
  - submit / poll / collect (results) happy paths with mocked httpx.
  - poll terminal-status detection and BatchTimeoutError.
  - results NDJSON parsing including succeeded / errored / malformed lines.
  - run() end-to-end convenience wrapper.
  - config-level plumbing: patch_gen_model_override / judges_model_override
    default to "" (no behaviour change) and are surfaced on Settings.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_httpx_response(status_code: int, data: dict | str) -> MagicMock:
    """Return a minimal httpx.Response-like mock."""
    resp = MagicMock()
    resp.status_code = status_code
    if isinstance(data, dict):
        resp.json.return_value = data
        resp.text = json.dumps(data)
    else:
        resp.text = data
        try:
            resp.json.return_value = json.loads(data)
        except Exception:
            resp.json.side_effect = ValueError("not JSON")
    resp.raise_for_status = MagicMock()  # no-op unless we set side_effect
    return resp


# ─────────────────────────────────────────────────────────────────────────────
# Import guard
# ─────────────────────────────────────────────────────────────────────────────

from eden.llm.batch_client import (
    AnthropicBatchClient,
    BatchClientDisabledError,
    BatchRequest,
    BatchTimeoutError,
)


# ─────────────────────────────────────────────────────────────────────────────
# BatchClientDisabledError — empty key
# ─────────────────────────────────────────────────────────────────────────────

class TestBatchClientDisabled:
    def test_disabled_when_no_api_key(self):
        client = AnthropicBatchClient(api_key="")
        assert client._disabled is True

    @pytest.mark.asyncio
    async def test_submit_raises_when_disabled(self):
        client = AnthropicBatchClient(api_key="")
        with pytest.raises(BatchClientDisabledError):
            await client.submit([])

    @pytest.mark.asyncio
    async def test_poll_raises_when_disabled(self):
        client = AnthropicBatchClient(api_key="")
        with pytest.raises(BatchClientDisabledError):
            await client.poll("msgbatch_abc")

    @pytest.mark.asyncio
    async def test_results_raises_when_disabled(self):
        client = AnthropicBatchClient(api_key="")
        with pytest.raises(BatchClientDisabledError):
            await client.results("msgbatch_abc")


# ─────────────────────────────────────────────────────────────────────────────
# BatchRequest serialisation
# ─────────────────────────────────────────────────────────────────────────────

class TestBatchRequest:
    def test_to_api_dict_minimal(self):
        req = BatchRequest(
            custom_id="req-0",
            model="claude-haiku-4-5",
            max_tokens=100,
            messages=[{"role": "user", "content": "Hi"}],
        )
        d = req.to_api_dict()
        assert d["custom_id"] == "req-0"
        assert d["params"]["model"] == "claude-haiku-4-5"
        assert d["params"]["max_tokens"] == 100
        assert d["params"]["messages"] == [{"role": "user", "content": "Hi"}]
        assert "system" not in d["params"]
        assert "temperature" not in d["params"]

    def test_to_api_dict_with_system_and_temperature(self):
        req = BatchRequest(
            custom_id="req-1",
            model="claude-haiku-4-5",
            max_tokens=50,
            messages=[{"role": "user", "content": "Hey"}],
            system="You are helpful.",
            temperature=0.0,
        )
        d = req.to_api_dict()
        assert d["params"]["system"] == "You are helpful."
        assert d["params"]["temperature"] == 0.0


# ─────────────────────────────────────────────────────────────────────────────
# submit
# ─────────────────────────────────────────────────────────────────────────────

class TestSubmit:
    @pytest.mark.asyncio
    async def test_submit_returns_batch_id(self):
        client = AnthropicBatchClient(api_key="sk-ant-test")

        mock_resp = _make_httpx_response(200, {"id": "msgbatch_01abc", "type": "message_batch"})

        with patch("httpx.AsyncClient") as mock_cls:
            ctx = MagicMock()
            ctx.__aenter__ = AsyncMock(return_value=ctx)
            ctx.__aexit__ = AsyncMock(return_value=False)
            # The client.post call returns the response directly (not a coroutine)
            ctx.post = MagicMock(return_value=mock_resp)
            mock_cls.return_value = ctx

            req = BatchRequest(
                custom_id="r0",
                model="claude-haiku-4-5",
                max_tokens=50,
                messages=[{"role": "user", "content": "test"}],
            )
            batch_id = await client.submit([req])

        assert batch_id == "msgbatch_01abc"
        # Verify raise_for_status was called
        mock_resp.raise_for_status.assert_called_once()


# ─────────────────────────────────────────────────────────────────────────────
# poll
# ─────────────────────────────────────────────────────────────────────────────

class TestPoll:
    @pytest.mark.asyncio
    async def test_poll_returns_on_ended(self):
        client = AnthropicBatchClient(api_key="sk-ant-test")

        mock_resp = _make_httpx_response(200, {
            "id": "msgbatch_01abc",
            "processing_status": "ended",
            "request_counts": {"succeeded": 1},
        })

        with patch("httpx.AsyncClient") as mock_cls:
            ctx = MagicMock()
            ctx.__aenter__ = AsyncMock(return_value=ctx)
            ctx.__aexit__ = AsyncMock(return_value=False)
            ctx.get = MagicMock(return_value=mock_resp)
            mock_cls.return_value = ctx

            result = await client.poll("msgbatch_01abc", poll_interval=0.0)

        assert result["processing_status"] == "ended"

    @pytest.mark.asyncio
    async def test_poll_waits_until_terminal(self):
        """poll keeps checking until status is 'ended'."""
        client = AnthropicBatchClient(api_key="sk-ant-test")

        responses = [
            _make_httpx_response(200, {"id": "b", "processing_status": "in_progress"}),
            _make_httpx_response(200, {"id": "b", "processing_status": "in_progress"}),
            _make_httpx_response(200, {"id": "b", "processing_status": "ended"}),
        ]
        call_count = 0

        def _get(*args, **kwargs):
            nonlocal call_count
            resp = responses[call_count]
            call_count += 1
            return resp

        with patch("httpx.AsyncClient") as mock_cls, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            ctx = MagicMock()
            ctx.__aenter__ = AsyncMock(return_value=ctx)
            ctx.__aexit__ = AsyncMock(return_value=False)
            ctx.get = _get
            mock_cls.return_value = ctx

            result = await client.poll("b", poll_interval=0.01)

        assert result["processing_status"] == "ended"
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_poll_raises_timeout(self):
        client = AnthropicBatchClient(api_key="sk-ant-test")

        mock_resp = _make_httpx_response(200, {"processing_status": "in_progress"})

        with patch("httpx.AsyncClient") as mock_cls, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            ctx = MagicMock()
            ctx.__aenter__ = AsyncMock(return_value=ctx)
            ctx.__aexit__ = AsyncMock(return_value=False)
            ctx.get = MagicMock(return_value=mock_resp)
            mock_cls.return_value = ctx

            with pytest.raises(BatchTimeoutError):
                await client.poll("b", poll_interval=0.0, max_polls=2)


# ─────────────────────────────────────────────────────────────────────────────
# results (collect)
# ─────────────────────────────────────────────────────────────────────────────

class TestResults:
    @pytest.mark.asyncio
    async def test_results_parses_succeeded(self):
        client = AnthropicBatchClient(api_key="sk-ant-test")

        ndjson = json.dumps({
            "custom_id": "req-0",
            "result": {
                "type": "succeeded",
                "message": {
                    "content": [{"type": "text", "text": "Hello world"}]
                },
            },
        })

        mock_resp = _make_httpx_response(200, ndjson)

        with patch("httpx.AsyncClient") as mock_cls:
            ctx = MagicMock()
            ctx.__aenter__ = AsyncMock(return_value=ctx)
            ctx.__aexit__ = AsyncMock(return_value=False)
            ctx.get = MagicMock(return_value=mock_resp)
            mock_cls.return_value = ctx

            rows = await client.results("msgbatch_01abc")

        assert len(rows) == 1
        assert rows[0]["custom_id"] == "req-0"
        assert rows[0]["status"] == "succeeded"
        assert rows[0]["content"] == "Hello world"
        assert rows[0]["error"] is None

    @pytest.mark.asyncio
    async def test_results_parses_errored(self):
        client = AnthropicBatchClient(api_key="sk-ant-test")

        ndjson = json.dumps({
            "custom_id": "req-1",
            "result": {
                "type": "errored",
                "error": {"type": "overloaded_error", "message": "Overloaded"},
            },
        })

        mock_resp = _make_httpx_response(200, ndjson)

        with patch("httpx.AsyncClient") as mock_cls:
            ctx = MagicMock()
            ctx.__aenter__ = AsyncMock(return_value=ctx)
            ctx.__aexit__ = AsyncMock(return_value=False)
            ctx.get = MagicMock(return_value=mock_resp)
            mock_cls.return_value = ctx

            rows = await client.results("msgbatch_01abc")

        assert rows[0]["status"] == "errored"
        assert rows[0]["content"] is None
        assert rows[0]["error"]["type"] == "overloaded_error"

    @pytest.mark.asyncio
    async def test_results_skips_malformed_lines(self):
        client = AnthropicBatchClient(api_key="sk-ant-test")

        good_line = json.dumps({
            "custom_id": "req-0",
            "result": {"type": "succeeded",
                       "message": {"content": [{"type": "text", "text": "ok"}]}},
        })
        ndjson = "\n".join(["NOT_JSON", good_line, ""])

        mock_resp = _make_httpx_response(200, ndjson)

        with patch("httpx.AsyncClient") as mock_cls:
            ctx = MagicMock()
            ctx.__aenter__ = AsyncMock(return_value=ctx)
            ctx.__aexit__ = AsyncMock(return_value=False)
            ctx.get = MagicMock(return_value=mock_resp)
            mock_cls.return_value = ctx

            rows = await client.results("msgbatch_01abc")

        # Malformed line silently skipped; good line parsed.
        assert len(rows) == 1
        assert rows[0]["status"] == "succeeded"

    @pytest.mark.asyncio
    async def test_results_multiple_rows(self):
        client = AnthropicBatchClient(api_key="sk-ant-test")

        lines = [
            json.dumps({
                "custom_id": f"req-{i}",
                "result": {
                    "type": "succeeded",
                    "message": {"content": [{"type": "text", "text": f"reply-{i}"}]},
                },
            })
            for i in range(3)
        ]
        mock_resp = _make_httpx_response(200, "\n".join(lines))

        with patch("httpx.AsyncClient") as mock_cls:
            ctx = MagicMock()
            ctx.__aenter__ = AsyncMock(return_value=ctx)
            ctx.__aexit__ = AsyncMock(return_value=False)
            ctx.get = MagicMock(return_value=mock_resp)
            mock_cls.return_value = ctx

            rows = await client.results("msgbatch_01abc")

        assert len(rows) == 3
        assert [r["content"] for r in rows] == ["reply-0", "reply-1", "reply-2"]


# ─────────────────────────────────────────────────────────────────────────────
# run() end-to-end
# ─────────────────────────────────────────────────────────────────────────────

class TestRun:
    @pytest.mark.asyncio
    async def test_run_calls_submit_poll_results(self):
        """run() calls submit → poll → results in sequence."""
        client = AnthropicBatchClient(api_key="sk-ant-test")

        submitted_ids: list[str] = []
        polled_ids: list[str] = []
        results_ids: list[str] = []

        async def _submit(reqs):
            submitted_ids.append("batch-xyz")
            return "batch-xyz"

        async def _poll(batch_id, **kw):
            polled_ids.append(batch_id)
            return {"processing_status": "ended"}

        async def _results(batch_id):
            results_ids.append(batch_id)
            return [{"custom_id": "r0", "status": "succeeded", "content": "done"}]

        client.submit = _submit
        client.poll = _poll
        client.results = _results

        req = BatchRequest(
            custom_id="r0",
            model="claude-haiku-4-5",
            max_tokens=10,
            messages=[{"role": "user", "content": "x"}],
        )
        rows = await client.run([req], poll_interval=0.0, max_polls=1)

        assert submitted_ids == ["batch-xyz"]
        assert polled_ids == ["batch-xyz"]
        assert results_ids == ["batch-xyz"]
        assert rows[0]["content"] == "done"


# ─────────────────────────────────────────────────────────────────────────────
# Config plumbing (OOM W4-3) — override fields default to empty
# ─────────────────────────────────────────────────────────────────────────────

class TestOverrideConfigPlumbing:
    def test_patch_gen_model_override_defaults_empty(self):
        from eden.config import get_settings
        s = get_settings()
        assert hasattr(s, "patch_gen_model_override")
        # Default must be empty string — no behaviour change.
        assert s.patch_gen_model_override == ""

    def test_judges_model_override_defaults_empty(self):
        from eden.config import get_settings
        s = get_settings()
        assert hasattr(s, "judges_model_override")
        assert s.judges_model_override == ""

    def test_rubric_synthesis_batch_v1_defaults_false(self):
        from eden.config import get_settings
        s = get_settings()
        assert hasattr(s, "rubric_synthesis_batch_v1")
        assert s.rubric_synthesis_batch_v1 is False

    def test_anthropic_api_key_defaults_empty(self):
        from eden.config import get_settings
        s = get_settings()
        assert hasattr(s, "anthropic_api_key")
        assert s.anthropic_api_key == ""

    def test_model_override_on_pipeline_task_defaults_empty(self):
        from eden.optimization.model_router import PipelineTask
        task = PipelineTask(agent="test", description="desc")
        assert task.model_override == ""

    def test_model_override_on_pipeline_task_can_be_set(self):
        from eden.optimization.model_router import PipelineTask
        task = PipelineTask(
            agent="patch_generator",
            description="desc",
            model_override="claude-haiku-4-5",
        )
        assert task.model_override == "claude-haiku-4-5"

    def test_route_sync_accepts_model_override_kwarg(self):
        """route_sync pops model_override into the task rather than passing
        it to the LLM client; verify it doesn't raise TypeError."""
        from eden.llm.internal_router import build_task
        task = build_task(
            "test_agent",
            model_override="claude-haiku-4-5",
        )
        assert task.model_override == "claude-haiku-4-5"
