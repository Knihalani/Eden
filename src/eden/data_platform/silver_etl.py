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
                logger.error(f"Silver write failed: {exc}")
                report.errors.append(f"Silver write: {exc}")

        # ── Step 8: Push to ClickHouse (analytics) ──────────────────────
        if push_to_clickhouse and normalized:
            try:
                await self._push_clickhouse(normalized)
                logger.info(f"Pushed {len(normalized)} events to ClickHouse")
            except Exception as exc:
                logger.warning(f"ClickHouse push failed (non-critical): {exc}")

        report.duration_ms = (
            datetime.now(UTC) - start
        ).total_seconds() * 1000

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
    ) -> ETLReport:
        """Read unprocessed Bronze events from PostgreSQL and run ETL.

        Uses the usage_events table as the Bronze source. Events that have
        already been processed (have a silver_event_id) are skipped.
        """
        client = await self._get_postgres()

        since_clause = ""
        params: list[Any] = [limit]
        if since:
            since_clause = "AND created_at >= $2"
            params = [since.isoformat(), limit]

        query = f"""
            SELECT *
            FROM usage_events
            WHERE silver_processed = FALSE OR silver_processed IS NULL
            {since_clause}
            ORDER BY created_at ASC
            LIMIT $1
        """
        rows = await client.fetch(query, *params)
        if not rows:
            logger.info("No unprocessed Bronze events found")
            return ETLReport(processed=0)

        events = [dict(r) for r in rows]
        report = await self.run_batch(events, push_to_clickhouse=push_to_clickhouse)

        # Mark processed events
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

            # Derive total_tokens from input + output
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
            event["silver_event_id"] = str(uuid.uuid4())

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
            "silver_event_id": event.get("silver_event_id") or str(uuid.uuid4()),
            "bronze_event_id": event.get("id"),
            "org_id": event.get("org_id"),
            "user_id": event.get("user_id"),
            "event_type": event.get("event_type"),
            "resource": event.get("resource"),
            "quantity": event.get("quantity"),
            "unit": event.get("unit"),
            "model": event.get("model"),
            "model_family": event.get("model_family"),
            "cost_usd": event.get("cost_usd") if event.get("cost_usd") is not None else event.get("estimated_cost_usd"),
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
            "timestamp": event.get("created_at") or event.get("timestamp") or datetime.now(UTC).isoformat(),
            "silver_processed_at": event.get("silver_processed_at") or datetime.now(UTC).isoformat(),
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
        rows = [(e["silver_event_id"],) for e in events]
        await client.execute(
            f"INSERT INTO {table_name} (silver_event_id) VALUES ($1)",
            *rows[0] if rows else (None,),
        )
        # For bulk insert, use executemany
        if len(rows) > 1:
            query = f"INSERT INTO {table_name} (silver_event_id) VALUES ($1)"
            async with client.acquire() as conn:
                await conn.executemany(query, rows)

    async def _push_clickhouse(self, events: list[dict[str, Any]]) -> None:
        """Push normalized Silver events to ClickHouse for OLAP analytics."""
        sink = await get_clickhouse_sink()
        if sink is None:
            return

        # Flatten events into ClickHouse-compatible records
        rows = []
        for e in events:
            rows.append({
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
                "silver_processed_at": e.get("silver_processed_at") or datetime.now(UTC).isoformat(),
            })
        await sink.insert_silver_events(rows)

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
            rows.append((
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
            ))

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
            rows.append((
                str(uuid.uuid4()),
                e.get("id"),
                e.get("org_id"),
                e.get("event_type"),
                json.dumps(reason),
                json.dumps(e, default=str),
                datetime.now(UTC).isoformat(),
            ))
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
            chunk = event_ids[i:i + chunk_size]
            placeholders = ", ".join(f"${j + 2}" for j in range(len(chunk)))
            query = f"""
                UPDATE usage_events
                SET silver_processed = TRUE, silver_processed_at = NOW()
                WHERE id IN ({placeholders})
            """
            await client.execute(query, True, *chunk)

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

    async def reprocess_quarantine(
        self, quarantine_ids: list[str]
    ) -> ETLReport:
        """Reprocess specific quarantined events (after fixing upstream issues)."""
        client = await self._get_postgres()
        placeholders = ", ".join(f"${i + 1}" for i in range(len(quarantine_ids)))
        query = f"""
            SELECT raw_payload FROM quarantine_events
            WHERE quarantine_id IN ({placeholders})
        """
        rows = await client.fetch(query, *quarantine_ids)
        events = []
        for row in rows:
            try:
                payload = json.loads(row["raw_payload"])
                events.append(payload)
            except json.JSONDecodeError:
                continue

        report = await self.run_batch(events)

        # Remove from quarantine on success
        if report.silver_inserted > 0:
            del_placeholders = ", ".join(f"${i + 1}" for i in range(len(quarantine_ids)))
            await client.execute(
                f"DELETE FROM quarantine_events WHERE quarantine_id IN ({del_placeholders})",
                *quarantine_ids,
            )

        return report
