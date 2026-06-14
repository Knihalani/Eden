"""Cat 19 — AlertAsCode.

Compile an EQL alert definition into a Cat 19 alert rule that
fires on the configured interval. The "killer query" path
per the appendix — the customer writes the EQL, the compiler
parses + expands + lints, and the result is a ``eql_alert_rules``
row the cron watchdog reads on every tick.

The v1.3 ship supports three severities (info, warning, high)
— the appendix lists four (info, warning, high, critical) but
the cron watchdog ships with three in v1.3; the 4th is a v1.4
addition once we have customer data to justify the extra
notification path. The compiler accepts all 4 anyway; the
watchdog filters at fire time.

Closed-loop wiring: when the compiler finds at least one
lint warning, :func:`DSLHook.on_alert_lint_warning` fires
(the hook is a no-op logger in v1.3; v1.4 will surface the
warnings in the alert editor).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from ._common import (
    _alert_id_for,
    _fire_dsl_alert_lint_warning_hook,
    _looks_like_readonly_sql,
    _not_implemented_envelope,
    _ok_envelope,
    _upsert_alert_rule,
)
from .parser import EQLParser

logger = logging.getLogger(__name__)


# The v1.3 ship supports the 3 severities the cron watchdog
# actually fires on. ``critical`` is accepted for forward-
# compatibility (the customer can register the alert; the
# watchdog filters to info|warning|high at fire time).
_VALID_SEVERITIES: frozenset[str] = frozenset(
    {"info", "warning", "high", "critical"}
)

# Minimum alert interval — the failure-modes table calls this
# out as a guardrail against a customer writing a 24/7 query
# that overloads ClickHouse. 60s is the Braintrust default.
_MIN_INTERVAL_SECONDS: int = 60


class AlertAsCode:
    """Compile an EQL alert into a Cat 19 alert rule."""

    async def compile(
        self,
        org_id: str,
        *,
        name: str,
        eql_query: str,
        interval_seconds: int = 3600,
        severity: str = "warning",
        shape: str = "traces",
    ) -> dict[str, Any]:
        """Compile the alert definition and persist the rule.

        Args:
            org_id: The tenant id.
            name: The customer-facing alert name (used in
                the deterministic id derivation).
            eql_query: The EQL query (SQL only).
            interval_seconds: How often the alert fires.
                Minimum 60s. Default 3600s (1h).
            severity: One of ``info|warning|high|critical``.
                Default ``warning``.
            shape: One of ``traces|spans|summary``. Default
                ``traces``.

        Returns:
            The Cat 19 live envelope with the
            ``alert_id``, ``interval_seconds``,
            ``next_fire_at``, and the ``warnings`` the
            compiler surfaced. Errors return the
            ``not_implemented`` envelope.
        """
        if not name or not name.strip():
            return _not_implemented_envelope(
                "AlertAsCode",
                "name is required and must be non-empty",
            )
        if severity not in _VALID_SEVERITIES:
            return _not_implemented_envelope(
                "AlertAsCode",
                f"invalid severity: {severity!r} "
                "(expected one of: info, warning, high, critical)",
            )
        if interval_seconds < _MIN_INTERVAL_SECONDS:
            return _not_implemented_envelope(
                "AlertAsCode",
                f"interval_seconds must be >= {_MIN_INTERVAL_SECONDS} "
                f"(got {interval_seconds})",
            )
        if not eql_query or not eql_query.strip():
            return _not_implemented_envelope(
                "AlertAsCode",
                "eql_query is required and must be non-empty",
            )
        if not _looks_like_readonly_sql(eql_query):
            return _not_implemented_envelope(
                "AlertAsCode",
                "eql_query failed the read-only allowlist check",
            )

        # 1. Parse + expand the EQL query. The parser is the
        #    single source of truth for the expansion
        #    (the alert compiler does not duplicate the
        #    expansion logic).
        parser = EQLParser()
        parse_result = await parser.parse(
            org_id,
            query=eql_query,
            shape=shape,
            lint_mode="default",  # alert compile is always non-strict
        )
        # Surface the parse result if it failed.
        if parse_result["status"] != "ok":
            return _not_implemented_envelope(
                "AlertAsCode",
                f"EQL parse failed: {parse_result.get('message', 'unknown')}",
            )
        clickhouse_sql = parse_result["data"]["clickhouse_sql"]
        warnings = parse_result["data"]["warnings"]

        # 2. Compute the alert id (deterministic on org + name).
        alert_id = _alert_id_for(org_id=org_id, name=name)

        # 3. Persist the alert rule. The upsert pattern means
        #    a re-compile on the same (org, name) updates the
        #    row in place — the watchdog reads the new
        #    clickhouse_sql on the next tick.
        await _upsert_alert_rule(
            org_id=org_id,
            alert_id=alert_id,
            name=name,
            eql_query=eql_query,
            clickhouse_sql=clickhouse_sql,
            shape=shape,
            interval_seconds=interval_seconds,
            severity=severity,
        )

        # 4. Fire the closed-loop hook when at least one
        #    warning surfaced. The hook is a no-op logger in
        #    v1.3; the wiring is in place for v1.4.
        if warnings:
            await _fire_dsl_alert_lint_warning_hook(
                org_id,
                alert_id=alert_id,
                warnings=warnings,
            )

        next_fire_at = datetime.fromtimestamp(
            datetime.now(UTC).timestamp() + interval_seconds,
            tz=UTC,
        )
        return _ok_envelope(
            "AlertAsCode",
            {
                "alert_id": alert_id,
                "name": name,
                "shape": shape,
                "interval_seconds": interval_seconds,
                "severity": severity,
                "next_fire_at": next_fire_at.isoformat(),
                "warnings": warnings,
                "n_warnings": len(warnings),
            },
        )

    async def list_alerts(
        self,
        org_id: str,
        *,
        enabled_only: bool = False,
    ) -> dict[str, Any]:
        """List the org's alert rules.

        Returns the deterministic list of ``eql_alert_rules``
        rows for the org, sorted by ``next_fire_at ASC`` (the
        watchdog's hot path).
        """
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        sql = (
            "SELECT alert_id, name, shape, interval_seconds, severity, "
            "last_fired_at, next_fire_at, enabled, lifecycle_status, "
            "n_fired, created_at "
            "FROM eql_alert_rules WHERE org_id = $1"
        )
        if enabled_only:
            sql += " AND enabled = true"
        sql += " ORDER BY next_fire_at ASC"
        rows = await client.fetch(sql, org_id)
        alerts: list[dict[str, Any]] = []
        for r in rows:
            d: dict[str, Any] = dict(r)
            for k, v in d.items():
                if hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            alerts.append(d)
        return _ok_envelope(
            "AlertAsCode",
            {
                "alerts": alerts,
                "n_alerts": len(alerts),
            },
        )


__all__ = [
    "AlertAsCode",
    "_MIN_INTERVAL_SECONDS",
    "_VALID_SEVERITIES",
]
