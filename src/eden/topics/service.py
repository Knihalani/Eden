"""F65 — Topics / insights clustering service."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

logger = logging.getLogger(__name__)

Facet = Literal["task", "sentiment", "issues", "custom"]

_BUILTIN_FACETS: tuple[Facet, ...] = ("task", "sentiment", "issues")


async def list_topics(
    org_id: str,
    *,
    facet: Facet | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return []
    if pg is None:
        return []

    clauses = ["org_id = $1", "status = 'active'"]
    args: list[Any] = [org_id]
    if facet:
        args.append(facet)
        clauses.append(f"facet = ${len(args)}")
    try:
        rows = await pg.fetch(
            f"""
            SELECT id, facet, name, description, share_pct, keywords,
                   sample_count, representative_trace_ids, pattern_id,
                   signal_cluster_id, first_seen, last_seen, metadata
            FROM topic_clusters
            WHERE {' AND '.join(clauses)}
            ORDER BY sample_count DESC
            LIMIT ${len(args) + 1}
            """,
            *args,
            limit,
        )
    except Exception as exc:
        logger.debug("topics: list failed: %s", exc)
        return await _fallback_from_patterns(org_id, facet=facet, limit=limit)

    if not rows:
        return await _fallback_from_patterns(org_id, facet=facet, limit=limit)

    return [_row_to_topic(r) for r in rows]


async def _fallback_from_patterns(
    org_id: str, *, facet: Facet | None, limit: int
) -> list[dict[str, Any]]:
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return []
    if pg is None:
        return []
    try:
        rows = await pg.fetch(
            """
            SELECT pattern_id, name, description, topic_label,
                   coherence_score, sample_count, representative_trace_ids,
                   first_seen, last_seen, metadata
            FROM trace_patterns
            WHERE tenant_id = $1 AND status = 'active'
            ORDER BY sample_count DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
    except Exception:
        return []
    topics: list[dict[str, Any]] = []
    for r in rows:
        meta = r.get("metadata") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except (TypeError, ValueError):
                meta = {}
        topics.append(
            {
                "id": str(r["pattern_id"]),
                "facet": facet or "task",
                "name": str(r["topic_label"] or r["name"]),
                "description": r.get("description"),
                "share_pct": None,
                "keywords": list((meta or {}).get("keywords") or []),
                "sample_count": int(r["sample_count"] or 0),
                "representative_trace_ids": list(
                    r["representative_trace_ids"] or []
                ),
                "pattern_id": str(r["pattern_id"]),
                "signal_cluster_id": None,
                "first_seen": r["first_seen"].isoformat()
                if hasattr(r.get("first_seen"), "isoformat")
                else None,
                "last_seen": r["last_seen"].isoformat()
                if hasattr(r.get("last_seen"), "isoformat")
                else None,
                "source": "trace_patterns",
            }
        )
    return topics


def _row_to_topic(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "facet": str(row["facet"]),
        "name": str(row["name"]),
        "description": row.get("description"),
        "share_pct": float(row["share_pct"]) if row.get("share_pct") is not None else None,
        "keywords": list(row["keywords"] or []),
        "sample_count": int(row["sample_count"] or 0),
        "representative_trace_ids": list(row["representative_trace_ids"] or []),
        "pattern_id": str(row["pattern_id"]) if row.get("pattern_id") else None,
        "signal_cluster_id": str(row["signal_cluster_id"])
        if row.get("signal_cluster_id")
        else None,
        "first_seen": row["first_seen"].isoformat()
        if row.get("first_seen") and hasattr(row["first_seen"], "isoformat")
        else None,
        "last_seen": row["last_seen"].isoformat()
        if row.get("last_seen") and hasattr(row["last_seen"], "isoformat")
        else None,
        "source": "topic_clusters",
    }


async def generate_topics(org_id: str, *, facet: Facet = "task") -> dict[str, Any]:
    """Run the patterns clusterer and mirror results into ``topic_clusters``."""
    from eden.observability.patterns_clusterer import get_patterns_clusterer

    summary = await get_patterns_clusterer().run_once()
    synced = await _sync_patterns_to_topics(org_id, facet=facet)
    return {"patterns_summary": summary, "topics_synced": synced, "facet": facet}


async def _sync_patterns_to_topics(org_id: str, *, facet: Facet) -> int:
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return 0
    if pg is None:
        return 0
    try:
        rows = await pg.fetch(
            """
            SELECT pattern_id, name, topic_label, sample_count,
                   representative_trace_ids, first_seen, last_seen, metadata
            FROM trace_patterns
            WHERE tenant_id = $1 AND status = 'active'
            ORDER BY sample_count DESC
            LIMIT 50
            """,
            org_id,
        )
    except Exception as exc:
        logger.debug("topics: sync fetch patterns failed: %s", exc)
        return 0

    total = sum(int(r["sample_count"] or 0) for r in rows) or 1
    synced = 0
    now = datetime.now(UTC)
    for r in rows:
        count = int(r["sample_count"] or 0)
        share = round(100.0 * count / total, 2)
        topic_id = str(uuid.uuid4())
        try:
            await pg.execute(
                """
                INSERT INTO topic_clusters
                    (id, org_id, facet, name, description, share_pct,
                     sample_count, representative_trace_ids, pattern_id,
                     first_seen, last_seen, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (id) DO NOTHING
                """,
                topic_id,
                org_id,
                facet,
                str(r["topic_label"] or r["name"])[:200],
                f"Pattern cluster ({count} traces)",
                share,
                count,
                list(r["representative_trace_ids"] or [])[:10],
                str(r["pattern_id"]),
                r.get("first_seen") or now,
                r.get("last_seen") or now,
                now,
            )
            synced += 1
        except Exception as exc:
            logger.debug("topics: sync insert failed: %s", exc)
    return synced


async def act_on_topic(
    org_id: str,
    topic_id: str,
    *,
    action: Literal["dataset", "alert"],
    name: str | None = None,
) -> dict[str, Any]:
    """Create a dataset from a topic cluster (F53 bridge)."""
    topics = await list_topics(org_id, limit=500)
    topic = next((t for t in topics if t["id"] == topic_id), None)
    if topic is None:
        raise ValueError("topic not found")
    trace_ids = topic.get("representative_trace_ids") or []
    if action != "dataset":
        return {"action": action, "topic_id": topic_id, "status": "queued"}

    try:
        from eden.datasets.hub import DatasetHub

        hub = DatasetHub()
        ds_name = name or f"topic-{topic['name'][:40]}"
        created = await hub.create_dataset(
            org_id,
            name=ds_name,
            description=f"Created from topic cluster {topic['name']}",
            source_type="topic_cluster",
            source_ref=topic_id,
        )
        dataset_id = created.id
        added = 0
        for tid in trace_ids[:100]:
            try:
                await hub.promote_trace(org_id, tid, dataset_id=dataset_id)
                added += 1
            except Exception:
                continue
        return {
            "action": "dataset",
            "topic_id": topic_id,
            "dataset_id": dataset_id,
            "traces_added": added,
        }
    except Exception as exc:
        logger.debug("topics: act dataset failed: %s", exc)
        return {
            "action": "dataset",
            "topic_id": topic_id,
            "dataset_id": None,
            "traces_added": 0,
            "error": str(exc)[:200],
        }
