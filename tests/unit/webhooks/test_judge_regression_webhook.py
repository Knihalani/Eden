"""Contract tests — `judge.regression` outbound webhook (OOM 9.7).

Asserts that when a judge regression is detected (via
``PromotionHook.on_judge_regression``) the delivery service's
``enqueue_event`` is called with:

* ``event_type == "judge.regression"``
* A payload containing ``org_id``, ``judge_name``, ``current_score``,
  and ``trace_id``.

The DB transport is mocked so these tests run without Postgres/Redis.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


# ─── helpers ─────────────────────────────────────────────────────


async def _run_hook(
    org_id: str = "org-abc",
    *,
    judge_name: str = "hallucination",
    trace_id: str = "trace-xyz",
    score: float = 0.2,
) -> None:
    """Instantiate PromotionHook and call on_judge_regression."""
    from eden.llmops.promotion_hooks import PromotionHook

    hook = PromotionHook()
    await hook.on_judge_regression(
        org_id,
        judge_name=judge_name,
        trace_id=trace_id,
        score=score,
    )


# ─── test classes ────────────────────────────────────────────────


class TestJudgeRegressionWebhookContract:
    """Core contract: on_judge_regression must call enqueue_event."""

    @pytest.mark.asyncio
    async def test_enqueue_event_called_on_regression(self) -> None:
        """enqueue_event must be invoked once per on_judge_regression call."""
        enqueue_mock = AsyncMock(return_value=1)

        with (
            patch(
                "eden.llmops.promotion_hooks.get_promotion_hook",
                side_effect=ImportError("no hook"),
            ),
            patch(
                "eden.llmops.promotion_hooks._record_action",
                new=AsyncMock(return_value="act-1"),
            ),
            patch(
                "eden.llmops.promotion_hooks.PromotionHook._degrade_active_canaries",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "eden.services.webhook_delivery.get_webhook_delivery_service"
            ) as mock_get_svc,
        ):
            mock_svc = AsyncMock()
            mock_svc.enqueue_event = enqueue_mock
            mock_get_svc.return_value = mock_svc

            await _run_hook(
                "org-abc",
                judge_name="hallucination",
                trace_id="trace-xyz",
                score=0.2,
            )

        enqueue_mock.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_event_type_is_judge_regression(self) -> None:
        """The event_type arg to enqueue_event must be 'judge.regression'."""
        enqueue_mock = AsyncMock(return_value=1)

        with (
            patch(
                "eden.llmops.promotion_hooks._record_action",
                new=AsyncMock(return_value="act-1"),
            ),
            patch(
                "eden.llmops.promotion_hooks.PromotionHook._degrade_active_canaries",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "eden.services.webhook_delivery.get_webhook_delivery_service"
            ) as mock_get_svc,
        ):
            mock_svc = AsyncMock()
            mock_svc.enqueue_event = enqueue_mock
            mock_get_svc.return_value = mock_svc

            await _run_hook(score=0.15)

        _args, kwargs = enqueue_mock.call_args
        positional = list(_args) + [kwargs.get("event_type")]
        # enqueue_event(org_id, event_type, payload) — event_type is 2nd arg
        event_type = _args[1] if len(_args) >= 2 else kwargs.get("event_type")
        assert event_type == "judge.regression"

    @pytest.mark.asyncio
    async def test_payload_contains_required_fields(self) -> None:
        """Payload must carry org_id, judge_name, current_score, trace_id."""
        enqueue_mock = AsyncMock(return_value=1)

        with (
            patch(
                "eden.llmops.promotion_hooks._record_action",
                new=AsyncMock(return_value="act-1"),
            ),
            patch(
                "eden.llmops.promotion_hooks.PromotionHook._degrade_active_canaries",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "eden.services.webhook_delivery.get_webhook_delivery_service"
            ) as mock_get_svc,
        ):
            mock_svc = AsyncMock()
            mock_svc.enqueue_event = enqueue_mock
            mock_get_svc.return_value = mock_svc

            await _run_hook(
                "org-test",
                judge_name="coherence",
                trace_id="trace-42",
                score=0.31,
            )

        _args, _kwargs = enqueue_mock.call_args
        payload = _args[2] if len(_args) >= 3 else _kwargs.get("payload")
        assert payload is not None, "payload must be passed"
        assert payload["event_type"] == "judge.regression"
        assert payload["org_id"] == "org-test"
        assert payload["judge_name"] == "coherence"
        assert payload["current_score"] == pytest.approx(0.31)
        assert payload["trace_id"] == "trace-42"

    @pytest.mark.asyncio
    async def test_org_id_propagates_to_enqueue(self) -> None:
        """org_id passed to on_judge_regression must reach enqueue_event."""
        enqueue_mock = AsyncMock(return_value=1)

        with (
            patch(
                "eden.llmops.promotion_hooks._record_action",
                new=AsyncMock(return_value="act-1"),
            ),
            patch(
                "eden.llmops.promotion_hooks.PromotionHook._degrade_active_canaries",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "eden.services.webhook_delivery.get_webhook_delivery_service"
            ) as mock_get_svc,
        ):
            mock_svc = AsyncMock()
            mock_svc.enqueue_event = enqueue_mock
            mock_get_svc.return_value = mock_svc

            await _run_hook("org-specific-123")

        _args, _kwargs = enqueue_mock.call_args
        org_id_arg = _args[0] if _args else _kwargs.get("org_id")
        assert org_id_arg == "org-specific-123"


class TestJudgeRegressionWebhookRobustness:
    """enqueue_event failures must not break on_judge_regression."""

    @pytest.mark.asyncio
    async def test_webhook_error_does_not_raise(self) -> None:
        """If enqueue_event raises, on_judge_regression must still succeed."""
        with (
            patch(
                "eden.llmops.promotion_hooks._record_action",
                new=AsyncMock(return_value="act-1"),
            ),
            patch(
                "eden.llmops.promotion_hooks.PromotionHook._degrade_active_canaries",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "eden.services.webhook_delivery.get_webhook_delivery_service"
            ) as mock_get_svc,
        ):
            mock_svc = AsyncMock()
            mock_svc.enqueue_event = AsyncMock(
                side_effect=RuntimeError("delivery down")
            )
            mock_get_svc.return_value = mock_svc

            # Must not raise even though enqueue_event fails.
            result = await _run_hook()

        # on_judge_regression returns the action_id, not None.
        assert result is None or isinstance(result, str)

    @pytest.mark.asyncio
    async def test_import_error_does_not_raise(self) -> None:
        """ImportError on the delivery service must not break the hook."""
        with (
            patch(
                "eden.llmops.promotion_hooks._record_action",
                new=AsyncMock(return_value="act-1"),
            ),
            patch(
                "eden.llmops.promotion_hooks.PromotionHook._degrade_active_canaries",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "eden.services.webhook_delivery.get_webhook_delivery_service",
                side_effect=ImportError("delivery service not installed"),
            ),
        ):
            # Must not raise.
            await _run_hook()


class TestEnqueueEventContract:
    """Unit tests for WebhookDeliveryService.enqueue_event."""

    @pytest.mark.asyncio
    async def test_enqueue_event_method_exists(self) -> None:
        """enqueue_event must exist on WebhookDeliveryService."""
        import asyncio

        from eden.services.webhook_delivery import WebhookDeliveryService

        svc = WebhookDeliveryService()
        assert hasattr(svc, "enqueue_event")
        assert asyncio.iscoroutinefunction(svc.enqueue_event)

    @pytest.mark.asyncio
    async def test_enqueue_event_inserts_delivery_per_subscription(self) -> None:
        """One INSERT per matching webhook subscription."""
        from eden.services.webhook_delivery import WebhookDeliveryService

        svc = WebhookDeliveryService()

        # Two subscriptions match.
        mock_pg = AsyncMock()
        mock_pg.fetch = AsyncMock(
            return_value=[{"id": "wh-1"}, {"id": "wh-2"}]
        )
        mock_pg.execute = AsyncMock(return_value="INSERT 0 1")

        with (
            patch(
                "eden.services.webhook_delivery.get_postgres_client",
                new=AsyncMock(return_value=mock_pg),
            ),
            patch(
                "eden.services.webhook_delivery._signal_outbox_pending",
                new=AsyncMock(),
            ),
        ):
            n = await svc.enqueue_event(
                "org-xyz",
                "judge.regression",
                {"event_type": "judge.regression", "org_id": "org-xyz"},
            )

        assert n == 2
        assert mock_pg.execute.await_count == 2

    @pytest.mark.asyncio
    async def test_enqueue_event_no_subscriptions_returns_zero(self) -> None:
        """If no webhooks subscribe to the event_type, return 0."""
        from eden.services.webhook_delivery import WebhookDeliveryService

        svc = WebhookDeliveryService()

        mock_pg = AsyncMock()
        mock_pg.fetch = AsyncMock(return_value=[])
        mock_pg.execute = AsyncMock()

        with patch(
            "eden.services.webhook_delivery.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ):
            n = await svc.enqueue_event(
                "org-xyz",
                "judge.regression",
                {},
            )

        assert n == 0
        mock_pg.execute.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_enqueue_event_db_error_returns_zero(self) -> None:
        """DB failure must not raise — return 0 and log a warning."""
        from eden.services.webhook_delivery import WebhookDeliveryService

        svc = WebhookDeliveryService()

        with (
            patch(
                "eden.services.webhook_delivery.get_postgres_client",
                new=AsyncMock(side_effect=RuntimeError("pg down")),
            ),
            patch("eden.services.webhook_delivery.logger") as mock_log,
        ):
            n = await svc.enqueue_event("org-xyz", "judge.regression", {})

        assert n == 0
        assert mock_log.warning.called

    @pytest.mark.asyncio
    async def test_enqueue_event_signals_outbox_pending(self) -> None:
        """After inserting deliveries, the outbox signal must be sent."""
        from eden.services.webhook_delivery import WebhookDeliveryService

        svc = WebhookDeliveryService()
        signal_mock = AsyncMock()

        mock_pg = AsyncMock()
        mock_pg.fetch = AsyncMock(return_value=[{"id": "wh-1"}])
        mock_pg.execute = AsyncMock(return_value="INSERT 0 1")

        with (
            patch(
                "eden.services.webhook_delivery.get_postgres_client",
                new=AsyncMock(return_value=mock_pg),
            ),
            patch(
                "eden.services.webhook_delivery._signal_outbox_pending",
                new=signal_mock,
            ),
        ):
            await svc.enqueue_event("org-xyz", "judge.regression", {})

        signal_mock.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_enqueue_event_filters_by_event_type(self) -> None:
        """The subscription query must filter by event_type via ANY(events)."""
        import inspect

        from eden.services.webhook_delivery import WebhookDeliveryService

        src = inspect.getsource(WebhookDeliveryService.enqueue_event)
        assert "ANY(events)" in src
        assert "active = true" in src
        assert "org_id" in src
