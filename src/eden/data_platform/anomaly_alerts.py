"""Anomaly detection and alerting for the Eden data platform.

Phase 5.5: Monitors data quality metrics, pipeline throughput, and
ClickHouse analytics for anomalies. Sends alerts via multiple channels:
- In-app notifications (PostgreSQL)
- WebSocket push (real-time)
- Email / webhook (async)

Usage:
    from eden.data_platform.anomaly_alerts import AnomalyDetector
    detector = AnomalyDetector()
    alerts = await detector.check_data_quality("silver_events")
"""

from __future__ import annotations

import asyncio
import json
import logging
import statistics
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class AnomalyAlert:
    """A single anomaly alert."""

    alert_id: str
    alert_type: str  # data_quality, throughput, cost_spike, pii_breach, schema_drift
    severity: str  # info, warning, critical
    table: str | None
    metric: str
    observed_value: float
    expected_range: tuple[float, float]
    deviation_percent: float
    message: str
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "alert_id": self.alert_id,
            "alert_type": self.alert_type,
            "severity": self.severity,
            "table": self.table,
            "metric": self.metric,
            "observed_value": self.observed_value,
            "expected_min": self.expected_range[0],
            "expected_max": self.expected_range[1],
            "deviation_percent": round(self.deviation_percent, 2),
            "message": self.message,
            "timestamp": self.timestamp,
            "context": self.context,
        }


@dataclass
class AlertReport:
    """Aggregated alert report from an anomaly detection run."""

    checked_metrics: int = 0
    alerts_triggered: int = 0
    alerts: list[AnomalyAlert] = field(default_factory=list)
    duration_ms: float = 0.0
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


