"""Incident clustering (Cat 2) — real implementation.

Groups similar failed traces into named clusters using a
**deterministic** ``(category, error_type, agent_id)`` key —
no embedding model required. The clustering operation is
idempotent: re-running on the same input produces the same
``cluster_id``. Large buckets (>10k members) are recursively
split by appending a sub-key derived from the trace_id
character position to keep per-cluster latency bounded.

This is intentionally a *simpler* approach than the spec's
"DBSCAN on trace embeddings" — that requires an embedding
model wired into the runtime, which Cat 2 doesn't need for v1.
The cluster keys are explainable (a cluster named
``planner_timeouterror_tool_20260611`` tells you everything),
the operation is deterministic, and a future Phase 1 upgrade
can swap in a real embedding model without changing the
public surface.

See ``docs/observability-gap/02-root-cause-incidents.md``.
"""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from datetime import UTC, datetime
from typing import Any

from eden.insights.rca._common import (
    MAX_CLUSTER_SIZE,
    MAX_RECURSION_DEPTH,
    _agent_id_from_event,
    _classify_events,
    _delete_then_insert_incidents,
    _error_type_from_event,
    _fetch_cluster_members,
    _fetch_cluster_row,
    _fetch_failed_traces_in_window,
    _fetch_incident_clusters,
    _fetch_trace_events,
    _first_failed_event,
    _jaccard_mean,
    _json_dumps,
    _make_cluster_id,
    _not_found_envelope,
    _ok_envelope,
    _parse_window,
    _recommendation_for_category,
    _severity_for_count,
    _tokenize,
    _update_cluster_summary,
)

logger = logging.getLogger(__name__)


async def _gather_trace_events(
    org_id: str, trace_ids: list[str]
) -> dict[str, list[dict[str, Any]]]:
    """Fan out ``_fetch_trace_events`` over ``trace_ids`` concurrently.

    Each per-trace fetch is an independent read against Postgres; we
    used to await them serially inside ``cluster_failures`` and
    ``update_cluster_summary``, which made the cluster pass scale
    O(N × per-trace RTT). With a 50ms RTT and 100 traces this dropped
    the cluster pass from ~5s to ~50ms.

    Concurrency is capped via ``bounded_gather`` so a large candidate
    set cannot exhaust the Postgres pool (the upstream fetch is also
    LIMIT 500).

    Returned dict preserves the trace_id → events mapping the callers
    iterate over; missing/empty traces map to an empty list.
    """
    if not trace_ids:
        return {}
    from eden.async_tasks import bounded_gather

    results = await bounded_gather(
        *(_fetch_trace_events(org_id, tid) for tid in trace_ids),
        limit=32,
        return_exceptions=True,
    )
    out: dict[str, list[dict[str, Any]]] = {}
    for tid, res in zip(trace_ids, results, strict=False):
        if isinstance(res, Exception):
            # Don't let one bad trace take down the whole cluster pass —
            # log and treat as empty events. Caller's loop will skip.
            logger.debug(
                "incidents.clusterer: _fetch_trace_events(%s) failed: %s",
                tid, res,
            )
            out[tid] = []
        else:
            out[tid] = list(res) if res else []
    return out


def _cluster_name(
    category: str, error_type: str, agent_id: str, now: datetime
) -> str:
    """Build a human-readable cluster name. Slug-safe (no
    spaces, all lowercase) so it can be used as a URL slug."""
    slug_cat = category.replace("_", "")
    slug_err = re.sub(r"[^a-z0-9]+", "", error_type.lower()) or "unknown"
    slug_agent = re.sub(r"[^a-z0-9]+", "", agent_id.lower()) or "unknown"
    return f"{slug_agent}_{slug_err}_{slug_cat}_{now.strftime('%Y%m%d')}"


