"""FEAT-15: a real sandbox path-escape attempt must publish a
``sandbox.security_alert`` event that AlertStreamProcessor's P0
``rule_sandbox_escape`` rule can evaluate.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.sandbox.runner import run_in_sandbox


class TestSandboxEscapeAlertEmission:
    @pytest.mark.asyncio
    async def test_path_traversal_publishes_security_alert(self, tmp_path) -> None:
        with patch(
            "eden.realtime.kafka_consumer.publish_alert_event", new=AsyncMock(return_value=True)
        ) as mock_publish:
            result = await run_in_sandbox(
                ["pytest"],
                files=[{"path": "../escape.py", "content": "bad"}],
                workdir=tmp_path,
                cleanup=False,
                tenant_id="org-1",
                entity_id="job-1",
            )

        assert result.error == "path_traversal_or_bad_patch"
        mock_publish.assert_awaited_once()
        args, kwargs = mock_publish.call_args
        assert args[0] == "sandbox.security_alert"
        assert kwargs["entity_id"] == "job-1"
        assert kwargs["tenant_id"] == "org-1"
        assert kwargs["payload"]["severity"] == "critical"
        assert kwargs["payload"]["reason"] == "path_traversal"
        assert "escape.py" in kwargs["payload"]["message"]

    @pytest.mark.asyncio
    async def test_nested_traversal_publishes_security_alert(self, tmp_path) -> None:
        with patch(
            "eden.realtime.kafka_consumer.publish_alert_event", new=AsyncMock(return_value=True)
        ) as mock_publish:
            result = await run_in_sandbox(
                ["pytest"],
                files=[{"path": "a/../../etc/passwd", "content": "bad"}],
                workdir=tmp_path,
                cleanup=False,
            )

        assert result.error == "path_traversal_or_bad_patch"
        mock_publish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_malformed_patch_does_not_publish_security_alert(self, tmp_path) -> None:
        """Missing 'content' is a bad patch, not an escape attempt — must
        not spam a P0 security alert for ordinary caller errors."""
        with patch(
            "eden.realtime.kafka_consumer.publish_alert_event", new=AsyncMock(return_value=True)
        ) as mock_publish:
            result = await run_in_sandbox(
                ["pytest"],
                files=[{"path": "ok.py"}],  # no 'content'
                workdir=tmp_path,
                cleanup=False,
            )

        assert result.error == "path_traversal_or_bad_patch"
        mock_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_kafka_publish_failure_does_not_break_sandbox_result(
        self, tmp_path
    ) -> None:
        """publish_alert_event itself is best-effort, but this asserts the
        outer defensive guard in runner.py too: even a raising import/call
        must not affect the returned SandboxResult."""
        with patch(
            "eden.realtime.kafka_consumer.publish_alert_event",
            new=AsyncMock(side_effect=RuntimeError("kafka down")),
        ):
            result = await run_in_sandbox(
                ["pytest"],
                files=[{"path": "../escape.py", "content": "bad"}],
                workdir=tmp_path,
                cleanup=False,
            )

        assert result.error == "path_traversal_or_bad_patch"
        assert result.exit_code == 125

    @pytest.mark.asyncio
    async def test_no_traversal_does_not_publish(self, tmp_path) -> None:
        with patch(
            "eden.realtime.kafka_consumer.publish_alert_event", new=AsyncMock(return_value=True)
        ) as mock_publish:
            result = await run_in_sandbox(
                ["pytest"],
                files=[{"path": "ok.py", "content": "print(1)"}],
                workdir=tmp_path,
                cleanup=False,
            )

        assert result.error != "path_traversal_or_bad_patch"
        mock_publish.assert_not_awaited()
