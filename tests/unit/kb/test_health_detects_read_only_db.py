"""A database you cannot write to must not report as healthy.

On 2026-07-30 the Neon endpoint went read-only for roughly two minutes.
Every INSERT failed with ReadOnlySQLTransactionError — ingest, signup
and onboarding were all down — while ``/health`` reported
``postgres: connected`` throughout, because ``SELECT 1`` succeeds
perfectly against a read-only database.

For a product whose entire job is accepting writes, "reachable" and
"usable" are not the same claim, and the health endpoint has to be able
to tell them apart.

These drive the pure classifier rather than ``health_check`` itself: the
first version of this file patched the client factory and proved
order-dependent (the second test kept receiving the first test's fake),
which is exactly the kind of test that passes for the wrong reason.
Extracting the decision made it directly testable.
"""

from __future__ import annotations

import inspect

import pytest

from eden.kb import classify_postgres_health


class TestClassifyPostgresHealth:
    @pytest.mark.parametrize("guc", ["on", "ON", "true", "yes", "1", " on "])
    def test_read_only_values_are_reported_as_read_only(self, guc):
        assert classify_postgres_health(1, guc) == "read_only", (
            "a read-only database is an outage for a write-path product; "
            "reporting 'connected' hid a live two-minute incident"
        )

    @pytest.mark.parametrize("guc", ["off", "OFF", "false", "no", "0"])
    def test_writable_values_are_connected(self, guc):
        assert classify_postgres_health(1, guc) == "connected"

    def test_unreadable_guc_does_not_invent_an_outage(self):
        assert classify_postgres_health(1, None) == "connected"

    @pytest.mark.parametrize("bad", [0, None, "x"])
    def test_failed_liveness_probe_is_error(self, bad):
        assert classify_postgres_health(bad, "off") == "error"

    def test_read_only_never_equals_connected(self):
        """app.py gates overall health on postgres == "connected", so
        "read_only" must fall through to degraded rather than pass."""
        assert classify_postgres_health(1, "on") != "connected"


class TestHealthCheckUsesTheClassifier:
    def test_health_check_consults_the_read_only_guc(self):
        from eden.kb import health_check

        src = inspect.getsource(health_check)
        assert "transaction_read_only" in src, (
            "health_check must probe writability, not just SELECT 1"
        )
        assert "classify_postgres_health" in src
