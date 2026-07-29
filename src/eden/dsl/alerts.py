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

Runtime: :meth:`AlertAsCode.evaluate` runs one rule on
demand; :meth:`AlertAsCode.fire_due` is the cron watchdog
that evaluates every due rule and persists firings to
``eql_alert_firings``.
"""

from __future__ import annotations

import json
import logging
import uuid as _uuid
from datetime import UTC, datetime
from typing import Any

from eden.storage.empty_cooldown import make_empty_cooldown

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

_eql_in_cooldown, _eql_mark_empty, _eql_clear_cooldown = make_empty_cooldown(
    default_seconds=300.0,
    settings_attr="eql_empty_cooldown_seconds",
)


# The v1.3 ship supports the 3 severities the cron watchdog
# actually fires on. ``critical`` is accepted for forward-
# compatibility (the customer can register the alert; the
# watchdog filters to info|warning|high at fire time).
_VALID_SEVERITIES: frozenset[str] = frozenset(
    {"info", "warning", "high", "critical"}
)

# Severities the cron watchdog actually fires notifications for.
_FIREABLE_SEVERITIES: frozenset[str] = frozenset(
    {"info", "warning", "high"}
)

# Minimum alert interval — the failure-modes table calls this
# out as a guardrail against a customer writing a 24/7 query
# that overloads ClickHouse. 60s is the Braintrust default.
_MIN_INTERVAL_SECONDS: int = 60

# Cap sample rows persisted on a firing so an adversarial
# query that returns millions of rows can't bloat the table.
_FIRING_SAMPLE_LIMIT: int = 20


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

        parser = EQLParser()
        parse_result = await parser.parse(
            org_id,
            query=eql_query,
            shape=shape,
            lint_mode="default",
        )
        if parse_result["status"] != "ok":
            return _not_implemented_envelope(
                "AlertAsCode",
                f"EQL parse failed: {parse_result.get('message', 'unknown')}",
            )
        clickhouse_sql = parse_result["data"]["clickhouse_sql"]
        warnings = parse_result["data"]["warnings"]

        alert_id = _alert_id_for(org_id=org_id, name=name)

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
        _eql_clear_cooldown()

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

    async def evaluate(
        self,
        org_id: str,
        *,
        alert_id: str,
        force: bool = True,
    ) -> dict[str, Any]:
        """On-demand evaluation of one alert rule.

        Runs the compiled SQL, persists a row to
        ``eql_alert_firings`` when the query returns ≥1 row
        (or a ``missed`` / ``error`` row otherwise), and
        advances ``next_fire_at``. ``force=True`` (default
        for the HTTP endpoint) evaluates even when
        ``next_fire_at`` is still in the future.
        """
        if not alert_id:
            return _not_implemented_envelope(
                "AlertAsCode",
                "alert_id is required",
            )
        rule = await _fetch_alert_rule(org_id, alert_id)
        if rule is None:
            return _not_implemented_envelope(
                "AlertAsCode",
                f"alert_id={alert_id!r} not found",
            )
        if not rule.get("enabled", True) and not force:
            return _ok_envelope(
                "AlertAsCode",
                {
                    "alert_id": alert_id,
                    "fired": False,
                    "reason": "disabled",
                },
            )
        result = await _evaluate_rule(rule, force=force)
        return _ok_envelope("AlertAsCode", result)

    async def fire_due(self, *, limit: int = 100) -> dict[str, Any]:
        """Cron watchdog: evaluate every due enabled alert.

        Selects ``eql_alert_rules`` where ``enabled`` and
        ``next_fire_at <= now()`` and ``lifecycle_status`` is
        not ``auto_disabled``. Persists firings and advances
        schedules. Hosted on ``eden-worker`` (leader-gated);
        ``cron_tick`` remains a legacy fallback when cron is enabled.
        """
        if _eql_in_cooldown():
            return _ok_envelope(
                "AlertAsCode",
                {
                    "n_due": 0,
                    "n_fired": 0,
                    "n_missed": 0,
                    "n_errors": 0,
                    "results": [],
                },
            )
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        now = datetime.now(UTC)
        rows = await client.fetch(
            """
            SELECT alert_id, org_id, name, eql_query, clickhouse_sql,
                   shape, interval_seconds, severity, next_fire_at,
                   enabled, lifecycle_status, n_fired
            FROM eql_alert_rules
            WHERE enabled = true
              AND lifecycle_status <> 'auto_disabled'
              AND (next_fire_at IS NULL OR next_fire_at <= $1)
            ORDER BY next_fire_at ASC NULLS FIRST
            LIMIT $2
            """,
            now,
            limit,
        )
        if not rows:
            _eql_mark_empty()
            return _ok_envelope(
                "AlertAsCode",
                {
                    "n_due": 0,
                    "n_fired": 0,
                    "n_missed": 0,
                    "n_errors": 0,
                    "results": [],
                },
            )
        _eql_clear_cooldown()
        results: list[dict[str, Any]] = []
        n_fired = 0
        n_missed = 0
        n_errors = 0
        for r in rows:
            rule = dict(r)
            try:
                out = await _evaluate_rule(rule, force=False)
                results.append(out)
                if out.get("fired"):
                    n_fired += 1
                elif out.get("status") == "error":
                    n_errors += 1
                else:
                    n_missed += 1
            except Exception as exc:  # noqa: BLE001 - continue
                logger.warning(
                    "AlertAsCode.fire_due failed for alert=%s: %s",
                    rule.get("alert_id"),
                    exc,
                )
                n_errors += 1
                results.append(
                    {
                        "alert_id": rule.get("alert_id"),
                        "org_id": rule.get("org_id"),
                        "fired": False,
                        "status": "error",
                        "error": str(exc),
                    }
                )
        return _ok_envelope(
            "AlertAsCode",
            {
                "n_due": len(rows),
                "n_fired": n_fired,
                "n_missed": n_missed,
                "n_errors": n_errors,
                "results": results,
            },
        )


# ── Internal helpers ───────────────────────────────────────────────


async def _fetch_alert_rule(
    org_id: str, alert_id: str
) -> dict[str, Any] | None:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    row = await client.fetchrow(
        """
        SELECT alert_id, org_id, name, eql_query, clickhouse_sql,
               shape, interval_seconds, severity, next_fire_at,
               enabled, lifecycle_status, n_fired
        FROM eql_alert_rules
        WHERE org_id = $1 AND alert_id = $2
        """,
        org_id,
        alert_id,
    )
    return dict(row) if row else None


async def _evaluate_rule(
    rule: dict[str, Any], *, force: bool
) -> dict[str, Any]:
    """Run one alert rule and persist the firing / miss."""
    org_id = rule["org_id"]
    alert_id = rule["alert_id"]
    severity = rule.get("severity") or "warning"
    interval = int(rule.get("interval_seconds") or 3600)
    sql = rule.get("clickhouse_sql") or rule.get("eql_query") or ""

    # Watchdog filters critical at fire time in v1.3 (accepted
    # at compile for forward-compat). On-demand force still runs.
    if not force and severity not in _FIREABLE_SEVERITIES:
        await _advance_next_fire(org_id, alert_id, interval)
        return {
            "alert_id": alert_id,
            "org_id": org_id,
            "fired": False,
            "reason": "severity_filtered",
            "severity": severity,
        }

    rows: list[dict[str, Any]] = []
    data_source = "postgres"
    error: str | None = None
    try:
        rows, data_source = await _run_alert_sql(sql)
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        logger.warning(
            "AlertAsCode evaluate SQL failed alert=%s: %s",
            alert_id,
            exc,
        )

    now = datetime.now(UTC)
    firing_id = f"eql_fire_{_uuid.uuid4().hex[:12]}"
    n_rows = len(rows)
    fired = error is None and n_rows > 0
    status = "error" if error else ("fired" if fired else "missed")
    sample = rows[:_FIRING_SAMPLE_LIMIT]

    await _insert_alert_firing(
        firing_id=firing_id,
        org_id=org_id,
        alert_id=alert_id,
        severity=severity,
        fired_at=now,
        n_rows=n_rows,
        sample_rows_json=json.dumps(sample, default=str),
        clickhouse_sql=sql,
        data_source=data_source,
        status=status,
        error=error,
    )

    if fired:
        await _mark_alert_fired(org_id, alert_id, now, interval)
        await _trigger_triage(
            org_id=org_id,
            alert_id=alert_id,
            name=rule.get("name") or alert_id,
            eql_query=rule.get("eql_query") or sql,
            severity=severity,
            firing_id=firing_id,
            n_rows=n_rows,
            sample_rows=sample,
            data_source=data_source,
        )
    else:
        await _advance_next_fire(org_id, alert_id, interval)
        if error:
            await _maybe_auto_disable(org_id, alert_id)

    return {
        "alert_id": alert_id,
        "org_id": org_id,
        "firing_id": firing_id,
        "fired": fired,
        "status": status,
        "n_rows": n_rows,
        "severity": severity,
        "data_source": data_source,
        "error": error,
        "sample_rows": sample,
    }


async def _trigger_triage(
    *,
    org_id: str,
    alert_id: str,
    name: str,
    eql_query: str,
    severity: str,
    firing_id: str,
    n_rows: int,
    sample_rows: list[dict[str, Any]],
    data_source: str,
) -> None:
    """Wire a fresh ``eql_alert_firings`` row into the NL-alert pipeline.

    ``eql_alert_rules``/``eql_alert_firings`` is the Cat 19 alert-as-
    code table set; ``alert_events`` + :class:`AlertTriageJudge` is
    the F81 NL-alert triage + paging pipeline. The two were never
    connected, so a fired EQL alert recorded a firing row but nobody
    was ever paged. This creates the corresponding ``alert_events``
    row and runs it through triage so a ``real_incident`` verdict
    reaches ``send_nl_incident_email``.

    Additive only: the firing record above has already been
    persisted and ``next_fire_at``/``n_fired`` already advanced by
    the time this runs, so a failure here (bad Postgres row, judge
    exception, etc.) is logged and swallowed rather than propagated
    — it must never turn an already-recorded firing into a reported
    ``fire_due`` error.
    """
    try:
        from eden.alerts import repo
        from eden.alerts.triage_judge import AlertTriageJudge

        event = await repo.create_alert_event(
            org_id=org_id,
            # alert_events.rule_id is a FK into nl_alert_rules, a
            # different table from eql_alert_rules (no shared id
            # space today) — leave unset and carry the eql alert_id
            # in the payload instead so the event stays traceable.
            rule_id=None,
            title=f"Alert '{name}' fired ({n_rows} row(s))",
            severity=severity,
            payload={
                "alert_id": alert_id,
                "firing_id": firing_id,
                "eql_query": eql_query,
                "n_rows": n_rows,
                "data_source": data_source,
                "sample_rows": sample_rows,
            },
        )
        await AlertTriageJudge().run_for_event(
            org_id,
            event["id"],
            rule_name=name,
            nl_text=eql_query,
            payload=event.get("payload"),
        )
    except Exception as exc:  # noqa: BLE001 - triage must never break firing
        logger.warning(
            "AlertAsCode triage wiring failed alert=%s: %s", alert_id, exc
        )


async def _run_alert_sql(
    sql: str,
) -> tuple[list[dict[str, Any]], str]:
    """Execute alert SQL via ClickHouse when healthy, else Postgres."""
    from eden.columnar._common import _check_ch_available

    if await _check_ch_available():
        try:
            from eden.data_platform.clickhouse_sink import get_clickhouse_sink

            sink = await get_clickhouse_sink()
            raw = await sink._execute(sql)  # noqa: SLF001
            rows = sink._parse_tsv(raw)  # noqa: SLF001
            return list(rows or []), "clickhouse"
        except Exception as exc:
            logger.debug(
                "AlertAsCode CH path failed, falling back to PG: %s", exc
            )

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    # Translate common ClickHouse date helpers so the Postgres
    # fallback can run the same compiled SQL shape.
    pg_sql = (
        sql.replace("toStartOfHour(", "date_trunc('hour', ")
        .replace("toDate(", "date_trunc('day', ")
        .replace("toMonday(", "date_trunc('week', ")
    )
    rows = await client.fetch(pg_sql)
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        for k, v in list(d.items()):
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        out.append(d)
    return out, "postgres_fallback"


async def _insert_alert_firing(
    *,
    firing_id: str,
    org_id: str,
    alert_id: str,
    severity: str,
    fired_at: datetime,
    n_rows: int,
    sample_rows_json: str,
    clickhouse_sql: str,
    data_source: str,
    status: str,
    error: str | None,
) -> None:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    try:
        await client.execute(
            """
            INSERT INTO eql_alert_firings (
                id, org_id, alert_id, severity, fired_at, n_rows,
                sample_rows_json, clickhouse_sql, data_source, status, error
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
            )
            """,
            firing_id,
            org_id,
            alert_id,
            severity,
            fired_at,
            n_rows,
            sample_rows_json,
            clickhouse_sql,
            data_source,
            status,
            error,
        )
    except Exception as exc:
        logger.debug("AlertAsCode insert firing failed: %s", exc)


async def _mark_alert_fired(
    org_id: str, alert_id: str, fired_at: datetime, interval: int
) -> None:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    next_fire = datetime.fromtimestamp(
        fired_at.timestamp() + max(interval, _MIN_INTERVAL_SECONDS),
        tz=UTC,
    )
    await client.execute(
        """
        UPDATE eql_alert_rules
        SET last_fired_at = $3,
            next_fire_at = $4,
            n_fired = COALESCE(n_fired, 0) + 1
        WHERE org_id = $1 AND alert_id = $2
        """,
        org_id,
        alert_id,
        fired_at,
        next_fire,
    )


async def _advance_next_fire(
    org_id: str, alert_id: str, interval: int
) -> None:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    next_fire = datetime.fromtimestamp(
        datetime.now(UTC).timestamp() + max(interval, _MIN_INTERVAL_SECONDS),
        tz=UTC,
    )
    await client.execute(
        """
        UPDATE eql_alert_rules
        SET next_fire_at = $3
        WHERE org_id = $1 AND alert_id = $2
        """,
        org_id,
        alert_id,
        next_fire,
    )


async def _maybe_auto_disable(org_id: str, alert_id: str) -> None:
    """Auto-disable after 3 consecutive evaluation errors."""
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    try:
        row = await client.fetchrow(
            """
            SELECT COUNT(*) AS n
            FROM (
                SELECT status FROM eql_alert_firings
                WHERE org_id = $1 AND alert_id = $2
                ORDER BY fired_at DESC
                LIMIT 3
            ) t
            WHERE status = 'error'
            """,
            org_id,
            alert_id,
        )
        if row and int(row["n"] or 0) >= 3:
            await client.execute(
                """
                UPDATE eql_alert_rules
                SET lifecycle_status = 'auto_disabled', enabled = false
                WHERE org_id = $1 AND alert_id = $2
                """,
                org_id,
                alert_id,
            )
    except Exception as exc:
        logger.debug("AlertAsCode auto_disable check failed: %s", exc)


__all__ = [
    "AlertAsCode",
    "_MIN_INTERVAL_SECONDS",
    "_VALID_SEVERITIES",
]
