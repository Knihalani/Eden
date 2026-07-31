"""Eden Telemetry Collector (ETC) — ingestion pipeline for observability v2.

Phase 6.5: Validates, enriches, deduplicates, and routes telemetry events
from the SDK and internal services to multiple sinks (Redis hot path,
PostgreSQL cold path, ClickHouse analytics, and real-time WebSocket fanout).

Usage:
    from eden.observability.telemetry_collector import get_telemetry_collector
    collector = await get_telemetry_collector()
    await collector.ingest(event)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.observability.bounded_expiry_cache import (
    BoundedExpiryCache,
    resolve_max_entries,
)
from eden.observability.drop_metrics import record_drop
from eden.observability.errors import IngestionUnavailable

logger = logging.getLogger(__name__)


@dataclass
class TelemetryEvent:
    """A single telemetry event from an agent or environment."""

    event_id: str
    tenant_id: str
    project_id: str
    trace_id: str
    realm: str  # "environment" | "production"
    event_type: str  # "span.start", "span.end", "tool.call", "llm.completion", "env.step", etc.
    timestamp: str  # ISO 8601
    agent_id: str | None = None
    agent_version: str | None = None
    environment_id: str | None = None
    parent_span_id: str | None = None
    span_id: str | None = None
    name: str | None = None
    duration_ms: float | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)
    attributes: dict[str, str] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    outcome: str | None = None  # "success", "failure", "partial", "timeout", "crash"
    # Phase 7.0 — which ingestion format produced this row. Defaults to
    # the existing in-process emit path. The multi-format ingestion layer
    # stamps one of: "otel", "helicone", "langfuse", "openai", "anthropic",
    # "bedrock", "gemini", "framework", "webhook". The collector also
    # backfills this for events created in-process by the SDK decorators
    # and auto-instrumentation.
    source_format: str | None = "eden_native"
    # Phase 7.2 — full LLM call capture. The decoders populate these
    # fields with the COMPLETE request/response bodies and any provider
    # extensions (reasoning, tool calls, images, logprobs, citations).
    # The transcript view in the portal renders straight from these.
    request_body: dict[str, Any] | None = None
    response_body: dict[str, Any] | None = None
    reasoning: dict[str, Any] | None = None
    tool_calls_full: list[dict[str, Any]] = field(default_factory=list)
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    images: list[dict[str, Any]] = field(default_factory=list)
    audio: list[dict[str, Any]] = field(default_factory=list)
    logprobs: dict[str, Any] | None = None
    citations: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None
    stop_sequence: str | None = None
    system_fingerprint: str | None = None
    cache_hit: bool = False
    prompt_cache_savings_usd: float | None = None
    model_version: str | None = None
    service_tier: str | None = None
    # Canonical model id for list/filter UI (also mirrored in attributes).
    model: str | None = None
    model_name: str | None = None
    # Phase A (Laminar 20x dedup) — content-addressed dedup of the
    # request/response message arrays. Each entry is the 64-char hex
    # SHA-256 of the canonical-JSON form of one message. Spans store
    # the hash array; the full payload is reconstructed at read time by
    # joining against ``trace_messages``. Empty list (the default) means
    # "no dedup was attempted" — usually because the payload had no
    # messages to extract.
    request_message_hashes: list[str] = field(default_factory=list)
    response_message_hashes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "tenant_id": self.tenant_id,
            "project_id": self.project_id,
            "trace_id": self.trace_id,
            "realm": self.realm,
            "event_type": self.event_type,
            "timestamp": self.timestamp,
            "agent_id": self.agent_id,
            "agent_version": self.agent_version,
            "environment_id": self.environment_id,
            "parent_span_id": self.parent_span_id,
            "span_id": self.span_id,
            "name": self.name,
            "duration_ms": self.duration_ms,
            "payload": self.payload,
            "metrics": self.metrics,
            "attributes": self.attributes,
            "tags": self.tags,
            "outcome": self.outcome,
            "source_format": self.source_format,
            "request_body": self.request_body,
            "response_body": self.response_body,
            "reasoning": self.reasoning,
            "tool_calls_full": self.tool_calls_full,
            "tool_results": self.tool_results,
            "images": self.images,
            "audio": self.audio,
            "logprobs": self.logprobs,
            "citations": self.citations,
            "finish_reason": self.finish_reason,
            "stop_sequence": self.stop_sequence,
            "system_fingerprint": self.system_fingerprint,
            "cache_hit": self.cache_hit,
            "prompt_cache_savings_usd": self.prompt_cache_savings_usd,
            "model_version": self.model_version,
            "service_tier": self.service_tier,
            "request_message_hashes": self.request_message_hashes,
            "response_message_hashes": self.response_message_hashes,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TelemetryEvent:
        return cls(
            event_id=data["event_id"],
            tenant_id=data["tenant_id"],
            project_id=data["project_id"],
            trace_id=data["trace_id"],
            realm=data["realm"],
            event_type=data["event_type"],
            timestamp=data["timestamp"],
            agent_id=data.get("agent_id"),
            agent_version=data.get("agent_version"),
            environment_id=data.get("environment_id"),
            parent_span_id=data.get("parent_span_id"),
            span_id=data.get("span_id"),
            name=data.get("name"),
            duration_ms=data.get("duration_ms"),
            payload=data.get("payload", {}),
            metrics=data.get("metrics", {}),
            attributes=data.get("attributes", {}),
            tags=data.get("tags", []),
            outcome=data.get("outcome"),
            source_format=data.get("source_format") or "eden_native",
            request_body=data.get("request_body"),
            response_body=data.get("response_body"),
            reasoning=data.get("reasoning"),
            tool_calls_full=data.get("tool_calls_full") or [],
            tool_results=data.get("tool_results") or [],
            images=data.get("images") or [],
            audio=data.get("audio") or [],
            logprobs=data.get("logprobs"),
            citations=data.get("citations") or [],
            finish_reason=data.get("finish_reason"),
            stop_sequence=data.get("stop_sequence"),
            system_fingerprint=data.get("system_fingerprint"),
            cache_hit=bool(data.get("cache_hit", False)),
            prompt_cache_savings_usd=data.get("prompt_cache_savings_usd"),
            model_version=data.get("model_version"),
            service_tier=data.get("service_tier"),
            request_message_hashes=data.get("request_message_hashes") or [],
            response_message_hashes=data.get("response_message_hashes") or [],
        )


@dataclass
class TraceTree:
    """Hierarchical trace tree for visualization."""

    trace_id: str
    tenant_id: str
    realm: str
    root_spans: list[dict[str, Any]]
    span_map: dict[str, dict[str, Any]]
    total_duration_ms: float
    span_count: int
    outcome: str | None = None


@dataclass
class HeatmapData:
    """Performance heatmap for a set of traces."""

    metric_name: str
    buckets: list[dict[str, Any]]  # [{"x": "tool_name", "y": "latency_ms", "value": 42}, ...]
    x_labels: list[str]
    y_labels: list[str]
    min_value: float
    max_value: float


@dataclass
class TimelineData:
    """Step timeline for a single trace."""

    trace_id: str
    steps: list[
        dict[str, Any]
    ]  # [{"name": "tool.search", "start_ms": 0, "end_ms": 120, "outcome": "success"}, ...]
    total_duration_ms: float
    markers: list[dict[str, Any]]  # [{"at_ms": 500, "label": "failure", "severity": "high"}, ...]


def _json_dumps(value: Any, *, sort_keys: bool = False) -> str:
    """Prefer A4 ``eden.util.jsonx`` when present; else compact stdlib."""
    try:
        from eden.util.jsonx import dumps as _jsonx_dumps

        if sort_keys:
            # jsonx may not accept sort_keys; fall back for hash inputs.
            return json.dumps(value, default=str, separators=(",", ":"), sort_keys=True)
        return _jsonx_dumps(value)
    except Exception:
        return json.dumps(value, default=str, separators=(",", ":"), sort_keys=sort_keys)


def _dump_jsonb(value):
    """Compact JSON serialiser used by the legacy JSONB columns.

    Returns ``None`` for ``None`` / ``{}`` / ``[]`` so the DB sees NULL
    (mirrors what compress_many does for the zstd columns); everything
    else is serialised with ``default=str, separators=(",", ":")`` —
    the compact form saves ~10% vs the stdlib default and matches
    what the compression layer writes for the ``*_zstd`` columns.

    Token metric keys are coerced to ints before serialise so jsonb
    never stores ``198.0`` (which becomes ``'198.0'`` under ``->>``
    and breaks bare ``::int`` SQL casts).
    """
    if value is None or value == {} or value == []:
        return None
    if isinstance(value, dict):
        value = _normalize_token_metrics_dict(value)
    return _json_dumps(value)


_TOKEN_METRIC_KEYS = frozenset(
    {
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "prompt_tokens",
        "completion_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
        "cached_tokens",
        "thoughts_tokens",
    }
)


def _normalize_token_metrics_dict(metrics: dict) -> dict:
    out = dict(metrics)
    for key in _TOKEN_METRIC_KEYS:
        if key not in out or out[key] is None:
            continue
        try:
            out[key] = int(float(out[key]))
        except (TypeError, ValueError):
            continue
    return out


# The one statement every telemetry write goes through, single or batched.
# Module level so ``_route_postgres`` and ``_route_postgres_many`` cannot
# drift apart -- two copies of a 48-column INSERT would.
TELEMETRY_INSERT_SQL = """
                INSERT INTO telemetry_events (
                    event_id, tenant_id, project_id, trace_id, realm,
                    event_type, timestamp, agent_id, agent_version, environment_id,
                    parent_span_id, span_id, name, duration_ms, payload,
                    metrics, attributes, tags, outcome, source_format,
                    request_body, response_body, reasoning,
                    tool_calls_full, tool_results, images, audio,
                    logprobs, citations, finish_reason, stop_sequence,
                    system_fingerprint, cache_hit, prompt_cache_savings_usd,
                    model_version, service_tier, model, model_name,
                    request_body_zstd, response_body_zstd,
                    reasoning_zstd, tool_calls_full_zstd, tool_results_zstd,
                    payload_zstd, metrics_zstd, attributes_zstd,
                    request_message_hashes, response_message_hashes,
                    created_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                    $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
                    $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
                    $41, $42, $43, $44, $45, $46, $47, $48, NOW()
                )
                ON CONFLICT (event_id, timestamp) DO NOTHING
                """


class TelemetryCollector:
    """Central telemetry ingestion and routing engine.

    Responsibilities:
      1. Validate incoming telemetry events (schema, required fields).
      2. Enrich with derived fields (hashes, fingerprinting, geohash if geo).
      3. Deduplicate via content hash (idempotent re-ingestion).
      4. Route to sinks: Redis (hot), PostgreSQL (cold), ClickHouse (analytics),
         and WebSocket fanout (real-time).
    """

    # Hot-path Redis stream maxlen per trace
    STREAM_MAXLEN = 10000
    # ClickHouse telemetry batch insert size.
    # Raised 100→250 (2026-07 Wave 2): fewer CH round-trips under SDK
    # batch flush; still flushed by CH_FLUSH_INTERVAL_S so latency bound
    # holds. K23 policy unchanged: never flush per-event.
    CH_TELEMETRY_BATCH_SIZE = 250
    # ClickHouse time-based flush (never flush after every single event)
    CH_FLUSH_INTERVAL_S = 5.0
    # Redis stream TTL + sparse EXPIRE refresh cadence
    STREAM_TTL_S = 7 * 24 * 3600
    STREAM_EXPIRE_REFRESH_S = 3600
    # Deduplication window in seconds
    DEDUP_WINDOW_SECONDS = 3600
    # Audit 2026-07-02 P-14 cap; FIFO eviction at this size.
    DEDUP_CACHE_MAX = 50_000
    _DEDUP_CACHE_MAX = 50_000  # backward-compat alias for older imports
    # Max events to keep in memory per tenant
    MAX_EVENTS_PER_TENANT = 50000

    def __init__(self) -> None:
        self._redis: Any = None
        self._postgres: Any = None
        self._clickhouse: Any = None
        # Audit 2026-07-02 P-14: OrderedDict for O(1) FIFO eviction
        # at the 50k cap. ``dict`` is insertion-ordered in CPython
        # 3.7+ but the type system is happier with the explicit
        # ``OrderedDict`` (and the test asserts
        # ``popitem(last=False)`` which is OrderedDict-specific).
        self._dedup_cache: OrderedDict[str, float] = OrderedDict()
        self._tenant_event_counts: dict[str, int] = defaultdict(int)
        self._ch_telemetry_buffer: list[dict[str, Any]] = []
        self._ch_buffer_lock = asyncio.Lock()
        self._ch_flush_task: asyncio.Task[None] | None = None
        # Bounded: stream keys are per-trace, so this map would otherwise
        # grow one entry per trace for the process lifetime. Same shape as
        # ``_step_expire_at`` in ingestion/checkpoint_hook.py.
        self._stream_expire_at = BoundedExpiryCache(resolve_max_entries())
        self._bg_tasks: set[asyncio.Task[Any]] = set()

    # ── Sink accessors ────────────────────────────────────────────────────

    async def _get_redis(self) -> Any:
        if self._redis is not None:
            return self._redis
        try:
            from eden.storage.redis import get_redis_client

            self._redis = await get_redis_client()
        except Exception as exc:
            logger.warning(f"Redis unavailable for telemetry: {exc}")
        return self._redis

    async def _get_postgres(self) -> Any:
        if self._postgres is not None:
            return self._postgres
        try:
            from eden.storage.postgres import get_postgres_client

            self._postgres = await get_postgres_client()
        except Exception as exc:
            logger.warning(f"Postgres unavailable for telemetry: {exc}")
        return self._postgres

    async def _get_clickhouse(self) -> Any:
        if self._clickhouse is not None:
            return self._clickhouse
        try:
            from eden.data_platform.clickhouse_sink import get_clickhouse_sink

            self._clickhouse = await get_clickhouse_sink()
        except Exception as exc:
            logger.debug(f"ClickHouse unavailable for telemetry: {exc}")
        return self._clickhouse

    # ── Public API ────────────────────────────────────────────────────────

    @staticmethod
    def _single_result(**counts: int) -> dict[str, int]:
        """One event's outcome in ``ingest_batch``'s count shape."""
        result = {
            "accepted": 0,
            "deduplicated": 0,
            "rejected": 0,
            "sampled_out": 0,
            "total": 1,
        }
        result.update(counts)
        return result

    async def ingest(self, event: TelemetryEvent) -> bool:
        """Ingest a single telemetry event.

        Returns True if the event was **stored**, False otherwise —
        rejected, deduplicated, or sampled out.

        A bool cannot say *why*, and for the ingest routes the difference
        matters: a sampled-out event is neither an error nor a duplicate,
        and reporting it as either misleads the SDK. Callers that need
        the breakdown should use :meth:`ingest_one`.
        """
        return (await self.ingest_one(event))["accepted"] == 1

    async def ingest_one(self, event: TelemetryEvent) -> dict[str, int]:
        """Ingest a single event, returning ``ingest_batch``'s count shape.

        Exactly one of ``accepted`` / ``deduplicated`` / ``rejected`` /
        ``sampled_out`` is 1; ``total`` is always 1. ``accepted`` means
        *stored* — see :meth:`ingest_batch` for why sampled-out events are
        counted separately rather than folded in.
        """
        # 1. Validate
        if not self._validate(event):
            return self._single_result(rejected=1)

        # 1b. Late-span policy (W9)
        try:
            from eden.observability.ingestion.late_span import evaluate_late_span

            if evaluate_late_span(event) == "reject":
                return self._single_result(rejected=1)
        except Exception:
            pass

        # 2. Enrich
        self._enrich(event)

        # 3. Deduplicate
        if self._is_duplicate(event):
            logger.debug(f"Telemetry event {event.event_id} deduplicated")
            return self._single_result(deduplicated=1)

        # 3b. N16 intelligence-aware sampling (soft-launch default: full /
        # 100% keep). When EDEN_SAMPLING_PROFILE=balanced|aggressive,
        # sampled-out events get a metrics-only summary and skip sinks.
        try:
            from eden.observability.sampling.apply import should_route_event

            if not await should_route_event(event):
                # Skips all six sinks, so it is not stored and must not be
                # reported as accepted — it is reported as ``sampled_out``.
                record_drop("sample", "sampled_out")
                logger.debug(
                    "Telemetry event %s sampled out (N16 metrics-only)",
                    event.event_id,
                )
                return self._single_result(sampled_out=1)
        except Exception:  # noqa: BLE001 — never fail ingest for sampling
            pass

        # 4. Per-tenant limit. DL-2: instead of dropping events when
        # the cap is hit, reset the counter to 0 and accept the
        # event. The cap is a soft rate-limit (it bounds the size of
        # the in-memory _tenant_event_counts dict), not a hard
        # admission-control gate.
        if self._tenant_event_counts[event.tenant_id] >= self.MAX_EVENTS_PER_TENANT:
            logger.warning(
                f"Telemetry per-tenant counter hit cap; " f"resetting for tenant {event.tenant_id}",
            )
            self._tenant_event_counts[event.tenant_id] = 0
        self._tenant_event_counts[event.tenant_id] += 1

        # 5. Route to sinks (CH flushes on size>=100 or <=5s timer — not here).
        #    On failure the dedup reservation is released so the SDK's retry is
        #    not rejected as a duplicate — see ``_release_dedup``.
        try:
            await self._route(event)
        except BaseException:
            self._release_dedup(event)
            raise

        # 5b. Phase 7.x — billing roll-up (deferred; must not block ingest).
        #
        # ``ingest_batch`` has always done this; this single-event path never
        # did, so every event arriving through it — including the live
        # ``POST /observability/events`` route and the Kafka consumer — was
        # routed to the sinks and stored but never billed. The two paths must
        # agree on what constitutes a billable event, so the same call is made
        # here rather than being folded into ``_route``.
        self._spawn_bg(self._emit_billing_events([event]))

        # F03 — best-effort debugger checkpoint (fire-and-forget).
        try:
            from eden.observability.ingestion.checkpoint_hook import (
                maybe_persist_checkpoint,
            )

            self._spawn_bg(maybe_persist_checkpoint(event))
        except Exception:  # noqa: BLE001 — never fail ingest for debugger
            pass
        # Discover agents in the portal from SDK agent_id without a
        # separate /agents/register call.
        self._spawn_bg(self._touch_agent_registrations([event]))
        return self._single_result(accepted=1)

    async def ingest_batch(self, events: list[TelemetryEvent]) -> dict[str, Any]:
        """Ingest a batch of telemetry events.

        Returns a summary dict with counts of accepted, deduplicated,
        rejected and sampled_out.

        ``accepted`` means *stored*. Sampled-out events used to be folded
        into it, which made the number the API hands back to the SDK
        larger than the number of events Eden can actually show the
        customer — and larger than the number it bills for, since the
        billing roll-up correctly only sees routed events. The two
        disagreed with nothing in the response to explain why.
        ``sampled_out`` is that explanation.

        Audit 2026-07-02 P-2: validate/enrich/dedup pre-pass is
        sequential (it mutates ``_tenant_event_counts`` /
        ``_dedup_cache``); the per-event ``_route`` step is
        fired in parallel via ``asyncio.gather`` to collapse
        round-trip latency on batches of 10+ events.
        """
        accepted = 0
        deduplicated = 0
        rejected = 0
        sampled_out = 0
        to_route: list[TelemetryEvent] = []

        # Pre-pass MUST be sequential — concurrent writes to
        # ``_dedup_cache`` and ``_tenant_event_counts`` would race.
        for event in events:
            if not self._validate(event):
                rejected += 1
                continue
            try:
                from eden.observability.ingestion.late_span import evaluate_late_span

                if evaluate_late_span(event) == "reject":
                    rejected += 1
                    continue
            except Exception:
                pass
            self._enrich(event)
            if self._is_duplicate(event):
                deduplicated += 1
                continue
            # N16 sampling — see ingest_one(). Sampled-out events are
            # reported under their own count, never as accepted: they are
            # not stored, and they are not billed either.
            try:
                from eden.observability.sampling.apply import should_route_event

                if not await should_route_event(event):
                    record_drop("sample", "sampled_out")
                    sampled_out += 1
                    continue
            except Exception:  # noqa: BLE001
                pass
            if self._tenant_event_counts[event.tenant_id] >= self.MAX_EVENTS_PER_TENANT:
                # DL-2: reset on cap rather than drop.
                self._tenant_event_counts[event.tenant_id] = 0
            self._tenant_event_counts[event.tenant_id] += 1
            to_route.append(event)
            accepted += 1

        # Per-event routing in parallel.
        #
        # ``return_exceptions=True`` matters here. A bare gather propagates the
        # first per-event failure straight out of ``ingest_batch``, which
        # abandons the billing roll-up and the checkpoint hooks below for the
        # *whole* batch — including every event that routed successfully — and
        # returns a 500 to a client whose events were partly stored. The retry
        # that follows is safe because the Postgres write is
        # ``ON CONFLICT (event_id, timestamp) DO NOTHING``, so re-sending the
        # batch cannot double-count.
        #
        # The result is deliberately *not* folded back into ``rejected``: the
        # SDK acks on any 2xx, so reporting a partial failure in the response
        # body would let the client discard events it still needs to retry.
        # Failures are logged and counted instead.
        if to_route:
            # The durable write goes first, and as ONE statement.
            #
            # It used to ride along inside the per-event ``_route`` fan-out,
            # which had two problems. Correctness: ``RLSOrgContextMiddleware``
            # pins one pooled connection per request and asyncpg permits one
            # operation in flight per connection, so N concurrent INSERTs on
            # the pinned connection collided — 9 of 10 raising
            # ``InterfaceError``, each wrapped as ``IngestionUnavailable``,
            # which 503'd the whole batch. (``RequestConnLease.use`` now
            # serialises that, so the collision is fixed either way; batching
            # means there is nothing left to serialise.) Performance:
            # ``executemany`` beats N separate INSERTs by 2.56-3.42x across
            # batch sizes 10-200, and by more over the production DSN where a
            # round trip is expensive. See ``_route_postgres_many``.
            #
            # Raised, not gathered: a single statement in a single transaction
            # either lands or does not, and "it did not" means nothing in this
            # batch is stored. That is precisely ``IngestionUnavailable``, and
            # the handler below already releases every dedup reservation for
            # it so the SDK's retry is not rejected as duplicate.
            try:
                await self._route_postgres_many(to_route)
            except Exception:
                for event in to_route:
                    self._release_dedup(event)
                record_drop("queue", "write_error", len(to_route))
                raise

            # The five non-durable sinks stay per-event and concurrent: they
            # are independent, individually fail-soft, and none of them is the
            # store of record.
            results = await asyncio.gather(
                *(self._route(event, skip_postgres=True) for event in to_route),
                return_exceptions=True,
            )
            failures = [r for r in results if isinstance(r, BaseException)]

            # ``IngestionUnavailable`` is not a per-event failure — it means the
            # store is down, so nothing in this batch landed. It must still
            # propagate: the caller turns it into a 503 and the SDK retries.
            # Swallowing it would silently discard the batch while telling the
            # client it succeeded.
            unavailable = next((f for f in failures if isinstance(f, IngestionUnavailable)), None)
            if unavailable is not None:
                # Nothing in this batch landed, so every reservation must go —
                # otherwise the SDK's retry is rejected wholesale and the entire
                # batch is lost while the store recovers.
                for event in to_route:
                    self._release_dedup(event)
                raise unavailable

            if failures:
                # Release the dedup reservation for each event that failed, so
                # the SDK's retry of this batch is not rejected as duplicate.
                # ``gather`` preserves input order, so results[i] belongs to
                # to_route[i].
                for event, result in zip(to_route, results, strict=True):
                    if isinstance(result, BaseException):
                        self._release_dedup(event)
                record_drop("queue", "write_error", len(failures))
                logger.error(
                    "telemetry_collector: %d/%d events failed to route " "(first: %s: %s)",
                    len(failures),
                    len(to_route),
                    type(failures[0]).__name__,
                    failures[0],
                )

        # Phase 7.x — billing roll-up (deferred; must not block ingest).
        self._spawn_bg(self._emit_billing_events(list(to_route)))
        # F03 — best-effort debugger checkpoints (fire-and-forget).
        try:
            from eden.observability.ingestion.checkpoint_hook import (
                maybe_persist_checkpoint,
            )

            for ev in to_route:
                self._spawn_bg(maybe_persist_checkpoint(ev))
        except Exception:  # noqa: BLE001
            pass
        self._spawn_bg(self._touch_agent_registrations(list(to_route)))

        return {
            "accepted": accepted,
            "deduplicated": deduplicated,
            "rejected": rejected,
            "sampled_out": sampled_out,
            "total": len(events),
        }

    async def _emit_billing_events(self, events: list[TelemetryEvent]) -> None:
        """Record a ``usage_events`` row for every LLM completion event.

        Mirrors what :func:`eden.services.usage_service.UsageService.track_event`
        accepts: a single quantity + USD cost for the event. We compute
        the cost on the server from the token counts the SDK already
        shipped so the SDK never has to ship a pricing model.

        Only ``llm.completion`` / ``llm_completion`` /
        ``llm_completion_stream`` event types carry billing signal —
        everything else (spans, tool calls, agent runs) is silently
        skipped here and rolled up via other surfaces (job_start,
        storage_mb, …).
        """
        # Local imports so the collector doesn't pull in usage_service
        # at module load (avoids circular imports in some test setups).
        try:
            from eden.services.usage_service import UsageService
        except Exception:  # pragma: no cover — usage service unavailable
            return

        try:
            service = UsageService()
        except Exception:
            return

        # Event types that carry a billable LLM call. Anything that
        # the SDK's auto-instrumentation emits AND any of the
        # server-side decoder normalizations (openai.chat_completion,
        # anthropic.message, bedrock.invoke_model, …).
        BILLABLE_EVENT_TYPES = frozenset(
            {
                "llm.completion",
                "llm_completion",
                "llm_completion_stream",
                "openai.chat_completion",
                "anthropic.message",
                "bedrock.invoke_model",
                "gemini.generate_content",
                "helicone.request",
                "langfuse.observation",
                "otel.llm_completion",
            }
        )

        pending: list[Any] = []
        for event in events:
            if event.event_type not in BILLABLE_EVENT_TYPES:
                continue
            metrics = event.metrics or {}
            input_tokens = float(metrics.get("input_tokens") or 0)
            output_tokens = float(metrics.get("output_tokens") or 0)
            cache_read = float(metrics.get("cache_read_tokens") or 0)
            cache_write = float(
                metrics.get("cache_creation_tokens")
                or metrics.get("cache_creation_input_tokens")
                or 0
            )
            total = input_tokens + output_tokens + cache_read + cache_write
            if total <= 0:
                # The provider did not report token usage (e.g.
                # an o1 reasoning call without the ``usage`` block
                # populated yet, or an error event). Skip rather
                # than bill 0 tokens at 0 cost.
                continue
            # Pull the model name from the most reliable field, in
            # order: ``payload.model_normalized`` (preferred — strips
            # dated suffixes) > ``model_version`` > ``payload.model``.
            model = (
                (event.payload or {}).get("model_normalized")
                or event.model_version
                or (event.payload or {}).get("model")
                or "unknown"
            )
            cost_usd = None
            try:
                from eden.llmops.pricing import estimate_cost_usd

                stamped = (event.metrics or {}).get("cost_usd")
                if stamped is not None:
                    cost_usd = float(stamped)
                else:
                    cost_usd = estimate_cost_usd(
                        model=str(model),
                        input_tokens=int(input_tokens),
                        output_tokens=int(output_tokens),
                        cache_read_tokens=int(cache_read),
                        cache_write_tokens=int(cache_write),
                    )
            except Exception:  # noqa: BLE001
                cost_usd = None
            pending.append(
                service.track_event(
                    org_id=event.tenant_id,
                    event_type="llm_call",
                    resource=str(model),
                    quantity=total,
                    unit="tokens",
                    user_id=None,
                    model=str(model),
                    cost_usd=cost_usd,
                    metadata={
                        "input_tokens": int(input_tokens),
                        "output_tokens": int(output_tokens),
                        "cache_read_tokens": int(cache_read),
                        "cache_creation_tokens": int(cache_write),
                        "source_format": event.source_format,
                        "event_id": event.event_id,
                        "trace_id": event.trace_id,
                    },
                    correlation_id=event.event_id,
                )
            )
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    def _spawn_bg(self, coro: Any) -> None:
        """Fire-and-forget a coroutine; keep a strong ref until done.

        CRITICAL: strip the request-pinned Postgres connection from the
        task's context. ``asyncio.create_task`` copies the caller's
        ``contextvars.Context``, so a bare create_task here would let
        billing / checkpoint / agent-registration work share the
        RLS-pinned connection that ``RLSOrgContextMiddleware`` still
        holds open for the ingest write. Concurrent use of that
        connection raises ``InterfaceError: another operation is in
        progress``, aborts the middleware transaction, and the later
        COMMIT fails — while the handler has already returned
        ``accepted: 1``. Traces vanish. Same pattern as
        ``webhook_delivery`` / ``copy_context_without_request_pg_conn``.
        """
        try:
            from eden.storage.postgres import copy_context_without_request_pg_conn

            task = asyncio.create_task(
                coro,
                context=copy_context_without_request_pg_conn(),
            )
        except TypeError:
            # Python < 3.11 has no create_task(context=...); fall back
            # without the strip rather than dropping the work entirely.
            try:
                task = asyncio.create_task(coro)
            except RuntimeError:
                return
        except RuntimeError:
            return
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    async def _touch_agent_registrations(self, events: list[TelemetryEvent]) -> None:
        """Upsert ``agent_registrations`` from ingested ``agent_id`` values.

        Portal Agents is registry-first; telemetry-only discovery is a
        fallback. Touching the registry on ingest means SDK-chosen agent
        IDs appear in the fleet list without a separate register call,
        and repo / Improve / autonomous flows can key off the same id.
        Best-effort — never fail ingest.
        """
        pairs: dict[tuple[str, str], str] = {}
        for event in events:
            agent_id = (event.agent_id or "").strip()
            tenant_id = (event.tenant_id or "").strip()
            if not agent_id or not tenant_id:
                continue
            # Prefer a human name from attributes when present.
            name = agent_id
            attrs = event.attributes or {}
            for key in ("agent_name", "eden.agent_name", "name"):
                raw = attrs.get(key)
                if isinstance(raw, str) and raw.strip():
                    name = raw.strip()
                    break
            pairs[(tenant_id, agent_id)] = name
        if not pairs:
            return
        try:
            pg = await self._get_postgres()
            if pg is None:
                return
            rows = [
                (org_id, agent_id, name)
                for (org_id, agent_id), name in pairs.items()
            ]
            await pg.executemany(
                """
                INSERT INTO agent_registrations (org_id, agent_id, name, last_seen_at, updated_at)
                VALUES ($1::uuid, $2, $3, NOW(), NOW())
                ON CONFLICT (org_id, agent_id) DO UPDATE SET
                    last_seen_at = NOW(),
                    updated_at = NOW(),
                    name = CASE
                        WHEN agent_registrations.name = agent_registrations.agent_id
                             AND EXCLUDED.name <> EXCLUDED.agent_id
                        THEN EXCLUDED.name
                        ELSE agent_registrations.name
                    END
                """,
                rows,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "telemetry: agent_registrations touch skipped: %s",
                exc,
            )

    # ── Validation ────────────────────────────────────────────────────────

    def _validate(self, event: TelemetryEvent) -> bool:
        """Validate a telemetry event."""
        required = [
            event.event_id,
            event.tenant_id,
            event.project_id,
            event.trace_id,
            event.realm,
            event.event_type,
            event.timestamp,
        ]
        if not all(required):
            logger.warning(f"Telemetry event missing required fields: {event.to_dict()}")
            return False
        if event.realm not in ("environment", "production"):
            logger.warning(f"Invalid realm '{event.realm}' in telemetry event {event.event_id}")
            return False
        try:
            datetime.fromisoformat(event.timestamp.replace("Z", "+00:00"))
        except ValueError:
            logger.warning(f"Invalid timestamp in telemetry event {event.event_id}")
            return False
        return True

    # ── Enrichment ────────────────────────────────────────────────────────

    def _enrich(self, event: TelemetryEvent) -> None:
        """Add derived fields to a telemetry event."""
        # Content hash for deduplication — ids + type only (no full
        # sorted payload dump; payload bodies are huge on LLM spans).
        content = (
            f"{event.trace_id}|{event.event_type}|{event.span_id}|"
            f"{event.timestamp}|{event.event_id}"
        )
        event.attributes["_content_hash"] = hashlib.sha256(content.encode()).hexdigest()[:16]

        # Stamp cost_usd from the seed pricing catalog when the SDK
        # omitted it. Portal list/detail sum metrics->>'cost_usd';
        # without this the UI shows $0 even when tokens are present.
        self._stamp_cost_usd(event)

        # Ingestion latency
        try:
            event_ts = datetime.fromisoformat(event.timestamp.replace("Z", "+00:00"))
            ingest_latency_ms = (datetime.now(UTC) - event_ts).total_seconds() * 1000
            event.metrics["_ingest_latency_ms"] = max(0.0, round(ingest_latency_ms, 2))
        except Exception as exc:  # noqa: BLE001 — never fail ingest for a metric
            # Not a bare ``pass``: an unparseable timestamp silently costs
            # the event its ingest-latency metric, and a whole SDK version
            # shipping a bad format would show up only as a gap in the
            # latency series.
            logger.warning(
                "telemetry_collector: could not parse timestamp %r on event %s "
                "(%s); ingest latency not recorded for it",
                getattr(event, "timestamp", None),
                getattr(event, "event_id", None),
                exc,
            )

    @staticmethod
    def _stamp_cost_usd(event: TelemetryEvent) -> None:
        """Fill ``metrics.cost_usd`` from seed pricing when missing/zero."""
        metrics = event.metrics if isinstance(event.metrics, dict) else {}
        existing = metrics.get("cost_usd")
        try:
            if existing is not None and float(existing) > 0:
                return
        except (TypeError, ValueError):
            pass

        def _tok(key: str) -> int:
            raw = metrics.get(key)
            if raw is None:
                return 0
            try:
                return int(float(raw))
            except (TypeError, ValueError):
                return 0

        input_tokens = _tok("input_tokens") or _tok("prompt_tokens")
        output_tokens = _tok("output_tokens") or _tok("completion_tokens")
        cache_read = _tok("cache_read_tokens") or _tok("cached_tokens")
        cache_write = _tok("cache_creation_tokens") or _tok("cache_creation_input_tokens")
        if input_tokens + output_tokens + cache_read + cache_write <= 0:
            return

        payload = event.payload if isinstance(event.payload, dict) else {}
        model = (
            payload.get("model_normalized")
            or event.model_version
            or event.model
            or event.model_name
            or payload.get("model")
        )
        try:
            from eden.llmops.pricing import estimate_cost_usd

            cost = estimate_cost_usd(
                model=str(model) if model else None,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_tokens=cache_read,
                cache_write_tokens=cache_write,
            )
        except Exception as exc:  # noqa: BLE001 — never fail ingest for pricing
            logger.warning(
                "telemetry_collector: cost stamp failed for event %s (%s)",
                getattr(event, "event_id", None),
                exc,
            )
            return
        if cost <= 0:
            return
        if not isinstance(event.metrics, dict):
            event.metrics = {}
        event.metrics["cost_usd"] = cost

    # ── Deduplication ─────────────────────────────────────────────────────

    def _is_duplicate(self, event: TelemetryEvent) -> bool:
        """Check if an event is a duplicate within the dedup window.

        Audit 2026-07-02 P-14: the cache is an ``OrderedDict`` so
        we can pop the oldest entry in O(1) (FIFO eviction at the
        50k cap) rather than the O(N) dict-comprehension rebuild
        the previous implementation used. On a hit we ``move_to_end``
        so the recently-seen hash isn't evicted first.
        """
        content_hash = event.attributes.get("_content_hash")
        if not content_hash:
            return False
        now = time.time()
        cutoff = now - self.DEDUP_WINDOW_SECONDS
        # Drop expired entries.
        while self._dedup_cache:
            oldest_key, oldest_ts = next(iter(self._dedup_cache.items()))
            if oldest_ts > cutoff:
                break
            self._dedup_cache.popitem(last=False)
        if content_hash in self._dedup_cache:
            # Refresh the timestamp + bump to "most recently seen"
            # so eviction treats it as fresh.
            self._dedup_cache[content_hash] = now
            self._dedup_cache.move_to_end(content_hash)
            return True
        # This insert is a *reservation*, not a record of success: the event has
        # not been routed yet. If routing fails, ``_release_dedup`` must undo it
        # (see below), or the client's retry is rejected as a duplicate and the
        # event is lost for good.
        self._dedup_cache[content_hash] = now
        # Enforce cap: drop the oldest entry when we're full.
        if len(self._dedup_cache) > self._DEDUP_CACHE_MAX:
            self._dedup_cache.popitem(last=False)
        return False

    def _release_dedup(self, event: TelemetryEvent) -> None:
        """Undo the dedup reservation ``_is_duplicate`` took for ``event``.

        ``_is_duplicate`` inserts the content hash *before* the event is routed,
        because that is the only way to make the check atomic against a
        concurrent duplicate. The consequence is that a routing failure left the
        hash behind: the caller got a 5xx, the SDK retried exactly as designed,
        and the retry was then rejected as a duplicate — so the event was
        dropped permanently by the mechanism meant to prevent double-counting.
        One failed write became one lost event, invisibly.

        Releasing on failure is safe: the Postgres write is
        ``ON CONFLICT (event_id, timestamp) DO NOTHING``, so a retry that *does*
        land cannot double-count.
        """
        content_hash = event.attributes.get("_content_hash")
        if content_hash:
            self._dedup_cache.pop(content_hash, None)

    # ── Routing ───────────────────────────────────────────────────────────

    async def _route(self, event: TelemetryEvent, *, skip_postgres: bool = False) -> None:
        """Route an event to all configured sinks.

        ``skip_postgres`` is for ``ingest_batch``, which writes the whole batch
        in one ``executemany`` before calling this — so the durable write has
        already happened and must not be repeated per event. Defaults to
        ``False`` so the single-event ``ingest()`` path is unchanged.

        Sinks are independent — Redis, Postgres, ClickHouse, WebSocket,
        OTel dual-emit, and Typesense can run concurrently. Pre-fix
        they were awaited serially, so per-event latency was the sum
        of every sink's hot path (PG insert alone can be 10-50ms).
        Using ``asyncio.gather`` with ``return_exceptions=True`` keeps
        fail-soft semantics for secondary sinks, but Postgres is the
        durable store: ``IngestionUnavailable`` must surface so the
        route can return 503 and the SDK can retry.
        """
        sinks = [
            self._route_redis(event),
            self._route_clickhouse(event),
            self._route_websocket(event),
            self._route_otel_dual_emit(event),
            self._route_typesense(event),
        ]
        if not skip_postgres:
            sinks.append(self._route_postgres(event))
        results = await asyncio.gather(*sinks, return_exceptions=True)
        from eden.observability.errors import IngestionUnavailable

        for result in results:
            if isinstance(result, IngestionUnavailable):
                raise result

    async def _route_redis(self, event: TelemetryEvent) -> None:
        redis = await self._get_redis()
        if not redis:
            return
        event_dict = event.to_dict()

        # Per-span telemetry streams are only consumed by the async
        # judge RedisTailer (off by default). Skipping XADD saves 1–2
        # Redis cmds per ingest event on Upstash Free.
        write_stream = False
        try:
            from eden.config import get_settings

            settings = get_settings()
            write_stream = bool(
                getattr(settings, "redis_telemetry_stream_enabled", False)
                or getattr(settings, "judges_async_tailer_enabled", False)
            )
        except Exception:
            write_stream = False

        if write_stream:
            stream_key = f"telemetry:{event.tenant_id}:{event.trace_id}:events"
            payload_json = _json_dumps(event_dict)
            try:
                from eden.observability.ingest_hot_path_metrics import (
                    record_ingest_redis_commands,
                )

                now = time.time()
                need_expire = self._stream_expire_at.is_due(stream_key, now)
                pipe = redis.pipeline(transaction=False)
                pipe.xadd(
                    stream_key,
                    fields={"data": payload_json},
                    maxlen=self.STREAM_MAXLEN,
                )
                cmds = 1
                if need_expire:
                    pipe.expire(stream_key, self.STREAM_TTL_S)
                    cmds += 1
                await pipe.execute()
                record_ingest_redis_commands(cmds)
                if need_expire:
                    self._stream_expire_at.set(
                        stream_key,
                        now + self.STREAM_EXPIRE_REFRESH_S,
                        now=now,
                    )
            except Exception as exc:
                # This ``return`` also skips the SSE fanout and the
                # trace.finalized emit below, so one Redis failure costs three
                # things. Both of those need Redis too, so retrying them here
                # would only add latency against a dead server — but the loss is
                # counted rather than left to a single xadd warning.
                record_drop("sse", "write_error", 2.0)
                logger.warning(
                    "Redis telemetry xadd failed (%s); also skipping the SSE "
                    "fanout and the trace.finalized emit for this event",
                    exc,
                )
                return

        # SSE fanout — no-ops when nobody is listening (default).
        try:
            from eden.api.routes.observability_stream import publish_trace_event

            await publish_trace_event(
                org_id=event.tenant_id,
                payload=event_dict,
            )
        except Exception as exc:
            record_drop("sse", "write_error")
            logger.debug(f"telemetry: publish_trace_event failed: {exc}")

        # F20 — signal the auto-issue scanner when a trace finalizes.
        try:
            from eden.observability.trace_finalized import (
                maybe_emit_trace_finalized,
            )

            await maybe_emit_trace_finalized(event, redis)
        except Exception as exc:
            # Losing this means the auto-issue scanner never runs for the trace,
            # so a failing trace produces no issue — a missing *feature*, not a
            # missing row, which is why nothing ever surfaced it.
            record_drop("queue", "write_error")
            logger.debug(f"telemetry: trace.finalized emit failed: {exc}")

    async def _require_postgres(self) -> Any:
        """The Postgres client, or ``IngestionUnavailable`` if there is none.

        Postgres is the durable store, so its absence is not a per-event
        failure — the caller turns this into a 503 so the SDK retries rather
        than acking events that were never written.
        """
        client = await self._get_postgres()
        if not client:
            from eden.observability.errors import IngestionUnavailable

            logger.warning(
                "Postgres unavailable for telemetry; raising IngestionUnavailable",
            )
            raise IngestionUnavailable(
                "Ingestion temporarily unavailable; Postgres unavailable, retry after backoff",
            )
        return client

    async def _prepare_postgres_row(self, event: TelemetryEvent) -> tuple[Any, ...]:
        """Compress, dedup, and build one ``telemetry_events`` row.

        Split out of ``_route_postgres`` so a batch can build every row and
        then write them all in one statement — see
        :meth:`_route_postgres_many`. Everything here is per-event work that
        has to happen either way; only the write is batchable.
        """
        if True:
            # v1.8 (storage-optimisation pass): dispatch the 8 zstd
            # compress calls via :func:`compress_many` so the work
            # fans out across the storage layer's worker pool (each
            # worker owns its own ZstdCompressor — sharing a
            # compressor across threads is unsafe under zstd). The
            # old path used 8 ``asyncio.to_thread`` dispatches inside
            # a gather, which both had higher scheduling overhead
            # (~0.5 ms each) and shared the loop's default
            # ThreadPoolExecutor (unbounded). The new path has one
            # dispatch per event and the worker pool is fixed-size.
            from eden.storage.compression import compress_many

            (
                request_body_zstd,
                response_body_zstd,
                reasoning_zstd,
                tool_calls_full_zstd,
                tool_results_zstd,
                payload_zstd,
                metrics_zstd,
                attributes_zstd,
            ) = await asyncio.to_thread(
                compress_many,
                [
                    event.request_body,
                    event.response_body,
                    event.reasoning,
                    event.tool_calls_full,
                    event.tool_results,
                    event.payload,
                    event.metrics,
                    event.attributes,
                ],
            )
            # Phase A / N09 — content-addressed message dedup (Laminar 20x).
            # Hash every message in request_body / response_body via the
            # canonical-JSON SHA-256 in :mod:`eden.observability.canonical`
            # and upsert into ``trace_messages``. Kill switch:
            # ``Settings.content_dedupe_enabled`` / ``EDEN_CONTENT_DEDUPE_ENABLED``.
            _dedupe_on = True
            try:
                from eden.config import get_settings

                _dedupe_on = bool(get_settings().content_dedupe_enabled)
            except Exception:
                _dedupe_on = True
            if _dedupe_on and event.request_body is not None and not event.request_message_hashes:
                try:
                    from eden.observability.message_store import get_message_store

                    event.request_message_hashes = await get_message_store().upsert_request(
                        event.trace_id,
                        event.request_body,
                    )
                except Exception as exc:
                    logger.debug(f"dedup upsert_request failed (non-fatal): {exc}")
            if _dedupe_on and event.response_body is not None and not event.response_message_hashes:
                try:
                    from eden.observability.message_store import get_message_store

                    event.response_message_hashes = await get_message_store().upsert_response(
                        event.trace_id,
                        event.response_body,
                    )
                except Exception as exc:
                    logger.debug(f"dedup upsert_response failed (non-fatal): {exc}")
            # Dual-write note (Wave 3 / PERF+COST deferred): plaintext JSONB
            # columns AND *_zstd are both populated. Primary readers prefer
            # zstd, but online rules_engine still prefers JSONB first.
            # Stopping plaintext writes is gated on
            # scripts/check_zstd_drop_prerequisites.py + mig 033/039.
            return (
                event.event_id,
                event.tenant_id,
                event.project_id,
                event.trace_id,
                event.realm,
                event.event_type,
                # asyncpg requires datetime for timestamptz — TelemetryEvent
                # keeps ISO strings on the wire / dataclass.
                event.timestamp
                if isinstance(event.timestamp, datetime)
                else datetime.fromisoformat(str(event.timestamp).replace("Z", "+00:00")),
                event.agent_id,
                event.agent_version,
                event.environment_id,
                event.parent_span_id,
                event.span_id,
                event.name,
                event.duration_ms,
                # NOT NULL JSONB cols: _dump_jsonb maps {} / [] → None, but
                # an explicit NULL bypasses the column DEFAULT and raises
                # not-null (webhook/telemetry with empty payload/tags).
                _dump_jsonb(event.payload) or "{}",
                _dump_jsonb(event.metrics) or "{}",
                _dump_jsonb(event.attributes) or "{}",
                _dump_jsonb(event.tags) or "[]",
                event.outcome,
                event.source_format or "eden_native",
                _dump_jsonb(event.request_body),
                _dump_jsonb(event.response_body),
                _dump_jsonb(event.reasoning),
                _dump_jsonb(event.tool_calls_full) if event.tool_calls_full else None,
                _dump_jsonb(event.tool_results) if event.tool_results else None,
                _dump_jsonb(event.images) if event.images else None,
                _dump_jsonb(event.audio) if event.audio else None,
                _dump_jsonb(event.logprobs) if event.logprobs is not None else None,
                _dump_jsonb(event.citations) if event.citations else None,
                event.finish_reason,
                event.stop_sequence,
                event.system_fingerprint,
                event.cache_hit,
                event.prompt_cache_savings_usd,
                event.model_version,
                event.service_tier,
                event.model
                or (event.attributes or {}).get("model")
                or (event.attributes or {}).get("openai.model")
                or (event.attributes or {}).get("anthropic.model"),
                event.model_name or event.model,
                request_body_zstd,
                response_body_zstd,
                reasoning_zstd,
                tool_calls_full_zstd,
                tool_results_zstd,
                payload_zstd,
                metrics_zstd,
                attributes_zstd,
                event.request_message_hashes or None,
                event.response_message_hashes or None,
            )
        raise AssertionError("unreachable")  # pragma: no cover

    async def _route_postgres(self, event: TelemetryEvent) -> None:
        """Write one event. Unchanged semantics; the row build moved out."""
        client = await self._require_postgres()
        try:
            row = await self._prepare_postgres_row(event)
            await client.execute(TELEMETRY_INSERT_SQL, *row)
        except Exception as exc:
            from eden.observability.errors import IngestionUnavailable

            if isinstance(exc, IngestionUnavailable):
                raise
            logger.warning(f"Postgres telemetry insert failed: {exc}")
            raise IngestionUnavailable(
                "Ingestion temporarily unavailable; Postgres write failed, retry after backoff",
            ) from exc

    async def _route_postgres_many(self, events: list[TelemetryEvent]) -> None:
        """Write a whole batch in one statement.

        Measured against a table with this one's shape and conflict target
        (local Postgres 18, unix socket, one transaction per batch),
        ``executemany`` beats N separate INSERTs by **3.42x** at 10 events,
        **2.56x** at 50 and **2.67x** at 200 — 60.2 -> 22.6 us/event at 200.
        Its advantage is round-trip count, so it should widen on the production
        DSN, where Neon over TLS charges far more per round trip than a unix
        socket.

        ``copy_records_to_table`` was measured and rejected. ``COPY`` has no
        ``ON CONFLICT``, and this write must stay idempotent — the SDK retries
        on 5xx, and ``ingest_batch``'s partial-failure handling depends on a
        re-send not double-counting. Preserving that needs ``COPY`` into a temp
        table plus a second ``INSERT ... SELECT``, whose fixed cost makes it
        **slower than the status quo** at batch 10 (0.67x) and still behind
        ``executemany`` at 200. See
        ``docs/ops/remediation-measured-corrections.md``.

        Failure is all-or-nothing, which is a deliberate change from the
        per-event fate the fan-out had: one statement in one transaction either
        lands or does not. ``ingest_batch`` already handles exactly this case —
        its ``IngestionUnavailable`` branch releases every dedup reservation in
        the batch — and ``ON CONFLICT ... DO NOTHING`` keeps the retry safe.
        """
        if not events:
            return
        client = await self._require_postgres()
        try:
            rows = await asyncio.gather(*(self._prepare_postgres_row(e) for e in events))
            await client.executemany(TELEMETRY_INSERT_SQL, rows)
        except Exception as exc:
            from eden.observability.errors import IngestionUnavailable

            if isinstance(exc, IngestionUnavailable):
                raise
            logger.warning(
                "Postgres telemetry batch insert failed (%d events): %s",
                len(events),
                exc,
            )
            raise IngestionUnavailable(
                "Ingestion temporarily unavailable; Postgres write failed, retry after backoff",
            ) from exc

    async def _route_clickhouse(self, event: TelemetryEvent) -> None:
        sink = await self._get_clickhouse()
        if not sink:
            # One event's columnar copy. Postgres remains the
            # durable store, so this is a fidelity loss rather than
            # a data loss — but it was entirely uncounted.
            record_drop("sink_ch", "write_error")
            return
        row = {
            "event_id": event.event_id,
            "tenant_id": event.tenant_id,
            "project_id": event.project_id,
            "trace_id": event.trace_id,
            "realm": event.realm,
            "event_type": event.event_type,
            "timestamp": event.timestamp,
            "agent_id": event.agent_id or "",
            "agent_version": event.agent_version or "",
            "environment_id": event.environment_id or "",
            "span_id": event.span_id or "",
            "name": event.name or "",
            "duration_ms": event.duration_ms or 0.0,
            "metrics": _dump_jsonb(event.metrics) or "",
            "tags": _json_dumps(event.tags),
            "outcome": event.outcome or "",
            "request_body": _dump_jsonb(event.request_body) or "",
            "response_body": _dump_jsonb(event.response_body) or "",
            "reasoning": _dump_jsonb(event.reasoning) or "",
            "tool_calls_full": _dump_jsonb(event.tool_calls_full) or "",
            "tool_results": _dump_jsonb(event.tool_results) or "",
            "images": _dump_jsonb(event.images) or "",
            "audio": _dump_jsonb(event.audio) or "",
            "logprobs": _dump_jsonb(event.logprobs) or "",
            "citations": _dump_jsonb(event.citations) or "",
            "finish_reason": event.finish_reason or "",
            "model": event.attributes.get("model", "") or "",
            "model_version": event.model_version or "",
            "cache_hit": 1 if event.cache_hit else 0,
            "prompt_cache_savings_usd": float(event.prompt_cache_savings_usd or 0.0),
            "ingested_at": datetime.now(UTC).isoformat(),
        }
        batch: list[dict[str, Any]] | None = None
        async with self._ch_buffer_lock:
            self._ch_telemetry_buffer.append(row)
            if len(self._ch_telemetry_buffer) >= self.CH_TELEMETRY_BATCH_SIZE:
                batch = self._ch_telemetry_buffer
                self._ch_telemetry_buffer = []
        self._ensure_ch_flush_loop()
        if batch:
            await self._insert_ch_batch(batch)

    def _ensure_ch_flush_loop(self) -> None:
        """Start the ≤5s ClickHouse time-flush loop once per collector."""
        if self._ch_flush_task is not None and not self._ch_flush_task.done():
            return
        try:
            self._ch_flush_task = asyncio.create_task(self._ch_flush_loop())
        except RuntimeError:
            self._ch_flush_task = None

    async def _ch_flush_loop(self) -> None:
        while True:
            await asyncio.sleep(self.CH_FLUSH_INTERVAL_S)
            try:
                await self._flush_clickhouse_buffer()
            except Exception as exc:
                logger.debug("ClickHouse telemetry timer flush failed: %s", exc)

    async def _insert_ch_batch(self, batch: list[dict[str, Any]]) -> None:
        """Insert one detached ClickHouse batch, accounting for any loss.

        ``batch`` has already been swapped out of ``_ch_telemetry_buffer`` by the
        caller, so it exists nowhere else. Both failure paths below therefore
        lose the whole batch — at ``CH_TELEMETRY_BATCH_SIZE`` that is 100+ rows
        per occurrence — and neither used to be counted. The absent-sink branch
        was a bare ``return`` whose only trace was a ``logger.debug`` inside
        ``_get_clickhouse``, a different function, so a misconfigured or
        unreachable ClickHouse silently shredded every flush indefinitely.
        """
        sink = await self._get_clickhouse()
        if not sink:
            record_drop("sink_ch", "write_error", len(batch))
            logger.warning(
                "ClickHouse sink unavailable; dropped %d buffered telemetry "
                "row(s) — this batch is not retried and exists nowhere else",
                len(batch),
            )
            return
        try:
            from eden.observability.ingest_hot_path_metrics import (
                record_ch_flush_batch_size,
            )

            record_ch_flush_batch_size(len(batch))
        except Exception:  # noqa: BLE001 — metrics must not block the flush
            pass
        try:
            # sink.insert does NOT raise on a failed write — it returns an
            # IngestionReport with rows_failed set and parks the rows in
            # clickhouse_fallback. Discarding that return value meant a
            # 100%-failing columnar mirror was indistinguishable from a
            # healthy one: nothing logged, nothing counted, and the only
            # evidence was rows quietly piling up in the fallback table.
            report = await sink.insert("telemetry_events_ch", batch)
            failed = int(getattr(report, "rows_failed", 0) or 0)
            if failed:
                record_drop("sink_ch", "write_error", failed)
                logger.error(
                    "ClickHouse telemetry mirror failed for %d/%d row(s); "
                    "parked in clickhouse_fallback for the drain: %s",
                    failed,
                    len(batch),
                    "; ".join(getattr(report, "errors", []) or [])[:500],
                )
        except Exception as exc:
            record_drop("sink_ch", "write_error", len(batch))
            logger.warning(
                "ClickHouse telemetry batch insert failed, dropping %d row(s): %s",
                len(batch),
                exc,
            )

    async def _flush_clickhouse_buffer(self) -> None:
        """Flush any buffered telemetry_events_ch rows."""
        async with self._ch_buffer_lock:
            if not self._ch_telemetry_buffer:
                return
            batch = self._ch_telemetry_buffer
            self._ch_telemetry_buffer = []
        await self._insert_ch_batch(batch)

    async def _route_websocket(self, event: TelemetryEvent) -> None:
        """Fan out telemetry event to real-time WebSocket subscribers."""
        try:
            from eden.api.routes.websocket import _job_connections

            # Use trace_id as the entity key for fanout
            if event.trace_id in _job_connections:
                message = {
                    "type": "telemetry_event",
                    "event": event.to_dict(),
                }
                for ws in list(_job_connections[event.trace_id]):
                    try:
                        await ws.send_json(message)
                    except Exception:
                        _job_connections[event.trace_id].discard(ws)
                        if not _job_connections[event.trace_id]:
                            del _job_connections[event.trace_id]
                            break
        except Exception as exc:
            logger.debug(f"WebSocket telemetry fanout failed: {exc}")

    async def _route_otel_dual_emit(self, event: TelemetryEvent) -> None:
        """Phase 7.2c — forward to OTLP if enabled. Best-effort, no-op
        when disabled."""
        try:
            from eden.observability.otel_exporter import get_otel_dual_exporter

            await get_otel_dual_exporter().export_event(event)
        except Exception as exc:
            logger.debug(f"OTel dual-emit route failed: {exc}")

    async def _route_typesense(self, event: TelemetryEvent) -> None:
        """Phase B — index the span into Typesense for full-text search.

        Idempotent upsert on the (tenant_id, event_id) composite id.
        A network error is logged at debug level only — Typesense
        is best-effort; if it's down the trace view falls back to
        Postgres, which is fine (just slower for cross-trace search).
        Skipped when the event has no tenant_id or no payload worth
        indexing (e.g. pure heartbeat telemetry).
        """
        try:
            from eden.observability.typesense_client import (
                build_span_doc,
                get_typesense_client,
            )

            client = get_typesense_client()
            if client is None:
                return
            # Skip if there's nothing to index — pure heartbeat
            # spans with no request/response waste a Typesense doc.
            if (
                event.request_body is None
                and event.response_body is None
                and not event.tool_calls_full
                and not event.name
            ):
                return
            doc = build_span_doc(event)
            # Prefer bulk path when buffer is enabled; fall back to single upsert.
            indexed_via_bulk = False
            try:
                from eden.config import get_settings
                from eden.observability.ingestion.bulk_typesense import enqueue_span_doc

                if bool(getattr(get_settings(), "typesense_bulk_index_enabled", True)):
                    # Non-blocking from the critical ingest path.
                    self._spawn_bg(enqueue_span_doc(doc))
                    indexed_via_bulk = True
            except Exception:
                indexed_via_bulk = False
            if not indexed_via_bulk:
                await client.index_span(doc)
            # Typesense lag = event age at index time (not RPC duration).
            try:
                from datetime import UTC, datetime

                from eden.observability.search_service import record_index_lag

                event_ts = datetime.fromisoformat(str(event.timestamp).replace("Z", "+00:00"))
                if event_ts.tzinfo is None:
                    event_ts = event_ts.replace(tzinfo=UTC)
                lag_s = max(0.0, (datetime.now(UTC) - event_ts).total_seconds())
                record_index_lag(lag_s)
            except Exception:
                pass
        except Exception as exc:
            logger.debug(f"Typesense route failed (non-fatal): {exc}")

    # ── Query API ─────────────────────────────────────────────────────────

    async def _load_from_archive(
        self,
        tenant_id: str,
        trace_id: str,
    ) -> list[dict[str, Any]]:
        """Cold-archive fallback for ``get_trace_tree`` (Phase B3).

        Called when the Postgres query for ``trace_id`` returns no
        rows. Looks up the trace in ``trace_archive_index`` and
        rehydrates from Impossible Cloud via :class:`ArchiveService`.

        ``tenant_id`` must match the archive index ``org_id``; a
        mismatch is treated as not found (no cross-tenant IDOR).

        Returns a list of row dicts (same shape as the Postgres
        ``SELECT *`` output) or an empty list. Errors are logged
        and treated as "not found" so the trace view returns 404
        cleanly.
        """
        try:
            from eden.services.data_platform import ArchiveService
        except Exception as exc:
            logger.debug(f"_load_from_archive: import failed: {exc}")
            return []
        archive = ArchiveService()
        try:
            return await archive.rehydrate(trace_id, org_id=tenant_id)
        except Exception as exc:
            logger.warning(f"_load_from_archive: rehydrate failed for {trace_id}: {exc}")
            return []

    async def get_trace_tree(
        self,
        tenant_id: str,
        trace_id: str,
        *,
        hydrate_bodies: bool = True,
        max_spans: int = 500,
    ) -> TraceTree | None:
        """Build a hierarchical trace tree from stored telemetry events.

        Phase B3 (2026-06-19): falls back to the Impossible Cloud
        cold archive (via :class:`ArchiveService.rehydrate`) when
        the trace isn't in Postgres — happens for any trace older
        than the configured cold-archive age (default 90 days).

        ``hydrate_bodies=False`` skips message_store reconstruct and
        large request/response body zstd — used by portal list-detail
        for span structure without N message round-trips. Attributes,
        payload, and metrics zstd are still decoded so error text,
        tokens, and cost remain available on the cheap path.
        """
        client = await self._get_postgres()
        if not client:
            return None

        try:
            rows = await client.fetch(
                """
                SELECT * FROM telemetry_events
                WHERE tenant_id = $1 AND trace_id = $2
                ORDER BY timestamp ASC
                LIMIT $3
                """,
                tenant_id,
                trace_id,
                max(1, min(int(max_spans), 2000)),
            )
        except Exception as exc:
            logger.warning(f"Failed to fetch trace tree: {exc}")
            return None

        if not rows:
            # Phase B3 (2026-06-19): cold-archive fallback. If the
            # trace isn't in Postgres, check ``trace_archive_index``
            # and rehydrate from Impossible Cloud. The reader
            # continues with the same shape so the rest of this
            # method doesn't need to branch.
            rows = await self._load_from_archive(tenant_id, trace_id)
            if not rows:
                return None
            if len(rows) > max_spans:
                rows = rows[:max_spans]
        # Phase 3: read path prefers batch-decompressed ``*_zstd``
        # columns (below), falling back to inline JSONB when zstd is
        # missing or soft-fails. Legacy per-column helper removed —
        # decompress_many + coalesce in the node builder cover it.
        # Phase A — content-addressed dedup reconstruction. If the row
        # has request_message_hashes, the original request_body was
        # already moved into trace_messages (with the JSONB kept as a
        # 30-day burn-in) and we can rebuild it via JOIN. If the
        # reconstruction returns nothing (hashes missing or DB
        # transient failure) we fall through to the zstd/JSONB path
        # so the trace view never goes blank.
        message_store = None
        if hydrate_bodies:
            from eden.observability.message_store import get_message_store

            message_store = get_message_store()

        span_map: dict[str, dict[str, Any]] = {}
        root_spans: list[dict[str, Any]] = []
        total_duration = 0.0
        outcome: str | None = None
        realm = "environment"

        # v1.8 (storage-optimisation pass): batch the zstd
        # decompressions across all rows instead of doing them
        # serially inside the loop. With N rows × 6 zstd columns,
        # the serial path made N×6 sync decompress calls; the batch
        # path makes a single dispatch to :func:`decompress_many`
        # which fans out across the storage layer's worker pool.
        # Measured: ~3-5x faster on traces with 50+ spans.
        #
        # Structure path still needs attributes/payload/metrics (errors,
        # tokens, cost). Only skip the large body / message_store path.
        # A dict-mismatched column soft-fails per-row via decompress_many.
        from eden.storage.compression import decompress_many

        per_row: list[dict[str, Any]] = []
        if hydrate_bodies:
            _zstd_cols = (
                "request_body_zstd",
                "response_body_zstd",
                "reasoning_zstd",
                "tool_calls_full_zstd",
                "tool_results_zstd",
                "payload_zstd",
                "metrics_zstd",
                "attributes_zstd",
            )
        else:
            _zstd_cols = (
                "payload_zstd",
                "metrics_zstd",
                "attributes_zstd",
            )
        # Collect every (row, col) value to feed the batch API.
        flat: list[bytes | None] = []
        for row in rows:
            for col in _zstd_cols:
                flat.append(row.get(col))
        decoded = await asyncio.to_thread(decompress_many, flat) if flat else []
        # Re-shape into a {row_index: {col: value}} lookup.
        cols_n = len(_zstd_cols)
        for i in range(0, len(decoded), cols_n):
            per_row.append({col: decoded[i + j] for j, col in enumerate(_zstd_cols)})

        async def _resolve_request_for(row: dict, decoded_cols: dict) -> Any:
            if message_store is not None:
                hashes = row.get("request_message_hashes")
                if hashes:
                    reconstructed = await message_store.reconstruct_request_body(
                        trace_id,
                        list(hashes),
                    )
                    if reconstructed is not None:
                        return reconstructed
            # decompress_many already returned parsed JSON (or None on
            # soft-fail) — do not feed it back into decompress_jsonb.
            zstd_val = decoded_cols.get("request_body_zstd")
            if zstd_val is not None:
                return zstd_val
            return row.get("request_body")

        async def _resolve_response_for(row: dict, decoded_cols: dict) -> Any:
            if message_store is not None:
                hashes = row.get("response_message_hashes")
                if hashes:
                    reconstructed = await message_store.reconstruct_response_body(
                        trace_id,
                        list(hashes),
                    )
                    if reconstructed is not None:
                        return reconstructed
            zstd_val = decoded_cols.get("response_body_zstd")
            if zstd_val is not None:
                return zstd_val
            return row.get("response_body")

        for idx, row in enumerate(rows):
            span_id = row.get("span_id") or str(uuid.uuid4())
            parent = row.get("parent_span_id")
            name = row.get("name") or row.get("event_type")
            duration = row.get("duration_ms") or 0.0
            realm = row.get("realm", "environment")
            if row.get("outcome"):
                outcome = row.get("outcome")

            decoded_cols = per_row[idx] if idx < len(per_row) else {}
            if hydrate_bodies:
                request_body, response_body = await asyncio.gather(
                    _resolve_request_for(row, decoded_cols),
                    _resolve_response_for(row, decoded_cols),
                )
            else:
                # Cheap path for portal structure: keep inline JSONB
                # previews, skip message_store reconstruct + body zstd.
                request_body = row.get("request_body")
                response_body = row.get("response_body")
            def _json_obj(value: Any, *, default: Any = None) -> Any:
                """Normalize JSONB that asyncpg sometimes returns as ``str``."""
                if value is None:
                    return default
                if isinstance(value, (dict, list)):
                    return value
                if isinstance(value, (bytes, bytearray)):
                    try:
                        value = value.decode("utf-8")
                    except Exception:
                        return default
                if isinstance(value, str):
                    text = value.strip()
                    if not text:
                        return default
                    try:
                        return json.loads(text)
                    except Exception:
                        return default
                return value

            node = {
                "span_id": span_id,
                "parent_span_id": parent,
                "name": name,
                "event_type": row.get("event_type"),
                "timestamp": row.get("timestamp"),
                "duration_ms": duration,
                "metrics": decoded_cols.get("metrics_zstd")
                if decoded_cols.get("metrics_zstd") is not None
                else _json_obj(row.get("metrics"), default={}) or {},
                "attributes": decoded_cols.get("attributes_zstd")
                if decoded_cols.get("attributes_zstd") is not None
                else _json_obj(row.get("attributes"), default={}) or {},
                "payload": decoded_cols.get("payload_zstd")
                if decoded_cols.get("payload_zstd") is not None
                else _json_obj(row.get("payload"), default={}) or {},
                "outcome": row.get("outcome"),
                "request_body": _json_obj(request_body, default=request_body),
                "response_body": _json_obj(response_body, default=response_body),
                "reasoning": decoded_cols.get("reasoning_zstd")
                if decoded_cols.get("reasoning_zstd") is not None
                else row.get("reasoning"),
                "tool_calls_full": decoded_cols.get("tool_calls_full_zstd")
                if decoded_cols.get("tool_calls_full_zstd") is not None
                else (row.get("tool_calls_full") or []),
                "tool_results": decoded_cols.get("tool_results_zstd")
                if decoded_cols.get("tool_results_zstd") is not None
                else (row.get("tool_results") or []),
                "images": row.get("images") or [],
                "audio": row.get("audio") or [],
                "logprobs": row.get("logprobs"),
                "citations": row.get("citations") or [],
                "finish_reason": row.get("finish_reason"),
                "stop_sequence": row.get("stop_sequence"),
                "system_fingerprint": row.get("system_fingerprint"),
                "cache_hit": row.get("cache_hit") or False,
                "prompt_cache_savings_usd": row.get("prompt_cache_savings_usd"),
                "model_version": row.get("model_version"),
                "service_tier": row.get("service_tier"),
                "error_type": row.get("error_type"),
                "error_message": row.get("error_message"),
                "children": [],
            }
            span_map[span_id] = node
            total_duration = max(total_duration, duration)

        # Link children to parents
        for _span_id, node in span_map.items():
            parent_id = node.get("parent_span_id")
            if parent_id and parent_id in span_map:
                span_map[parent_id]["children"].append(node)
            else:
                root_spans.append(node)

        return TraceTree(
            trace_id=trace_id,
            tenant_id=tenant_id,
            realm=realm,
            root_spans=root_spans,
            span_map=span_map,
            total_duration_ms=total_duration,
            span_count=len(span_map),
            outcome=outcome,
        )

    async def get_heatmap(
        self,
        tenant_id: str,
        metric_name: str = "duration_ms",
        x_axis: str = "name",
        days: int = 7,
    ) -> HeatmapData | None:
        """Build a performance heatmap from telemetry events."""
        client = await self._get_postgres()
        if not client:
            return None

        try:
            rows = await client.fetch(
                f"""
                SELECT name, event_type, metrics->>$3 as metric_value, timestamp
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND timestamp > NOW() - INTERVAL '{days} days'
                  AND name IS NOT NULL
                ORDER BY timestamp DESC
                LIMIT 5000
                """,
                tenant_id,
                metric_name,
            )
        except Exception as exc:
            logger.warning(f"Failed to fetch heatmap data: {exc}")
            return None

        if not rows:
            return None

        # Bucket by name (x) and hour-of-day (y)
        bucket_values: dict[tuple[str, int], list[float]] = defaultdict(list)
        x_labels_set: set[str] = set()

        for row in rows:
            name = row.get("name") or row.get("event_type") or "unknown"
            try:
                ts = datetime.fromisoformat(str(row.get("timestamp")).replace("Z", "+00:00"))
                hour = ts.hour
            except Exception:
                hour = 0
            try:
                value = float(row.get("metric_value") or 0)
            except (TypeError, ValueError):
                value = 0.0
            bucket_values[(name, hour)].append(value)
            x_labels_set.add(name)

        x_labels = sorted(x_labels_set)[:20]
        y_labels = [f"{h:02d}:00" for h in range(24)]

        buckets = []
        min_val = float("inf")
        max_val = float("-inf")

        for x in x_labels:
            for hour in range(24):
                values = bucket_values.get((x, hour), [0.0])
                avg_val = sum(values) / len(values)
                buckets.append(
                    {
                        "x": x,
                        "y": f"{hour:02d}:00",
                        "value": round(avg_val, 2),
                        "count": len(values),
                    }
                )
                min_val = min(min_val, avg_val)
                max_val = max(max_val, avg_val)

        return HeatmapData(
            metric_name=metric_name,
            buckets=buckets,
            x_labels=x_labels,
            y_labels=y_labels,
            min_value=min_val if min_val != float("inf") else 0.0,
            max_value=max_val if max_val != float("-inf") else 0.0,
        )

    async def get_timeline(self, tenant_id: str, trace_id: str) -> TimelineData | None:
        """Build a step timeline for a single trace."""
        client = await self._get_postgres()
        if not client:
            return None

        try:
            rows = await client.fetch(
                """
                SELECT * FROM telemetry_events
                WHERE tenant_id = $1 AND trace_id = $2
                ORDER BY timestamp ASC
                """,
                tenant_id,
                trace_id,
            )
        except Exception as exc:
            logger.warning(f"Failed to fetch timeline data: {exc}")
            return None

        if not rows:
            rows = await self._load_from_archive(tenant_id, trace_id)
            if not rows:
                return None

        steps: list[dict[str, Any]] = []
        markers: list[dict[str, Any]] = []
        base_time: datetime | None = None

        for row in rows:
            try:
                ts = datetime.fromisoformat(str(row.get("timestamp")).replace("Z", "+00:00"))
                if base_time is None:
                    base_time = ts
                start_ms = (ts - base_time).total_seconds() * 1000
            except Exception:
                start_ms = 0.0

            duration = row.get("duration_ms") or 0.0
            name = row.get("name") or row.get("event_type") or "unknown"
            outcome = row.get("outcome")

            steps.append(
                {
                    "name": name,
                    "start_ms": round(start_ms, 2),
                    "end_ms": round(start_ms + duration, 2),
                    "duration_ms": round(duration, 2),
                    "event_type": row.get("event_type"),
                    "outcome": outcome,
                }
            )

            if outcome and outcome != "success":
                markers.append(
                    {
                        "at_ms": round(start_ms + duration, 2),
                        "label": f"{name}: {outcome}",
                        "severity": "high" if outcome in ("failure", "crash") else "warning",
                    }
                )

        total_duration = steps[-1]["end_ms"] if steps else 0.0

        return TimelineData(
            trace_id=trace_id,
            steps=steps,
            total_duration_ms=total_duration,
            markers=markers,
        )

    async def get_comparative_summary(
        self,
        tenant_id: str,
        env_trace_id: str,
        prod_trace_id: str,
    ) -> dict[str, Any] | None:
        """Build a comparative summary between environment and production traces."""
        env_tree = await self.get_trace_tree(tenant_id, env_trace_id)
        prod_tree = await self.get_trace_tree(tenant_id, prod_trace_id)

        if not env_tree or not prod_tree:
            return None

        # Compare span counts
        env_spans = env_tree.span_count
        prod_spans = prod_tree.span_count
        span_gap = abs(env_spans - prod_spans) / max(env_spans, prod_spans, 1)

        # Compare durations
        env_duration = env_tree.total_duration_ms
        prod_duration = prod_tree.total_duration_ms
        duration_ratio = env_duration / max(prod_duration, 1)

        # Compare outcomes
        outcome_match = env_tree.outcome == prod_tree.outcome

        # Tool usage comparison
        env_tools = set()
        prod_tools = set()
        for span in env_tree.span_map.values():
            if span.get("event_type") == "tool.call":
                env_tools.add(span.get("name", ""))
        for span in prod_tree.span_map.values():
            if span.get("event_type") == "tool.call":
                prod_tools.add(span.get("name", ""))

        tool_overlap = len(env_tools & prod_tools) / max(len(env_tools | prod_tools), 1)
        env_only_tools = sorted(env_tools - prod_tools)
        prod_only_tools = sorted(prod_tools - env_tools)

        return {
            "env_trace_id": env_trace_id,
            "prod_trace_id": prod_trace_id,
            "overall_score": round(1.0 - (span_gap + abs(1 - duration_ratio)) / 2, 3),
            "dimensions": [
                {
                    "name": "span_count",
                    "env_value": env_spans,
                    "prod_value": prod_spans,
                    "gap": round(span_gap, 3),
                    "severity": "high" if span_gap > 0.5 else "medium" if span_gap > 0.2 else "low",
                    "explanation": f"Environment trace has {env_spans} spans, production has {prod_spans}",
                },
                {
                    "name": "duration",
                    "env_value": round(env_duration, 2),
                    "prod_value": round(prod_duration, 2),
                    "gap": round(abs(1 - duration_ratio), 3),
                    "severity": "high"
                    if duration_ratio > 2 or duration_ratio < 0.5
                    else "medium"
                    if duration_ratio > 1.5 or duration_ratio < 0.67
                    else "low",
                    "explanation": f"Environment duration is {env_duration:.0f}ms vs production {prod_duration:.0f}ms (ratio {duration_ratio:.2f})",
                },
                {
                    "name": "outcome",
                    "env_value": env_tree.outcome or "unknown",
                    "prod_value": prod_tree.outcome or "unknown",
                    "gap": 0.0 if outcome_match else 1.0,
                    "severity": "high" if not outcome_match else "low",
                    "explanation": "Outcomes match"
                    if outcome_match
                    else f"Outcomes differ: env={env_tree.outcome} vs prod={prod_tree.outcome}",
                },
                {
                    "name": "tool_usage",
                    "env_value": len(env_tools),
                    "prod_value": len(prod_tools),
                    "gap": round(1.0 - tool_overlap, 3),
                    "severity": "high"
                    if tool_overlap < 0.5
                    else "medium"
                    if tool_overlap < 0.8
                    else "low",
                    "explanation": f"Tool overlap: {tool_overlap:.0%}. Env-only: {env_only_tools}. Prod-only: {prod_only_tools}",
                },
            ],
            "recommendations": [],
            "metadata": {
                "env_only_tools": env_only_tools,
                "prod_only_tools": prod_only_tools,
                "outcome_match": outcome_match,
            },
        }

    # ── §11.2 KB cache tier labels ──────────────────────────────────────────
    # The optimization layer has three cache tiers (L1 exact, L2 semantic,
    # DB fallback). This helper emits a TelemetryEvent tagged with
    # ``tier`` so the latency dashboard can break down p50/p95/p99 by
    # tier — closing the §11.2 partial.

    async def record_cache_lookup(
        self,
        *,
        tenant_id: str,
        trace_id: str,
        tier: str,  # 'L1' | 'L2' | 'DB'
        hit: bool,
        latency_ms: float,
        cache_key: str | None = None,
    ) -> bool:
        """Emit a TelemetryEvent for a KB cache lookup. The event
        carries ``tier`` and ``hit`` as tags so the dashboard can
        break down p95 by tier (L1 hit vs L2 hit vs DB miss)."""
        if tier not in ("L1", "L2", "DB"):
            return False
        event = TelemetryEvent(
            event_id=f"cache-{trace_id}-{tier}-{int(time.time() * 1000)}",
            tenant_id=tenant_id,
            trace_id=trace_id,
            realm="production",
            event_type="kb_cache_lookup",
            payload={
                "tier": tier,
                "hit": hit,
                "latency_ms": latency_ms,
                "cache_key": cache_key or "",
            },
            attributes={
                "tier": tier,
                "hit": "true" if hit else "false",
            },
            tags={"tier": tier, "hit": "true" if hit else "false"},
        )
        return await self.ingest(event)

    # ── §Phase 7.2a — Per-chunk streaming capture ──────────────────
    # SDKs buffer streaming chunks (50 chunks OR 250ms) and POST them
    # to /orgs/{org_id}/ingest/chunks. The collector validates each
    # chunk against its parent event_id, deduplicates by chunk_id, and
    # writes to telemetry_stream_chunks. A separate background job
    # rolls up ttft/itl/tpot per (tenant, model, hour) into
    # telemetry_streaming_metrics.

    async def record_stream_chunks(
        self,
        tenant_id: str,
        chunks: list[dict[str, Any]],
        *,
        settings: Any = None,
    ) -> dict[str, int]:
        """Persist a batch of streaming chunks.

        Returns a dict with ``accepted`` / ``rejected`` / ``deduplicated``
        / ``total``. Caller (the chunks ingest route) maps that to
        HTTP 200 with body.

        Chunks must be dicts with at least ``event_id``, ``trace_id``,
        ``chunk_index``. Missing required fields count as rejected;
        duplicate ``chunk_id`` (set by SDK as
        ``f"{event_id}:{chunk_index}"``) are deduped.
        """
        accepted = 0
        rejected = 0
        deduplicated = 0
        if not chunks:
            return {
                "accepted": 0,
                "rejected": 0,
                "deduplicated": 0,
                "total": 0,
            }

        client = await self._get_postgres()
        if not client:
            # DL-3: when Postgres is unavailable, raise so the route
            # returns 503 + Retry-After. The SDK will retry the
            # buffered chunks. Silently dropping leaves the SDK
            # thinking the data was persisted.
            from eden.observability.errors import IngestionUnavailable

            logger.warning(
                "record_stream_chunks: no Postgres client; "
                "raising IngestionUnavailable for the route to map "
                "to 503",
            )
            raise IngestionUnavailable(
                "Ingestion temporarily unavailable; Postgres unavailable, retry after backoff",
            )

        # PII pre-mask on text fields
        pii_on = bool(settings and settings.ingestion_pii_pre_mask)
        if pii_on:
            try:
                from eden.observability.ingestion.pii import mask_payload

                for chunk in chunks:
                    for field in ("delta_text", "reasoning_delta"):
                        if isinstance(chunk.get(field), str):
                            masked = await mask_payload({"text": chunk[field]})
                            if isinstance(masked, dict) and "text" in masked:
                                chunk[field] = masked["text"]
            except Exception as exc:
                logger.debug(f"chunk PII mask failed: {exc}")

        # Dedupe in-memory by chunk_id (set by SDK as event_id:index).
        # The DB unique constraint on chunk_id is the durable guard.
        seen: set[str] = set()
        rows: list[tuple] = []
        for chunk in chunks:
            try:
                event_id = str(chunk["event_id"])
                trace_id = str(chunk["trace_id"])
                chunk_index = int(chunk["chunk_index"])
            except (KeyError, TypeError, ValueError):
                rejected += 1
                continue
            parent_span_id = chunk.get("parent_span_id")
            span_id = chunk.get("span_id")
            delta_text = chunk.get("delta_text")
            reasoning_delta = chunk.get("reasoning_delta")
            tool_call_delta = chunk.get("tool_call_delta")
            ttft_ms = chunk.get("ttft_ms")
            itl_ms = chunk.get("itl_ms")
            tpot_ms = chunk.get("tpot_ms")
            # telemetry_stream_chunks.chunk_id is uuid NOT NULL, and
            # f"{event_id}:{chunk_index}" can never be a valid UUID — a
            # 36-char uuid plus ":N" is too long, and a 32-char hex id
            # plus ":N" still fails on the colon. asyncpg rejected it
            # client-side, the handler below counted the DataError as
            # `rejected` rather than a server fault, and the route
            # answered 200. The table has 0 rows, lifetime: the whole
            # streaming TTFT/ITL/TPOT feature has never stored anything.
            #
            # uuid5 keeps it deterministic, so the ON CONFLICT
            # (chunk_id) DO NOTHING idempotency still holds.
            chunk_id = str(
                uuid.uuid5(uuid.NAMESPACE_URL, f"{event_id}:{chunk_index}")
            )
            if chunk_id in seen:
                deduplicated += 1
                continue
            seen.add(chunk_id)
            rows.append(
                (
                    chunk_id,
                    event_id,
                    tenant_id,
                    trace_id,
                    parent_span_id,
                    span_id,
                    chunk_index,
                    delta_text,
                    reasoning_delta,
                    json.dumps(tool_call_delta, default=str)
                    if tool_call_delta is not None
                    else None,
                    ttft_ms,
                    itl_ms,
                    tpot_ms,
                )
            )

        if not rows:
            return {
                "accepted": accepted,
                "rejected": rejected,
                "deduplicated": deduplicated,
                "total": len(chunks),
            }

        # Use execute_many for batched insert. ON CONFLICT on chunk_id
        # (which we generate deterministically) gives us idempotency.
        #
        # DL-3: distinguish between "rows rejected because of validation
        # rules" (caller-side data issue, no retry needed) and "rows
        # could not be persisted because the DB is down" (transient,
        # retry needed). The route maps the latter to HTTP 503 +
        # ``Retry-After`` so the SDK buffers + retries; silently
        # returning ``accepted=0, rejected=len(rows)`` would tell the
        # SDK the data was bad and stop retrying.
        try:
            await client.executemany(
                """
                INSERT INTO telemetry_stream_chunks (
                    chunk_id, event_id, tenant_id, trace_id,
                    parent_span_id, span_id, chunk_index,
                    delta_text, reasoning_delta, tool_call_delta,
                    ttft_ms, itl_ms, tpot_ms, received_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
                ON CONFLICT (chunk_id) DO NOTHING
                """,
                rows,
            )
            accepted = len(rows)
        except Exception as exc:
            # Check whether the underlying error is a Postgres
            # connection / availability problem. If yes, re-raise as
            # ``IngestionUnavailable`` so the route returns 503 +
            # ``Retry-After``. Otherwise (e.g. constraint violation,
            # type error) keep the existing behaviour of counting the
            # rows as rejected — the SDK already validated chunk
            # shape, so this branch is rare but possible (schema
            # drift, manual DB edits).
            import asyncpg

            from eden.observability.errors import IngestionUnavailable

            if isinstance(
                exc,
                (
                    asyncpg.exceptions.PostgresConnectionError,
                    asyncpg.exceptions.InterfaceError,
                    asyncpg.exceptions.CannotConnectNowError,
                    ConnectionError,
                    OSError,
                ),
            ):
                logger.warning(
                    "record_stream_chunks: DB unavailable; "
                    "raising IngestionUnavailable for the route to "
                    "map to 503: %s",
                    exc,
                )
                raise IngestionUnavailable(
                    "Ingestion temporarily unavailable; Postgres unavailable, retry after backoff"
                ) from exc
            # Non-connection error (constraint, type error). Treat
            # the rows as rejected so the SDK sees a normal shape.
            logger.warning(f"record_stream_chunks insert failed: {exc}")
            rejected = len(rows)
            accepted = 0

        return {
            "accepted": accepted,
            "rejected": rejected,
            "deduplicated": deduplicated,
            "total": len(chunks),
        }


# ── Singleton accessor ──────────────────────────────────────────────────

_telemetry_collector: TelemetryCollector | None = None
_telemetry_collector_lock = asyncio.Lock()


async def get_telemetry_collector() -> TelemetryCollector:
    """Get the singleton telemetry collector."""
    global _telemetry_collector
    # Fast path: no lock when already initialised.
    if _telemetry_collector is not None:
        return _telemetry_collector
    # Slow path: lock so only one TelemetryCollector is ever constructed.
    async with _telemetry_collector_lock:
        if _telemetry_collector is None:
            _telemetry_collector = TelemetryCollector()
    return _telemetry_collector


async def close_telemetry_collector() -> None:
    """Close the telemetry collector, flushing any buffered ClickHouse rows."""
    global _telemetry_collector
    if _telemetry_collector is not None:
        await _telemetry_collector._flush_clickhouse_buffer()
    _telemetry_collector = None
