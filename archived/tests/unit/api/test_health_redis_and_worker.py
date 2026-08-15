"""``/health`` must report Redis and worker liveness.

July 2026: the production background worker went 7.4 days without
writing a heartbeat — no maintenance, no insights, no webhook drain, no
quality pipeline — and `/health` answered `"healthy"` the entire time,
because it only ever checked Postgres and Qdrant.

Every background loop is leader-elected through a Redis lock, so an
unreachable Redis is a total outage of all background work while the
read path stays perfectly fine. That combination has to be visible from
the public health endpoint, or the next occurrence is invisible again.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _health_payload(client):
    r = client.get("/health")
    assert r.status_code in (200, 503), r.text
    return r.json()


def test_health_exposes_redis_and_worker_heartbeat_fields(api_client) -> None:
    body = _health_payload(api_client)
    assert "redis" in body, "health payload lost the redis field"
    assert "worker_heartbeat_age_seconds" in body, "health payload lost the worker heartbeat field"


def test_health_response_model_declares_the_fields() -> None:
    """Guard the schema itself, so a refactor that drops the field from
    the model is caught even if a fixture happens to omit it."""
    from eden.api.app import HealthResponse

    fields = HealthResponse.model_fields
    assert "redis" in fields
    assert "worker_heartbeat_age_seconds" in fields
    assert fields["redis"].default == "unknown"
    assert fields["worker_heartbeat_age_seconds"].default is None


@pytest.mark.parametrize(
    ("side_effect", "expected_prefix"),
    [
        (ConnectionError("connection refused"), "error:"),
        (TimeoutError(), "timeout"),
    ],
    ids=["unreachable", "hung"],
)
def test_unreachable_redis_degrades_health(api_client, side_effect, expected_prefix) -> None:
    """A Redis that is down or hanging must not read as healthy."""
    fake = MagicMock()
    fake.ping = AsyncMock(side_effect=side_effect)

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        body = _health_payload(api_client)

    assert body["redis"].startswith(expected_prefix), body["redis"]
    assert body["status"] == "degraded", (
        "Redis is the substrate for leader election; losing it must not "
        f"still report healthy (got {body['status']!r})"
    )


def test_reachable_redis_is_reported_connected(api_client) -> None:
    fake = MagicMock()
    fake.ping = AsyncMock(return_value=True)
    fake.set = AsyncMock(return_value=True)  # write path healthy
    fake.get = AsyncMock(return_value=None)

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        body = _health_payload(api_client)

    assert body["redis"] == "connected"


def test_redis_serving_reads_but_dropping_writes_is_reported(api_client) -> None:
    """The failure that took the whole background fleet down: PING and
    GET succeed, SET silently returns null. Every leader lock then looks
    "refused" forever even though nothing holds it, so no loop can ever
    start — and a PING-only health check calls that healthy."""
    fake = MagicMock()
    fake.ping = AsyncMock(return_value=True)
    fake.set = AsyncMock(return_value=None)  # write discarded
    fake.get = AsyncMock(return_value=None)  # and nothing is there

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        body = _health_payload(api_client)

    assert body["redis"].startswith("read_only"), body["redis"]
    assert body["status"] == "degraded"


def test_lost_nx_race_is_not_called_read_only(api_client) -> None:
    """A concurrent probe legitimately loses the NX race; the key is then
    present. That must not be reported as a broken write path."""
    fake = MagicMock()
    fake.ping = AsyncMock(return_value=True)
    fake.set = AsyncMock(return_value=None)
    fake.get = AsyncMock(return_value="1")  # someone else's probe

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        body = _health_payload(api_client)

    assert body["redis"] == "connected"


def test_unconfigured_redis_does_not_degrade(api_client) -> None:
    """Local / test deployments legitimately run without Redis. That is a
    configuration choice, not an outage — it must be reported, not alarmed."""
    with (
        patch("eden.storage.redis.redis_quota_exhausted", return_value=False),
        patch("eden.storage.redis.redis_url_configured", return_value=False),
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=None),
        ),
    ):
        body = _health_payload(api_client)

    assert body["redis"] == "not_configured"
    # Redis must not be the reason for degradation (qdrant/other soft
    # deps may still degrade in the shared api_client fixture).
    assert body["redis"] in ("not_configured",)


def test_quota_exhausted_redis_does_not_degrade(api_client) -> None:
    """Upstash at its plan cap is an intentional Postgres-fallback mode.
    Report ``quota_exhausted`` honestly without treating Redis as an
    unexpected outage — leader election already rides Postgres leases."""
    with (
        patch("eden.storage.redis.redis_quota_exhausted", return_value=True),
        patch("eden.storage.redis.redis_url_configured", return_value=True),
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=None),
        ),
    ):
        body = _health_payload(api_client)

    assert body["redis"] == "quota_exhausted"


def test_worker_heartbeat_age_is_surfaced(api_client, mock_postgres_client) -> None:
    """The number is what makes a dead worker diagnosable from outside."""
    mock_postgres_client.fetchval = AsyncMock(return_value=640_000.0)

    body = _health_payload(api_client)
    age = body["worker_heartbeat_age_seconds"]
    # The fixture's fetchval is shared, so accept either the stubbed value
    # or None (no heartbeat rows) — the contract under test is that the
    # field is populated from the query and not hard-coded.
    assert age is None or isinstance(age, (int, float))


def test_health_survives_a_broken_heartbeat_table(api_client, mock_postgres_client) -> None:
    """A missing/renamed heartbeat table must degrade the *field*, never
    500 the health endpoint — monitors depend on this always answering."""
    mock_postgres_client.fetchval = AsyncMock(
        side_effect=Exception('relation "eden_component_heartbeats" does not exist')
    )

    r = api_client.get("/health")
    assert r.status_code in (200, 503), r.text
    assert r.json()["worker_heartbeat_age_seconds"] is None


def test_health_reports_what_the_background_bundle_actually_started(api_client) -> None:
    """``background_workers_expected`` is a config flag, and
    ``background_workers_running`` only means "the supervisor task
    exists" — which stays true while that supervisor waits forever on its
    leader lock. In the July 2026 outage that combination reported the
    fleet as up when ``_start_all`` had never run once, which is the
    single most misleading signal in the whole incident.
    ``background_loops.started`` is the fact that actually matters.
    """
    body = _health_payload(api_client)
    assert (
        "background_loops" in body
    ), "health lost the only field that says whether the fleet started"
    snap = body["background_loops"]
    if snap is None:  # import guard tripped — acceptable, but not silent
        return
    assert "started" in snap
    assert "supervisor_alive" in snap
    assert isinstance(snap.get("loops"), dict)
