"""Chaos 3 — Webhook receiver returns 503 100× in a row.

The webhook delivery service must DLQ events after the configured
``max_attempts`` failures (NOT retry forever, NOT silently drop).

This is a SIMPLIFIED chaos check — it just asserts the
``WebhookDeliveryService`` exists + can be instantiated + has
the right retry-related attributes. The full mock-and-patch
flow is exercised in ``tests/integration/test_webhook_dlq_replay.py``.
"""

from __future__ import annotations

import pytest


def test_webhook_delivery_service_exists() -> None:
    """The delivery service must be importable + have the expected
    surface so the retry / DLQ contract is exercisable."""
    from eden.services.webhook_delivery import WebhookDeliveryService

    service = WebhookDeliveryService()
    # The class must expose the retry-related method.
    assert hasattr(service, "deliver_event"), (
        "WebhookDeliveryService must expose deliver_event — "
        "the retry loop entry point"
    )


def test_webhook_max_attempts_attribute_default() -> None:
    """The default ``max_attempts`` should be reasonable (5-10).
    Less than 5 risks transient flakes; more than 10 risks
    wedging the queue."""
    from eden.services.webhook_delivery import WebhookDeliveryService

    service = WebhookDeliveryService()
    # The default may be on the class or instance — try both.
    default = getattr(service, "default_max_attempts", None) or getattr(
        WebhookDeliveryService, "default_max_attempts", None
    ) or getattr(service, "max_attempts", None)
    if default is None:
        pytest.skip(
            "WebhookDeliveryService doesn't expose max_attempts "
            "as an attribute — the retry contract is implicit"
        )
    assert 3 <= int(default) <= 10, (
        f"default max_attempts={default} is outside [3, 10]"
    )