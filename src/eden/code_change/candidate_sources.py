"""Aggregate improvement candidates for the scheduled optimization agent.

Sources (configurable via ``policy.candidate_sources``):

* ``clusters`` — high-severity Cat 2 incident clusters (same substrate
  as ``evaluate_pending_clusters``).
* ``issues`` — open agent issues whose triage suggests a code patch.
* ``drift`` — recent drift-alert style signals (best-effort; empty when
  the backing table is absent).

Candidates are fingerprint-deduped so the same root issue does not spawn
multiple PRs in one scheduled run. Shape matches
:func:`eden.code_change.triggers.incident_trigger.run` input.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_SOURCES = ("clusters", "issues", "drift")
_OPEN_ISSUE_STATUSES = ("open", "triaged", "healing", "patch_proposed", "verifying")


def _fingerprint_key(candidate: dict[str, Any]) -> str:
    return str(
        candidate.get("error_signature")
        or candidate.get("fingerprint")
        or candidate.get("cluster_id")
        or candidate.get("rca_id")
        or candidate.get("incident_id")
        or candidate.get("summary")
        or ""
    ).lower()


def _dedupe(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for c in candidates:
        key = _fingerprint_key(c)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


async def _from_clusters(
    org_id: str, *, since: datetime | None, limit: int
) -> list[dict[str, Any]]:
    try:
        from eden.code_change.scheduler import _list_clusters_for_org
        from eden.config import get_settings

        settings = get_settings()
        clusters = await _list_clusters_for_org(
            org_id, min_size=int(getattr(settings, "patch_cluster_min_size", 3))
        )
    except Exception as exc:
        logger.debug("candidate_sources.clusters failed: %s", exc)
        return []

    out: list[dict[str, Any]] = []
    for cl in clusters[:limit]:
        last_seen = cl.get("last_seen_at")
        if since is not None and last_seen is not None:
            try:
                if isinstance(last_seen, str):
                    ls = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
                else:
                    ls = last_seen
                if ls.tzinfo is None:
                    ls = ls.replace(tzinfo=UTC)
                if ls < since:
                    continue
            except Exception:
                pass
        category = str(cl.get("category") or "")
        error_type = str(cl.get("error_type") or "")
        out.append(
            {
                "org_id": org_id,
                "target_kind": "scheduled_cluster",
                "cluster_id": str(cl.get("id") or ""),
                "repo_id": str(cl.get("agent_id") or ""),
                "summary": str(cl.get("name") or f"{error_type}:{category}"),
                "error_signature": f"{error_type}|{category}",
                "file_path_hint": category if category.endswith(".py") else "",
                "evidence_count": int(cl.get("member_count") or 0),
                "rca_confidence": 0.75,
                "fingerprint": str(cl.get("id") or ""),
            }
        )
    return out


async def _from_issues(
    org_id: str, *, since: datetime | None, limit: int
) -> list[dict[str, Any]]:
    try:
        from eden.issues.repo import IssuesRepo

        repo = IssuesRepo()
        # list_issues may not filter by status set; fetch then filter.
        list_fn = getattr(repo, "list_issues", None)
        if list_fn is None:
            return []
        issues = await list_fn(org_id, limit=limit * 2)
    except Exception as exc:
        logger.debug("candidate_sources.issues failed: %s", exc)
        return []

    out: list[dict[str, Any]] = []
    for issue in issues or []:
        status = getattr(issue, "status", None) or (
            issue.get("status") if isinstance(issue, dict) else None
        )
        if status and str(status) not in _OPEN_ISSUE_STATUSES:
            continue
        triage = getattr(issue, "triage_result", None) or (
            (issue.get("triage_result") if isinstance(issue, dict) else None) or {}
        )
        if not isinstance(triage, dict):
            triage = {}
        suggested = triage.get("suggested_actions") or []
        wants_patch = False
        for a in suggested:
            if not isinstance(a, dict):
                continue
            at = a.get("action_type") or a.get("type")
            if at in ("propose_patch", "patch", "code_change"):
                wants_patch = True
                break
        root = str(triage.get("root_cause") or "")
        if not wants_patch and "code" not in root.lower() and "bug" not in root.lower():
            # Also accept issues explicitly tagged code_bug kind.
            kind = getattr(issue, "kind", None) or (
                issue.get("kind") if isinstance(issue, dict) else ""
            )
            if str(kind) not in ("tool_error", "task_failure", "timeout"):
                continue
            # Without a patch suggestion, only keep high-repetition issues.
            stumble_count = int(
                getattr(issue, "stumble_count", None)
                or (issue.get("stumble_count") if isinstance(issue, dict) else 0)
                or 0
            )
            if stumble_count < 5:
                continue

        last_seen = getattr(issue, "last_seen", None) or (
            issue.get("last_seen") if isinstance(issue, dict) else None
        )
        if since is not None and last_seen is not None:
            try:
                ls = last_seen
                if isinstance(ls, str):
                    ls = datetime.fromisoformat(ls.replace("Z", "+00:00"))
                if ls.tzinfo is None:
                    ls = ls.replace(tzinfo=UTC)
                if ls < since:
                    continue
            except Exception:
                pass

        issue_id = str(
            getattr(issue, "id", None)
            or (issue.get("id") if isinstance(issue, dict) else "")
        )
        fingerprint = str(
            getattr(issue, "fingerprint", None)
            or (issue.get("fingerprint") if isinstance(issue, dict) else "")
            or issue_id
        )
        title = str(
            getattr(issue, "title", None)
            or (issue.get("title") if isinstance(issue, dict) else "")
            or fingerprint
        )
        agent_id = str(
            getattr(issue, "agent_id", None)
            or (issue.get("agent_id") if isinstance(issue, dict) else "")
            or ""
        )
        out.append(
            {
                "org_id": org_id,
                "target_kind": "scheduled_issue",
                "rca_id": f"iss_{issue_id}",
                "incident_id": issue_id,
                "repo_id": agent_id,
                "summary": title,
                "error_signature": fingerprint,
                "fingerprint": fingerprint,
                "evidence_count": int(
                    getattr(issue, "stumble_count", None)
                    or (issue.get("stumble_count") if isinstance(issue, dict) else 1)
                    or 1
                ),
                "rca_confidence": float(triage.get("confidence") or 0.7),
                "file_path_hint": str(
                    triage.get("primary_file")
                    or triage.get("file_path")
                    or ""
                ),
            }
        )
        if len(out) >= limit:
            break
    return out


async def _from_drift(
    org_id: str, *, since: datetime | None, limit: int
) -> list[dict[str, Any]]:
    """Best-effort drift candidates from ``closed_loop_actions`` / alerts.

    Returns [] when the table is missing — schedule still works on
    clusters + issues alone.
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        since_dt = since or (datetime.now(UTC) - timedelta(days=7))
        async with client.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, action_type, status, detail, created_at
                  FROM closed_loop_actions
                 WHERE org_id = $1
                   AND action_type ILIKE '%drift%'
                   AND created_at > $2
                 ORDER BY created_at DESC
                 LIMIT $3
                """,
                org_id,
                since_dt,
                limit,
            )
    except Exception as exc:
        logger.debug("candidate_sources.drift failed: %s", exc)
        return []

    out: list[dict[str, Any]] = []
    for r in rows:
        detail = r.get("detail") or {}
        if isinstance(detail, str):
            detail = {}
        sig = str(
            detail.get("drift_type")
            or detail.get("fingerprint")
            or r.get("id")
            or ""
        )
        out.append(
            {
                "org_id": org_id,
                "target_kind": "scheduled_drift",
                "incident_id": str(r.get("id") or ""),
                "summary": f"drift:{sig}",
                "error_signature": sig,
                "fingerprint": sig,
                "evidence_count": 1,
                "rca_confidence": 0.6,
            }
        )
    return out


async def gather_candidates(
    org_id: str,
    *,
    policy: dict[str, Any] | None = None,
    since: datetime | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Collect fingerprint-deduped candidates for a scheduled run."""
    policy = policy or {}
    raw_sources = policy.get("candidate_sources") or list(_DEFAULT_SOURCES)
    sources = {str(s).lower() for s in raw_sources}

    if since is None:
        raw = policy.get("last_optimization_run_at")
        if isinstance(raw, str) and raw:
            try:
                since = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                since = None

    buckets: list[dict[str, Any]] = []
    per = max(1, limit)

    if "clusters" in sources:
        buckets.extend(await _from_clusters(org_id, since=since, limit=per))
    if "issues" in sources:
        buckets.extend(await _from_issues(org_id, since=since, limit=per))
    if "drift" in sources:
        buckets.extend(await _from_drift(org_id, since=since, limit=per))

    return _dedupe(buckets)[:limit]
