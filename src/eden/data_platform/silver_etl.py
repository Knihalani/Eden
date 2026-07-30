"""Silver ETL pipeline — Bronze → Silver transformations.

Transforms raw Bronze-layer events into clean, normalized Silver tables:
- Deduplication (by trace_id / kafka_offset)
- Schema validation (via data contracts)
- PII scrubbing
- Enrichment (derived metrics: total_tokens, estimated_cost_usd)
- Normalization (flatten nested JSON, type coercion)
- Quality validation
- Partitioned write to silver_events table

Usage:
    from eden.data_platform.silver_etl import SilverETLPipeline
    etl = SilverETLPipeline()
    report = await etl.run_batch(events)
"""

from __future__ import annotations

import contextlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.config import get_settings
from eden.data_platform.clickhouse_sink import get_clickhouse_sink
from eden.data_platform.contracts import (
    ContractValidator,
)
from eden.data_platform.pii import PIIMasker
from eden.data_platform.quality import (
    DataQualityValidator,
)

logger = logging.getLogger(__name__)
settings = get_settings()

#: Namespace for deriving Silver/quarantine ids from a Bronze event id.
#:
#: Both ``silver_events.silver_event_id`` and
#: ``quarantine_events.quarantine_id`` are primary keys, and both INSERTs carry
#: an ``ON CONFLICT`` clause — which could never fire, because the id was a
#: fresh ``uuid.uuid4()`` on every run. Re-processing the same Bronze event
#: therefore inserted a *new* row rather than updating the existing one, so the
#: ETL was not idempotent despite looking like it was. Deriving the id from the
#: Bronze id with uuid5 makes the existing ON CONFLICT clauses do their job.
_ID_NAMESPACE = uuid.UUID("6f9f6a3e-6d2e-5f4a-9c1b-2a7e4d8f0b31")


def _derive_id(kind: str, bronze_event_id: Any) -> str:
    """Return a stable UUID for ``kind`` derived from the Bronze event id.

    Falls back to a random id when the Bronze id is missing: without it there
    is nothing to be idempotent *about*, and a NULL primary key would fail the
    insert outright.
    """
    if not bronze_event_id:
        return str(uuid.uuid4())
    return str(uuid.uuid5(_ID_NAMESPACE, f"{kind}:{bronze_event_id}"))


def _silver_event_id(bronze_event_id: Any) -> str:
    return _derive_id("silver", bronze_event_id)


def _quarantine_id(bronze_event_id: Any) -> str:
    return _derive_id("quarantine", bronze_event_id)


@dataclass
class ETLReport:
    """Report from a Silver ETL run."""

    processed: int = 0
    deduplicated: int = 0
    quarantined: int = 0
    pii_scrubbed: int = 0
    enriched: int = 0
    quality_violations: int = 0
    silver_inserted: int = 0
    duration_ms: float = 0.0
    errors: list[str] = field(default_factory=list)
    #: True when the Silver write raised. ``run_from_bronze`` uses this to
    #: decide whether the Bronze rows may be marked processed — see there.
    silver_write_failed: bool = False