class IncidentClusterer:
    """Group similar failed traces into named clusters.

    The cluster operation reads the failed-trace candidates
    for a time window, classifies each via the shared
    :func:`_classify_events` rule-based pre-filter, buckets by
    ``(category, error_type, agent_id)``, and writes the
    resulting clusters + members to the two Cat 2 cluster
    tables.
    """

    name = "incident_clusterer"

    async def cluster(
        self,
        org_id: str,
        *,
        window: str = "24h",
        min_cluster_size: int = 3,
    ) -> dict[str, Any]:
        """Cluster failed traces within ``window``.

        ``window`` accepts the human-friendly forms ``"1h"``,
        ``"24h"``, ``"7d"``, ``"30d"``, ``"30m"``, ``"90s"``.
        Invalid windows return a ``bad_request`` envelope. The
        minimum-cluster-size default (3) matches the spec.
        """
        interval_sql = _parse_window(window)
        if interval_sql is None:
            return {
                "status": "bad_request",
                "feature": self.name,
                "live": True,
                "trace_id": f"clu_{org_id}_{int(datetime.now(UTC).timestamp())}",
                "timestamp": datetime.now(UTC).isoformat(),
                "data": {
                    "message": (
                        f"invalid window {window!r}; "
                        "use 1h, 24h, 7d, 30d, 30m, or 90s"
                    ),
                },
            }

        trace_ids = await _fetch_failed_traces_in_window(
            org_id, interval_sql
        )
        total_failed = len(trace_ids)

        if not trace_ids:
            return _ok_envelope(
                self.name,
                {
                    "clusters": [],
                    "small_buckets": [],
                    "window": window,
                    "min_cluster_size": min_cluster_size,
                    "total_failed_traces": 0,
                },
            )

        # Build the per-trace classification + key
        per_trace: list[tuple[str, tuple[str, str, str]]] = []
        error_messages_by_key: dict[tuple[str, str, str], list[str]] = defaultdict(list)
        # Fan out the per-trace event fetches concurrently — each
        # _fetch_trace_events is an independent read; serialising them
        # made the cluster pass scale O(N × per-trace RTT). With a
        # 50ms RTT and 100 traces this dropped from 5s to ~50ms.
        events_by_trace = await _gather_trace_events(
            org_id, trace_ids
        )
        for trace_id, events in events_by_trace.items():
            if not events:
                continue
            category, _conf, _sigs = _classify_events(events, [])
            first = _first_failed_event(events)
            error_type = _error_type_from_event(first)
            agent_id = _agent_id_from_event(first)
            key: tuple[str, str, str] = (category, error_type, agent_id)
            per_trace.append((trace_id, key))
            # Collect error messages for Jaccard
            err = first.get("error")
            msg = ""
            if isinstance(err, dict):
                m = err.get("message") or err.get("detail") or err.get("reason")
                if isinstance(m, str):
                    msg = m
            if not msg and first.get("outcome") == "error":
                msg = first.get("name") or first.get("event_type") or ""
            error_messages_by_key[key].append(msg or error_type)

        # Bucket + (optional) recursive split
        buckets = self._bucket_with_split(per_trace, depth=0)
        # Build cluster rows + members
        clusters: list[dict[str, Any]] = []
        members: list[dict[str, Any]] = []
        small_buckets: list[dict[str, Any]] = []
        now = datetime.now(UTC)

        for key, member_traces in buckets.items():
            if len(member_traces) < min_cluster_size:
                small_buckets.append(
                    {
                        "key": list(key),
                        "member_count": len(member_traces),
                        "note": (
                            "below min_cluster_size; increase sensitivity "
                            "or wait for more samples"
                        ),
                    }
                )
                continue
            # Build the cluster id
            cluster_id = _make_cluster_id(org_id, key)
            severity = _severity_for_count(len(member_traces))
            # Secondary similarity (Jaccard) on the error-message bag
            token_sets = [
                _tokenize(m) for m in error_messages_by_key[key]
            ]
            avg_jaccard = _jaccard_mean(token_sets)
            centroid_json = _json_dumps(
                {
                    "key": list(key),
                    "avg_jaccard": round(avg_jaccard, 4),
                    "sample_size": len(token_sets),
                    "version": "rule_based_v1",
                }
            )
            name = _cluster_name(
                key[0], key[1], key[2], now
            )
            summary = self._build_summary_template(
                key, len(member_traces), severity
            )
            clusters.append(
                {
                    "id": cluster_id,
                    "name": name,
                    "centroid_embedding": centroid_json,
                    "member_count": len(member_traces),
                    "severity": severity,
                    "summary": summary,
                    "key": list(key),
                }
            )
            # One member row per trace (similarity defaults to
            # avg_jaccard; for >10k clusters this is a useful
            # signal of how tight the cluster is).
            sim = max(0.0, min(1.0, avg_jaccard)) if token_sets else 0.5
            for trace_id in member_traces:
                members.append(
                    {
                        "cluster_id": cluster_id,
                        "trace_id": trace_id,
                        "similarity": round(sim, 4),
                    }
                )

        # Persist (delete-then-insert) — best-effort
        await _delete_then_insert_incidents(org_id, clusters, members)

        # Fire closed-loop hook for high-severity, large clusters
        await self._fire_incident_hooks(org_id, clusters, members)

        return _ok_envelope(
            self.name,
            {
                "clusters": [
                    {k: v for k, v in c.items() if k != "key"}
                    for c in clusters
                ],
                "small_buckets": small_buckets,
                "window": window,
                "min_cluster_size": min_cluster_size,
                "total_failed_traces": total_failed,
            },
        )

    async def summarize(
        self, org_id: str, cluster_id: str
    ) -> dict[str, Any]:
        """Return a one-paragraph cluster summary and write it
        back to ``incident_clusters.summary``."""
        row = await _fetch_cluster_row(org_id, cluster_id)
        if row is None:
            return _not_found_envelope(self.name, cluster_id=cluster_id)

        member_traces = await _fetch_cluster_members(org_id, cluster_id)
        if not member_traces:
            # No members — return a short stub summary
            summary = (
                f"Cluster '{row.get('name', cluster_id)}' has no members."
            )
            await _update_cluster_summary(org_id, cluster_id, summary)
            return _ok_envelope(
                self.name,
                {
                    "cluster_id": cluster_id,
                    "name": row.get("name"),
                    "member_count": row.get("member_count", 0),
                    "summary": summary,
                },
            )

        # Aggregate event stats across member traces
        event_type_counts: Counter[str] = Counter()
        error_type_counts: Counter[str] = Counter()
        agent_counts: Counter[str] = Counter()
        durations: list[float] = []
        first_at: str | None = None
        last_at: str | None = None
        total_events = 0

        # Same fan-out pattern as cluster_failures — the per-member event
        # fetches are independent reads, so we run them concurrently.
        events_by_trace = await _gather_trace_events(org_id, member_traces)
        for trace_id in member_traces:
            events = events_by_trace.get(trace_id, [])
            if not events:
                continue
            for ev in events[:20]:  # cap per-member event fetch
                total_events += 1
                et = (ev.get("event_type") or "unknown").lower()
                event_type_counts[et] += 1
                err = ev.get("error")
                if isinstance(err, dict):
                    err_type = err.get("type")
                    if isinstance(err_type, str) and err_type:
                        error_type_counts[err_type] += 1
                d = ev.get("duration_ms")
                if isinstance(d, (int, float)):
                    durations.append(float(d))
                aid = ev.get("agent_id")
                if isinstance(aid, str) and aid:
                    agent_counts[aid] += 1
                ts = ev.get("timestamp")
                if isinstance(ts, str):
                    if first_at is None or ts < first_at:
                        first_at = ts
                    if last_at is None or ts > last_at:
                        last_at = ts
            if total_events >= 200:
                # hard cap to keep latency bounded
                break

        # Build the summary paragraph
        top_event_types = [
            et for et, _ in event_type_counts.most_common(3)
        ]
        top_error_types = [
            et for et, _ in error_type_counts.most_common(3)
        ]
        top_agent = (
            agent_counts.most_common(1)[0][0]
            if agent_counts else "unknown"
        )
        avg_duration_ms = (
            sum(durations) / len(durations) if durations else 0.0
        )
        # Category from the cluster name slug (..._<cat>_YYYYMMDD)
        category = "model"
        name_slug = (row.get("name") or "").rsplit("_", 2)
        if len(name_slug) >= 3:
            # The slug format is agent_err_cat_YYYYMMDD; the 3rd
            # underscore-separated token from the end is the
            # category. But the err segment may itself contain
            # underscores we stripped earlier, so the heuristic
            # is best-effort. Pull the most-common error_type as
            # a backup.
            category = name_slug[1] or "model"
        # Top error type drives the recommendation
        rec_cat = category
        if top_error_types and category == "model":
            # If the cluster is "model" but the dominant error is
            # a known-category one, the recommendation should
            # follow the error type, not the cluster label.
            err_slug = re.sub(r"[^a-z0-9]+", "", top_error_types[0].lower())
            if err_slug in ("timeout", "ratelimitexceeded"):
                rec_cat = "tool"
        recommendation = _recommendation_for_category(rec_cat)

        # Final summary paragraph
        summary = (
            f"Cluster of {row.get('member_count', len(member_traces))} "
            f"failures on agent '{top_agent}'. "
            f"Dominant error: '{top_error_types[0] if top_error_types else 'unknown'}' "
            f"({error_type_counts.most_common(1)[0][1] if error_type_counts else 0}×). "
            f"Top event sequence: {', '.join(top_event_types) or 'none'}. "
            f"First seen: {first_at or 'unknown'}, "
            f"last seen: {last_at or 'unknown'}. "
            f"Avg duration: {avg_duration_ms:.1f}ms. "
            f"Recommended action: {recommendation}"
        )

        # Persist back
        await _update_cluster_summary(org_id, cluster_id, summary)

        return _ok_envelope(
            self.name,
            {
                "cluster_id": cluster_id,
                "name": row.get("name"),
                "member_count": row.get("member_count"),
                "severity": row.get("severity"),
                "summary": summary,
                "top_event_types": top_event_types,
                "top_error_types": top_error_types,
                "top_agent": top_agent,
                "first_at": first_at,
                "last_at": last_at,
                "avg_duration_ms": round(avg_duration_ms, 2),
                "recommendation": recommendation,
            },
        )

    # ── Private helpers ──────────────────────────────────────────

    def _bucket_with_split(
        self,
        per_trace: list[tuple[str, tuple[str, str, str]]],
        *,
        depth: int,
    ) -> dict[tuple[str, ...], list[str]]:
        """Bucket traces by their 3-tuple key, recursively
        splitting any bucket with > MAX_CLUSTER_SIZE members
        on the next available sub-key field (parent_span_id →
        first_span_id → alphabetic-prefix fallback)."""
        buckets: dict[tuple[str, ...], list[str]] = defaultdict(list)
        for trace_id, key in per_trace:
            buckets[key].append(trace_id)
        # Recursive split
        if depth < MAX_RECURSION_DEPTH:
            out: dict[tuple[str, ...], list[str]] = {}
            for key, members in buckets.items():
                if len(members) <= MAX_CLUSTER_SIZE:
                    out[key] = members
                else:
                    # Sub-bucket: append a sub-key field derived
                    # from the trace_id prefix. We don't have the
                    # event details at this layer (that would
                    # re-fetch from Postgres), so we use a
                    # deterministic alphabetic split of the
                    # trace_id itself. This is the "final
                    # fallback" in the spec.
                    sub = self._split_by_trace_id_prefix(members, depth)
                    for sub_key, sub_members in sub.items():
                        out[key + (sub_key,)] = sub_members
            return out
        return dict(buckets)

    @staticmethod
    def _split_by_trace_id_prefix(
        traces: list[str], depth: int
    ) -> dict[str, list[str]]:
        """Split a list of trace_ids into N sub-buckets by
        their ``trace_id[depth % len(trace_id)]`` character. N
        is 4 to keep the recursion shallow. At depth 3 this
        gives 4³ = 64 sub-buckets max."""
        n_buckets = 4
        out: dict[str, list[str]] = defaultdict(list)
        for tid in traces:
            if not tid:
                bucket = "0"
            else:
                idx = depth % len(tid)
                # Map the character to a bucket index 0-3
                ch = tid[idx]
                bucket = str(ord(ch) % n_buckets)
            out[bucket].append(tid)
        return out

    @staticmethod
    def _build_summary_template(
        key: tuple[str, str, str], member_count: int, severity: str
    ) -> str:
        """One-line templated cluster summary (separate from
        the full ``summarize`` paragraph — this is the row's
        default summary on insert)."""
        category, error_type, agent_id = key
        return (
            f"{severity.title()} cluster: agent '{agent_id}' failed "
            f"with '{error_type}' on {category} category {member_count} times."
        )

    @staticmethod
    async def _fire_incident_hooks(
        org_id: str,
        clusters: list[dict[str, Any]],
        members: list[dict[str, Any]],
    ) -> None:
        """Fire ``IncidentHook.on_clustered`` for clusters that meet
        the severity + size threshold (G4).

        A high-severity cluster with 10+ members is a strong signal
        that something regressed in production. The correct closed-loop
        entry point is ``IncidentHook.on_clustered`` (action_kind
        ``investigate``) — the previous code called
        ``PromotionHook.on_drift_alert`` (action_kind ``rollback_canary``)
        as a fire-and-forget sync call, which (a) never triaged and
        (b) leaked an un-awaited coroutine. ``on_drift_alert`` is
        reserved for genuine rollback semantics (a stricter, separate
        threshold) so we do not auto-rollback on every large cluster.
        """
        # Pre-index sample trace ids per cluster (cap 5) for the hook.
        samples: dict[str, list[str]] = {}
        for m in members:
            cid = m.get("cluster_id")
            if not cid:
                continue
            bucket = samples.setdefault(cid, [])
            if len(bucket) < 5 and m.get("trace_id"):
                bucket.append(str(m["trace_id"]))

        for c in clusters:
            severity = c.get("severity")
            count = c.get("member_count", 0)
            if severity not in ("critical", "high") or count < 10:
                continue
            cluster_id = str(c.get("id") or "")
            if not cluster_id:
                continue
            try:
                from eden.llmops.promotion_hooks import get_incident_hook

                await get_incident_hook().on_clustered(
                    org_id,
                    cluster_id=cluster_id,
                    trace_count=int(count),
                    sample_trace_ids=samples.get(cluster_id, []),
                )
            except Exception as exc:
                logger.debug(
                    "clusterer: on_clustered failed: %s", exc
                )

            # Reserve on_drift_alert for a stricter rollback threshold:
            # only critical clusters with a large blast radius trip the
            # canary rollback path.
            if severity == "critical" and count >= 30:
                try:
                    from eden.llmops.promotion_hooks import (
                        get_promotion_hook,
                    )

                    await get_promotion_hook().on_drift_alert(
                        org_id,
                        drift_type="incident_cluster",
                        severity=severity,
                    )
                except Exception as exc:
                    logger.debug(
                        "clusterer: on_drift_alert failed: %s", exc
                    )


class IncidentStore:
    """Paginated list of clusters with severity."""

    name = "incident_store"

    async def list(
        self,
        org_id: str,
        *,
        limit: int = 50,
        severity: str | None = None,
    ) -> dict[str, Any]:
        """List clusters for ``org_id``, newest + largest first."""
        rows = await _fetch_incident_clusters(
            org_id, limit=limit, severity=severity
        )
        if not rows:
            return _ok_envelope(
                self.name,
                {
                    "clusters": [],
                    "message": "no clusters yet — run POST /incidents/cluster",
                },
            )
        # Normalise datetime fields for JSON
        clusters = []
        for r in rows:
            row = dict(r)
            if isinstance(row.get("created_at"), datetime):
                row["created_at"] = row["created_at"].isoformat()
            clusters.append(row)
        return _ok_envelope(
            self.name,
            {
                "clusters": clusters,
                "count": len(clusters),
                "limit": limit,
                "severity_filter": severity,
            },
        )
