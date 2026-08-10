"""P0-1 A4 — stream-consumer gating is per-feature, not per-telemetry-flag.

The audit's literal A4 said to gate the two XREADGROUP consumers
(``workers.trace_finalized_consumer``, ``closed_loop.event_bus``) behind
``REDIS_TELEMETRY_STREAM_ENABLED``. That flag is ``false`` in production
(northflank.yml) but gates the per-span judge-tailer XADD — NOT these
consumers. Wiring it to the consumers would silently disable the
auto-issue scanner and the closed loop, both launch features (see
``docs/ops/disabled-features.md``: "Deliberately NOT disabled").

The intent behind A4 — *feature-off = zero burn* — is already satisfied
by each consumer's own feature gate (``auto_issue_detection_v1`` /
``closed_loop_orchestrator_v1``), checked inside ``start_consumer()``
before any task is created. These tests pin that contract so a future
"unconditional on the guard-holder" regression is caught, and document
that the telemetry flag is the wrong lever.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_consumer_state():
    import eden.closed_loop.event_bus as eb
    import eden.workers.trace_finalized_consumer as tf

    eb._TASK = None
    eb._STOP = None
    tf._TASK = None
    tf._STOP = None
    yield
    eb._TASK = None
    eb._STOP = None
    tf._TASK = None
    tf._STOP = None


def _settings_with(**overrides):
    import eden.config as config_module

    class _Settings:
        pass

    s = _Settings()
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


@pytest.mark.asyncio
async def test_trace_finalized_skips_when_auto_issue_detection_off():
    """Feature-off → no consumer task, no Redis polling (zero burn)."""
    import eden.workers.trace_finalized_consumer as tf

    with (
        patch(
            "eden.config.get_settings",
            return_value=_settings_with(auto_issue_detection_v1=False),
        ),
        patch(
            "eden.workers.trace_finalized_consumer.asyncio.create_task",
            new_callable=MagicMock,
        ) as create_task,
    ):
        await tf.start_consumer()

    create_task.assert_not_called()
    assert tf._TASK is None


@pytest.mark.asyncio
async def test_trace_finalized_starts_when_feature_on():
    """Feature-on → consumer task created (existing behavior preserved)."""
    import eden.workers.trace_finalized_consumer as tf

    with (
        patch(
            "eden.config.get_settings",
            return_value=_settings_with(auto_issue_detection_v1=True),
        ),
        patch(
            "eden.workers.trace_finalized_consumer.asyncio.create_task",
            new_callable=MagicMock,
        ) as create_task,
    ):
        await tf.start_consumer()

    create_task.assert_called_once()
    assert tf._TASK is not None


@pytest.mark.asyncio
async def test_closed_loop_skips_when_closed_loop_orchestrator_off():
    """Feature-off → no consumer task, no Redis polling (zero burn)."""
    import eden.closed_loop.event_bus as eb

    with (
        patch(
            "eden.config.get_settings",
            return_value=_settings_with(closed_loop_orchestrator_v1=False),
        ),
        patch(
            "eden.closed_loop.event_bus.asyncio.create_task",
            new_callable=MagicMock,
        ) as create_task,
    ):
        await eb.start_consumer()

    create_task.assert_not_called()
    assert eb._TASK is None


@pytest.mark.asyncio
async def test_closed_loop_starts_when_feature_on():
    """Feature-on → consumer task created (existing behavior preserved)."""
    import eden.closed_loop.event_bus as eb

    with (
        patch(
            "eden.config.get_settings",
            return_value=_settings_with(closed_loop_orchestrator_v1=True),
        ),
        patch(
            "eden.closed_loop.event_bus.asyncio.create_task",
            new_callable=MagicMock,
        ) as create_task,
    ):
        await eb.start_consumer()

    create_task.assert_called_once()
    assert eb._TASK is not None
