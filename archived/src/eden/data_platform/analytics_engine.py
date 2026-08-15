"""Analytics Engine — aggregated metrics, cohort analysis, and trend forecasting.

Computes:
- Time-series metrics (jobs, costs, quality scores over time)
- Cohort analysis (retention, activation, engagement by join date)
- Trend detection (moving averages, change rates, anomalies)
- Forecasting (simple linear extrapolation for capacity planning)
- Comparative benchmarks (org vs. global averages)

Usage:
    from eden.data_platform.analytics_engine import AnalyticsEngine
    engine = AnalyticsEngine()
    trends = await engine.get_job_trends(org_id="...", days=30)
    cohorts = await engine.get_cohort_analysis(org_id="...", period_days=90)
"""

from __future__ import annotations

import logging
import statistics
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class TimeSeriesPoint:
    """A single point in a time series."""

    timestamp: str
    value: float
    count: int = 0


@dataclass
class TrendAnalysis:
    """Trend analysis result for a metric."""

    metric_name: str
    period_days: int
    current_value: float
    previous_value: float
    change_abs: float
    change_pct: float
    direction: str  # up | down | flat
    moving_average_7d: float
    moving_average_30d: float
    data_points: list[TimeSeriesPoint] = field(default_factory=list)
    forecast_next_7d: float | None = None
    anomaly_dates: list[str] = field(default_factory=list)


@dataclass
class CohortMetrics:
    """Metrics for a single cohort."""

    cohort_label: str  # e.g., "2024-01"
    total_members: int
    active_members: int
    activation_rate: float  # % who created at least one job
    retention_day_7: float
    retention_day_30: float
    avg_jobs_per_member: float
    avg_quality_score: float
    total_cost_usd: float


@dataclass
class BenchmarkComparison:
    """Comparison of org metrics against benchmarks."""

    metric_name: str
    org_value: float
    global_avg: float
    global_p50: float
    global_p90: float
    percentile: float  # where org ranks globally (0-100)
    gap_pct: float  # % difference from global avg


