"""Insights Service — orchestration facade for the Insights Engine.

Phase 6.3: Central service that ties together trace ingestion, detector
execution, dataset generation, and comparative analysis.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from eden.insights.comparative_analysis import ComparativeAnalysisEngine, DisparityReport
from eden.insights.dataset_engine import DatasetEntry, DatasetGenerationEngine
from eden.insights.detectors import DetectorRegistry, Insight
from eden.insights.unified_trace_model import Realm, TraceNormalizer, UnifiedTrace

logger = logging.getLogger(__name__)


class InsightsService:
    """Central service for the Insights Engine.

    Handles trace ingestion, runs detectors, generates datasets,
    and produces comparative analysis reports.
    """

    # In-memory store limits per tenant (production: use PostgreSQL + Redis)
    MAX_TRACES_PER_TENANT = 5000
    MAX_INSIGHTS_PER_TENANT = 2000
    MAX_DISPARITY_REPORTS_PER_TENANT = 500

    def __init__(self, embedder: Any | None = None):
        self.normalizer = TraceNormalizer()
        self.registry = DetectorRegistry()
        self.dataset_engine = DatasetGenerationEngine()
        self.comparative_engine = ComparativeAnalysisEngine()
        # In-memory trace store — production would use PostgreSQL + Redis
        self._traces: dict[str, UnifiedTrace] = {}
        self._tenant_traces: dict[str, list[str]] = {}
        self._insights: list[Insight] = []
        self._disparity_reports: list[DisparityReport] = []
        # §3.2 — pluggable embedder. Default tries
        # SentenceTransformerEmbedder (offline, 384-dim), then falls
        # back to a deterministic hash-derived 1536-dim vector so the
        # KB write path never blocks. Production should pass an
        # OpenAIEmbedder or a real SentenceTransformer via ``embedder=``.
        self._embedder = embedder
        self._embedder_dim: int | None = None
        self._embedder_kind: str = "uninitialized"

    # ──────────────────────────────────────────────────────────────────────
    # Trace Ingestion
    # ──────────────────────────────────────────────────────────────────────

    def ingest_environment_trace(
        self,
        tenant_id: str,
        raw: dict[str, Any],
    ) -> UnifiedTrace:
        """Ingest and normalize an environment trace."""
        trace = self.normalizer.from_environment_trace(tenant_id, raw)
        self._store_trace(trace)
        return trace

    def ingest_production_trace(
        self,
        tenant_id: str,
        raw: dict[str, Any],
    ) -> UnifiedTrace:
        """Ingest and normalize a production trace."""
        trace = self.normalizer.from_production_trace(tenant_id, raw)
        self._store_trace(trace)
        return trace

    def ingest_comparative_trace(
        self,
        tenant_id: str,
        env_trace_id: str,
        prod_trace_id: str,
        metrics: dict[str, Any],
    ) -> UnifiedTrace:
        """Ingest a comparative trace from disparity metrics."""
        trace = self.normalizer.from_comparative_metrics(
            tenant_id, env_trace_id, prod_trace_id, metrics
        )
        self._store_trace(trace)
        return trace

    def _store_trace(self, trace: UnifiedTrace) -> None:
        self._traces[trace.trace_id] = trace
        tenant_list = self._tenant_traces.setdefault(trace.tenant_id, [])
        tenant_list.append(trace.trace_id)
        # Enforce per-tenant trace limit (FIFO eviction)
        if len(tenant_list) > self.MAX_TRACES_PER_TENANT:
            evicted = tenant_list[:len(tenant_list) - self.MAX_TRACES_PER_TENANT]
            self._tenant_traces[trace.tenant_id] = tenant_list[-self.MAX_TRACES_PER_TENANT:]
            for tid in evicted:
                self._traces.pop(tid, None)

    def get_trace(self, tenant_id: str, trace_id: str) -> UnifiedTrace | None:
        """Look up one trace, scoped to ``tenant_id``.

        ``_traces`` is keyed by trace id alone and shared across tenants;
        ``_tenant_traces`` is the ownership index. Without the check any
        caller could read any trace given its id.
        """
        if trace_id not in self._tenant_trace_ids(tenant_id):
            return None
        return self._traces.get(trace_id)

    def list_traces(
        self,
        tenant_id: str,
        realm: Realm | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[UnifiedTrace]:
        trace_ids = self._tenant_traces.get(tenant_id, [])
        traces = [self._traces[tid] for tid in trace_ids if tid in self._traces]
        if realm:
            traces = [t for t in traces if t.realm == realm]
        return traces[offset:offset + limit]

    # ──────────────────────────────────────────────────────────────────────
    # Detector Execution
    # ──────────────────────────────────────────────────────────────────────

    def run_detectors(
        self,
        tenant_id: str,
        detector_names: list[str] | None = None,
        realm: Realm | None = None,
    ) -> list[Insight]:
        """Run detectors on traces for a tenant."""
        traces = self.list_traces(tenant_id, realm=realm, limit=1000)
        if not traces:
            return []

        if detector_names:
            insights = self.registry.run_selected(traces, detector_names)
        else:
            insights = self.registry.run_all(traces)

        # Store insights with per-tenant limit
        tenant_insight_count = sum(
            1 for i in self._insights
            if any(tid in self._tenant_traces.get(tenant_id, []) for tid in i.affected_trace_ids)
        )
        room = max(0, self.MAX_INSIGHTS_PER_TENANT - tenant_insight_count)
        self._insights.extend(insights[:room])
        if len(insights) > room:
            logger.warning(f"Dropped {len(insights) - room} insights for tenant {tenant_id} (limit reached)")

        # Auto-generate datasets from insights
        for insight in insights:
            if insight.auto_created_dataset:
                self._auto_generate_dataset(insight, traces)

        return insights

    def _tenant_trace_ids(self, tenant_id: str) -> set[str]:
        """Trace ids owned by ``tenant_id``, as a set.

        ``_tenant_traces`` stores lists, so ``tid in list`` is O(n) per probe.
        Callers scanning every insight against every affected trace id turned
        that into O(insights x affected x traces) on a process-global store —
        measurable as multi-second blocking on a busy pod. Build the set once
        per call instead.
        """
        return set(self._tenant_traces.get(tenant_id, ()))

    def _owned_by_tenant(self, insight: Insight, owned: set[str]) -> bool:
        """True when any affected trace belongs to the tenant."""
        return any(tid in owned for tid in insight.affected_trace_ids)

    def get_insights(
        self,
        tenant_id: str,
        detector: str | None = None,
        severity: str | None = None,
        limit: int = 100,
    ) -> list[Insight]:
        """Get stored insights for a tenant."""
        owned = self._tenant_trace_ids(tenant_id)
        insights = [i for i in self._insights if self._owned_by_tenant(i, owned)]
        if detector:
            insights = [i for i in insights if i.detector == detector]
        if severity:
            insights = [i for i in insights if i.severity == severity]
        return insights[:limit]

    def get_insight_by_id(
        self, tenant_id: str, insight_id: str
    ) -> Insight | None:
        """Look up one insight, scoped to ``tenant_id``.

        ``tenant_id`` is required. ``_insights`` is a process-global list
        shared by every tenant in the pod, so an id-only lookup returned
        another organisation's insight to any caller who could reach the
        route — the route validated access to the *path* org and then served
        whatever matched the id.

        ``Insight`` carries no tenant field of its own, so ownership is
        derived from ``affected_trace_ids``, matching ``get_insights``.
        """
        owned = self._tenant_trace_ids(tenant_id)
        for i in self._insights:
            if i.insight_id == insight_id and self._owned_by_tenant(i, owned):
                return i
        return None

    # ──────────────────────────────────────────────────────────────────────
    # Dataset Generation
    # ──────────────────────────────────────────────────────────────────────

    def generate_datasets(
        self,
        tenant_id: str,
        trace_ids: list[str] | None = None,
    ) -> dict[str, list[DatasetEntry]]:
        """Generate datasets from traces using configured rules."""
        if trace_ids:
            traces = [self._traces[tid] for tid in trace_ids if tid in self._traces]
        else:
            traces = self.list_traces(tenant_id, limit=1000)

        return self.dataset_engine.process_batch(traces)

    def list_datasets(self, tenant_id: str) -> list[dict[str, Any]]:
        """List all datasets for a tenant."""
        datasets = self.dataset_engine.list_datasets(tenant_id)
        return [d.to_dict() for d in datasets]

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        dataset = self.dataset_engine.get_dataset(dataset_id)
        return dataset.to_dict() if dataset else None

    def get_dataset_entries(
        self,
        dataset_id: str,
        limit: int = 1000,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        entries = self.dataset_engine.get_entries(dataset_id, limit, offset)
        return [e.to_dict() for e in entries]

    def export_dataset(
        self,
        dataset_id: str,
        format_type: str = "jsonl",
        split_ratio: tuple[float, float] | None = None,
    ) -> dict[str, Any]:
        return self.dataset_engine.export_dataset(dataset_id, format_type, split_ratio)

    def get_dataset_stats(self) -> dict[str, Any]:
        return self.dataset_engine.get_stats()

    def _auto_generate_dataset(self, insight: Insight, traces: list[UnifiedTrace]) -> None:
        """Automatically generate a dataset from an insight."""
        affected_traces = [
            self._traces.get(tid)
            for tid in insight.affected_trace_ids
            if tid in self._traces
        ]
        affected_traces = [t for t in affected_traces if t is not None]
        if affected_traces:
            self.dataset_engine.process_batch(affected_traces)
            logger.info(f"Auto-generated dataset '{insight.auto_created_dataset}' from insight {insight.insight_id}")

    # ──────────────────────────────────────────────────────────────────────
    # Phase 6.3.6: Insights → KB → better environments
    # ──────────────────────────────────────────────────────────────────────
    # The "feedback flywire" loops an insight back into the
    # knowledge base so future Planner / Critic / Executor runs can
    # read it as a warning. Each insight becomes a semantic-graph
    # entity of type ``insight`` and (when applicable) creates a
    # CONTAINS edge back to the affected trace ids.

    async def write_insight_to_kb(
        self,
        insight: Insight,
        *,
        organization_id: str | None = None,
    ) -> str | None:
        """Persist an insight as a KB semantic-graph entity.

        Returns the entity id (str) on success, or ``None`` if the
        KB write failed. Failures are logged but never raised —
        insights are advisory, not blocking.
        """
        try:
            # Bug fix (June 2026 audit): the previous import was
            # ``get_semantic_client`` which doesn't exist; the
            # ``kb.semantic.vector_client`` module exports
            # ``get_vector_client``. The class also has ``upsert`` (not
            # ``upsert_entity``) and no ``query_by_name`` — we use
            # ``search`` for AUDN dedup.
            from datetime import datetime
            from uuid import uuid4

            from eden.kb.semantic.vector_client import get_vector_client
            from eden.kb.shared.audit import evaluate_audn

            semantic = get_vector_client()
            entity_name = f"insight:{insight.insight_id}"

            payload = {
                "entity_type": "insight",
                "name": entity_name,
                "title": insight.summary,
                "description": insight.recommended_action or insight.summary,
                "detector": insight.detector,
                "severity": insight.severity,
                "confidence": insight.confidence,
                "affected_trace_ids": insight.affected_trace_ids,
                "recommendations": [insight.recommended_action] if insight.recommended_action else [],
                "organization_id": organization_id,
                "recorded_at": datetime.now(UTC).isoformat(),
            }

            # §3.2 — Real embeddings, not a hash-derived stub. Build the
            # vector from the insight's summary + recommended_action so
            # semantically-similar insights land close together in
            # Qdrant. Falls back to a deterministic vector if the
            # embedder is unavailable.
            try:
                embed_text = insight.summary
                if insight.recommended_action:
                    embed_text = f"{insight.summary}\n\n{insight.recommended_action}"
                vec, dim = await self._embed_async(embed_text)
            except Exception as exc:
                logger.debug("write_insight_to_kb: embedder failed (%s); using fallback", exc)
                vec, dim = self._fallback_vector(entity_name)

            # AUDN dedup — best-effort search; if the search fails we
            # skip dedup and write anyway. AUDN is advisory, not
            # blocking.
            try:
                existing_hits = await semantic.search(
                    collection="insights",
                    query_vector=vec,
                    filter_conditions={"name": entity_name},
                    limit=1,
                )
                existing = [h.payload if hasattr(h, "payload") else dict(h) for h in (existing_hits or [])]
            except Exception:
                existing = []

            audn = evaluate_audn(
                payload,
                existing,
                subject_key="name",
                timestamp_key="recorded_at",
            )
            if audn.action.value in ("ADD", "UPDATE"):
                entity_id = str(uuid4())
                ok = await semantic.upsert(
                    collection="insights",
                    points=[{
                        "id": entity_id,
                        "vector": vec,
                        "payload": payload,
                    }],
                )
                if not ok:
                    logger.warning(f"KB upsert returned False for {insight.insight_id}")
                    return None
                logger.info(
                    f"Wrote insight {insight.insight_id} to KB "
                    f"(action={audn.action.value}, entity_id={entity_id}, dim={dim})"
                )
                # Mirror to Postgres for the closed-loop correlation report.
                await self.persist_insight_to_postgres(
                    insight, organization_id=organization_id
                )
                await self.record_kb_insight_write(insight.insight_id, entity_id)
                return entity_id
            logger.debug(
                f"Skipped writing insight {insight.insight_id} to KB: "
                f"AUDN={audn.action.value}"
            )
            return None
        except Exception as exc:
            logger.warning(f"Failed to write insight {insight.insight_id} to KB: {exc}")
            return None

    async def _embed_async(self, text: str) -> tuple[list[float], int]:
        """Embed ``text`` using the configured embedder.

        Resolution order:
          1. The embedder passed to ``__init__(embedder=...)`` — the
             production path (OpenAI or sentence-transformers).
          2. A lazily-constructed ``SentenceTransformerEmbedder`` (or
             ``OpenAIEmbedder`` if no API key is set) — set up once
             per process.
          3. The deterministic hash-derived vector (always works,
             same dimensions as OpenAI's text-embedding-3-small).

        Returns ``(vector, dim)``. ``dim`` is recorded on the logger
        line so a misconfigured production deployment can be spotted
        from the KB row.
        """
        if self._embedder is None:
            self._embedder = self._build_default_embedder()
        if self._embedder_kind == "uninitialized":
            # Detect the kind for logging.
            cls_name = type(self._embedder).__name__
            self._embedder_kind = cls_name
        try:
            vec = self._embedder.embed(text)
            if not isinstance(vec, list) or not vec:
                raise ValueError(f"embedder returned non-list: {type(vec)}")
            self._embedder_dim = len(vec)
            return vec, len(vec)
        except Exception:
            # Bubble up; the outer try/except in write_insight_to_kb
            # falls back to the hash-derived vector.
            raise

    def _build_default_embedder(self) -> Any:
        """Build the default embedder. Tries sentence-transformers
        first (offline), then OpenAI (online), then a deterministic
        hash fallback.
        """
        # 1) sentence-transformers (offline-capable)
        try:
            from eden.llmops.semantic_cache import SentenceTransformerEmbedder
            emb = SentenceTransformerEmbedder()
            # Don't actually load the model here — that happens on
            # first .embed() call so importing this module is fast.
            self._embedder_kind = "SentenceTransformerEmbedder"
            return emb
        except Exception:
            pass
        # 2) OpenAI
        try:
            from eden.llmops.semantic_cache import OpenAIEmbedder
            self._embedder_kind = "OpenAIEmbedder"
            return OpenAIEmbedder()
        except Exception:
            pass
        # 3) Hash fallback (synthetic; always works)
        self._embedder_kind = "HashFallback"
        return _HashFallbackEmbedder(dim=1536)

    def _fallback_vector(self, text: str) -> tuple[list[float], int]:
        """Deterministic 1536-dim vector derived from SHA-256(text).
        Used only when the configured embedder is unavailable."""
        import hashlib
        seed = hashlib.sha256(text.encode()).digest()
        vec = [b / 255.0 for b in (seed * 48)[:1536]]
        return vec, 1536

    async def write_all_pending_insights_to_kb(
        self,
        organization_id: str | None = None,
    ) -> dict[str, Any]:
        """Write every unprocessed insight to the KB. Returns a
        summary of what was written/skipped/failed so callers can
        surface it in the insights dashboard."""
        written: list[str] = []
        skipped: list[str] = []
        failed: list[str] = []
        # Bug fix (June 2026 audit): ``self._insights`` is a ``list``,
        # not a dict — iterating ``.values()`` raised AttributeError.
        # The right iteration is direct.
        for insight in self._insights:
            if getattr(insight, "_kb_written", False):
                skipped.append(insight.insight_id)
                continue
            entity_id = await self.write_insight_to_kb(
                insight, organization_id=organization_id
            )
            if entity_id is not None:
                insight._kb_written = True  # type: ignore[attr-defined]
                written.append(entity_id)
            else:
                failed.append(insight.insight_id)
        return {
            "written": written,
            "skipped": skipped,
            "failed": failed,
            "total": len(self._insights),
        }

    # ──────────────────────────────────────────────────────────────────────
    # Postgres persistence (closed-loop correlation)
    # ──────────────────────────────────────────────────────────────────────

    async def persist_insight_to_postgres(
        self,
        insight: Insight,
        *,
        organization_id: str | None = None,
    ) -> str | None:
        """Upsert an insight into the ``insights`` table (migration 019).

        Idempotent: re-running for the same ``insight_id`` is a no-op
        on conflict. Returns the row's UUID on success, ``None`` on
        failure (failures are logged but never raised — insights are
        advisory).
        """
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            row = await client.fetchrow(
                """
                INSERT INTO insights (
                    insight_id, organization_id, detector, severity, confidence,
                    summary, recommended_action, affected_trace_ids, payload, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                ON CONFLICT (insight_id) DO UPDATE
                SET severity = EXCLUDED.severity,
                    confidence = EXCLUDED.confidence,
                    summary = EXCLUDED.summary,
                    recommended_action = EXCLUDED.recommended_action,
                    affected_trace_ids = EXCLUDED.affected_trace_ids,
                    payload = EXCLUDED.payload
                RETURNING id
                """,
                insight.insight_id,
                organization_id,
                insight.detector,
                insight.severity,
                insight.confidence,
                insight.summary,
                insight.recommended_action,
                insight.affected_trace_ids,
                {
                    "pattern": insight.pattern,
                    "auto_created_dataset": insight.auto_created_dataset,
                    "metadata": insight.metadata,
                },
            )
            return str(row["id"]) if row else None
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "persist_insight_to_postgres: skipped (no DB? %s)", exc
            )
            return None

    async def record_kb_insight_write(
        self,
        insight_id: str,
        entity_id: str,
    ) -> None:
        """Record a successful KB write for the closed-loop join in
        ``correlation.py``. One row per (insight, entity) pair; the
        correlation report joins this table to ``insights`` and the
        ``jobs`` table on affected_trace_ids."""
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            await client.execute(
                """
                INSERT INTO kb_insight_writes (insight_id, entity_id, written_at)
                VALUES ($1, $2, NOW())
                """,
                insight_id,
                entity_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "record_kb_insight_write: skipped (no DB? %s)", exc
            )

    # ──────────────────────────────────────────────────────────────────────
    # Comparative Analysis
    # ──────────────────────────────────────────────────────────────────────

    def compare_env_vs_prod(
        self,
        tenant_id: str,
        env_trace_id: str,
        prod_trace_id: str,
    ) -> DisparityReport:
        """Compare an environment trace against a production trace."""
        env_trace = self._traces.get(env_trace_id)
        prod_trace = self._traces.get(prod_trace_id)

        if not env_trace:
            raise ValueError(f"Environment trace not found: {env_trace_id}")
        if not prod_trace:
            raise ValueError(f"Production trace not found: {prod_trace_id}")

        report = self.comparative_engine.compare(env_trace, prod_trace, tenant_id)
        self._disparity_reports.append(report)

        # Also ingest as a comparative trace
        self.ingest_comparative_trace(
            tenant_id,
            env_trace_id,
            prod_trace_id,
            {
                "action_divergence": next(
                    (d.gap for d in report.dimensions if d.name == "action_divergence"), 0.0
                ),
                "outcome_divergence": next(
                    (d.gap for d in report.dimensions if d.name == "outcome_divergence"), 0.0
                ),
                "latency_gap": {
                    "ratio": next(
                        (max(d.env_value, d.prod_value) / max(min(d.env_value, d.prod_value), 1)
                         for d in report.dimensions if d.name == "latency_gap"),
                        1.0
                    ),
                },
                "coverage_gap": next(
                    (d.gap for d in report.dimensions if d.name == "coverage_gap"), 0.0
                ),
                "tool_usage_gap": next(
                    (d.gap for d in report.dimensions if d.name == "tool_usage_gap"), 0.0
                ),
                "error_pattern_gap": next(
                    (d.gap for d in report.dimensions if d.name == "error_pattern_gap"), 0.0
                ),
            },
        )

        return report

    def batch_compare(
        self,
        tenant_id: str,
        trace_pairs: list[tuple[str, str]],
    ) -> list[DisparityReport]:
        """Batch compare multiple trace pairs."""
        unified_pairs = []
        for env_id, prod_id in trace_pairs:
            env_trace = self._traces.get(env_id)
            prod_trace = self._traces.get(prod_id)
            if env_trace and prod_trace:
                unified_pairs.append((env_trace, prod_trace))

        reports = self.comparative_engine.batch_compare(unified_pairs, tenant_id)
        # Enforce per-tenant disparity report limit
        existing = [r for r in self._disparity_reports if r.tenant_id == tenant_id]
        room = max(0, self.MAX_DISPARITY_REPORTS_PER_TENANT - len(existing))
        self._disparity_reports.extend(reports[:room])
        if len(reports) > room:
            logger.warning(f"Dropped {len(reports) - room} disparity reports for tenant {tenant_id} (limit reached)")
        return reports[:room]

    def get_disparity_reports(
        self,
        tenant_id: str,
        min_score: float | None = None,
        limit: int = 100,
    ) -> list[DisparityReport]:
        reports = [r for r in self._disparity_reports if r.tenant_id == tenant_id]
        if min_score is not None:
            reports = [r for r in reports if r.overall_score >= min_score]
        # Sort by overall score descending
        reports.sort(key=lambda r: r.overall_score, reverse=True)
        return reports[:limit]

    def get_disparity_report(
        self, tenant_id: str, report_id: str
    ) -> DisparityReport | None:
        """Look up one disparity report, scoped to ``tenant_id``.

        Unlike ``Insight``, ``DisparityReport`` carries its own ``tenant_id``,
        so the check is direct.
        """
        for r in self._disparity_reports:
            if r.report_id == report_id and r.tenant_id == tenant_id:
                return r
        return None

    # ──────────────────────────────────────────────────────────────────────
    # Dashboard / Overview
    # ──────────────────────────────────────────────────────────────────────

    async def get_overview_from_postgres(
        self,
        organization_id: str,
    ) -> dict[str, Any] | None:
        """Build overview from the ``insights`` table (detector_loop writes).

        Returns ``None`` when Postgres is unreachable or the table is
        missing so callers can fall back to the in-memory store with an
        honesty banner. An empty result set still returns a postgres-
        sourced overview (honest zero, not a silent in-memory demo).
        """
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            rows = await client.fetch(
                """
                SELECT insight_id, detector, severity, confidence, summary,
                       recommended_action, affected_trace_ids, payload,
                       created_at
                FROM insights
                WHERE organization_id = $1::uuid
                ORDER BY created_at DESC
                LIMIT 500
                """,
                organization_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "get_overview_from_postgres: unavailable (%s)", exc
            )
            return None

        by_detector: dict[str, int] = {}
        by_severity: dict[str, int] = {}
        recent: list[dict[str, Any]] = []
        for r in rows:
            detector = str(r["detector"])
            severity = str(r["severity"])
            by_detector[detector] = by_detector.get(detector, 0) + 1
            by_severity[severity] = by_severity.get(severity, 0) + 1

        for r in rows[:10]:
            payload = r["payload"] or {}
            if not isinstance(payload, dict):
                payload = {}
            affected = r["affected_trace_ids"] or []
            if isinstance(affected, str):
                import json

                try:
                    affected = json.loads(affected)
                except Exception:  # noqa: BLE001
                    affected = []
            created = r["created_at"]
            recent.append(
                {
                    "insight_id": r["insight_id"],
                    "detector": r["detector"],
                    "severity": r["severity"],
                    "confidence": float(r["confidence"]),
                    "summary": r["summary"],
                    "affected_trace_ids": list(affected) if affected else [],
                    "pattern": payload.get("pattern") or {},
                    "recommended_action": r["recommended_action"] or "",
                    "auto_created_dataset": payload.get("auto_created_dataset"),
                    "metadata": {
                        **(payload.get("metadata") or {}),
                        "created_at": (
                            created.isoformat()
                            if hasattr(created, "isoformat")
                            else str(created or "")
                        ),
                        "source": "postgres",
                    },
                }
            )

        return {
            "summary": {
                "total_traces": 0,
                "total_insights": len(rows),
                "total_disparity_reports": 0,
                "total_datasets": 0,
                "high_disparity_count": 0,
                "avg_disparity_score": 0.0,
                "source": "postgres",
            },
            "traces": {"by_realm": {}, "by_outcome": {}},
            "insights": {
                "by_detector": by_detector,
                "by_severity": by_severity,
                "recent": recent,
            },
            "disparity": {
                "reports": [],
                "high_disparity_count": 0,
                "avg_score": 0.0,
            },
            "datasets": {"count": 0, "items": []},
        }

    def get_overview(self, tenant_id: str) -> dict[str, Any]:
        """Get a comprehensive overview for the insights dashboard.

        In-memory only — production detector_loop persists to Postgres
        separately. Callers should prefer ``get_overview_from_postgres``.
        """
        traces = self.list_traces(tenant_id, limit=1000)
        insights = self.get_insights(tenant_id, limit=500)
        reports = self.get_disparity_reports(tenant_id, limit=100)
        datasets = self.list_datasets(tenant_id)

        # Insight statistics
        by_detector: dict[str, int] = {}
        by_severity: dict[str, int] = {}
        for i in insights:
            by_detector[i.detector] = by_detector.get(i.detector, 0) + 1
            by_severity[i.severity] = by_severity.get(i.severity, 0) + 1

        # Trace statistics
        by_realm = {}
        by_outcome = {}
        for t in traces:
            by_realm[t.realm.value] = by_realm.get(t.realm.value, 0) + 1
            by_outcome[t.outcome.value] = by_outcome.get(t.outcome.value, 0) + 1

        # Disparity statistics
        high_disparity_count = sum(1 for r in reports if r.overall_score > 0.5)
        avg_disparity = sum(r.overall_score for r in reports) / max(len(reports), 1)

        # Recent activity
        recent_insights = sorted(
            insights,
            key=lambda i: i.metadata.get("created_at", ""),
            reverse=True,
        )[:10]

        return {
            "summary": {
                "total_traces": len(traces),
                "total_insights": len(insights),
                "total_disparity_reports": len(reports),
                "total_datasets": len(datasets),
                "high_disparity_count": high_disparity_count,
                "avg_disparity_score": round(avg_disparity, 3),
                "source": "in_memory",
                "honesty_banner": (
                    "demo/in-memory — production detector loop writes separately"
                ),
            },
            "traces": {
                "by_realm": by_realm,
                "by_outcome": by_outcome,
            },
            "insights": {
                "by_detector": by_detector,
                "by_severity": by_severity,
                "recent": [i.to_dict() for i in recent_insights],
            },
            "disparity": {
                "reports": [r.to_dict() for r in reports[:20]],
                "high_disparity_count": high_disparity_count,
                "avg_score": round(avg_disparity, 3),
            },
            "datasets": {
                "count": len(datasets),
                "items": datasets[:10],
            },
        }

    def get_trends(self, tenant_id: str, days: int = 30) -> dict[str, Any]:
        """Get trend data over time for charts."""
        cutoff = datetime.now(UTC).timestamp() - (days * 86400)
        traces = [
            t for t in self.list_traces(tenant_id, limit=5000)
            if t.started_at and t.started_at.timestamp() >= cutoff
        ]

        # Daily trace counts
        daily_counts = {}
        for t in traces:
            day = t.started_at.strftime("%Y-%m-%d") if t.started_at else "unknown"
            daily_counts[day] = daily_counts.get(day, 0) + 1

        # Daily insight counts
        daily_insights = {}
        for i in self._insights:
            # Use first affected trace's time as proxy
            if i.affected_trace_ids:
                trace = self._traces.get(i.affected_trace_ids[0])
                if trace and trace.started_at and trace.started_at.timestamp() >= cutoff:
                    day = trace.started_at.strftime("%Y-%m-%d")
                    daily_insights[day] = daily_insights.get(day, 0) + 1

        # Outcome trend
        outcome_by_day = {}
        for t in traces:
            day = t.started_at.strftime("%Y-%m-%d") if t.started_at else "unknown"
            if day not in outcome_by_day:
                outcome_by_day[day] = {"success": 0, "failure": 0, "other": 0}
            if t.outcome.value == "success":
                outcome_by_day[day]["success"] += 1
            elif t.outcome.value == "failure":
                outcome_by_day[day]["failure"] += 1
            else:
                outcome_by_day[day]["other"] += 1

        return {
            "period_days": days,
            "daily_traces": daily_counts,
            "daily_insights": daily_insights,
            "outcome_by_day": outcome_by_day,
        }


# ─────────────────────────────────────────────────────────────────────────────
# §3.2 — Hash-fallback embedder
# ─────────────────────────────────────────────────────────────────────────────

class _HashFallbackEmbedder:
    """Deterministic 1536-dim vector derived from SHA-256(text).

    Used when no real embedder is configured and the
    ``SentenceTransformerEmbedder`` / ``OpenAIEmbedder`` imports
    both fail. The vector is *not* semantically meaningful, but it
    IS stable across runs so the KB write path never blocks.
    Production should pass a real embedder via
    ``InsightsService(embedder=...)``.
    """

    def __init__(self, dim: int = 1536) -> None:
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        import hashlib
        seed = hashlib.sha256(text.encode()).digest()
        # Repeat the digest until we have enough bytes; normalize
        # to roughly [-1, 1] by subtracting 0.5.
        vec: list[float] = []
        while len(vec) < self.dim:
            for b in seed:
                vec.append(b / 255.0 - 0.5)
                if len(vec) >= self.dim:
                    break
            seed = hashlib.sha256(seed).digest()
        return vec