class AnomalyDetector:
    """Detects anomalies in data platform metrics and generates alerts.

    Detection methods:
    - Z-score based outlier detection for numeric metrics
    - Moving average deviation for throughput metrics
    - Threshold-based alerts for cost and PII metrics
    - Schema drift detection via column count / type changes

    All thresholds are configurable via settings.
    """

    DEFAULT_Z_THRESHOLD = 3.0
    DEFAULT_THROUGHPUT_WINDOW = 24  # hours
    DEFAULT_COST_SPIKE_MULTIPLIER = 5.0
    DEFAULT_PII_THRESHOLD = 0.05  # 5% of events

    def __init__(
        self,
        z_threshold: float = 3.0,
        throughput_window_hours: int = 24,
        cost_spike_multiplier: float = 5.0,
        pii_threshold: float = 0.05,
    ) -> None:
        self.z_threshold = z_threshold
        self.throughput_window_hours = throughput_window_hours
        self.cost_spike_multiplier = cost_spike_multiplier
        self.pii_threshold = pii_threshold
        self._postgres_client: Any | None = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    # ── Public API ─────────────────────────────────────────────────────────

    async def check_all(self) -> AlertReport:
        """Run all anomaly detection checks and return aggregated alerts."""
        start = datetime.now(UTC)
        report = AlertReport()

        # Run checks in parallel
        results = await asyncio.gather(
            self.check_data_quality("silver_events"),
            self.check_data_quality("usage_events"),
            self.check_throughput(),
            self.check_cost_spike(),
            self.check_pii_breach(),
            self.check_schema_drift("silver_events"),
            return_exceptions=True,
        )

        for result in results:
            if isinstance(result, Exception):
                logger.error(f"Anomaly check failed: {result}")
                continue
            report.alerts.extend(result)
            report.checked_metrics += 1

        report.alerts_triggered = len(report.alerts)
        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000

        # Persist alerts
        await self._persist_alerts(report.alerts)

        logger.info(
            f"Anomaly detection complete: {report.checked_metrics} checks, "
            f"{report.alerts_triggered} alerts"
        )
        return report

    async def check_data_quality(self, table_name: str) -> list[AnomalyAlert]:
        """Check data quality metrics for anomalies.

        Looks at recent quality report scores and flags significant drops.
        """
        client = await self._get_postgres()
        alerts: list[AnomalyAlert] = []

        # Get last 7 days of quality scores
        since = datetime.now(UTC) - timedelta(days=7)
        rows = await client.fetch(
            """
            SELECT quality_score, timestamp
            FROM data_quality_reports
            WHERE table_name = $1 AND timestamp >= $2
            ORDER BY timestamp ASC
            """,
            table_name,
            since.isoformat(),
        )

        if len(rows) < 3:
            return alerts

        scores = [r["quality_score"] for r in rows]
        current_score = scores[-1]

        # Z-score on score drops
        mean = statistics.mean(scores)
        stdev = statistics.stdev(scores) if len(scores) > 1 else 0.001

        if stdev > 0:
            z_score = (current_score - mean) / stdev
            if z_score < -self.z_threshold:
                deviation = abs((current_score - mean) / mean) * 100 if mean > 0 else 0
                alerts.append(AnomalyAlert(
                    alert_id=f"dq-{table_name}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}",
                    alert_type="data_quality",
                    severity="critical" if current_score < 0.5 else "warning",
                    table=table_name,
                    metric="quality_score",
                    observed_value=current_score,
                    expected_range=(mean - self.z_threshold * stdev, mean + self.z_threshold * stdev),
                    deviation_percent=deviation,
                    message=f"Data quality score dropped to {current_score:.3f} (z={z_score:.2f}) for {table_name}",
                    context={"historical_scores": scores},
                ))

        # Check error count spikes
        error_rows = await client.fetch(
            """
            SELECT error_count, timestamp
            FROM data_quality_reports
            WHERE table_name = $1 AND timestamp >= $2
            ORDER BY timestamp ASC
            """,
            table_name,
            since.isoformat(),
        )
        if len(error_rows) >= 3:
            error_counts = [r["error_count"] for r in error_rows]
            current_errors = error_counts[-1]
            mean_errors = statistics.mean(error_counts)
            stdev_errors = statistics.stdev(error_counts) if len(error_counts) > 1 else 0.001

            if stdev_errors > 0:
                z_error = (current_errors - mean_errors) / stdev_errors
                if z_error > self.z_threshold:
                    deviation = (current_errors / max(mean_errors, 1)) * 100
                    alerts.append(AnomalyAlert(
                        alert_id=f"dq-err-{table_name}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}",
                        alert_type="data_quality",
                        severity="warning",
                        table=table_name,
                        metric="error_count",
                        observed_value=float(current_errors),
                        expected_range=(0.0, mean_errors + self.z_threshold * stdev_errors),
                        deviation_percent=deviation,
                        message=f"Error count spike: {current_errors} errors (z={z_error:.2f}) for {table_name}",
                    ))

        return alerts

    async def check_throughput(self) -> list[AnomalyAlert]:
        """Check pipeline throughput for drops or stalls."""
        client = await self._get_postgres()
        alerts: list[AnomalyAlert] = []

        since = datetime.now(UTC) - timedelta(hours=self.throughput_window_hours * 2)
        rows = await client.fetch(
            """
            SELECT
                DATE_TRUNC('hour', created_at) as hour,
                COUNT(*) as event_count
            FROM usage_events
            WHERE created_at >= $1
            GROUP BY hour
            ORDER BY hour ASC
            """,
            since.isoformat(),
        )

        if len(rows) < 3:
            return alerts

        counts = [r["event_count"] for r in rows]
        current_count = counts[-1]
        mean = statistics.mean(counts[:-1])  # exclude current
        stdev = statistics.stdev(counts[:-1]) if len(counts) > 2 else 0.001

        if stdev > 0 and mean > 0:
            z_score = (current_count - mean) / stdev
            if z_score < -self.z_threshold:
                deviation = abs((current_count - mean) / mean) * 100
                alerts.append(AnomalyAlert(
                    alert_id=f"throughput-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}",
                    alert_type="throughput",
                    severity="critical" if current_count == 0 else "warning",
                    table="usage_events",
                    metric="events_per_hour",
                    observed_value=float(current_count),
                    expected_range=(mean - self.z_threshold * stdev, mean + self.z_threshold * stdev),
                    deviation_percent=deviation,
                    message=f"Pipeline throughput dropped: {current_count} events/hour (avg={mean:.1f})",
                    context={"hourly_counts": counts},
                ))

        return alerts

    async def check_cost_spike(self) -> list[AnomalyAlert]:
        """Detect unusual cost spikes in LLM usage."""
        client = await self._get_postgres()
        alerts: list[AnomalyAlert] = []

        since = datetime.now(UTC) - timedelta(days=7)
        rows = await client.fetch(
            """
            SELECT
                DATE_TRUNC('day', created_at) as day,
                SUM(cost_usd) as daily_cost
            FROM usage_events
            WHERE event_type = 'llm_call' AND created_at >= $1
            GROUP BY day
            ORDER BY day ASC
            """,
            since.isoformat(),
        )

        if len(rows) < 3:
            return alerts

        costs = [r["daily_cost"] or 0 for r in rows]
        current_cost = costs[-1]
        mean_cost = statistics.mean(costs[:-1])

        if mean_cost > 0 and current_cost > mean_cost * self.cost_spike_multiplier:
            deviation = (current_cost / mean_cost) * 100
            alerts.append(AnomalyAlert(
                alert_id=f"cost-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}",
                alert_type="cost_spike",
                severity="critical" if current_cost > mean_cost * 10 else "warning",
                table="usage_events",
                metric="daily_cost_usd",
                observed_value=round(current_cost, 4),
                expected_range=(0.0, mean_cost * self.cost_spike_multiplier),
                deviation_percent=deviation,
                message=f"Cost spike detected: ${current_cost:.4f} today (avg=${mean_cost:.4f}/day)",
                context={"daily_costs": [round(c, 4) for c in costs]},
            ))

        return alerts

    async def check_pii_breach(self) -> list[AnomalyAlert]:
        """Detect PII detection rate spikes."""
        client = await self._get_postgres()
        alerts: list[AnomalyAlert] = []

        since = datetime.now(UTC) - timedelta(days=1)
        row = await client.fetchrow(
            """
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN metadata->>'pii_detected' = 'true' THEN 1 ELSE 0 END) as pii_count
            FROM usage_events
            WHERE created_at >= $1
            """,
            since.isoformat(),
        )

        if not row or row["total"] == 0:
            return alerts

        total = row["total"]
        pii_count = row["pii_count"] or 0
        pii_rate = pii_count / total

        if pii_rate > self.pii_threshold:
            alerts.append(AnomalyAlert(
                alert_id=f"pii-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}",
                alert_type="pii_breach",
                severity="critical",
                table="usage_events",
                metric="pii_detection_rate",
                observed_value=round(pii_rate, 4),
                expected_range=(0.0, self.pii_threshold),
                deviation_percent=(pii_rate / self.pii_threshold) * 100,
                message=f"High PII detection rate: {pii_rate:.2%} of events ({pii_count}/{total})",
            ))

        return alerts

    async def check_schema_drift(self, table_name: str) -> list[AnomalyAlert]:
        """Detect schema changes that might break downstream consumers."""
        client = await self._get_postgres()
        alerts: list[AnomalyAlert] = []

        # Get current column count from information_schema
        row = await client.fetchrow(
            """
            SELECT COUNT(*) as col_count
            FROM information_schema.columns
            WHERE table_name = $1
            """,
            table_name,
        )

        if not row:
            return alerts

        current_col_count = row["col_count"]

        # Compare with stored baseline
        baseline_row = await client.fetchrow(
            """
            SELECT value
            FROM data_platform_metadata
            WHERE key = $1
            """,
            f"schema_baseline:{table_name}",
        )

        if baseline_row:
            baseline_count = baseline_row["value"]
            try:
                baseline_count = int(baseline_count)
            except (ValueError, TypeError):
                baseline_count = current_col_count

            if current_col_count != baseline_count:
                alerts.append(AnomalyAlert(
                    alert_id=f"schema-{table_name}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}",
                    alert_type="schema_drift",
                    severity="warning",
                    table=table_name,
                    metric="column_count",
                    observed_value=float(current_col_count),
                    expected_range=(float(baseline_count), float(baseline_count)),
                    deviation_percent=abs(current_col_count - baseline_count) * 100,
                    message=f"Schema drift detected: {table_name} has {current_col_count} columns (baseline: {baseline_count})",
                ))

        # Update baseline
        await client.execute(
            """
            INSERT INTO data_platform_metadata (key, value, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = EXCLUDED.updated_at
            """,
            f"schema_baseline:{table_name}",
            str(current_col_count),
        )

        return alerts

    # ── Alert dispatch ─────────────────────────────────────────────────────

    async def dispatch_alerts(
        self,
        alerts: list[AnomalyAlert],
        channels: list[str] | None = None,
    ) -> dict[str, int]:
        """Dispatch alerts to configured channels.

        Channels: in_app, websocket, email, webhook, slack
        """
        channels = channels or ["in_app"]
        dispatched = dict.fromkeys(channels, 0)

        for alert in alerts:
            for channel in channels:
                try:
                    if channel == "in_app":
                        await self._dispatch_in_app(alert)
                    elif channel == "websocket":
                        await self._dispatch_websocket(alert)
                    elif channel == "webhook":
                        await self._dispatch_webhook(alert)
                    dispatched[channel] += 1
                except Exception as exc:
                    logger.warning(f"Failed to dispatch alert to {channel}: {exc}")

        return dispatched

    async def _persist_alerts(self, alerts: list[AnomalyAlert]) -> None:
        """Store alerts in PostgreSQL for historical tracking."""
        if not alerts:
            return

        client = await self._get_postgres()
        query = """
            INSERT INTO data_platform_alerts (
                alert_id, alert_type, severity, table_name, metric,
                observed_value, expected_min, expected_max,
                deviation_percent, message, context, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (alert_id) DO NOTHING
        """

        rows = []
        for alert in alerts:
            rows.append((
                alert.alert_id,
                alert.alert_type,
                alert.severity,
                alert.table,
                alert.metric,
                alert.observed_value,
                alert.expected_range[0],
                alert.expected_range[1],
                alert.deviation_percent,
                alert.message,
                json.dumps(alert.context),
                alert.timestamp,
            ))

        async with client.acquire() as conn:
            await conn.executemany(query, rows)

    async def _dispatch_in_app(self, alert: AnomalyAlert) -> None:
        """Create an in-app notification."""
        client = await self._get_postgres()
        await client.execute(
            """
            INSERT INTO notifications (id, user_id, type, title, message, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            alert.alert_id,
            "_system",  # System-wide alert
            f"anomaly:{alert.alert_type}",
            f"Anomaly: {alert.metric}",
            alert.message,
            alert.timestamp,
        )

    async def _dispatch_websocket(self, alert: AnomalyAlert) -> None:
        """Push alert to connected WebSocket clients."""
        try:
            from eden.api.routes.websocket import _job_connections

            for job_id, connections in _job_connections.items():
                for ws in list(connections):
                    try:
                        await ws.send_json({
                            "type": "anomaly_alert",
                            "alert": alert.to_dict(),
                        })
                    except Exception:
                        connections.discard(ws)
        except ImportError:
            pass

    async def _dispatch_webhook(self, alert: AnomalyAlert) -> None:
        """Send alert to configured webhook URL."""
        webhook_url = getattr(settings, "alert_webhook_url", None)
        if not webhook_url:
            return

        try:
            import aiohttp
            async with aiohttp.ClientSession() as session:
                await session.post(
                    webhook_url,
                    json=alert.to_dict(),
                    timeout=aiohttp.ClientTimeout(total=10),
                )
        except Exception as exc:
            logger.warning(f"Webhook dispatch failed: {exc}")

    # ── API helper ─────────────────────────────────────────────────────────

    async def get_alert_history(
        self,
        alert_type: str | None = None,
        severity: str | None = None,
        since: datetime | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Get historical alerts from PostgreSQL."""
        client = await self._get_postgres()

        conditions = []
        params = []
        param_idx = 1

        if alert_type:
            conditions.append(f"alert_type = ${param_idx}")
            params.append(alert_type)
            param_idx += 1
        if severity:
            conditions.append(f"severity = ${param_idx}")
            params.append(severity)
            param_idx += 1
        if since:
            conditions.append(f"created_at >= ${param_idx}")
            params.append(since.isoformat())
            param_idx += 1

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"""
            SELECT *
            FROM data_platform_alerts
            {where}
            ORDER BY created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """
        params.extend([limit, 0])

        rows = await client.fetch(query, *params)
        return [dict(r) for r in rows]
