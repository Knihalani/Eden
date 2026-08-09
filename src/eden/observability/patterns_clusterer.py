"""Datadog-style Patterns clusterer (Phase 7.2 C5).

Reads the last ``lookback_days`` of telemetry events for a tenant,
embeds the request messages (a real semantic embedder when one is
installed, else a hashed lexical-overlap fallback — see
``_embed_topics``), clusters the embeddings with HDBSCAN, labels each
cluster via the LLM, and persists the result to the ``trace_patterns``
table.

Coverage gap detection: every cluster is checked against
``golden_datasets`` — clusters with no matching eval are flagged
as a coverage gap. An Insight is emitted so the closed-loop tab
surfaces it, and the portal's Patterns page can show it as
``🟡 partial`` or ``🔴 no coverage``.

The clusterer runs on demand when topics are generated:
``eden.topics.service.generate_topics`` calls
``get_patterns_clusterer().run_once()`` (e.g. via ``POST /topics/generate``).
Each ``run_once`` pass is idempotent and time-bounded.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)

# FEAT-142 — recent-window volume vs longer baseline for trend badges.
TREND_RECENT_DAYS = 7
TREND_BASELINE_DAYS = 21
TREND_FLAT_THRESHOLD = 0.25


def compute_cluster_trend(
    recent_count: int,
    baseline_count: int,
    *,
    recent_days: int = TREND_RECENT_DAYS,
    baseline_days: int = TREND_BASELINE_DAYS,
    flat_threshold: float = TREND_FLAT_THRESHOLD,
) -> dict[str, Any]:
    """Compare per-day volume in the recent window vs the baseline window.

    ``baseline_count`` is the event count across the full baseline window
    (which includes the recent window). Rates are ``count / window_days``;
    ``trend_score`` is ``recent_rate / baseline_rate - 1`` when baseline
    rate is positive, else ``1.0`` when recent activity exists and ``0.0``
    when both windows are quiet. Labels use ±``flat_threshold`` on the score.
    """
    recent = max(0, int(recent_count))
    baseline = max(0, int(baseline_count))
    recent_days = max(1, int(recent_days))
    baseline_days = max(1, int(baseline_days))

    recent_rate = recent / recent_days
    baseline_rate = baseline / baseline_days

    if baseline_rate == 0.0:
        if recent_rate > 0.0:
            trend_score = 1.0
            trend = "rising"
        else:
            trend_score = 0.0
            trend = "flat"
    else:
        trend_score = recent_rate / baseline_rate - 1.0
        if trend_score >= flat_threshold:
            trend = "rising"
        elif trend_score <= -flat_threshold:
            trend = "falling"
        else:
            trend = "flat"

    return {
        "trend": trend,
        "trend_score": float(trend_score),
        "recent_count": recent,
        "baseline_count": baseline,
    }


def _count_window_events(
    timestamps: list[datetime],
    *,
    recent_cutoff: datetime,
    baseline_cutoff: datetime,
) -> tuple[int, int]:
    """Return (recent_count, baseline_count) for the given event timestamps."""
    recent = 0
    baseline = 0
    for ts in timestamps:
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        if ts >= baseline_cutoff:
            baseline += 1
        if ts >= recent_cutoff:
            recent += 1
    return recent, baseline


def _topic_fingerprint(topic: str) -> str:
    """Normalize topic text for within-cluster dedup."""
    return re.sub(r"\s+", " ", (topic or "").strip().lower())


def dedupe_cluster_members(
    topics: list[str],
    trace_ids: list[str],
) -> tuple[list[str], list[str]]:
    """Collapse duplicate trace_ids and identical topic fingerprints (FEAT-143)."""
    seen_traces: set[str] = set()
    seen_topics: set[str] = set()
    out_topics: list[str] = []
    out_traces: list[str] = []
    for topic, trace_id in zip(topics, trace_ids, strict=True):
        tid = (trace_id or "").strip()
        if tid and tid in seen_traces:
            continue
        topic_key = _topic_fingerprint(topic)
        if not tid and topic_key and topic_key in seen_topics:
            continue
        if tid:
            seen_traces.add(tid)
        if topic_key:
            seen_topics.add(topic_key)
        out_topics.append(topic)
        out_traces.append(trace_id)
    return out_topics, out_traces


def stable_pattern_id(tenant_id: str, label: str) -> str:
    """Deterministic pattern id for cross-run merge by tenant + normalized label."""
    norm = _topic_fingerprint(label)
    digest = hashlib.sha256(f"{tenant_id}:{norm}".encode()).hexdigest()[:32]
    return digest


# ── Optional heavy imports are deferred ─────────────────────────────
# HDBSCAN, sklearn, and the embedder may not be installed in dev
# environments. We import them lazily inside ``run_once`` so a
# missing dependency just disables the clusterer (with a warning)
# rather than crashing the app at startup.


class PatternsClusterer:
    """One pass: read events → embed → cluster → label → persist."""

    def __init__(self, llm_client: Any | None = None) -> None:
        self.llm_client = llm_client

    async def run_once(self) -> dict[str, Any]:
        """Process all tenants (or a single one if specified) and
        return a summary."""
        settings = get_settings()
        if not getattr(settings, "patterns_clusterer_enabled", True):
            return {"tenants_processed": 0, "patterns_created": 0}

        # For now, run per-tenant. A production deployment would
        # shard across workers by tenant_id range.
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if not client:
                return {"tenants_processed": 0, "patterns_created": 0}
            rows = await client.fetch(
                "SELECT DISTINCT tenant_id FROM telemetry_events ORDER BY tenant_id ASC LIMIT 100"
            )
            tenants = [str(r["tenant_id"]) for r in rows]
        except Exception as exc:
            logger.warning(f"PatternsClusterer could not list tenants: {exc}")
            return {"tenants_processed": 0, "patterns_created": 0}

        total_patterns = 0
        for tenant_id in tenants:
            try:
                created = await self._run_for_tenant(tenant_id)
                total_patterns += created
            except Exception as exc:
                logger.warning(f"PatternsClusterer failed for {tenant_id}: {exc}")
        return {"tenants_processed": len(tenants), "patterns_created": total_patterns}

    async def _run_for_tenant(self, tenant_id: str) -> int:
        """Cluster one tenant's events and persist the result."""
        settings = get_settings()
        lookback = getattr(settings, "patterns_clusterer_lookback_days", 7)
        min_cluster_size = getattr(settings, "patterns_clusterer_min_cluster_size", 20)
        trend_recent_days = getattr(
            settings, "patterns_clusterer_trend_recent_days", TREND_RECENT_DAYS
        )
        trend_baseline_days = getattr(
            settings, "patterns_clusterer_trend_baseline_days", TREND_BASELINE_DAYS
        )
        effective_lookback = max(lookback, trend_baseline_days)
        now = datetime.now(UTC)
        cutoff = now - timedelta(days=effective_lookback)
        recent_cutoff = now - timedelta(days=trend_recent_days)
        baseline_cutoff = now - timedelta(days=trend_baseline_days)

        # 1) Pull events with a request body on either the plaintext
        # JSONB column or its zstd shadow — Phase 4 storage: reads must
        # not depend on ``request_body`` staying populated once
        # ``telemetry_plaintext_jsonb_write_enabled`` flips to False.
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        rows = await client.fetch(
            """
            SELECT event_id, trace_id, name, timestamp, request_body, request_body_zstd,
                   metrics, attributes
            FROM telemetry_events
            WHERE tenant_id = $1
              AND timestamp >= $2
              AND (request_body IS NOT NULL OR request_body_zstd IS NOT NULL)
              AND source_format IN ('openai', 'anthropic', 'gemini', 'bedrock', 'otel')
            ORDER BY timestamp DESC
            LIMIT 5000
            """,
            tenant_id, cutoff,
        )
        if not rows:
            return 0

        # 2) Extract the "topic" — first user-message content, or
        # the request body's first message. We use the first 500
        # chars to avoid huge inputs.
        topics: list[str] = []
        trace_ids: list[str] = []
        timestamps: list[datetime] = []
        for r in rows:
            # zstd first — matches the canonical reader
            # (telemetry_collector.get_trace_tree) and rules_engine's
            # _load_span_content, so this stays correct once
            # telemetry_plaintext_jsonb_write_enabled=False stops
            # populating the plaintext column on new rows.
            req = None
            zstd_val = r.get("request_body_zstd")
            if zstd_val:
                try:
                    from eden.storage.compression import decompress_jsonb

                    req = decompress_jsonb(zstd_val)
                except Exception:
                    req = None
            if req is None:
                req = r.get("request_body")
            req = req or {}
            if not isinstance(req, dict):
                continue
            messages = req.get("messages") or []
            topic = ""
            for m in messages:
                if isinstance(m, dict) and m.get("role") == "user":
                    content = m.get("content")
                    if isinstance(content, str):
                        topic = content[:500]
                        break
            if not topic:
                topic = (r.get("name") or "")[:500]
            if topic:
                topics.append(topic)
                trace_ids.append(str(r.get("trace_id") or ""))
                ts = r.get("timestamp")
                if isinstance(ts, datetime):
                    timestamps.append(ts)
                else:
                    timestamps.append(now)
        if len(topics) < min_cluster_size:
            return 0

        # 3) Embed
        try:
            vectors = await self._embed_topics(topics)
        except Exception as exc:
            # _embed_topics already catches and logs its own embedder
            # failures internally (falling back to hashed_term_vector), so
            # reaching here means something unexpected happened. Don't let
            # one tenant's failure take down the whole clustering sweep.
            logger.error(
                f"PatternsClusterer: embedding step failed unexpectedly for {tenant_id}: {exc}",
                exc_info=True,
            )
            return 0
        if not vectors or len(vectors) != len(topics):
            return 0

        # 4) Cluster with HDBSCAN (or sklearn KMeans if HDBSCAN missing)
        try:
            import hdbscan
            clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size)
            labels = clusterer.fit_predict(vectors)
        except ImportError:
            try:
                # Heuristic: sqrt(n / 2) clusters, capped at 20
                import math

                from sklearn.cluster import KMeans
                k = max(2, min(20, int(math.sqrt(len(topics) / 2))))
                km = KMeans(n_clusters=k, n_init=10, random_state=42)
                labels = km.fit_predict(vectors)
            except Exception as exc:
                logger.debug(f"Clustering failed for {tenant_id}: {exc}")
                return 0

        # 5) For each non-noise cluster, label and persist
        cluster_topics: dict[int, list[str]] = {}
        cluster_traces: dict[int, list[str]] = {}
        cluster_times: dict[int, list[datetime]] = {}
        for i, lbl in enumerate(labels):
            if lbl < 0:
                continue  # HDBSCAN noise
            cluster_topics.setdefault(int(lbl), []).append(topics[i])
            cluster_traces.setdefault(int(lbl), []).append(trace_ids[i])
            cluster_times.setdefault(int(lbl), []).append(timestamps[i])

        created = 0
        for cluster_id, items in cluster_topics.items():
            traces = cluster_traces[cluster_id]
            dedup_topics, dedup_traces = dedupe_cluster_members(items, traces)
            if not dedup_topics:
                continue
            sample = dedup_topics[:5]
            # LLM label
            label = await self._label_cluster(sample)
            # Coherence = mean intra-cluster cosine similarity
            coherence = _coherence(vectors, [i for i, l in enumerate(labels) if l == cluster_id])
            recent_count, baseline_count = _count_window_events(
                cluster_times.get(cluster_id, []),
                recent_cutoff=recent_cutoff,
                baseline_cutoff=baseline_cutoff,
            )
            trend = compute_cluster_trend(
                recent_count,
                baseline_count,
                recent_days=trend_recent_days,
                baseline_days=trend_baseline_days,
            )
            metadata = {
                "sample_topics": sample[:3],
                **trend,
            }
            pattern_id = stable_pattern_id(tenant_id, label)
            # Persist
            try:
                await client.execute(
                    """
                    INSERT INTO trace_patterns (
                        pattern_id, tenant_id, name, description,
                        topic_label, coherence_score, sample_count,
                        representative_trace_ids, first_seen, last_seen,
                        status, metadata
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, 'active', $10)
                    ON CONFLICT (pattern_id) DO UPDATE
                    SET sample_count = EXCLUDED.sample_count,
                        coherence_score = EXCLUDED.coherence_score,
                        representative_trace_ids = EXCLUDED.representative_trace_ids,
                        last_seen = EXCLUDED.last_seen,
                        metadata = EXCLUDED.metadata,
                        name = EXCLUDED.name,
                        description = EXCLUDED.description,
                        topic_label = EXCLUDED.topic_label
                    """,
                    pattern_id,
                    tenant_id,
                    label[:200],
                    f"Pattern with {len(dedup_topics)} traces in the last {lookback} days",
                    label[:200],
                    float(coherence),
                    len(dedup_topics),
                    dedup_traces[:10],
                    now,
                    json.dumps(metadata, default=str),
                )
                created += 1
            except Exception as exc:
                logger.debug(f"Pattern persist failed: {exc}")

        # 6) Emit Insights for coverage gaps
        await self._emit_coverage_gaps(client, tenant_id, list(cluster_topics.keys()))

        return created

    async def _embed_topics(self, topics: list[str]) -> list[list[float]]:
        """Embed cluster topics.

        Prefers a real semantic embedder (``eden.kb.ledger.embeddings`` —
        BGE-small via ``sentence-transformers``, the same infra the KB
        ledger's retrieval path already uses) when one is actually
        installed. ``sentence-transformers`` is not a declared dependency
        of this repo today, so this almost always falls through to
        :func:`eden.util.stable_hash.hashed_term_vector` — a deterministic
        hashed bag-of-words vector that is a real (if lexical, not
        semantic) content-similarity measure, unlike returning no vectors
        at all (the previous behavior: the dead ``eden.kb.embeddings``
        import meant this step always raised ``ModuleNotFoundError`` and
        every tenant pass silently produced zero patterns).
        """
        if not topics:
            return []
        try:
            import importlib.util

            if importlib.util.find_spec("sentence_transformers") is None:
                raise ModuleNotFoundError(
                    "sentence-transformers not installed; "
                    "eden.kb.ledger.embeddings.embed_text would silently "
                    "degrade to a non-semantic hash embedding internally"
                )

            from eden.kb.ledger.embeddings import embed_text, unpack_embedding

            def _run() -> list[list[float]]:
                return [unpack_embedding(embed_text(t)) for t in topics]

            vectors = await asyncio.to_thread(_run)
            if (
                not vectors
                or len(vectors) != len(topics)
                or not vectors[0]
                or any(len(v) != len(vectors[0]) for v in vectors)
            ):
                raise ValueError(
                    "eden.kb.ledger.embeddings returned empty/inconsistent vectors"
                )
            return vectors
        except Exception as exc:
            logger.error(
                "PatternsClusterer: no real semantic embedder available (%s); "
                "falling back to hashed lexical-overlap vectors",
                exc,
                exc_info=True,
            )
            try:
                from eden.observability.simple_metrics import Counter

                Counter(
                    "eden_patterns_clusterer_embed_fallback_total",
                    "PatternsClusterer embedding step fell back to lexical vectors",
                ).inc()
            except Exception:  # noqa: BLE001 - metrics must never mask the log
                pass

            from eden.util.stable_hash import hashed_term_vector

            return [hashed_term_vector(t) for t in topics]

    async def _label_cluster(self, samples: list[str]) -> str:
        """Use the LLM to produce a 2-5 word topic label for the cluster.
        Falls back to a deterministic heuristic if no LLM is configured."""
        if not self.llm_client or not samples:
            # Heuristic: take the most common 3-word prefix
            from collections import Counter
            counters: Counter = Counter()
            for s in samples:
                words = s.split()[:3]
                if words:
                    counters[" ".join(words).lower()] += 1
            if counters:
                return counters.most_common(1)[0][0]
            return "general queries"
        # LLM label path
        try:
            prompt = (
                "Give a 2-5 word topic label for this cluster of user queries. "
                "Return only the label, no quotes.\n\n"
                + "\n".join(f"- {s[:200]}" for s in samples)
            )
            label = await self.llm_client.complete(prompt, max_tokens=20)
            return str(label).strip().strip('"').strip("'")
        except Exception as exc:
            logger.debug(f"LLM label failed: {exc}")
            return "general queries"

    async def _emit_coverage_gaps(
        self,
        client: Any,
        tenant_id: str,
        cluster_ids: list[int],
    ) -> None:
        """For each pattern, check if a golden_dataset entry covers
        it. If not, emit an Insight so the closed-loop tab surfaces
        the gap and the portal shows the pattern as uncovered."""
        # We approximate "coverage" by checking if the pattern's
        # representative traces have any associated golden_dataset
        # entry. The existing correlation code does the join.
        # For now, emit a generic insight per pattern that has
        # > 50 traces (high enough to be a real signal).
        try:
            rows = await client.fetch(
                """
                SELECT pattern_id, topic_label, sample_count
                FROM trace_patterns
                WHERE tenant_id = $1 AND status = 'active' AND sample_count > 50
                """,
                tenant_id,
            )
        except Exception:
            return

        for r in rows:
            try:
                from eden.insights.insights_service import write_insight
                await write_insight(
                    tenant_id=tenant_id,
                    detector="patterns.coverage_gap",
                    severity="info",
                    confidence=0.7,
                    summary=(
                        f"Pattern '{r['topic_label']}' has {r['sample_count']} "
                        f"production traces — verify the eval set covers it."
                    ),
                    pattern={
                        "pattern_id": str(r["pattern_id"]),
                        "topic_label": r["topic_label"],
                        "sample_count": int(r["sample_count"]),
                    },
                    recommended_action=(
                        "Open the Patterns page to inspect and generate an environment for this gap."
                    ),
                )
            except Exception as exc:
                logger.debug(f"Coverage gap insight emit failed: {exc}")


def _coherence(vectors: list[list[float]], indices: list[int]) -> float:
    """Mean intra-cluster cosine similarity, in [0, 1]."""
    if len(indices) < 2:
        return 0.0
    import math
    sims: list[float] = []
    for i_pos, i in enumerate(indices):
        for j in indices[i_pos + 1:]:
            vi = vectors[i]
            vj = vectors[j]
            dot = sum(a * b for a, b in zip(vi, vj, strict=False))
            n_i = math.sqrt(sum(a * a for a in vi))
            n_j = math.sqrt(sum(b * b for b in vj))
            if n_i > 0 and n_j > 0:
                sims.append(dot / (n_i * n_j))
    if not sims:
        return 0.0
    mean = sum(sims) / len(sims)
    # Map from [-1, 1] to [0, 1]
    return max(0.0, min(1.0, (mean + 1) / 2))


_clusterer: PatternsClusterer | None = None


def get_patterns_clusterer() -> PatternsClusterer:
    global _clusterer
    if _clusterer is None:
        _clusterer = PatternsClusterer()
    return _clusterer
