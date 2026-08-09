"""Wave 1.3 — health probe honesty for soft dependencies.

Qdrant (and other soft deps) must not pull pods out of the LB when
Postgres is up. Ingress probes ``/ready`` (Postgres-only);
``/health`` may still 503 for monitors while the portal treats
``status: degraded`` as a soft warning.
"""

from __future__ import annotations

import pytest

from eden.api.startup_checks import (
    REQUIRED_FOR_READY,
    health_probe_http_status,
    is_ready,
)


def test_required_for_ready_is_postgres_only():
    assert frozenset({"postgres"}) == REQUIRED_FOR_READY


def test_ready_stays_green_when_qdrant_down():
    """Errno-99-style Qdrant failure must not flip readiness."""
    checks = {
        "postgres": "ok",
        "redis": "ok",
        "qdrant": "error: [Errno 99] Cannot assign requested address",
        "openrouter": "ok",
    }
    assert is_ready(checks) is True


def test_ready_stays_green_when_all_soft_deps_down():
    assert is_ready(
        {
            "postgres": "ok",
            "redis": "error: down",
            "qdrant": "error: down",
            "typesense": "error: typesense unreachable",
            "openrouter": "error: down",
        }
    )


def test_ready_fails_when_postgres_down():
    assert (
        is_ready(
            {
                "postgres": "error: connection refused",
                "redis": "ok",
                "qdrant": "ok",
                "openrouter": "ok",
            }
        )
        is False
    )


@pytest.mark.parametrize(
    ("overall", "mode", "expected"),
    [
        ("healthy", "auto", 200),
        ("degraded", "auto", 503),  # monitors: soft-dep degradation → 503
        ("healthy", "200", 200),
        ("degraded", "200", 200),
        ("healthy", "503", 503),
        ("degraded", "503", 503),
    ],
)
def test_health_probe_http_status_modes(overall: str, mode: str, expected: int):
    assert health_probe_http_status(overall, mode) == expected


def test_health_degraded_body_matches_prod_qdrant_evidence():
    """Body shape from w2-07 health_api_health.json must map to 503 in auto."""
    # Evidence: postgres connected, qdrant Errno 99 → status degraded
    overall = "degraded"
    assert health_probe_http_status(overall, "auto") == 503
