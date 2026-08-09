"""F65 — Topics / insights clustering service."""

from __future__ import annotations

import contextlib
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
        meta = _parse_metadata(r.get("metadata"))
        topic = {
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
        topic.update(_trend_fields_from_metadata(meta))
        topics.append(topic)
    return topics


def _parse_metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            return {}
    return {}


def _trend_fields_from_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """Extract FEAT-142 trend fields stored in ``metadata`` JSONB."""
    trend = meta.get("trend")
    if trend not in ("rising", "falling", "flat"):
        trend = None
    trend_score = meta.get("trend_score")
    recent_count = meta.get("recent_count")
    baseline_count = meta.get("baseline_count")
    out: dict[str, Any] = {}
    if trend is not None:
        out["trend"] = trend
    if trend_score is not None:
        with contextlib.suppress(TypeError, ValueError):
            out["trend_score"] = float(trend_score)
    if recent_count is not None:
        with contextlib.suppress(TypeError, ValueError):
            out["recent_count"] = int(recent_count)
    if baseline_count is not None:
        with contextlib.suppress(TypeError, ValueError):
            out["baseline_count"] = int(baseline_count)
    return out


def _row_to_topic(row: Any) -> dict[str, Any]:
    meta = _parse_metadata(row.get("metadata"))
    topic = {
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
    topic.update(_trend_fields_from_metadata(meta))
    return topic


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
        pattern_meta = _parse_metadata(r.get("metadata"))
        try:
            await pg.execute(
                """
                INSERT INTO topic_clusters
                    (id, org_id, facet, name, description, share_pct,
                     sample_count, representative_trace_ids, pattern_id,
                     first_seen, last_seen, updated_at, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
                json.dumps(pattern_meta, default=str),
            )
            synced += 1
        except Exception as exc:
            logger.debug("topics: sync insert failed: %s", exc)
    return synced


# FEAT-179 — column order for the ``GET /topics/export`` CSV. List-valued
# fields (keywords, representative_trace_ids) are flattened below since a
# CSV cell can't hold a nested array.
TOPIC_CSV_FIELDS: tuple[str, ...] = (
    "id",
    "facet",
    "name",
    "description",
    "share_pct",
    "sample_count",
    "keywords",
    "representative_trace_ids",
    "pattern_id",
    "signal_cluster_id",
    "first_seen",
    "last_seen",
    "source",
    "trend",
    "trend_score",
    "recent_count",
    "baseline_count",
)


def topics_to_csv(topics: list[dict[str, Any]]) -> str:
    """Serialize :func:`list_topics` rows to CSV text (FEAT-179 export).

    List-valued fields are joined with ``"; "`` so each topic stays on
    a single CSV row rather than exploding into one row per member.
    """
    import csv
    import io

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=TOPIC_CSV_FIELDS, extrasaction="ignore")
    writer.writeheader()
    for t in topics:
        row: dict[str, Any] = dict(t)
        for list_field in ("keywords", "representative_trace_ids"):
            val = row.get(list_field)
            if isinstance(val, list):
                row[list_field] = "; ".join(str(v) for v in val)
        writer.writerow(row)
    return buf.getvalue()


async def _act_alert_on_topic(
    org_id: str,
    topic_id: str,
    topic: dict[str, Any],
    *,
    name: str | None = None,
) -> dict[str, Any]:
    """Create an NL alert rule for a topic cluster and notify via unified dispatch."""
    topic_name = str(topic.get("name") or "topic")
    rule_name = (name or f"topic-alert-{topic_name[:40]}").strip()
    facet = str(topic.get("facet") or "unknown")
    keywords = topic.get("keywords") or []
    kw_text = ", ".join(str(k) for k in keywords[:10]) if keywords else "n/a"
    sample_count = int(topic.get("sample_count") or 0)
    nl_text = (
        f"Alert on topic cluster '{topic_name}' (facet={facet}, "
        f"samples={sample_count}). Keywords: {kw_text}. Topic ID: {topic_id}."
    )
    eql_override = "SELECT * FROM traces WHERE error_rate > 0.05"

    try:
        from eden.alerts import repo
        from eden.alerts.compiler import AlertCompiler
        from eden.alerts.unified import (
            UnifiedAlertRouteRequest,
            destinations_from_nl_rule_channels,
            dispatch_unified_alert,
        )
        from eden.dsl import AlertAsCode

        compiled = await AlertCompiler().compile(
            org_id,
            nl_text,
            eql_override=eql_override,
        )
        eql = (eql_override or compiled.get("eql") or "").strip()
        if not eql:
            return {
                "action": "alert",
                "topic_id": topic_id,
                "status": "failed",
                "error": "could not compile alert EQL",
            }

        channels = {"in_app": True, "email": True}
        rule = await repo.create_nl_rule(
            org_id=org_id,
            name=rule_name,
            nl_text=nl_text,
            compiled_eql=eql,
            triage_enabled=True,
            channels=channels,
            enabled=True,
        )
        dsl = await AlertAsCode().compile(
            org_id,
            name=rule_name,
            eql_query=eql,
            interval_seconds=3600,
            severity="warning",
        )
        if dsl.get("status") != "ok":
            return {
                "action": "alert",
                "topic_id": topic_id,
                "status": "failed",
                "error": str(dsl.get("message") or "alert rule compilation failed")[
                    :200
                ],
                "rule_id": rule.get("id"),
            }

        alert_id = (dsl.get("data") or {}).get("alert_id")
        detail = (
            f"Created alert rule '{rule_name}' for topic '{topic_name}' "
            f"({sample_count} samples, facet={facet})."
        )
        dispatch = await dispatch_unified_alert(
            UnifiedAlertRouteRequest(
                org_id=org_id,
                severity="warning",
                title=f"Topic alert configured: {topic_name}",
                message=detail,
                event_kind="topic_alert_created",
                entity_id=topic_id,
                rule_id=str(rule.get("id") or ""),
                alert_id=str(alert_id or ""),
                destinations=destinations_from_nl_rule_channels(channels),
                extra={"topic_id": topic_id, "topic_name": topic_name},
                dedup_key=f"topic_alert:{topic_id}",
            )
        )
        from eden.alerts.unified import UnifiedDestinationKind

        email = dispatch.by_kind(UnifiedDestinationKind.EMAIL)
        if dispatch.any_sent:
            return {
                "action": "alert",
                "topic_id": topic_id,
                "status": "sent",
                "rule_id": rule.get("id"),
                "alert_id": alert_id,
                "rule_name": rule_name,
                "recipient_count": (
                    email.detail.get("recipient_count", 0) if email else 0
                ),
            }
        dispatch_error = next(
            (r.error for r in dispatch.results if r.error),
            "notification dispatch failed",
        )
        return {
            "action": "alert",
            "topic_id": topic_id,
            "status": "failed",
            "rule_id": rule.get("id"),
            "alert_id": alert_id,
            "rule_name": rule_name,
            "error": str(dispatch_error)[:200],
        }
    except Exception as exc:
        logger.debug("topics: act alert failed: %s", exc)
        return {
            "action": "alert",
            "topic_id": topic_id,
            "status": "failed",
            "error": str(exc)[:200],
        }


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
    if action == "alert":
        return await _act_alert_on_topic(org_id, topic_id, topic, name=name)

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
