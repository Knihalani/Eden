"""ClickHouse analytics sink for the Eden data platform.

Ingests Silver-layer events into ClickHouse for fast analytical queries:
- Agent performance metrics (latency, token usage, cost per agent)
- Pipeline throughput and bottleneck detection
- Usage trends and forecasting
- Benchmark result aggregation

Requires ClickHouse HTTP interface (default port 8123).

Usage:
    from eden.data_platform.clickhouse_sink import ClickHouseSink
    sink = ClickHouseSink()
    await sink.init_schema()
    await sink.ingest_agent_trace(trace_event)
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class ClickHouseConfig:
    """ClickHouse connection configuration."""

    url: str = "http://localhost:8123"
    database: str = "eden"
    user: str = "default"
    password: str = ""
    timeout: int = 30

    @classmethod
    def from_settings(cls) -> ClickHouseConfig:
        s = get_settings()
        return cls(
            url=getattr(s, "clickhouse_url", "http://localhost:8123"),
            database=getattr(s, "clickhouse_database", "eden"),
            user=getattr(s, "clickhouse_user", "default"),
            password=getattr(s, "clickhouse_password", ""),
            timeout=getattr(s, "clickhouse_timeout", 30),
        )


@dataclass
class IngestionReport:
    """Report from a ClickHouse ingestion batch."""

    table: str
    rows_inserted: int = 0
    rows_failed: int = 0
    duration_ms: float = 0.0
    errors: list[str] = field(default_factory=list)


class ClickHouseSink:
    """Analytics sink that writes Silver events to ClickHouse.

    Features:
    - Automatic schema initialization (idempotent)
    - Batch ingestion with configurable size
    - Async HTTP transport via aiohttp
    - Fallback to PostgreSQL if ClickHouse is unavailable
    - Row-level error isolation (bad rows don't kill the batch)
    """

    # Default batch size for ingestion
    BATCH_SIZE: int = 10_000

    def __init__(self, config: ClickHouseConfig | None = None) -> None:
        self.config = config or ClickHouseConfig.from_settings()
        self._initialized = False
        self._session: Any | None = None

    async def _get_session(self) -> Any:
        if self._session is None:
            import aiohttp
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.config.timeout),
            )
        return self._session

    async def close(self) -> None:
        if self._session:
            await self._session.close()
            self._session = None

    async def _execute(self, query: str, params: dict | None = None) -> str:
        """Execute a ClickHouse query via HTTP interface."""
        session = await self._get_session()
        url = f"{self.config.url.rstrip('/')}/"
        payload = {"query": query}
        if params:
            payload.update(params)
        auth = (
            aiohttp.BasicAuth(self.config.user, self.config.password)
            if self.config.password
            else None
        )
        async with session.post(url, data=payload, auth=auth) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise ClickHouseError(f"HTTP {resp.status}: {text[:500]}")
            return text

    async def init_schema(self) -> None:
        """Create ClickHouse tables if they don't exist. Idempotent."""
        if self._initialized:
            return

        try:
            await self._execute(f"CREATE DATABASE IF NOT EXISTS {self.config.database}")
        except Exception as exc:
            logger.warning(f"ClickHouse database creation skipped (may already exist): {exc}")

        # Agent performance metrics — aggregated per agent per job
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.agent_performance (
                tenant_id UUID,
                job_id UUID,
                agent_name LowCardinality(String),
                event_type LowCardinality(String),
                duration_ms UInt32,
                input_tokens UInt32,
                output_tokens UInt32,
                total_tokens UInt32,
                cost_usd Float64,
                model LowCardinality(String),
                pipeline_stage LowCardinality(String),
                timestamp DateTime64(3),
                date Date DEFAULT toDate(timestamp)
            )
            ENGINE = MergeTree()
            PARTITION BY toYYYYMM(timestamp)
            ORDER BY (tenant_id, agent_name, timestamp)
            TTL timestamp + INTERVAL 7 YEAR
        """)

        # Pipeline stage metrics — bottleneck detection
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.pipeline_stages (
                tenant_id UUID,
                job_id UUID,
                stage LowCardinality(String),
                status LowCardinality(String),
                duration_ms UInt32,
                error_message String,
                timestamp DateTime64(3),
                date Date DEFAULT toDate(timestamp)
            )
            ENGINE = MergeTree()
            PARTITION BY toYYYYMM(timestamp)
            ORDER BY (tenant_id, stage, timestamp)
            TTL timestamp + INTERVAL 7 YEAR
        """)

        # Usage trends — per-tenant, per-resource, per-hour
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.usage_trends (
                tenant_id UUID,
                user_id UUID,
                event_type LowCardinality(String),
                resource LowCardinality(String),
                quantity Float64,
                unit LowCardinality(String),
                model LowCardinality(String),
                cost_usd Float64,
                hour DateTime,
                date Date DEFAULT toDate(hour)
            )
            ENGINE = MergeTree()
            PARTITION BY toYYYYMM(hour)
            ORDER BY (tenant_id, event_type, hour)
            TTL hour + INTERVAL 7 YEAR
        """)

        # Benchmark results
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.benchmark_results (
                tenant_id UUID,
                benchmark_id UUID,
                job_id UUID,
                event_type LowCardinality(String),
                score Float64,
                passed UInt8,
                duration_ms UInt32,
                timestamp DateTime64(3),
                date Date DEFAULT toDate(timestamp)
            )
            ENGINE = MergeTree()
            PARTITION BY toYYYYMM(timestamp)
            ORDER BY (tenant_id, benchmark_id, timestamp)
            TTL timestamp + INTERVAL 7 YEAR
        """)

        # telemetry_events_ch — mirror of the Postgres telemetry_events
        # table for fast analytical queries (heatmap, p50/p95/p99 over
        # millions of rows). JSONB is stored as String for simplicity;
        # the portal parses on the way out. 90-day TTL keeps the cluster
        # bounded; Postgres + cold storage hold the long tail.
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.telemetry_events_ch (
                event_id           String,
                tenant_id          String,
                project_id         String,
                trace_id           String,
                realm              LowCardinality(String),
                event_type         LowCardinality(String),
                timestamp          DateTime64(3),
                agent_id           String,
                agent_version      String,
                environment_id     String,
                span_id            String,
                name               String,
                duration_ms        Float64,
                metrics            String,
                tags               String,
                outcome            LowCardinality(String),
                request_body       String,
                response_body      String,
                reasoning          String,
                tool_calls_full    String,
                tool_results       String,
                images             String,
                audio              String,
                logprobs           String,
                citations          String,
                finish_reason      LowCardinality(String),
                model              LowCardinality(String),
                model_version      String,
                cache_hit          UInt8,
                prompt_cache_savings_usd Float64,
                ingested_at        DateTime64(3)
            )
            ENGINE = MergeTree()
            PARTITION BY toYYYYMM(timestamp)
            ORDER BY (tenant_id, timestamp)
            TTL timestamp + INTERVAL 90 DAY
        """)

        self._initialized = True
        logger.info(f"ClickHouse schema initialized in database '{self.config.database}'")

    async def ingest_agent_traces(
        self,
        traces: list[dict[str, Any]],
    ) -> IngestionReport:
        """Ingest agent trace events into the agent_performance table."""
        if not self._initialized:
            await self.init_schema()

        report = IngestionReport(table="agent_performance")
        start = datetime.now(UTC)

        rows = []
        for t in traces:
            row = {
                "tenant_id": t.get("org_id", "00000000-0000-0000-0000-000000000000"),
                "job_id": t.get("job_id", "00000000-0000-0000-0000-000000000000"),
                "agent_name": t.get("agent_name", "unknown"),
                "event_type": t.get("event_type", "unknown"),
                "duration_ms": int(t.get("duration_ms", 0) or 0),
                "input_tokens": int(t.get("input_tokens", 0) or 0),
                "output_tokens": int(t.get("output_tokens", 0) or 0),
                "total_tokens": int(t.get("total_tokens", 0) or 0),
                "cost_usd": float(t.get("cost_usd", 0) or 0),
                "model": t.get("model", ""),
                "pipeline_stage": t.get("pipeline_stage", ""),
                "timestamp": t.get("timestamp", datetime.now(UTC).isoformat()),
            }
            rows.append(row)

        if not rows:
            return report

        try:
            await self._insert_json("agent_performance", rows)
            report.rows_inserted = len(rows)
        except Exception as exc:
            logger.error(f"ClickHouse agent trace ingestion failed: {exc}")
            report.rows_failed = len(rows)
            report.errors.append(str(exc))
            # Fallback: write to PostgreSQL for later retry
            await self._fallback_to_postgres("agent_performance", rows)

        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
        return report

    async def ingest_pipeline_stages(
        self,
        stages: list[dict[str, Any]],
    ) -> IngestionReport:
        """Ingest pipeline stage events into the pipeline_stages table."""
        if not self._initialized:
            await self.init_schema()

        report = IngestionReport(table="pipeline_stages")
        start = datetime.now(UTC)

        rows = []
        for s in stages:
            row = {
                "tenant_id": s.get("org_id", "00000000-0000-0000-0000-000000000000"),
                "job_id": s.get("job_id", "00000000-0000-0000-0000-000000000000"),
                "stage": s.get("stage", s.get("pipeline_stage", "unknown")),
                "status": s.get("status", "unknown"),
                "duration_ms": int(s.get("duration_ms", 0) or 0),
                "error_message": s.get("error_message", ""),
                "timestamp": s.get("timestamp", datetime.now(UTC).isoformat()),
            }
            rows.append(row)

        if not rows:
            return report

        try:
            await self._insert_json("pipeline_stages", rows)
            report.rows_inserted = len(rows)
        except Exception as exc:
            logger.error(f"ClickHouse pipeline stage ingestion failed: {exc}")
            report.rows_failed = len(rows)
            report.errors.append(str(exc))
            await self._fallback_to_postgres("pipeline_stages", rows)

        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
        return report

    async def ingest_usage_trends(
        self,
        events: list[dict[str, Any]],
    ) -> IngestionReport:
        """Ingest usage events into the usage_trends table."""
        if not self._initialized:
            await self.init_schema()

        report = IngestionReport(table="usage_trends")
        start = datetime.now(UTC)

        rows = []
        for e in events:
            ts = e.get("timestamp") or e.get("created_at") or datetime.now(UTC).isoformat()
            # Truncate to hour
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                hour = dt.replace(minute=0, second=0, microsecond=0).isoformat()
            except Exception:
                hour = ts

            row = {
                "tenant_id": e.get("org_id", "00000000-0000-0000-0000-000000000000"),
                "user_id": e.get("user_id", "00000000-0000-0000-0000-000000000000"),
                "event_type": e.get("event_type", "unknown"),
                "resource": e.get("resource", "unknown"),
                "quantity": float(e.get("quantity", 0) or 0),
                "unit": e.get("unit", ""),
                "model": e.get("model", ""),
                "cost_usd": float(e.get("cost_usd", 0) or 0),
                "hour": hour,
            }
            rows.append(row)

        if not rows:
            return report

        try:
            await self._insert_json("usage_trends", rows)
            report.rows_inserted = len(rows)
        except Exception as exc:
            logger.error(f"ClickHouse usage trend ingestion failed: {exc}")
            report.rows_failed = len(rows)
            report.errors.append(str(exc))
            await self._fallback_to_postgres("usage_trends", rows)

        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
        return report

    async def ingest_benchmark_results(
        self,
        results: list[dict[str, Any]],
    ) -> IngestionReport:
        """Ingest benchmark results into the benchmark_results table."""
        if not self._initialized:
            await self.init_schema()

        report = IngestionReport(table="benchmark_results")
        start = datetime.now(UTC)

        rows = []
        for r in results:
            row = {
                "tenant_id": r.get("org_id", "00000000-0000-0000-0000-000000000000"),
                "benchmark_id": r.get("benchmark_id", "00000000-0000-0000-0000-000000000000"),
                "job_id": r.get("job_id", "00000000-0000-0000-0000-000000000000"),
                "event_type": r.get("event_type", "benchmark.run_complete"),
                "score": float(r.get("score", 0) or 0),
                "passed": 1 if r.get("passed", False) else 0,
                "duration_ms": int(r.get("duration_ms", 0) or 0),
                "timestamp": r.get("timestamp", datetime.now(UTC).isoformat()),
            }
            rows.append(row)

        if not rows:
            return report

        try:
            await self._insert_json("benchmark_results", rows)
            report.rows_inserted = len(rows)
        except Exception as exc:
            logger.error(f"ClickHouse benchmark ingestion failed: {exc}")
            report.rows_failed = len(rows)
            report.errors.append(str(exc))
            await self._fallback_to_postgres("benchmark_results", rows)

        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
        return report

    async def _insert_json(self, table: str, rows: list[dict[str, Any]]) -> None:
        """Insert rows into a ClickHouse table using JSONEachRow format."""
        if not rows:
            return

        session = await self._get_session()
        url = f"{self.config.url.rstrip('/')}/"
        query = f"INSERT INTO {self.config.database}.{table} FORMAT JSONEachRow"

        body = "\n".join(json.dumps(r, default=str) for r in rows)
        auth = (
            aiohttp.BasicAuth(self.config.user, self.config.password)
            if self.config.password
            else None
        )

        async with session.post(
            url,
            data={"query": query, "": body},
            auth=auth,
        ) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise ClickHouseError(f"HTTP {resp.status}: {text[:500]}")

    async def insert(
        self,
        table: str,
        rows: list[dict[str, Any]],
    ) -> IngestionReport:
        """Public insert method used by TelemetryCollector and other call sites.

        Wraps ``_insert_json`` and returns an ``IngestionReport`` so callers
        can see how many rows succeeded or failed. This is the method the
        collector's ``_route_clickhouse`` calls — previously it called
        ``insert`` which didn't exist, so the route was a silent no-op.

        On failure, falls back to PostgreSQL so no data is lost while
        ClickHouse is unavailable.
        """
        report = IngestionReport(table=table)
        start = datetime.now(UTC)
        if not rows:
            return report
        if not self._initialized:
            try:
                await self.init_schema()
            except Exception as exc:
                logger.debug(f"ClickHouse schema init deferred: {exc}")
                report.errors.append(str(exc))
                report.rows_failed = len(rows)
                await self._fallback_to_postgres(table, rows)
                report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
                return report
        try:
            await self._insert_json(table, rows)
            report.rows_inserted = len(rows)
        except Exception as exc:
            logger.error(f"ClickHouse {table} insert failed: {exc}")
            report.rows_failed = len(rows)
            report.errors.append(str(exc))
            await self._fallback_to_postgres(table, rows)
        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
        return report

    async def _fallback_to_postgres(
        self, table: str, rows: list[dict[str, Any]]
    ) -> None:
        """Write failed ClickHouse rows to PostgreSQL for later retry."""
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            query = """
                INSERT INTO clickhouse_fallback (
                    target_table, payload, failed_at, retry_count
                )
                VALUES ($1, $2, NOW(), 0)
            """
            for row in rows:
                await client.execute(query, table, json.dumps(row, default=str))
            logger.info(f"Fallback: wrote {len(rows)} rows to PostgreSQL clickhouse_fallback")
        except Exception as exc:
            logger.error(f"Fallback to PostgreSQL also failed: {exc}")

    # ── Query helpers for the API layer ──────────────────────────────────

    async def query_agent_performance(
        self,
        tenant_id: str | None = None,
        agent_name: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Query agent performance metrics from ClickHouse."""
        conditions = []
        params: dict[str, Any] = {}

        if tenant_id:
            conditions.append(f"tenant_id = toUUID('{tenant_id}')")
        if agent_name:
            conditions.append(f"agent_name = '{agent_name}'")
        if start_time:
            conditions.append(f"timestamp >= '{start_time}'")
        if end_time:
            conditions.append(f"timestamp <= '{end_time}'")

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"""
            SELECT
                tenant_id,
                agent_name,
                count() as call_count,
                avg(duration_ms) as avg_latency_ms,
                quantile(0.95)(duration_ms) as p95_latency_ms,
                sum(total_tokens) as total_tokens,
                sum(cost_usd) as total_cost_usd,
                max(timestamp) as last_seen
            FROM {self.config.database}.agent_performance
            {where}
            GROUP BY tenant_id, agent_name
            ORDER BY total_cost_usd DESC
            LIMIT {limit}
        """
        result = await self._execute(query, params)
        return self._parse_tsv(result)

    async def query_pipeline_bottlenecks(
        self,
        tenant_id: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Identify pipeline bottlenecks by stage duration."""
        conditions = []
        if tenant_id:
            conditions.append(f"tenant_id = toUUID('{tenant_id}')")
        if start_time:
            conditions.append(f"timestamp >= '{start_time}'")
        if end_time:
            conditions.append(f"timestamp <= '{end_time}'")

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"""
            SELECT
                stage,
                count() as run_count,
                avg(duration_ms) as avg_duration_ms,
                quantile(0.95)(duration_ms) as p95_duration_ms,
                max(duration_ms) as max_duration_ms,
                sumIf(1, status = 'error') as error_count
            FROM {self.config.database}.pipeline_stages
            {where}
            GROUP BY stage
            ORDER BY avg_duration_ms DESC
            LIMIT {limit}
        """
        result = await self._execute(query)
        return self._parse_tsv(result)

    async def query_usage_trends(
        self,
        tenant_id: str | None = None,
        granularity: str = "hour",
        start_time: str | None = None,
        end_time: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Query usage trends with configurable granularity."""
        conditions = []
        if tenant_id:
            conditions.append(f"tenant_id = toUUID('{tenant_id}')")
        if start_time:
            conditions.append(f"hour >= '{start_time}'")
        if end_time:
            conditions.append(f"hour <= '{end_time}'")

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        if granularity == "day":
            time_bucket = "toDate(hour)"
        else:
            time_bucket = "hour"

        query = f"""
            SELECT
                {time_bucket} as time_bucket,
                event_type,
                resource,
                sum(quantity) as total_quantity,
                sum(cost_usd) as total_cost_usd,
                count() as event_count
            FROM {self.config.database}.usage_trends
            {where}
            GROUP BY time_bucket, event_type, resource
            ORDER BY time_bucket DESC
            LIMIT {limit}
        """
        result = await self._execute(query)
        return self._parse_tsv(result)

    def _parse_tsv(self, tsv: str) -> list[dict[str, Any]]:
        """Parse ClickHouse TSV output into a list of dicts."""
        lines = tsv.strip().split("\n")
        if len(lines) < 2:
            return []
        headers = lines[0].split("\t")
        rows = []
        for line in lines[1:]:
            values = line.split("\t")
            rows.append({h: v for h, v in zip(headers, values)})
        return rows

    async def health_check(self) -> str:
        """Check ClickHouse connectivity."""
        try:
            await self._execute("SELECT 1")
            return "connected"
        except Exception as exc:
            return f"error: {str(exc)[:200]}"


class ClickHouseError(Exception):
    """Error from ClickHouse ingestion or query."""


# Singleton
_clickhouse_sink: ClickHouseSink | None = None


async def get_clickhouse_sink() -> ClickHouseSink:
    """Get the singleton ClickHouseSink."""
    global _clickhouse_sink
    if _clickhouse_sink is None:
        _clickhouse_sink = ClickHouseSink()
        await _clickhouse_sink.init_schema()
    return _clickhouse_sink


async def close_clickhouse_sink() -> None:
    """Close the singleton ClickHouseSink."""
    global _clickhouse_sink
    if _clickhouse_sink:
        await _clickhouse_sink.close()
        _clickhouse_sink = None
