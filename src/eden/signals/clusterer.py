"""F06 — signal event clustering (absorbed F07).

Groups matched ``signal_events`` by embedding similarity, labels clusters,
and auto-resolves clusters quiet for 7+ days.
"""

from __future__ import annotations

import json
import logging
import math
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.util.stable_hash import stable_hash

logger = logging.getLogger(__name__)

_COSINE_THRESHOLD = 0.82
_QUIET_DAYS = 7
_LOOKBACK_DAYS = 14


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / (na * nb)


def _event_summary(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("evidence", "evidence_quote", "matched_tokens", "method"):
        val = payload.get(key)
        if val:
            parts.append(str(val))
    if not parts:
        parts.append(json.dumps(payload, default=str)[:200])
    return " ".join(parts)[:400]


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

        groups: list[list[int]] = []
        used: set[int] = set()
        for i, vi in enumerate(vectors):
            if i in used:
                continue
            group = [i]
            used.add(i)
            for j, vj in enumerate(vectors):
                if j in used:
                    continue
                if _cosine(vi, vj) >= _COSINE_THRESHOLD:
                    group.append(j)
                    used.add(j)
            if len(group) >= 2:
                groups.append(group)

        created = 0
        for group in groups:
            trace_ids = [str(rows[i]["trace_id"]) for i in group]
            times = [rows[i]["detected_at"] for i in group]
            centroid = vectors[group[0]]
            name = _label_cluster([summaries[i] for i in group[:5]])
            cluster_id = str(uuid.uuid4())
            try:
                await pg.execute(
                    """
                    INSERT INTO signal_clusters
                        (id, org_id, signal_id, name, status, event_count,
                         first_seen, last_seen, centroid, sample_trace_ids)
                    VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8::jsonb, $9)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    cluster_id,
                    org_id,
                    signal_id,
                    name[:200],
                    len(group),
                    min(times),
                    max(times),
                    json.dumps(centroid, separators=(",", ":")),
                    trace_ids[:10],
                )
                created += 1
            except Exception as exc:
                logger.debug("signal_clusterer: persist failed: %s", exc)
        return created

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
        if not texts:
            return []
        try:
            from eden.kb.embeddings import get_default_embedder

            embedder = get_default_embedder()
            import asyncio

            return await asyncio.to_thread(embedder.embed_batch, texts)
        except Exception as exc:
            logger.debug("signal_clusterer: embed failed: %s", exc)
            # Deterministic hash fallback for tests / no-embedder envs.
            out: list[list[float]] = []
            for t in texts:
                h = stable_hash(t) % 1000
                out.append([float((h + i) % 97) / 97.0 for i in range(8)])
            return out


async def cluster_after_match(org_id: str, signal_id: str) -> None:
    """Best-effort async hook after a matched signal event."""
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "signal_clusters_v1", True):
            return
        await SignalEventClusterer().cluster_signal(org_id, signal_id)
    except Exception as exc:
        logger.debug("signal_clusterer: cluster_after_match failed: %s", exc)