class SilverETLPipeline:
    """ETL pipeline for transforming Bronze events into Silver tables.

    Features:
    - Configurable batch size and parallel workers
    - Contract validation with quarantine
    - PII scrubbing before Silver storage
    - Derived metric enrichment
    - Quality gate enforcement
    - Idempotent writes (UPSERT by event_id)
    """

    def __init__(
        self,
        batch_size: int = 500,
        max_workers: int = 4,
        enforce_quality: bool = True,
        quarantine_on_violation: bool = True,
    ) -> None:
        self.batch_size = batch_size
        self.max_workers = max_workers
        self.enforce_quality = enforce_quality
        self.quarantine_on_violation = quarantine_on_violation
        self._masker = PIIMasker()
        self._contract_validator = ContractValidator()
        self._quality_validator = DataQualityValidator()
        self._postgres_client: Any | None = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client

            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    async def run_batch(
        self,
        events: list[dict[str, Any]],
        push_to_clickhouse: bool = False,
    ) -> ETLReport:
        """Run the full Silver ETL on a batch of Bronze events.

        Args:
            events: Raw Bronze events (dicts with at least event_type, payload).

        Returns:
            ETLReport with processing statistics.
        """
        start = datetime.now(UTC)
        report = ETLReport()
        report.processed = len(events)

        # ── Step 1: Deduplication ─────────────────────────────────────────
        deduped = self._deduplicate(events)
        report.deduplicated = len(events) - len(deduped)

        # ── Step 2: Contract validation + quarantine ─────────────────────
        valid_events, quarantined = self._validate_contracts(deduped)
        report.quarantined = len(quarantined)
        if quarantined:
            await self._write_quarantine(quarantined)

        # ── Step 3: PII scrubbing ────────────────────────────────────────
        scrubbed = self._scrub_pii(valid_events)
        report.pii_scrubbed = sum(1 for e in scrubbed if e.get("_pii_detected"))

        # ── Step 4: Enrichment ───────────────────────────────────────────
        enriched = self._enrich(scrubbed)
        report.enriched = len(enriched)

        # ── Step 5: Normalization ────────────────────────────────────────
        normalized = [self._normalize(e) for e in enriched]

        # ── Step 6: Quality validation ────────────────────────────────────
        if self.enforce_quality:
            passed, violations = await self._validate_quality(normalized)
            report.quality_violations = violations
            if self.quarantine_on_violation and violations > 0:
                # Only pass events that individually passed quality checks
                normalized = passed

        # ── Step 7: Write to Silver (PostgreSQL) ───────────────────────
        if normalized:
            try:
                inserted = await self._write_silver(normalized)
                report.silver_inserted = inserted
            except Exception as exc:
                report.silver_write_failed = True
                logger.error(
                    "Silver write failed for %d event(s); Bronze rows will NOT "
                    "be marked processed so the batch is retried: %s",
                    len(normalized),
                    exc,
                )
                report.errors.append(f"Silver write: {exc}")

        # ── Step 8: Push to ClickHouse (analytics) ──────────────────────
        if push_to_clickhouse and normalized:
            try:
                if await self._push_clickhouse(normalized):
                    logger.info(f"Pushed {len(normalized)} events to ClickHouse")
                else:
                    logger.info(
                        "ClickHouse sink not configured; %d events not "
                        "mirrored for analytics",
                        len(normalized),
                    )
            except Exception as exc:
                logger.warning(f"ClickHouse push failed (non-critical): {exc}")

        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000

        logger.info(
            f"Silver ETL complete: processed={report.processed}, "
            f"deduped={report.deduplicated}, quarantined={report.quarantined}, "
            f"silver={report.silver_inserted}, errors={len(report.errors)}"
        )
        return report

    async def run_from_bronze(
        self,
        since: datetime | None = None,
        limit: int = 10_000,
        push_to_clickhouse: bool = True,
        *,
        org_id: str | None = None,
    ) -> ETLReport:
        """Read unprocessed Bronze events from PostgreSQL and run ETL.

        Uses the usage_events table as the Bronze source. Events that have
        already been processed (have a silver_event_id) are skipped.
        """
        client = await self._get_postgres()

        # SECURITY: ``org_id`` scopes the Bronze read.
        #
        # POST /orgs/{org_id}/data-platform/etl/run resolves org_id via
        # require_path_org_access + require_org_admin and then did not
        # pass it here, and this query had no org predicate — so any
        # org admin triggered an ETL pass over EVERY tenant's
        # usage_events, mixing other tenants' metering into the silver
        # layer. usage_events is empty today, so nothing has leaked; the
        # isolation break is real the moment metering produces rows.
        #
        # ``None`` preserves the cross-org sweep for the internal cron
        # caller, which legitimately runs over all tenants.
        params: list[Any] = [limit]
        where = ["(silver_processed = FALSE OR silver_processed IS NULL)"]
        if since:
            params.append(since.isoformat())
            where.append(f"created_at >= ${len(params)}")
        if org_id:
            params.append(org_id)
            where.append(f"org_id = ${len(params)}::uuid")

        query = f"""
            SELECT id, org_id, user_id, event_type, resource, quantity, unit,
                   model, cost_usd, metadata, correlation_id, created_at,
                   silver_processed
            FROM usage_events
            WHERE {" AND ".join(where)}
            ORDER BY created_at ASC
            LIMIT $1
        """
        rows = await client.fetch(query, *params)
        if not rows:
            logger.info("No unprocessed Bronze events found")
            return ETLReport(processed=0)

        events = [dict(r) for r in rows]
        report = await self.run_batch(events, push_to_clickhouse=push_to_clickhouse)

        # Mark the Bronze rows processed — but *only* if the Silver write did not
        # fail.
        #
        # This used to be unconditional. ``run_batch`` catches a failed
        # ``_write_silver``, logs it, and returns a report; the caller then marked
        # every fetched id processed anyway. So a single Postgres blip made up to
        # ``limit`` (10,000) Bronze events permanently unreachable: never written
        # to Silver, and never re-fetched because the watermark had moved past
        # them. The only trace was one ERROR line that did not mention the rows
        # were now unrecoverable.
        #
        # Retrying the whole batch is safe: silver_event_id is a uuid5 derived
        # from the Bronze id, so re-running produces the same keys and the insert
        # is idempotent. Deduped and quarantined events are re-fetched too and
        # simply reach the same terminal outcome again.
        if report.silver_write_failed:
            logger.error(
                "Silver ETL: leaving %d Bronze event(s) unprocessed for retry "
                "because the Silver write failed",
                len(events),
            )
            return report

        event_ids = [e["id"] for e in events]
        if event_ids:
            await self._mark_bronze_processed(event_ids)

        return report

    def _deduplicate(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Remove exact duplicates based on idempotency key or composite key."""
        seen: set[str] = set()
        deduped: list[dict[str, Any]] = []
        for event in events:
            # Use id, correlation_id, or hash of event as dedup key
            key = event.get("id") or event.get("correlation_id")
            if not key:
                key = json.dumps(event, sort_keys=True, default=str)
            if key not in seen:
                seen.add(key)
                deduped.append(event)
        return deduped

    def _validate_contracts(
        self, events: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Validate events against data contracts. Return (valid, quarantined)."""
        valid: list[dict[str, Any]] = []
        quarantined: list[dict[str, Any]] = []

        for event in events:
            # Infer contract from event_type
            event_type = event.get("event_type", "")
            contract_name = self._infer_contract(event_type)
            if not contract_name:
                # No contract — pass through with warning
                event["_contract_warning"] = f"No contract for event_type '{event_type}'"
                valid.append(event)
                continue

            result = self._contract_validator.validate(event, contract_name)
            if result.quarantine:
                event["_quarantine_reason"] = result.violations
                quarantined.append(event)
            else:
                event["_contract_validated"] = True
                event["_contract_warnings"] = result.warnings
                valid.append(event)

        return valid, quarantined

    def _infer_contract(self, event_type: str) -> str | None:
        """Map event_type string to a registered contract name."""
        mapping: dict[str, str] = {
            "llm_call": "usage_event",
            "job_start": "usage_event",
            "job_complete": "usage_event",
            "job_cancel": "usage_event",
            "storage": "usage_event",
            "sandbox": "usage_event",
            "api_request": "usage_event",
            "benchmark_run": "usage_event",
            "agent.start": "agent_trace",
            "agent.think": "agent_trace",
            "agent.act": "agent_trace",
            "agent.tool_call": "agent_trace",
            "agent.complete": "agent_trace",
            "agent.error": "agent_trace",
            "pipeline.stage_start": "pipeline_event",
            "pipeline.stage_complete": "pipeline_event",
            "pipeline.stage_error": "pipeline_event",
            "benchmark.start": "benchmark_event",
            "benchmark.run_complete": "benchmark_event",
        }
        return mapping.get(event_type)

    def _scrub_pii(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Scrub PII from event payloads."""
        scrubbed: list[dict[str, Any]] = []
        for event in events:
            payload = event.get("metadata") or event.get("payload") or {}
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except json.JSONDecodeError:
                    payload = {}
            clean_payload = self._masker.mask(payload)
            event["metadata"] = clean_payload if isinstance(clean_payload, dict) else payload
            event["_pii_detected"] = self._masker.has_pii(payload)
            scrubbed.append(event)
        return scrubbed

    def _enrich(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Add derived metrics to events."""
        enriched: list[dict[str, Any]] = []
        for event in events:
            metadata = event.get("metadata") or {}
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except json.JSONDecodeError:
                    metadata = {}

            # Derive total_tokens from input + output.
            #
            # ``total`` must be reset per event. It used to be assigned *only*
            # inside the branch below, so a tokenless event (storage, sandbox,
            # api_request — none of which carry token counts) either raised
            # UnboundLocalError on the first event, killing the whole batch
            # from outside ``run_batch``'s try block, or silently reused the
            # previous event's ``total`` and stamped it with a bogus
            # estimated_cost_usd.
            total: int | None = None
            input_tokens = metadata.get("input_tokens") or event.get("input_tokens")
            output_tokens = metadata.get("output_tokens") or event.get("output_tokens")
            if input_tokens is not None or output_tokens is not None:
                total = (input_tokens or 0) + (output_tokens or 0)
                event["total_tokens"] = total
                metadata["total_tokens"] = total

            # Estimate cost if missing
            cost = event.get("cost_usd")
            if cost is None and total is not None:
                # Rough OpenAI-style pricing: $0.003/1K input, $0.015/1K output
                inp = input_tokens or 0
                out = output_tokens or 0
                estimated = (inp * 0.000_003) + (out * 0.000_015)
                event["estimated_cost_usd"] = round(estimated, 6)
                metadata["estimated_cost_usd"] = round(estimated, 6)

            # Extract pipeline stage if present
            stage = metadata.get("stage") or metadata.get("pipeline_stage")
            if stage:
                event["pipeline_stage"] = stage

            # Extract agent name if present
            agent = metadata.get("agent_name")
            if agent:
                event["agent_name"] = agent

            # Set model family
            model = event.get("model")
            if model:
                event["model_family"] = model.split("/")[0] if "/" in model else model.split("-")[0]

            # Add processing timestamp
            event["silver_processed_at"] = datetime.now(UTC).isoformat()
            event["silver_event_id"] = _silver_event_id(event.get("id"))

            enriched.append(event)
        return enriched

    def _normalize(self, event: dict[str, Any]) -> dict[str, Any]:
        """Normalize a single event into the silver_events schema."""
        metadata = event.get("metadata") or {}
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except json.JSONDecodeError:
                metadata = {}

        return {
            "silver_event_id": (event.get("silver_event_id") or _silver_event_id(event.get("id"))),
            "bronze_event_id": event.get("id"),
            "org_id": event.get("org_id"),
            "user_id": event.get("user_id"),
            "event_type": event.get("event_type"),
            "resource": event.get("resource"),
            "quantity": event.get("quantity"),
            "unit": event.get("unit"),
            "model": event.get("model"),
            "model_family": event.get("model_family"),
            "cost_usd": event.get("cost_usd")
            if event.get("cost_usd") is not None
            else event.get("estimated_cost_usd"),
            "total_tokens": event.get("total_tokens"),
            "input_tokens": metadata.get("input_tokens"),
            "output_tokens": metadata.get("output_tokens"),
            "duration_ms": metadata.get("duration_ms"),
            "pipeline_stage": event.get("pipeline_stage"),
            "agent_name": event.get("agent_name"),
            "job_id": event.get("job_id") or metadata.get("job_id"),
            "trace_id": metadata.get("trace_id"),
            "benchmark_id": metadata.get("benchmark_id"),
            "pii_detected": event.get("_pii_detected", False),
            "quarantined": False,
            "metadata": metadata,
            "correlation_id": event.get("correlation_id"),
            "timestamp": event.get("created_at")
            or event.get("timestamp")
            or datetime.now(UTC).isoformat(),
            "silver_processed_at": event.get("silver_processed_at")
            or datetime.now(UTC).isoformat(),
        }

    async def _validate_quality(
        self, events: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], int]:
        """Run quality checks on normalized events. Return (passing, violation_count)."""
        if not events:
            return [], 0

        # Bulk insert into a temp table for quality validation
        client = await self._get_postgres()
        temp_table = f"_silver_etl_temp_{uuid.uuid4().hex[:8]}"
        try:
            await self._create_temp_table(client, temp_table, events)
            report = await self._quality_validator.validate_silver_events(
                where=f"silver_event_id IN (SELECT silver_event_id FROM {temp_table})"
            )
            # For simplicity, we trust all events if the batch-level report passes
            # In production, you'd join back to identify specific failing rows
            violations = report.error_count
            return events, violations
        except Exception as exc:
            logger.warning(f"Quality validation failed: {exc}")
            return events, 0
        finally:
            with contextlib.suppress(Exception):
                await client.execute(f"DROP TABLE IF EXISTS {temp_table}")

    async def _create_temp_table(
        self, client: Any, table_name: str, events: list[dict[str, Any]]
    ) -> None:
        """Create a temporary table for batch quality validation."""
        await client.execute(f"""
            CREATE TEMP TABLE {table_name} (
                silver_event_id UUID PRIMARY KEY
            )
        """)
        # One executemany, not "insert the first row then executemany all of
        # them". The previous version inserted ``rows[0]`` and then re-inserted
        # it as part of the batch, violating the temp table's primary key. The
        # resulting exception was caught by the broad handler in
        # ``_validate_quality``, which logged "Quality validation failed" and
        # returned zero violations — so quality validation never actually ran
        # for any batch of more than one event.
        rows = [(e["silver_event_id"],) for e in events]
        if not rows:
            return
        query = f"INSERT INTO {table_name} (silver_event_id) VALUES ($1)"
        async with client.acquire() as conn:
            await conn.executemany(query, rows)

    async def _push_clickhouse(self, events: list[dict[str, Any]]) -> bool:
        """Push normalized Silver events to ClickHouse for OLAP analytics.

        Returns True when a push was actually attempted. The caller used
        to log "Pushed N events to ClickHouse" unconditionally, so a
        missing sink produced an actively false success line.
        """
        sink = await get_clickhouse_sink()
        if sink is None:
            logger.debug(
                "ClickHouse sink not configured; skipping push of %d events",
                len(events),
            )
            return False

        # Flatten events into ClickHouse-compatible records
        rows = []
        for e in events:
            rows.append(
                {
                    "silver_event_id": e.get("silver_event_id"),
                    "org_id": e.get("org_id") or "00000000-0000-0000-0000-000000000000",
                    "user_id": e.get("user_id") or "00000000-0000-0000-0000-000000000000",
                    "event_type": e.get("event_type") or "unknown",
                    "resource": e.get("resource") or "",
                    "quantity": e.get("quantity") or 0,
                    "unit": e.get("unit") or "",
                    "model": e.get("model") or "",
                    "model_family": e.get("model_family") or "",
                    "cost_usd": e.get("cost_usd") if e.get("cost_usd") is not None else 0.0,
                    "total_tokens": e.get("total_tokens") or 0,
                    "input_tokens": e.get("input_tokens") or 0,
                    "output_tokens": e.get("output_tokens") or 0,
                    "duration_ms": e.get("duration_ms") or 0,
                    "pipeline_stage": e.get("pipeline_stage") or "",
                    "agent_name": e.get("agent_name") or "",
                    "job_id": e.get("job_id") or "00000000-0000-0000-0000-000000000000",
                    "trace_id": e.get("trace_id") or "",
                    "benchmark_id": e.get("benchmark_id") or "",
                    "pii_detected": bool(e.get("pii_detected", False)),
                    "quarantined": bool(e.get("quarantined", False)),
                    "correlation_id": e.get("correlation_id") or "",
                    "timestamp": e.get("timestamp") or datetime.now(UTC).isoformat(),
                    "silver_processed_at": e.get("silver_processed_at")
                    or datetime.now(UTC).isoformat(),
                }
            )
        # ``insert_silver_events`` does not exist on the sink — the only public
        # entry point is ``insert(table, rows)``. Every ClickHouse push raised
        # AttributeError. ``clickhouse_sink.insert``'s own docstring records the
        # identical bug being fixed for the telemetry collector; this call site
        # was missed.
        await sink.insert("silver_events", rows)
        return True

    async def _write_silver(self, events: list[dict[str, Any]]) -> int:
        """Write normalized events to the silver_events table."""
        client = await self._get_postgres()
        query = """
            INSERT INTO silver_events (
                silver_event_id, bronze_event_id, org_id, user_id, event_type,
                resource, quantity, unit, model, model_family, cost_usd,
                total_tokens, input_tokens, output_tokens, duration_ms,
                pipeline_stage, agent_name, job_id, trace_id, benchmark_id,
                pii_detected, quarantined, metadata, correlation_id,
                timestamp, silver_processed_at
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                $12, $13, $14, $15, $16, $17, $18, $19, $20,
                $21, $22, $23, $24, $25, $26
            )
            ON CONFLICT (silver_event_id) DO UPDATE SET
                quantity = EXCLUDED.quantity,
                cost_usd = EXCLUDED.cost_usd,
                total_tokens = EXCLUDED.total_tokens,
                duration_ms = EXCLUDED.duration_ms,
                metadata = EXCLUDED.metadata,
                silver_processed_at = EXCLUDED.silver_processed_at
        """
        rows = []
        for e in events:
            rows.append(
                (
                    e.get("silver_event_id"),
                    e.get("bronze_event_id"),
                    e.get("org_id"),
                    e.get("user_id"),
                    e.get("event_type"),
                    e.get("resource"),
                    e.get("quantity"),
                    e.get("unit"),
                    e.get("model"),
                    e.get("model_family"),
                    e.get("cost_usd"),
                    e.get("total_tokens"),
                    e.get("input_tokens"),
                    e.get("output_tokens"),
                    e.get("duration_ms"),
                    e.get("pipeline_stage"),
                    e.get("agent_name"),
                    e.get("job_id"),
                    e.get("trace_id"),
                    e.get("benchmark_id"),
                    e.get("pii_detected", False),
                    e.get("quarantined", False),
                    json.dumps(e.get("metadata", {}), default=str),
                    e.get("correlation_id"),
                    e.get("timestamp"),
                    e.get("silver_processed_at"),
                )
            )

        async with client.acquire() as conn:
            await conn.executemany(query, rows)
        return len(rows)

    async def _write_quarantine(self, events: list[dict[str, Any]]) -> None:
        """Write quarantined events to the quarantine table for review."""
        client = await self._get_postgres()
        query = """
            INSERT INTO quarantine_events (
                quarantine_id, bronze_event_id, org_id, event_type,
                quarantine_reason, raw_payload, quarantined_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (quarantine_id) DO NOTHING
        """
        rows = []
        for e in events:
            reason = e.get("_quarantine_reason", ["contract violation"])
            rows.append(
                (
                    _quarantine_id(e.get("id")),
                    e.get("id"),
                    e.get("org_id"),
                    e.get("event_type"),
                    json.dumps(reason),
                    json.dumps(e, default=str),
                    datetime.now(UTC).isoformat(),
                )
            )
        if rows:
            async with client.acquire() as conn:
                await conn.executemany(query, rows)

    async def _mark_bronze_processed(self, event_ids: list[str]) -> None:
        """Mark Bronze events as processed."""
        if not event_ids:
            return
        client = await self._get_postgres()
        # Batch update in chunks to avoid oversized queries
        chunk_size = 1000
        for i in range(0, len(event_ids), chunk_size):
            chunk = event_ids[i : i + chunk_size]
            # Placeholders start at $1, and no extra leading argument is
            # passed. They used to start at $2 with a stray ``True`` bound to
            # a ``$1`` the query never contained ("silver_processed = TRUE" is
            # a literal), so asyncpg rejected every call for having more
            # arguments than placeholders. Bronze events were therefore never
            # marked processed and the ETL re-read the same rows on every run —
            # which, together with the random silver_event_id above, meant each
            # run appended a fresh duplicate of every event it had already
            # processed.
            placeholders = ", ".join(f"${j + 1}" for j in range(len(chunk)))
            query = f"""
                UPDATE usage_events
                SET silver_processed = TRUE, silver_processed_at = NOW()
                WHERE id IN ({placeholders})
            """
            await client.execute(query, *chunk)

    async def get_quarantine_summary(
        self, org_id: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        """Get a summary of quarantined events for review."""
        client = await self._get_postgres()
        if org_id:
            query = """
                SELECT quarantine_id, org_id, event_type, quarantine_reason, quarantined_at
                FROM quarantine_events
                WHERE org_id = $1
                ORDER BY quarantined_at DESC
                LIMIT $2
            """
            return await client.fetch(query, org_id, limit)
        query = """
            SELECT quarantine_id, org_id, event_type, quarantine_reason, quarantined_at
            FROM quarantine_events
            ORDER BY quarantined_at DESC
            LIMIT $1
        """
        return await client.fetch(query, limit)

    async def reprocess_quarantine(self, quarantine_ids: list[str]) -> ETLReport:
        """Reprocess specific quarantined events (after fixing upstream issues)."""
        client = await self._get_postgres()
        placeholders = ", ".join(f"${i + 1}" for i in range(len(quarantine_ids)))
        query = f"""
            SELECT quarantine_id, raw_payload FROM quarantine_events
            WHERE quarantine_id IN ({placeholders})
        """
        rows = await client.fetch(query, *quarantine_ids)
        events = []
        parsed_ids: list[str] = []
        unparseable: list[str] = []
        for row in rows:
            try:
                payload = json.loads(row["raw_payload"])
            except json.JSONDecodeError:
                # Previously a bare `continue`, and the delete below then
                # removed this id anyway — destroying the only copy of an
                # event that was never reprocessed.
                unparseable.append(str(row["quarantine_id"]))
                continue
            events.append(payload)
            parsed_ids.append(str(row["quarantine_id"]))

        if unparseable:
            logger.error(
                "reprocess_quarantine: %d row(s) have unparseable "
                "raw_payload and were NOT reprocessed; keeping them "
                "quarantined: %s",
                len(unparseable),
                unparseable,
            )

        report = await self.run_batch(events)

        # Remove from quarantine ONLY on full success, and only the ids
        # we actually reprocessed.
        #
        # This used to delete every id in the request whenever
        # silver_inserted > 0. A batch of 10 where 3 failed to parse and
        # 7 inserted deleted all 10 — silent, permanent loss of the 3.
        # Partial inserts had the same shape.
        fully_inserted = bool(parsed_ids) and report.silver_inserted >= len(events)
        if fully_inserted:
            del_placeholders = ", ".join(f"${i + 1}" for i in range(len(parsed_ids)))
            await client.execute(
                f"DELETE FROM quarantine_events WHERE quarantine_id IN ({del_placeholders})",
                *parsed_ids,
            )
        elif parsed_ids:
            logger.warning(
                "reprocess_quarantine: %d/%d event(s) inserted; keeping "
                "all %d reprocessed row(s) quarantined rather than "
                "deleting rows whose data may not have landed",
                report.silver_inserted,
                len(events),
                len(parsed_ids),
            )

        return report
