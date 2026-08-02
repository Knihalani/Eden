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

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import aiohttp

from eden.config import get_settings
from eden.util.jsonx import dumps as _jsonx_dumps

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
    tinybird_token: str = ""

    @classmethod
    def from_settings(cls) -> ClickHouseConfig:
        s = get_settings()
        token = (
            getattr(s, "tinybird_admin_token", "")
            or getattr(s, "tinybird_branch_token", "")
            or getattr(s, "clickhouse_password", "")
            or ""
        )
        host_override = getattr(s, "tinybird_api_host", "") or ""
        url = host_override or getattr(s, "clickhouse_url", "http://localhost:8123")
        return cls(
            url=url,
            database=getattr(s, "clickhouse_database", "eden"),
            user=getattr(s, "clickhouse_user", "default"),
            password=getattr(s, "clickhouse_password", "") or token,
            timeout=getattr(s, "clickhouse_timeout", 30),
            tinybird_token=token,
        )

    @property
    def is_tinybird(self) -> bool:
        return "tinybird.co" in (self.url or "").lower()

    def qualified_table(self, table: str) -> str:
        """Return a SQL table reference valid for the active substrate.

        Tinybird datasources are workspace-scoped bare names (no
        ``database.`` prefix). Local ClickHouse uses ``db.table``.
        """
        bare = (table or "").split(".")[-1]
        if self.is_tinybird:
            return bare
        return f"{self.database}.{bare}"


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
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.config.timeout),
            )
        return self._session

    async def close(self) -> None:
        if self._session:
            await self._session.close()
            self._session = None

    async def _execute(self, query: str, params: dict | None = None) -> str:
        """Execute a ClickHouse / Tinybird SQL query via HTTP."""
        session = await self._get_session()
        if self.config.is_tinybird:
            token = self.config.tinybird_token or self.config.password
            if not token:
                raise ClickHouseError("Tinybird token missing (set TINYBIRD_ADMIN_TOKEN)")
            url = f"{self.config.url.rstrip('/')}/v0/sql"
            headers = {"Authorization": f"Bearer {token}"}
            # Tinybird SQL is SELECT-only; datasources are owned by
            # ``tb deploy``. Raise (do not silent-no-op) so callers
            # soft-fail / fall back instead of treating DDL as success.
            q = query.strip()
            upper = q.upper()
            if upper.startswith(
                ("CREATE ", "ALTER ", "DROP ", "OPTIMIZE ", "TRUNCATE ", "INSERT ")
            ):
                raise ClickHouseError(
                    "Tinybird /v0/sql rejects DDL/DML; use datasources + Events API"
                )
            # Default Tinybird response is JSON. Force TSV so
            # ``_parse_tsv`` does not silently corrupt JSON bodies.
            if "FORMAT " not in upper:
                q = f"{q.rstrip().rstrip(';')} FORMAT TabSeparatedWithNames"
            async with session.post(
                url,
                params={"q": q},
                headers=headers,
            ) as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise ClickHouseError(f"HTTP {resp.status}: {text[:500]}")
                return text

        url = f"{self.config.url.rstrip('/')}/"
        auth = (
            aiohttp.BasicAuth(self.config.user, self.config.password)
            if self.config.password
            else None
        )
        # The statement goes in the QUERY STRING, not the body.
        #
        # This used to be ``session.post(url, data={"query": query, ...})``,
        # which aiohttp form-encodes into the request body. ClickHouse's HTTP
        # interface reads the request body *as SQL*, so it received the
        # literal text ``query=SELECT+1+AS+ok`` and answered:
        #
        #   Code: 62. DB::Exception: Syntax error: failed at position 1
        #   ('query'): query=SELECT+1+AS+ok
        #
        # Every statement failed that way — verified against ClickHouse
        # 24.3, where even ``SELECT 1`` could not get through. So
        # ``initialize()`` died on its first CREATE TABLE, no schema was ever
        # built, and every insert raised. What hid it is that each caller
        # catches the exception and falls back to Postgres, so the columnar
        # path degraded to "always Postgres" while reporting nothing: the
        # subsystem had never once run.
        #
        # Extra ``params`` (ClickHouse settings such as max_execution_time)
        # are query-string parameters too, so they merge in here.
        #
        # Reads get an explicit ``FORMAT TabSeparatedWithNames``, matching what
        # the Tinybird branch above already does. ``_parse_tsv`` reads
        # ``lines[0]`` as the header, and ClickHouse's default output format is
        # plain ``TabSeparated`` with no header — so a result with one data row
        # tripped ``len(lines) < 2`` and parsed as *empty*, and a result with
        # several silently lost its first row and mislabelled every column with
        # that row's values. Six of the eight ``_parse_tsv`` call sites did not
        # add the clause themselves; two did, which is why this looked like it
        # worked wherever anyone checked.
        #
        # Restricted to read statements: appending FORMAT to a CREATE/INSERT is
        # a syntax error.
        head = query.lstrip().upper()
        if (
            head.startswith(("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"))
            and "FORMAT " not in head
        ):
            query = f"{query.rstrip().rstrip(';')} FORMAT TabSeparatedWithNames"
        qs: dict[str, Any] = {"query": query}
        if params:
            qs.update(params)
        async with session.post(url, params=qs, auth=auth) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise ClickHouseError(f"HTTP {resp.status}: {text[:500]}")
            return text

    async def init_schema(self) -> None:
        """Create ClickHouse tables if they don't exist. Idempotent.

        On Tinybird, schema is owned by ``tinybird/*.datasource`` +
        ``tb deploy`` — skip DDL so we don't burn the 1k req/day quota.
        """
        if self._initialized:
            return

        if self.config.is_tinybird:
            if not (self.config.tinybird_token or self.config.password):
                logger.warning(
                    "Tinybird host configured but TINYBIRD_ADMIN_TOKEN empty; "
                    "analytics ingest will fall back to Postgres"
                )
            self._initialized = True
            logger.info(
                "Tinybird mode: skipping DDL (datasources via tb deploy) at %s",
                self.config.url,
            )
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
            TTL toDateTime(timestamp) + INTERVAL 7 YEAR
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
            TTL toDateTime(timestamp) + INTERVAL 7 YEAR
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
            TTL toDateTime(timestamp) + INTERVAL 7 YEAR
        """)

        # telemetry_events_ch — analytics mirror of the Postgres
        # telemetry_events table (heatmap, p50/p95/p99 over millions of rows).
        # JSONB is stored as String; the portal parses on the way out. 90-day
        # TTL aligned with the Tinybird datasource + Postgres warm window;
        # cold archive holds the long tail.
        #
        # Three storage decisions here, each measured against ClickHouse 24.3
        # rather than assumed (see ``docs/ops/clickhouse-storage.md``):
        #
        # 1. ``CODEC(ZSTD(3))`` on the String columns and ``Delta, ZSTD(3)`` on
        #    the DateTime64s. No CODEC clause existed anywhere in the
        #    repository, so every column used ClickHouse's default LZ4.
        #    Measured gain is strongly data-dependent: 5.29x on realistic
        #    prose-shaped payloads, 1.21x on incompressible worst-case bytes.
        #    Delta on a monotonically-ish increasing timestamp is close to free.
        #
        # 2. A ``bloom_filter`` skip index on ``trace_id``. The sort key is
        #    ``(tenant_id, timestamp)``, but ``telemetry_events_query_api.pipe``
        #    filters on ``trace_id`` — so pulling up one trace scanned the whole
        #    partition. Measured on 120k rows: 120,000 rows / 2.23 MiB read
        #    without the index versus 13,332 rows / 255 KiB with it.
        #
        # 3. The nine payload-blob columns are gone: request_body,
        #    response_body, reasoning, tool_calls_full, tool_results, images,
        #    audio, logprobs, citations. No SELECT in this repository reads any
        #    of them from ClickHouse, and the Tinybird pipe does not either —
        #    they were written on every event and read never. They were 58.5%
        #    of the compressed table on prose-shaped data and 97.7% on
        #    high-entropy data. Postgres remains the source of truth for
        #    payloads and already zstd-compresses exactly these fields
        #    (``telemetry_collector`` writes ``request_body_zstd`` etc.), so
        #    this removes a second, *uncompressed* copy rather than the only
        #    copy. Codec plus removal measured 14.05x smaller end to end.
        #
        #    The collector still sends these keys; ``_insert_json`` sets
        #    ``input_format_skip_unknown_fields`` so they are ignored rather
        #    than failing the insert.
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.telemetry_events_ch (
                event_id           String CODEC(ZSTD(3)),
                tenant_id          String CODEC(ZSTD(3)),
                project_id         String CODEC(ZSTD(3)),
                trace_id           String CODEC(ZSTD(3)),
                realm              LowCardinality(String),
                event_type         LowCardinality(String),
                timestamp          DateTime64(3) CODEC(Delta, ZSTD(3)),
                agent_id           String CODEC(ZSTD(3)),
                agent_version      String CODEC(ZSTD(3)),
                environment_id     String CODEC(ZSTD(3)),
                span_id            String CODEC(ZSTD(3)),
                name               String CODEC(ZSTD(3)),
                duration_ms        Float64 CODEC(ZSTD(3)),
                metrics            String CODEC(ZSTD(3)),
                tags               String CODEC(ZSTD(3)),
                outcome            LowCardinality(String),
                finish_reason      LowCardinality(String),
                model              LowCardinality(String),
                model_version      String CODEC(ZSTD(3)),
                cache_hit          UInt8 CODEC(ZSTD(3)),
                prompt_cache_savings_usd Float64 CODEC(ZSTD(3)),
                ingested_at        DateTime64(3) CODEC(Delta, ZSTD(3)),
                INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1
            )
            ENGINE = MergeTree()
            PARTITION BY toYYYYMM(timestamp)
            ORDER BY (tenant_id, timestamp)
            TTL toDateTime(timestamp) + INTERVAL 90 DAY
        """)

        await self._migrate_telemetry_storage()

        # Rollups below hold pre-aggregated state, so any table left over
        # from the SummingMergeTree era has to go before the CREATEs run —
        # IF NOT EXISTS would otherwise keep the broken one forever.
        await self._migrate_rollup_engines()

        # F83 — hourly drift aggregates (outcome × agent) for Home p95 tiles.
        # Populated automatically from telemetry_events_ch inserts.
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.drift_hourly (
                tenant_id String,
                agent_id String,
                outcome LowCardinality(String),
                hour DateTime,
                event_count SimpleAggregateFunction(sum, UInt64),
                avg_duration_state AggregateFunction(avg, Float64)
            )
            ENGINE = AggregatingMergeTree()
            PARTITION BY toYYYYMM(hour)
            ORDER BY (tenant_id, agent_id, outcome, hour)
            TTL hour + INTERVAL 90 DAY
        """)

        await self._execute(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS {self.config.database}.drift_hourly_mv
            TO {self.config.database}.drift_hourly
            AS SELECT
                tenant_id,
                agent_id,
                outcome,
                toStartOfHour(timestamp) AS hour,
                toUInt64(count()) AS event_count,
                avgState(toFloat64(duration_ms)) AS avg_duration_state
            FROM {self.config.database}.telemetry_events_ch
            GROUP BY tenant_id, agent_id, outcome, hour
        """)

        # F83 — daily experiment/benchmark rollups for compare panel.
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.experiment_daily (
                tenant_id UUID,
                benchmark_id UUID,
                day Date,
                run_count SimpleAggregateFunction(sum, UInt64),
                pass_count SimpleAggregateFunction(sum, UInt64),
                avg_score_state AggregateFunction(avg, Float64),
                avg_duration_state AggregateFunction(avg, Float64)
            )
            ENGINE = AggregatingMergeTree()
            PARTITION BY toYYYYMM(day)
            ORDER BY (tenant_id, benchmark_id, day)
            TTL day + INTERVAL 90 DAY
        """)

        await self._execute(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS {self.config.database}.experiment_daily_mv
            TO {self.config.database}.experiment_daily
            AS SELECT
                tenant_id,
                benchmark_id,
                toDate(timestamp) AS day,
                toUInt64(count()) AS run_count,
                toUInt64(sum(passed)) AS pass_count,
                avgState(toFloat64(score)) AS avg_score_state,
                avgState(toFloat64(duration_ms)) AS avg_duration_state
            FROM {self.config.database}.benchmark_results
            GROUP BY tenant_id, benchmark_id, day
        """)

        # W9 — Home KPI daily rollups (trace volume, error rate, p95 latency).
        await self._execute(f"""
            CREATE TABLE IF NOT EXISTS {self.config.database}.home_kpi_daily (
                tenant_id String,
                day Date,
                event_count SimpleAggregateFunction(sum, UInt64),
                error_count SimpleAggregateFunction(sum, UInt64),
                avg_duration_state AggregateFunction(avg, Float64),
                p95_duration_state AggregateFunction(quantile(0.95), Float64)
            )
            ENGINE = AggregatingMergeTree()
            PARTITION BY toYYYYMM(day)
            ORDER BY (tenant_id, day)
            TTL day + INTERVAL 90 DAY
        """)

        await self._execute(f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS {self.config.database}.home_kpi_daily_mv
            TO {self.config.database}.home_kpi_daily
            AS SELECT
                tenant_id,
                toDate(timestamp) AS day,
                toUInt64(count()) AS event_count,
                toUInt64(countIf(outcome = 'error')) AS error_count,
                avgState(toFloat64(duration_ms)) AS avg_duration_state,
                quantileState(0.95)(toFloat64(duration_ms)) AS p95_duration_state
            FROM {self.config.database}.telemetry_events_ch
            GROUP BY tenant_id, day
        """)

        await self._apply_ttl_migrations()

        self._initialized = True
        logger.info(f"ClickHouse schema initialized in database '{self.config.database}'")

    # Read-side expressions for the rollups' aggregate-state columns.
    #
    # An ``AggregateFunction`` column is an opaque serialized state, not a
    # number: reading it needs the matching ``-Merge`` combinator, and any
    # query over the rollups must ``GROUP BY`` the sort key (or use FINAL)
    # so unmerged parts are combined. Selecting one of these columns
    # directly fails loudly, which is the point — the old plain ``Float64``
    # columns returned a wrong number instead.
    #
    # Nothing reads these three rollups today; the mapping exists so the
    # first consumer starts from the correct expression rather than
    # rediscovering ``avgMerge`` the hard way.
    ROLLUP_READ_EXPR: dict[str, str] = {
        "avg_duration_ms": "avgMerge(avg_duration_state)",
        "avg_score": "avgMerge(avg_score_state)",
        "p95_duration_ms": "quantileMerge(0.95)(p95_duration_state)",
        # SimpleAggregateFunction columns read as plain values, but still
        # need summing across parts that have not merged yet.
        "event_count": "sum(event_count)",
        "error_count": "sum(error_count)",
        "run_count": "sum(run_count)",
        "pass_count": "sum(pass_count)",
    }

    # Rollup tables that were created as SummingMergeTree and must not be.
    # Mapped to the materialized view that feeds each, because the view has
    # to be dropped first — it references the target table's columns.
    _ROLLUP_TABLES: tuple[tuple[str, str], ...] = (
        ("drift_hourly", "drift_hourly_mv"),
        ("experiment_daily", "experiment_daily_mv"),
        ("home_kpi_daily", "home_kpi_daily_mv"),
    )

    #: Payload blobs that no ClickHouse query reads. Postgres holds these
    #: zstd-compressed as the source of truth.
    _UNREAD_BLOB_COLUMNS: tuple[str, ...] = (
        "request_body",
        "response_body",
        "reasoning",
        "tool_calls_full",
        "tool_results",
        "images",
        "audio",
        "logprobs",
        "citations",
    )

    #: Columns to (re)compress in place, with the codec each should carry.
    _TELEMETRY_CODECS: tuple[tuple[str, str, str], ...] = (
        ("event_id", "String", "ZSTD(3)"),
        ("project_id", "String", "ZSTD(3)"),
        ("trace_id", "String", "ZSTD(3)"),
        ("agent_id", "String", "ZSTD(3)"),
        ("agent_version", "String", "ZSTD(3)"),
        ("environment_id", "String", "ZSTD(3)"),
        ("span_id", "String", "ZSTD(3)"),
        ("name", "String", "ZSTD(3)"),
        ("metrics", "String", "ZSTD(3)"),
        ("tags", "String", "ZSTD(3)"),
        ("model_version", "String", "ZSTD(3)"),
        ("timestamp", "DateTime64(3)", "Delta, ZSTD(3)"),
        ("ingested_at", "DateTime64(3)", "Delta, ZSTD(3)"),
    )

    async def _migrate_telemetry_storage(self) -> None:
        """Bring an existing ``telemetry_events_ch`` up to the current shape.

        Unlike the rollup engine change, none of this needs a drop: ClickHouse
        can ``MODIFY COLUMN`` a codec, ``ADD INDEX``, and ``DROP COLUMN`` in
        place, so an existing table keeps every row it has. Codec changes apply
        to newly-written parts; existing parts are recompressed lazily by
        background merges (or immediately via ``OPTIMIZE FINAL``, which this
        deliberately does not trigger — it would rewrite the whole table).

        Skipped entirely on Tinybird, where ``tb deploy`` owns the schema and
        ``_execute`` refuses DDL.
        """
        if self.config.is_tinybird:
            return
        db = self.config.database
        table = f"{db}.telemetry_events_ch"

        try:
            existing = {
                line.strip()
                for line in (
                    await self._execute(
                        "SELECT name FROM system.columns WHERE database = "
                        f"'{db}' AND table = 'telemetry_events_ch' "
                        "FORMAT TabSeparated"
                    )
                ).splitlines()
                if line.strip()
            }
        except Exception as exc:  # noqa: BLE001 — probe only
            logger.warning(
                "clickhouse: could not read %s columns, skipping storage " "migration: %s",
                table,
                exc,
            )
            return
        if not existing:
            return

        statements: list[str] = []
        for column, ch_type, codec in self._TELEMETRY_CODECS:
            if column in existing:
                statements.append(
                    f"ALTER TABLE {table} MODIFY COLUMN {column} " f"{ch_type} CODEC({codec})"
                )
        statements.append(
            f"ALTER TABLE {table} ADD INDEX IF NOT EXISTS idx_trace_id "
            "trace_id TYPE bloom_filter(0.01) GRANULARITY 1"
        )
        # Dropping the blobs is the large win but also the irreversible step,
        # so it is logged at WARNING with the reason, not applied quietly.
        droppable = [c for c in self._UNREAD_BLOB_COLUMNS if c in existing]
        if droppable:
            logger.warning(
                "clickhouse: dropping %d unread payload column(s) from %s "
                "(%s). No query in this codebase reads them from ClickHouse; "
                "Postgres holds these fields zstd-compressed as the source of "
                "truth.",
                len(droppable),
                table,
                ", ".join(droppable),
            )
            statements.extend(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {c}" for c in droppable)

        for stmt in statements:
            try:
                await self._execute(stmt)
            except Exception as exc:  # noqa: BLE001
                # Each statement is independent; one failure must not stop the
                # rest. Logged at WARNING rather than DEBUG — a silently
                # skipped storage migration is how the TTL migrations went
                # unnoticed for their entire life.
                logger.warning(
                    "clickhouse: storage migration step failed (%s): %s",
                    stmt.split(" MODIFY ")[0].split(" ADD ")[0].split(" DROP ")[0],
                    exc,
                )

    async def _migrate_rollup_engines(self) -> None:
        """Drop rollup tables still on SummingMergeTree so they get rebuilt.

        All three rollups stored averages and percentiles as plain
        ``Float64`` columns under ``SummingMergeTree``. That engine collapses
        rows sharing the sort key by *adding* every non-key numeric column,
        which is right for ``event_count`` and wrong for everything else: a
        materialized view emits one partial row per inserted block, so the
        stored average became the sum of the per-block averages and the
        stored p95 the sum of the per-block p95s.

        Measured against ClickHouse 24.3 with 1000 events over 10 insert
        blocks — true avg 201.1ms / p95 290ms, reported 2010.9ms / 2888.6ms.
        The error factor is the number of blocks that contributed to the
        key, so it grows with ingest volume and never converges;
        ``OPTIMIZE FINAL`` reproduces it exactly, because the merge is what
        does the summing. Nothing surfaced an error — the query succeeded
        and returned a plausible, arbitrary number.

        ``CREATE TABLE IF NOT EXISTS`` cannot fix an existing table, and
        ``ALTER`` cannot change a column into an ``AggregateFunction`` or
        swap the engine, so the only route is drop-and-recreate (the same
        reason ``_apply_ttl_migrations`` exists). Dropping loses history that
        was numerically wrong and, as of this change, read by nothing.
        """
        if self.config.is_tinybird:
            # Tinybird owns its datasources via ``tb deploy``; _execute
            # refuses DDL there. Nothing to do and nothing to warn about.
            return
        db = self.config.database
        for table, view in self._ROLLUP_TABLES:
            try:
                engine = (
                    await self._execute(
                        "SELECT engine FROM system.tables WHERE database = "
                        f"'{db}' AND name = '{table}' FORMAT TabSeparated"
                    )
                ).strip()
            except Exception as exc:  # noqa: BLE001 — probe only
                logger.warning(
                    "clickhouse: could not read the engine of %s.%s, leaving " "it alone: %s",
                    db,
                    table,
                    exc,
                )
                continue
            if engine != "SummingMergeTree":
                continue
            logger.warning(
                "clickhouse: %s.%s is a SummingMergeTree, which sums the "
                "averages and percentiles it stores; dropping so it is "
                "rebuilt as an AggregatingMergeTree. Existing rows are "
                "discarded — they were wrong by a factor of the insert-block "
                "count.",
                db,
                table,
            )
            # View first: it depends on the target table's columns.
            #
            # Both DROPs have to land, and the failure mode of a half-drop is
            # worse than not starting. If the view goes and the table stays,
            # ``CREATE TABLE IF NOT EXISTS`` below no-ops on the surviving
            # SummingMergeTree, then ``CREATE MATERIALIZED VIEW`` tries to write
            # ``avgState(...)`` into a ``Float64`` column and raises — aborting
            # ``init_schema`` before ``_apply_ttl_migrations`` runs, with the MV
            # now gone. The rollup stops being populated at all, which is
            # strictly worse than the wrong-but-populated state it replaced.
            #
            # So: attempt both, then verify the table is actually gone. If it
            # is not, fail loudly here rather than let init_schema wander into
            # that state.
            for stmt in (
                f"DROP VIEW IF EXISTS {db}.{view}",
                f"DROP TABLE IF EXISTS {db}.{table}",
            ):
                try:
                    await self._execute(stmt)
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        "clickhouse: %s failed; %s.%s may still hold summed " "aggregates: %s",
                        stmt,
                        db,
                        table,
                        exc,
                    )
            try:
                still_there = (
                    await self._execute(
                        "SELECT engine FROM system.tables WHERE database = "
                        f"'{db}' AND name = '{table}' FORMAT TabSeparated"
                    )
                ).strip()
            except Exception:  # noqa: BLE001 — treat an unreadable probe as gone
                still_there = ""
            if still_there:
                raise ClickHouseError(
                    f"{db}.{table} is still a {still_there} after the rollup "
                    "migration attempted to drop it. Its materialized view has "
                    "been removed, so the table is no longer being populated. "
                    "Drop the table by hand and re-run init_schema; continuing "
                    "would create an MV whose aggregate state cannot be written "
                    "to the surviving Float64 columns."
                )

    async def _apply_ttl_migrations(self) -> None:
        """Apply TTL changes to existing tables.

        CREATE TABLE IF NOT EXISTS only sets TTL on new tables; existing
        tables keep whatever TTL they were created with. This method issues
        ALTER TABLE ... MODIFY TTL so that tables created before a TTL
        change are brought in line with the desired policy.

        The statements are idempotent — ClickHouse accepts a MODIFY TTL
        even when the current TTL is already identical.
        """
        ttl_statements = [
            (
                "telemetry_events_ch",
                "toDateTime(timestamp) + INTERVAL 90 DAY",
            ),
            (
                "agent_performance",
                "toDateTime(timestamp) + INTERVAL 7 YEAR",
            ),
            (
                "pipeline_stages",
                "toDateTime(timestamp) + INTERVAL 7 YEAR",
            ),
            (
                "usage_trends",
                "hour + INTERVAL 7 YEAR",
            ),
            (
                "benchmark_results",
                "toDateTime(timestamp) + INTERVAL 7 YEAR",
            ),
            (
                "drift_hourly",
                "hour + INTERVAL 90 DAY",
            ),
            (
                "experiment_daily",
                "day + INTERVAL 90 DAY",
            ),
            (
                "home_kpi_daily",
                "day + INTERVAL 90 DAY",
            ),
        ]
        for table, ttl_expr in ttl_statements:
            try:
                await self._execute(
                    f"ALTER TABLE {self.config.database}.{table} MODIFY TTL {ttl_expr}"
                )
            except Exception as exc:
                # Table may not exist yet (first-run before CREATE TABLE runs),
                # or the CH user may lack ALTER privilege. Both are non-fatal:
                # the CREATE TABLE above already set the correct TTL for new
                # tables, and a missing ALTER on an existing table only means
                # the old TTL is kept until the next schema rebuild.
                logger.debug(
                    "TTL migration skipped for %s.%s: %s",
                    self.config.database,
                    table,
                    exc,
                )

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
        """Insert rows via ClickHouse JSONEachRow or Tinybird Events API."""
        if not rows:
            return

        session = await self._get_session()
        # orjson via jsonx — NDJSON for JSONEachRow / Tinybird Events
        body = "\n".join(_jsonx_dumps(r, default=str) for r in rows)

        if self.config.is_tinybird:
            token = self.config.tinybird_token or self.config.password
            if not token:
                raise ClickHouseError("Tinybird token missing (set TINYBIRD_ADMIN_TOKEN)")
            # Datasource names match tinybird/datasources/*.datasource
            # (no database prefix). Strip accidental ``eden.`` prefix.
            ds = table.split(".")[-1]
            url = f"{self.config.url.rstrip('/')}/v0/events"
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }
            async with session.post(
                url,
                params={"name": ds},
                data=body,
                headers=headers,
            ) as resp:
                text = await resp.text()
                if resp.status not in (200, 202):
                    raise ClickHouseError(f"HTTP {resp.status}: {text[:500]}")
            return

        url = f"{self.config.url.rstrip('/')}/"
        query = f"INSERT INTO {self.config.database}.{table} FORMAT JSONEachRow"
        auth = (
            aiohttp.BasicAuth(self.config.user, self.config.password)
            if self.config.password
            else None
        )

        # Same fix as ``_execute``: the INSERT statement is a query-string
        # parameter and the body carries only the NDJSON rows. The previous
        # ``data={"query": query, "": body}`` form-encoded both into the body,
        # so ClickHouse parsed ``query=INSERT+INTO...`` as SQL and rejected
        # every insert with a syntax error — the rows never left the process
        # and each caller quietly fell back to Postgres.
        async with session.post(
            url,
            params={
                "query": query,
                # The collector serialises its whole event dict, including the
                # payload blobs that ``telemetry_events_ch`` no longer stores,
                # so JSONEachRow has to tolerate unknown fields.
                #
                # Stated explicitly rather than relied upon: ClickHouse 24.3
                # already defaults this to 1 (verified against
                # ``system.settings``), so inserts would survive without it —
                # but the default has changed across versions and a server
                # profile or ``users.xml`` can set it to 0, at which point every
                # batch would fail with UNKNOWN_FIELD. Sending it makes the
                # requirement part of the request instead of an assumption
                # about the server. It also decouples the two schemas going
                # forward: the collector can add a field without the mirror
                # having to learn about it first.
                "input_format_skip_unknown_fields": "1",
            },
            data=body,
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
                await self._fallback_to_postgres(table, rows, error=exc)
                report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
                return report
        try:
            await self._insert_json(table, rows)
            report.rows_inserted = len(rows)
        except Exception as exc:
            logger.error(f"ClickHouse {table} insert failed: {exc}")
            report.rows_failed = len(rows)
            report.errors.append(str(exc))
            await self._fallback_to_postgres(table, rows, error=exc)
        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
        return report

    async def _fallback_to_postgres(
        self,
        table: str,
        rows: list[dict[str, Any]],
        error: Exception | str | None = None,
    ) -> None:
        """Park failed ClickHouse rows in Postgres for the drain to replay.

        The retry lives in ``data_platform/clickhouse_fallback_drain.py``,
        scheduled from ``workers/cron_tick.py``. This docstring promised
        "later retry" for a long time while no retry existed anywhere in
        ``src/`` — the rows were written, never read, never deleted.
        """
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            # error_message was never populated, so every parked row
            # carried a NULL reason. 82 rows accumulated between Jul 6
            # and Jul 24 with no diagnostic whatsoever — you could see
            # that the mirror was failing but not why. The column has
            # existed the whole time.
            query = """
                INSERT INTO clickhouse_fallback (
                    target_table, payload, failed_at, retry_count, error_message
                )
                VALUES ($1, $2, NOW(), 0, $3)
            """
            reason = (str(error)[:2000] if error else None)
            args = [
                (table, _jsonx_dumps(row, default=str), reason) for row in rows
            ]
            await client.executemany(query, args)
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
            FROM {self.config.qualified_table("agent_performance")}
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
            FROM {self.config.qualified_table("pipeline_stages")}
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

        time_bucket = "toDate(hour)" if granularity == "day" else "hour"

        query = f"""
            SELECT
                {time_bucket} as time_bucket,
                event_type,
                resource,
                sum(quantity) as total_quantity,
                sum(cost_usd) as total_cost_usd,
                count() as event_count
            FROM {self.config.qualified_table("usage_trends")}
            {where}
            GROUP BY time_bucket, event_type, resource
            ORDER BY time_bucket DESC
            LIMIT {limit}
        """
        result = await self._execute(query)
        return self._parse_tsv(result)

    async def query_home_kpis(
        self,
        tenant_id: str,
        *,
        window_hours: int = 24,
    ) -> dict[str, Any]:
        """Aggregate Home KPI tiles from telemetry_events_ch / Tinybird.

        Soft contract: callers must catch errors and fall back to Postgres.
        Uses live telemetry table (works on Tinybird without home_kpi_daily MV).

        ``cost_usd`` is not a column on ``telemetry_events_ch`` (neither the
        ClickHouse DDL nor the Tinybird datasource). Returning ``0`` keeps
        the Home KPI contract stable; cost tiles come from the ledger / PG.
        """
        hours = max(1, int(window_hours))
        # SQL-standard string-literal escape (not backslash).
        safe_tid = str(tenant_id).replace("'", "''")
        table = self.config.qualified_table("telemetry_events_ch")
        query = f"""
            SELECT
                count() AS event_count,
                countIf(outcome = 'error') AS error_count,
                avg(duration_ms) AS avg_duration_ms,
                quantile(0.95)(duration_ms) AS p95_duration_ms
            FROM {table}
            WHERE tenant_id = '{safe_tid}'
              AND timestamp >= now() - INTERVAL {hours} HOUR
            FORMAT TabSeparatedWithNames
        """
        result = await self._execute(query)
        rows = self._parse_tsv(result)
        if not rows:
            # Some CH/Tinybird paths omit header line — parse as single value row.
            parts = [p for p in (result or "").strip().split("\t") if p != ""]
            if len(parts) >= 4:
                rows = [
                    {
                        "event_count": parts[0],
                        "error_count": parts[1],
                        "avg_duration_ms": parts[2],
                        "p95_duration_ms": parts[3],
                    }
                ]
        cur = rows[0] if rows else {}
        prev_query = f"""
            SELECT count() AS event_count
            FROM {table}
            WHERE tenant_id = '{safe_tid}'
              AND timestamp < now() - INTERVAL {hours} HOUR
              AND timestamp >= now() - INTERVAL {hours * 2} HOUR
            FORMAT TabSeparatedWithNames
        """
        prev_raw = await self._execute(prev_query)
        prev_rows = self._parse_tsv(prev_raw)
        if not prev_rows:
            parts = [p for p in (prev_raw or "").strip().split("\t") if p != ""]
            if parts:
                prev_rows = [{"event_count": parts[0]}]
        prev = prev_rows[0] if prev_rows else {}
        return {
            "event_count": int(float(cur.get("event_count") or 0)),
            "error_count": int(float(cur.get("error_count") or 0)),
            "avg_duration_ms": float(cur.get("avg_duration_ms") or 0),
            "p95_duration_ms": float(cur.get("p95_duration_ms") or 0),
            "cost_usd": 0.0,
            "prev_event_count": int(float(prev.get("event_count") or 0)),
        }

    def _parse_tsv(self, tsv: str) -> list[dict[str, Any]]:
        """Parse ClickHouse / Tinybird query output into a list of dicts.

        Accepts TabSeparatedWithNames. If the body is Tinybird's default
        JSON envelope (``{"data":[...]}``), parse that instead of
        mis-reading JSON lines as TSV columns (silent corruption).
        Rows whose column count does not match the header are skipped.
        """
        if not tsv or not tsv.strip():
            return []
        stripped = tsv.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            return self._parse_json_result(stripped)
        lines = stripped.split("\n")
        if len(lines) < 2:
            return []
        headers = lines[0].split("\t")
        n_cols = len(headers)
        rows: list[dict[str, Any]] = []
        for line in lines[1:]:
            if not line:
                continue
            values = line.split("\t")
            if len(values) != n_cols:
                logger.warning(
                    "ClickHouse TSV row skipped: expected %d cols, got %d",
                    n_cols,
                    len(values),
                )
                continue
            rows.append(dict(zip(headers, values, strict=True)))
        return rows

    def _parse_json_result(self, body: str) -> list[dict[str, Any]]:
        """Parse Tinybird / CH JSON query responses; reject error envelopes."""
        import json

        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ClickHouseError(f"unparseable JSON query response: {exc}") from exc
        if isinstance(payload, dict) and payload.get("error"):
            raise ClickHouseError(f"query error: {payload.get('error')}")
        if isinstance(payload, dict) and "data" in payload:
            data = payload["data"]
            if not isinstance(data, list):
                return []
            return [r for r in data if isinstance(r, dict)]
        if isinstance(payload, list):
            return [r for r in payload if isinstance(r, dict)]
        raise ClickHouseError("unexpected JSON query response shape")

    async def health_check(self) -> str:
        """Check ClickHouse / Tinybird connectivity."""
        try:
            if self.config.is_tinybird and not (
                self.config.tinybird_token or self.config.password
            ):
                return "error: tinybird token missing"
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