class AnalyticsEngine:
    """Engine for advanced analytics on Eden platform data.

    Aggregates time-series data, computes trends, cohorts, and benchmarks
    for organizational dashboards and capacity planning.
    """

    def __init__(self) -> None:
        self._postgres_client: Any | None = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    # ── Time Series Queries ─────────────────────────────────────────────

    async def get_job_trends(
        self,
        org_id: str,
        days: int = 30,
    ) -> TrendAnalysis:
        """Analyze job creation trends over time."""
        client = await self._get_postgres()
        now = datetime.now(UTC)
        start = now - timedelta(days=days)
        prev_start = start - timedelta(days=days)

        # Daily job counts
        rows = await client.fetch(
            """
            SELECT DATE(created_at) as day, COUNT(*) as count
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2
            GROUP BY DATE(created_at)
            ORDER BY day ASC
            """,
            org_id,
            start.isoformat(),
        )

        # Previous period for comparison
        prev_rows = await client.fetch(
            """
            SELECT COUNT(*) as count
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2 AND created_at < $3
            """,
            org_id,
            prev_start.isoformat(),
            start.isoformat(),
        )

        points = [
            TimeSeriesPoint(
                timestamp=r["day"].isoformat() if hasattr(r["day"], "isoformat") else str(r["day"]),
                value=float(r["count"]),
            )
            for r in rows
        ]

        current_total = sum(p.value for p in points)
        previous_total = prev_rows[0]["count"] if prev_rows else 0

        # Moving averages
        values = [p.value for p in points]
        ma7 = self._moving_average(values, 7)
        ma30 = self._moving_average(values, 30)

        # Forecast
        forecast = self._linear_forecast(values, days=7) if len(values) >= 3 else None

        # Anomaly detection — simple z-score
        anomalies = self._detect_anomalies(points)

        change_pct = ((current_total - previous_total) / max(previous_total, 1)) * 100
        direction = "up" if change_pct > 5 else ("down" if change_pct < -5 else "flat")

        return TrendAnalysis(
            metric_name="job_count",
            period_days=days,
            current_value=current_total,
            previous_value=previous_total,
            change_abs=current_total - previous_total,
            change_pct=round(change_pct, 1),
            direction=direction,
            moving_average_7d=round(ma7, 1) if ma7 else 0.0,
            moving_average_30d=round(ma30, 1) if ma30 else 0.0,
            data_points=points,
            forecast_next_7d=round(forecast, 1) if forecast else None,
            anomaly_dates=anomalies,
        )

    async def get_quality_trends(
        self,
        org_id: str,
        days: int = 30,
    ) -> TrendAnalysis:
        """Analyze quality score trends over time."""
        client = await self._get_postgres()
        now = datetime.now(UTC)
        start = now - timedelta(days=days)
        prev_start = start - timedelta(days=days)

        rows = await client.fetch(
            """
            SELECT DATE(created_at) as day, AVG(quality_score) as avg_quality, COUNT(*) as count
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2 AND quality_score IS NOT NULL
            GROUP BY DATE(created_at)
            ORDER BY day ASC
            """,
            org_id,
            start.isoformat(),
        )

        prev_rows = await client.fetch(
            """
            SELECT AVG(quality_score) as avg_quality
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2 AND created_at < $3 AND quality_score IS NOT NULL
            """,
            org_id,
            prev_start.isoformat(),
            start.isoformat(),
        )

        points = [
            TimeSeriesPoint(
                timestamp=r["day"].isoformat() if hasattr(r["day"], "isoformat") else str(r["day"]),
                value=round(float(r["avg_quality"] or 0), 3),
                count=r["count"],
            )
            for r in rows
        ]

        current_avg = statistics.mean([p.value for p in points]) if points else 0.0
        prev_avg = prev_rows[0]["avg_quality"] if prev_rows and prev_rows[0]["avg_quality"] else current_avg

        values = [p.value for p in points]
        ma7 = self._moving_average(values, 7)
        ma30 = self._moving_average(values, 30)
        forecast = self._linear_forecast(values, days=7) if len(values) >= 3 else None
        anomalies = self._detect_anomalies(points, threshold=2.5)

        change_pct = ((current_avg - prev_avg) / max(prev_avg, 0.01)) * 100
        direction = "up" if change_pct > 2 else ("down" if change_pct < -2 else "flat")

        return TrendAnalysis(
            metric_name="quality_score",
            period_days=days,
            current_value=round(current_avg, 3),
            previous_value=round(prev_avg, 3),
            change_abs=round(current_avg - prev_avg, 3),
            change_pct=round(change_pct, 1),
            direction=direction,
            moving_average_7d=round(ma7, 3) if ma7 else 0.0,
            moving_average_30d=round(ma30, 3) if ma30 else 0.0,
            data_points=points,
            forecast_next_7d=round(forecast, 3) if forecast else None,
            anomaly_dates=anomalies,
        )

    async def get_cost_trends(
        self,
        org_id: str,
        days: int = 30,
    ) -> TrendAnalysis:
        """Analyze cost trends over time."""
        client = await self._get_postgres()
        now = datetime.now(UTC)
        start = now - timedelta(days=days)
        prev_start = start - timedelta(days=days)

        rows = await client.fetch(
            """
            SELECT DATE(timestamp) as day, SUM(cost_usd) as total_cost
            FROM silver_events
            WHERE org_id = $1 AND timestamp >= $2 AND event_type = 'llm_call'
            GROUP BY DATE(timestamp)
            ORDER BY day ASC
            """,
            org_id,
            start.isoformat(),
        )

        prev_rows = await client.fetch(
            """
            SELECT SUM(cost_usd) as total_cost
            FROM silver_events
            WHERE org_id = $1 AND timestamp >= $2 AND timestamp < $3 AND event_type = 'llm_call'
            """,
            org_id,
            prev_start.isoformat(),
            start.isoformat(),
        )

        points = [
            TimeSeriesPoint(
                timestamp=r["day"].isoformat() if hasattr(r["day"], "isoformat") else str(r["day"]),
                value=round(float(r["total_cost"] or 0), 4),
            )
            for r in rows
        ]

        current_total = sum(p.value for p in points)
        previous_total = prev_rows[0]["total_cost"] if prev_rows and prev_rows[0]["total_cost"] else 0.0

        values = [p.value for p in points]
        ma7 = self._moving_average(values, 7)
        ma30 = self._moving_average(values, 30)
        forecast = self._linear_forecast(values, days=7) if len(values) >= 3 else None
        anomalies = self._detect_anomalies(points, threshold=2.5)

        change_pct = ((current_total - previous_total) / max(previous_total, 0.0001)) * 100
        direction = "up" if change_pct > 5 else ("down" if change_pct < -5 else "flat")

        return TrendAnalysis(
            metric_name="cost_usd",
            period_days=days,
            current_value=round(current_total, 4),
            previous_value=round(previous_total, 4),
            change_abs=round(current_total - previous_total, 4),
            change_pct=round(change_pct, 1),
            direction=direction,
            moving_average_7d=round(ma7, 4) if ma7 else 0.0,
            moving_average_30d=round(ma30, 4) if ma30 else 0.0,
            data_points=points,
            forecast_next_7d=round(forecast, 4) if forecast else None,
            anomaly_dates=anomalies,
        )

    # ── Cohort Analysis ──────────────────────────────────────────────────

    async def get_cohort_analysis(
        self,
        org_id: str,
        period_days: int = 90,
    ) -> list[CohortMetrics]:
        """Analyze member cohorts by join date.

        Groups members by the month they joined and computes
        activation, retention, and engagement metrics.
        """
        client = await self._get_postgres()
        now = datetime.now(UTC)
        start = now - timedelta(days=period_days)

        # Get members who joined in the period
        members = await client.fetch(
            """
            SELECT
                user_id,
                joined_at,
                DATE_TRUNC('month', joined_at) as cohort_month
            FROM org_members
            WHERE org_id = $1 AND joined_at >= $2
            ORDER BY joined_at ASC
            """,
            org_id,
            start.isoformat(),
        )

        if not members:
            return []

        # Group by cohort month
        cohorts: dict[str, list[dict[str, Any]]] = {}
        for m in members:
            label = m["cohort_month"].strftime("%Y-%m") if hasattr(m["cohort_month"], "strftime") else str(m["cohort_month"])[:7]
            cohorts.setdefault(label, []).append(dict(m))

        results: list[CohortMetrics] = []
        for label, cohort_members in sorted(cohorts.items()):
            user_ids = [m["user_id"] for m in cohort_members]
            total = len(user_ids)

            # Activation: created at least one job
            active_count = await client.fetchval(
                """
                SELECT COUNT(DISTINCT user_id)
                FROM jobs
                WHERE org_id = $1 AND user_id = ANY($2)
                """,
                org_id,
                user_ids,
            ) or 0

            # 7-day retention: job activity within 7 days of joining
            retention_7 = await client.fetchval(
                """
                SELECT COUNT(DISTINCT user_id)
                FROM jobs
                WHERE org_id = $1 AND user_id = ANY($2)
                  AND created_at <= (
                      SELECT joined_at + INTERVAL '7 days'
                      FROM org_members
                      WHERE org_id = $1 AND user_id = jobs.user_id
                      LIMIT 1
                  )
                """,
                org_id,
                user_ids,
            ) or 0

            # 30-day retention
            retention_30 = await client.fetchval(
                """
                SELECT COUNT(DISTINCT user_id)
                FROM jobs
                WHERE org_id = $1 AND user_id = ANY($2)
                  AND created_at <= (
                      SELECT joined_at + INTERVAL '30 days'
                      FROM org_members
                      WHERE org_id = $1 AND user_id = jobs.user_id
                      LIMIT 1
                  )
                """,
                org_id,
                user_ids,
            ) or 0

            # Average jobs per member
            job_counts = await client.fetch(
                """
                SELECT user_id, COUNT(*) as count
                FROM jobs
                WHERE org_id = $1 AND user_id = ANY($2)
                GROUP BY user_id
                """,
                org_id,
                user_ids,
            )
            avg_jobs = statistics.mean([r["count"] for r in job_counts]) if job_counts else 0.0

            # Average quality score for this cohort's jobs
            quality = await client.fetchval(
                """
                SELECT AVG(quality_score)
                FROM jobs
                WHERE org_id = $1 AND user_id = ANY($2) AND quality_score IS NOT NULL
                """,
                org_id,
                user_ids,
            ) or 0.0

            # Total cost
            cost = await client.fetchval(
                """
                SELECT SUM(cost_usd)
                FROM silver_events
                WHERE org_id = $1 AND user_id = ANY($2) AND event_type = 'llm_call'
                """,
                org_id,
                user_ids,
            ) or 0.0

            results.append(CohortMetrics(
                cohort_label=label,
                total_members=total,
                active_members=active_count,
                activation_rate=round((active_count / total * 100), 1) if total > 0 else 0.0,
                retention_day_7=round((retention_7 / total * 100), 1) if total > 0 else 0.0,
                retention_day_30=round((retention_30 / total * 100), 1) if total > 0 else 0.0,
                avg_jobs_per_member=round(avg_jobs, 1),
                avg_quality_score=round(quality, 2) if quality else 0.0,
                total_cost_usd=round(cost, 4),
            ))

        return results

    # ── Benchmark Comparison ────────────────────────────────────────────

    async def get_benchmark_comparison(
        self,
        org_id: str,
        days: int = 30,
    ) -> list[BenchmarkComparison]:
        """Compare organization metrics against global averages."""
        client = await self._get_postgres()
        now = datetime.now(UTC)
        start = now - timedelta(days=days)

        metrics_to_compare = [
            ("success_rate", "success_rate", "jobs"),
            ("avg_quality_score", "avg_quality", "jobs"),
            ("avg_duration_ms", "avg_duration", "jobs"),
            ("cost_per_job", "cost_per_job", "silver_events"),
        ]

        comparisons: list[BenchmarkComparison] = []

        for metric_name, metric_col, table in metrics_to_compare:
            # Org value
            if metric_name == "success_rate":
                org_row = await client.fetchrow(
                    """
                    SELECT
                        COUNT(*) FILTER (WHERE outcome_tier IN ('gold', 'silver')) as success,
                        COUNT(*) as total
                    FROM jobs
                    WHERE org_id = $1 AND created_at >= $2
                    """,
                    org_id,
                    start.isoformat(),
                )
                org_value = (org_row["success"] / max(org_row["total"], 1) * 100) if org_row else 0.0
            elif metric_name == "cost_per_job":
                org_row = await client.fetchrow(
                    """
                    SELECT
                        (SELECT SUM(cost_usd) FROM silver_events WHERE org_id = $1 AND timestamp >= $2) as cost,
                        (SELECT COUNT(*) FROM jobs WHERE org_id = $1 AND created_at >= $2) as jobs
                    """,
                    org_id,
                    start.isoformat(),
                )
                org_value = (org_row["cost"] or 0) / max(org_row["jobs"] or 1, 1) if org_row else 0.0
            else:
                org_row = await client.fetchrow(
                    f"""
                    SELECT AVG({metric_col}) as value
                    FROM {table}
                    WHERE org_id = $1 AND created_at >= $2
                    """ if table == "jobs" else f"""
                    SELECT AVG({metric_col}) as value
                    FROM {table}
                    WHERE org_id = $1 AND timestamp >= $2
                    """,
                    org_id,
                    start.isoformat(),
                )
                org_value = org_row["value"] or 0.0

            # Global distribution
            if metric_name == "success_rate":
                global_rows = await client.fetch(
                    """
                    SELECT org_id,
                        COUNT(*) FILTER (WHERE outcome_tier IN ('gold', 'silver'))::float / NULLIF(COUNT(*), 0) * 100 as rate
                    FROM jobs
                    WHERE created_at >= $1
                    GROUP BY org_id
                    HAVING COUNT(*) >= 5
                    """,
                    start.isoformat(),
                )
                global_values = [r["rate"] for r in global_rows if r["rate"] is not None]
            elif metric_name == "cost_per_job":
                global_rows = await client.fetch(
                    """
                    SELECT
                        org_id,
                        (SELECT SUM(cost_usd) FROM silver_events se WHERE se.org_id = j.org_id AND timestamp >= $1) /
                        NULLIF(COUNT(*), 0) as cost_per_job
                    FROM jobs j
                    WHERE created_at >= $1
                    GROUP BY org_id
                    HAVING COUNT(*) >= 5
                    """,
                    start.isoformat(),
                )
                global_values = [r["cost_per_job"] for r in global_rows if r["cost_per_job"] is not None]
            else:
                global_rows = await client.fetch(
                    f"""
                    SELECT org_id, AVG({metric_col}) as value
                    FROM {table}
                    WHERE {'created_at' if table == 'jobs' else 'timestamp'} >= $1
                    GROUP BY org_id
                    HAVING COUNT(*) >= 5
                    """,
                    start.isoformat(),
                )
                global_values = [r["value"] for r in global_rows if r["value"] is not None]

            if not global_values:
                comparisons.append(BenchmarkComparison(
                    metric_name=metric_name,
                    org_value=round(org_value, 3),
                    global_avg=0.0,
                    global_p50=0.0,
                    global_p90=0.0,
                    percentile=0.0,
                    gap_pct=0.0,
                ))
                continue

            global_avg = statistics.mean(global_values)
            global_p50 = statistics.median(global_values)
            global_p90 = self._percentile(global_values, 90)

            # Compute percentile rank
            sorted_vals = sorted(global_values)
            percentile = sum(1 for v in sorted_vals if v <= org_value) / len(sorted_vals) * 100
            gap_pct = ((org_value - global_avg) / max(abs(global_avg), 0.0001)) * 100

            comparisons.append(BenchmarkComparison(
                metric_name=metric_name,
                org_value=round(org_value, 3),
                global_avg=round(global_avg, 3),
                global_p50=round(global_p50, 3),
                global_p90=round(global_p90, 3),
                percentile=round(percentile, 1),
                gap_pct=round(gap_pct, 1),
            ))

        return comparisons

    # ── Aggregate Metrics ──────────────────────────────────────────────

    async def get_aggregate_metrics(
        self,
        org_id: str,
        days: int = 30,
    ) -> dict[str, Any]:
        """Get a comprehensive metrics bundle for dashboards."""
        client = await self._get_postgres()
        now = datetime.now(UTC)
        start = now - timedelta(days=days)

        # Jobs
        job_stats = await client.fetchrow(
            """
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE outcome_tier IN ('gold', 'silver')) as successful,
                AVG(quality_score) as avg_quality,
                AVG(duration_ms) as avg_duration,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2
            """,
            org_id,
            start.isoformat(),
        )

        # Costs
        cost_stats = await client.fetchrow(
            """
            SELECT
                SUM(cost_usd) as total_cost,
                SUM(quantity) FILTER (WHERE resource = 'tokens') as total_tokens
            FROM silver_events
            WHERE org_id = $1 AND timestamp >= $2
            """,
            org_id,
            start.isoformat(),
        )

        # Members
        member_stats = await client.fetchrow(
            """
            SELECT
                COUNT(*) as total_members,
                COUNT(*) FILTER (WHERE last_active_at >= $2) as active_members
            FROM org_members
            WHERE org_id = $1
            """,
            org_id,
            start.isoformat(),
        )

        # References
        ref_count = await client.fetchval(
            "SELECT COUNT(*) FROM code_references WHERE org_id = $1",
            org_id,
        ) or 0

        # Daily breakdown
        daily = await client.fetch(
            """
            SELECT DATE(created_at) as day, COUNT(*) as count
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2
            GROUP BY DATE(created_at)
            ORDER BY day ASC
            """,
            org_id,
            start.isoformat(),
        )

        return {
            "period_days": days,
            "period_start": start.isoformat(),
            "period_end": now.isoformat(),
            "jobs": {
                "total": job_stats["total"] or 0,
                "successful": job_stats["successful"] or 0,
                "success_rate": round((job_stats["successful"] or 0) / max(job_stats["total"] or 1, 1) * 100, 1),
                "avg_quality": round(job_stats["avg_quality"] or 0, 2),
                "avg_duration_ms": round(job_stats["avg_duration"] or 0, 0),
                "p95_duration_ms": round(job_stats["p95_duration"] or 0, 0),
            },
            "costs": {
                "total_cost_usd": round(cost_stats["total_cost"] or 0, 4),
                "total_tokens": int(cost_stats["total_tokens"] or 0),
            },
            "members": {
                "total": member_stats["total_members"] or 0,
                "active": member_stats["active_members"] or 0,
                "activity_rate": round((member_stats["active_members"] or 0) / max(member_stats["total_members"] or 1, 1) * 100, 1),
            },
            "references": {"total": ref_count},
            "daily_jobs": [
                {"date": r["day"].isoformat() if hasattr(r["day"], "isoformat") else str(r["day"]), "count": r["count"]}
                for r in daily
            ],
        }

    # ── Helper Methods ──────────────────────────────────────────────────

    @staticmethod
    def _moving_average(values: list[float], window: int) -> float | None:
        if len(values) < window:
            return None
        return sum(values[-window:]) / window

    @staticmethod
    def _linear_forecast(values: list[float], days: int = 7) -> float | None:
        """Simple linear regression forecast."""
        if len(values) < 3:
            return None
        n = len(values)
        x_mean = (n - 1) / 2
        y_mean = sum(values) / n
        # Compute slope
        numerator = sum((i - x_mean) * (values[i] - y_mean) for i in range(n))
        denominator = sum((i - x_mean) ** 2 for i in range(n))
        if denominator == 0:
            return y_mean
        slope = numerator / denominator
        # Forecast next value
        next_x = n + days - 1
        return y_mean + slope * (next_x - x_mean)

    @staticmethod
    def _detect_anomalies(points: list[TimeSeriesPoint], threshold: float = 2.0) -> list[str]:
        """Detect anomalous data points using z-score."""
        if len(points) < 5:
            return []
        values = [p.value for p in points]
        mean = statistics.mean(values)
        try:
            stdev = statistics.stdev(values)
        except statistics.StatisticsError:
            return []
        if stdev == 0:
            return []
        anomalies = []
        for p in points:
            z = abs((p.value - mean) / stdev)
            if z > threshold:
                anomalies.append(p.timestamp)
        return anomalies

    @staticmethod
    def _percentile(values: list[float], p: float) -> float:
        """Compute the p-th percentile of a list."""
        sorted_vals = sorted(values)
        k = (len(sorted_vals) - 1) * (p / 100)
        f = int(k)
        c = f + 1 if f + 1 < len(sorted_vals) else f
        if f == c:
            return sorted_vals[f]
        return sorted_vals[f] * (c - k) + sorted_vals[c] * (k - f)
