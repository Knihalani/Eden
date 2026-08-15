"""F06 — signal event clustering (absorbed F07).

Groups matched ``signal_events`` by embedding similarity, labels clusters,
and auto-resolves clusters quiet for 7+ days.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import math
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

_COSINE_THRESHOLD = 0.82
_QUIET_DAYS = 7
_LOOKBACK_DAYS = 14

# O(n^2) pairwise grouping below is only safe for a bounded candidate count.
# 500 rows -> C(500,2) = 124,750 comparisons; capping at 200 -> 19,900 (~6x
# fewer) while still comparing the most recent (most relevant) events. See
# ``_group_by_similarity`` for why this cap exists alongside the thread
# offload rather than a process pool.
_MAX_CLUSTER_CANDIDATES = 200

# Debounce window for ``cluster_after_match``: a burst of matches for the
# same signal (e.g. a noisy trace stream) should not re-run full clustering
# once per match. Mirrors the pattern in
# ``eden.services.budget_service.evaluate_budget_alerts``.
_CLUSTER_DEBOUNCE_S = 30.0
_last_cluster_run: dict[tuple[str, str], float] = {}


def _cosine(a: list[float], b: list[float], na: float = 0.0, nb: float = 0.0) -> float:
    """Cosine similarity. Pass precomputed L2 norms (``na``, ``nb``) when
    comparing one vector against many to avoid recomputing them on every
    call — the previous version recomputed both norms on *every* pairwise
    comparison inside the O(n^2) grouping loop."""
    if not a or not b or len(a) != len(b):
        return 0.0
    if na <= 0:
        na = math.sqrt(sum(x * x for x in a))
    if nb <= 0:
        nb = math.sqrt(sum(y * y for y in b))
    if na <= 0 or nb <= 0:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    return dot / (na * nb)


def _group_by_similarity(
    vectors: list[list[float]], threshold: float = _COSINE_THRESHOLD
) -> list[list[int]]:
    """Pairwise-group vector indices by cosine similarity — O(n^2).

    Pure/sync so it can be run off the event loop via ``asyncio.to_thread``.

    This repo has no ``ProcessPoolExecutor`` / worker-pool pattern to reuse
    (checked ``src/eden/workers`` and grepped ``ProcessPoolExecutor``
    repo-wide — zero hits), and standing one up (process lifecycle, pickling
    vectors across the boundary, IPC) is a disproportionate lift for what is,
    after ``_MAX_CLUSTER_CANDIDATES`` caps the input, at most a ~200-item
    comparison. ``asyncio.to_thread`` is only a *partial* mitigation — it
    does not give true CPU parallelism (GIL) — but it keeps the event loop's
    callback queue (other requests, DB polling) from being frozen solid for
    the whole comparison window the way running this inline on the loop
    would. Combined with the candidate cap this bounds the worst case to
    ~19,900 comparisons instead of ~124,750.
    """
    norms = [math.sqrt(sum(x * x for x in v)) for v in vectors]
    groups: list[list[int]] = []
    used: set[int] = set()
    for i, vi in enumerate(vectors):
        if i in used:
            continue
        group = [i]
        used.add(i)
        for j in range(i + 1, len(vectors)):
            if j in used:
                continue
            if _cosine(vi, vectors[j], norms[i], norms[j]) >= threshold:
                group.append(j)
                used.add(j)
        if len(group) >= 2:
            groups.append(group)
    return groups


def _event_summary(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("evidence", "evidence_quote", "matched_tokens", "method"):
        val = payload.get(key)
        if val:
            parts.append(str(val))
    if not parts:
        parts.append(json.dumps(payload, default=str)[:200])
    return " ".join(parts)[:400]


def _incr_counter(name: str, help_text: str, **labels: str) -> None:
    """Best-effort counter increment via the repo's in-house metrics
    registry (``eden.observability.simple_metrics``). Metrics must never
    mask a log, so this always swallows its own failures."""
    try:
        from eden.observability.simple_metrics import Counter

        if labels:
            Counter(name, help_text, labelnames=tuple(labels)).labels(**labels).inc()
        else:
            Counter(name, help_text).inc()
    except Exception:  # noqa: BLE001 - metrics must never mask the log
        pass


def _label_cluster(samples: list[str]) -> str:
    if not samples:
        return "signal cluster"
    words = samples[0].split()[:4]
    return " ".join(words).strip() or "signal cluster"


class SignalEventClusterer:
    """Cluster matched events for one signal definition."""

    async def cluster_signal(
        self, org_id: str, signal_id: str, *, lookback_days: int = _LOOKBACK_DAYS
    ) -> int:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception as exc:
            logger.debug("signal_clusterer: db unavailable: %s", exc)
            return 0
        if pg is None:
            return 0

        cutoff = datetime.now(UTC) - timedelta(days=lookback_days)
        try:
            rows = await pg.fetch(
                """
                SELECT id, trace_id, payload, detected_at
                FROM signal_events
                WHERE org_id = $1
                  AND signal_id = $2
                  AND matched = TRUE
                  AND detected_at >= $3
                ORDER BY detected_at DESC
                LIMIT 500
                """,
                org_id,
                signal_id,
                cutoff,
            )
        except Exception as exc:
            logger.debug("signal_clusterer: fetch events failed: %s", exc)
            return 0
        if len(rows) < 2:
            return 0

        if len(rows) > _MAX_CLUSTER_CANDIDATES:
            logger.info(
                "signal_clusterer: capping candidates %d -> %d for org=%s "
                "signal_id=%s to bound O(n^2) grouping cost",
                len(rows),
                _MAX_CLUSTER_CANDIDATES,
                org_id,
                signal_id,
            )
            rows = rows[:_MAX_CLUSTER_CANDIDATES]

        summaries = [
            _event_summary(
                r["payload"]
                if isinstance(r.get("payload"), dict)
                else json.loads(r.get("payload") or "{}")
            )
            for r in rows
        ]
        vectors = await self._embed(summaries)
        if not vectors or len(vectors) != len(rows):
            return 0

        # Offloaded off the event loop — see ``_group_by_similarity`` for why
        # ``asyncio.to_thread`` (not inline, not a process pool) was chosen.
        groups = await asyncio.to_thread(_group_by_similarity, vectors)
        if not groups:
            return 0

        # Batch the inserts into one round-trip instead of one INSERT per
        # group (previously N sequential awaits for N clusters).
        insert_rows: list[tuple[Any, ...]] = []
        for group in groups:
            trace_ids = [str(rows[i]["trace_id"]) for i in group]
            times = [rows[i]["detected_at"] for i in group]
            centroid = vectors[group[0]]
            name = _label_cluster([summaries[i] for i in group[:5]])
            insert_rows.append(
                (
                    str(uuid.uuid4()),
                    org_id,
                    signal_id,
                    name[:200],
                    len(group),
                    min(times),
                    max(times),
                    json.dumps(centroid, separators=(",", ":")),
                    trace_ids[:10],
                )
            )

        try:
            await pg.executemany(
                """
                INSERT INTO signal_clusters
                    (id, org_id, signal_id, name, status, event_count,
                     first_seen, last_seen, centroid, sample_trace_ids)
                VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8::jsonb, $9)
                ON CONFLICT (id) DO NOTHING
                """,
                insert_rows,
            )
        except Exception as exc:
            logger.error(
                "signal_clusterer: batch persist of %d cluster(s) failed: %s",
                len(insert_rows),
                exc,
                exc_info=True,
            )
            _incr_counter(
                "eden_signal_clusterer_persist_failed_total",
                "signal_clusters batch insert failed",
            )
            return 0
        return len(insert_rows)

    async def resolve_quiet_clusters(self, org_id: str | None = None) -> int:
        """Auto-resolve clusters with no events in the quiet window."""
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return 0
        if pg is None:
            return 0

        cutoff = datetime.now(UTC) - timedelta(days=_QUIET_DAYS)
        try:
            if org_id:
                res = await pg.execute(
                    """
                    UPDATE signal_clusters
                    SET status = 'resolved', updated_at = NOW()
                    WHERE org_id = $1
                      AND status = 'open'
                      AND last_seen < $2
                    """,
                    org_id,
                    cutoff,
                )
            else:
                res = await pg.execute(
                    """
                    UPDATE signal_clusters
                    SET status = 'resolved', updated_at = NOW()
                    WHERE status = 'open'
                      AND last_seen < $1
                    """,
                    cutoff,
                )
        except Exception as exc:
            logger.debug("signal_clusterer: resolve quiet failed: %s", exc)
            return 0
        try:
            return int(str(res).strip().split()[-1])
        except (ValueError, IndexError):
            return 0

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        """Embed event summaries for clustering.

        Prefers a real semantic embedder (``eden.kb.ledger.embeddings``,
        which wraps a BGE-small ``sentence-transformers`` model — the same
        infra the ledger's retrieval path already uses) when one is
        actually installed. ``sentence-transformers`` is not a declared
        dependency of this repo today, so in practice this almost always
        falls through to :func:`eden.util.stable_hash.hashed_term_vector` —
        a deterministic hashed bag-of-words vector. That fallback is a
        deliberate content-similarity measure (texts that share vocabulary
        get genuinely higher cosine similarity), not the previous
        degenerate whole-string hash that collapsed 478/500 unrelated rows
        into a single mega-cluster (OPT-2).
        """
        if not texts:
            return []
        try:
            if importlib.util.find_spec("sentence_transformers") is None:
                raise ModuleNotFoundError(
                    "sentence-transformers not installed; "
                    "eden.kb.ledger.embeddings.embed_text would silently "
                    "degrade to a non-semantic hash embedding internally"
                )

            from eden.kb.ledger.embeddings import embed_text, unpack_embedding

            def _run() -> list[list[float]]:
                return [unpack_embedding(embed_text(t)) for t in texts]

            vectors = await asyncio.to_thread(_run)
            if (
                not vectors
                or len(vectors) != len(texts)
                or not vectors[0]
                or any(len(v) != len(vectors[0]) for v in vectors)
            ):
                raise ValueError(
                    "eden.kb.ledger.embeddings returned empty/inconsistent vectors"
                )
            return vectors
        except Exception as exc:
            logger.error(
                "signal_clusterer: no real semantic embedder available (%s); "
                "falling back to hashed lexical-overlap vectors — clusters "
                "reflect token overlap, not full semantics",
                exc,
                exc_info=True,
            )
            _incr_counter(
                "eden_signal_clusterer_embed_fallback_total",
                "signal_clusterer._embed fell back to lexical vectors",
            )
            from eden.util.stable_hash import hashed_term_vector

            return [hashed_term_vector(t) for t in texts]


async def cluster_after_match(org_id: str, signal_id: str) -> None:
    """Best-effort async hook after a matched signal event.

    Debounced per ``(org_id, signal_id)`` — without this, a burst of
    matches for the same signal (a noisy trace stream) re-runs full
    clustering on every single ``signal_events`` insert.
    """
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "signal_clusters_v1", True):
            return

        key = (org_id, signal_id)
        now = time.monotonic()
        last = _last_cluster_run.get(key)
        if last is not None and (now - last) < _CLUSTER_DEBOUNCE_S:
            return
        _last_cluster_run[key] = now
        if len(_last_cluster_run) > 8192:
            stale = [
                k
                for k, t in _last_cluster_run.items()
                if (now - t) > _CLUSTER_DEBOUNCE_S * 4
            ]
            for k in stale:
                _last_cluster_run.pop(k, None)

        await SignalEventClusterer().cluster_signal(org_id, signal_id)
    except Exception as exc:
        logger.error(
            "signal_clusterer: cluster_after_match failed org=%s signal_id=%s: %s",
            org_id,
            signal_id,
            exc,
            exc_info=True,
        )
        _incr_counter(
            "eden_signal_clusterer_cluster_after_match_failed_total",
            "cluster_after_match raised",
        )
