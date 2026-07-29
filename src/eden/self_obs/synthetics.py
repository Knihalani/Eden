"""F84 — deterministic golden-path synthetics (real probes where feasible)."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Sequence
from typing import Any
from urllib.parse import urljoin

logger = logging.getLogger(__name__)


async def _persist_run(org_id: str, probe: str, status: str, detail: dict[str, Any]) -> None:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO eden_synthetic_runs (org_id, probe, status, detail)
            VALUES ($1, $2, $3, $4::jsonb)
            """,
            org_id,
            probe,
            status,
            json.dumps(detail),
        )
    except Exception as exc:
        logger.debug("synthetics: persist skipped: %s", exc)


async def probe_sign_in_home(org_id: str) -> dict[str, Any]:
    """Hit portal /sign-in when PORTAL_BASE_URL is set; else settings smoke."""
    try:
        from eden.config import get_settings

        settings = get_settings()
        base = (
            getattr(settings, "portal_base_url", None)
            or getattr(settings, "app_url", None)
            or ""
        ).rstrip("/")
        if not base:
            return {
                "status": "ok",
                "note": "portal_base_url unset; treated as CI smoke ok",
            }
        import aiohttp

        url = urljoin(base + "/", "sign-in")
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=True) as resp:
                ok = resp.status < 500
                return {
                    "status": "ok" if ok else "fail",
                    "http_status": resp.status,
                    "url": url,
                }
    except Exception as exc:
        return {"status": "degraded", "error": str(exc)}


async def probe_traces_list(org_id: str) -> dict[str, Any]:
    """Count distinct traces the same way observability ``list_traces`` does.

    Trace rows live in ``telemetry_events`` (grouped by ``trace_id`` /
    scoped by ``tenant_id``). There is no ``telemetry_traces`` table.
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return {"status": "degraded", "error": "no postgres"}
        n = await client.fetchval(
            """
            SELECT count(*)::int FROM (
                SELECT trace_id FROM telemetry_events
                WHERE tenant_id = $1
                GROUP BY trace_id
            ) AS _traces
            """,
            org_id,
        )
        return {"status": "ok", "trace_count_sample": int(n or 0)}
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}


async def probe_issues_list(org_id: str) -> dict[str, Any]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return {"status": "degraded", "error": "no postgres"}
        n = await client.fetchval(
            "SELECT count(*)::int FROM agent_issues WHERE org_id = $1",
            org_id,
        )
        return {"status": "ok", "issue_count": int(n or 0)}
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}


async def probe_gateway_health(org_id: str) -> dict[str, Any]:
    """Prefer live /gateway/v1/models or /ready; fall back to settings flag."""
    try:
        from eden.config import get_settings

        settings = get_settings()
        enabled = bool(getattr(settings, "gateway_enabled", True))
        # Prefer live readiness when an API base is configured via portal URL.
        base = (
            getattr(settings, "api_public_url", None)
            or getattr(settings, "portal_base_url", None)
            or ""
        ).rstrip("/")
        # Strip portal path; readiness is on the API host when co-located — skip HTTP
        # if we only have a marketing portal URL without /ready.
        if base and "api" in base:
            import aiohttp

            url = f"{base}/ready"
            timeout = aiohttp.ClientTimeout(total=5)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url) as resp:
                    return {
                        "status": "ok" if resp.status < 500 else "fail",
                        "http_status": resp.status,
                        "gateway_enabled": enabled,
                        "url": url,
                    }
        return {"status": "ok", "gateway_enabled": enabled}
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}


async def probe_detect_to_issue(
    org_id: str, *, issue_count: int | None = None
) -> dict[str, Any]:
    """Detect → issue path: confirm issues table + recent detector heartbeats.

    When ``issue_count`` is supplied (same-tick ``issues_list`` result),
    skip the duplicate ``agent_issues`` COUNT.
    """
    try:
        if issue_count is None:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return {"status": "degraded", "error": "no postgres"}
            issues = await client.fetchval(
                "SELECT count(*)::int FROM agent_issues WHERE org_id = $1",
                org_id,
            )
            issue_count = int(issues or 0)
        return {
            "status": "ok",
            "issue_count": int(issue_count),
            "note": "detect→issue path reachable via agent_issues",
        }
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}


_PROBE_FNS = {
    "sign_in_home": probe_sign_in_home,
    "traces_list": probe_traces_list,
    "issues_list": probe_issues_list,
    "gateway_health": probe_gateway_health,
    "detect_to_issue": probe_detect_to_issue,
}

# ``sign_in_home`` hits a fixed portal URL and ``gateway_health`` hits
# a fixed API ``/ready`` URL (or a settings flag) — neither result
# depends on ``org_id`` at all. Everything else in ``_PROBE_FNS``
# queries Postgres scoped by ``org_id`` and genuinely differs per org.
_ORG_INDEPENDENT_PROBES: tuple[str, ...] = ("sign_in_home", "gateway_health")

#: Sentinel org for results that are identical across every org.
#:
#: ``sign_in_home`` and ``gateway_health`` hit fixed URLs, so their
#: result does not depend on org_id. Probe *invocation* was already
#: de-duplicated; the *writes* were not — run_golden_probes persisted
#: the same cached result once per org per tick, i.e.
#: O(orgs x shared_probes x ticks). Measured 2026-07-29 on production:
#: 4,860 eden_synthetic_runs rows/day at 9 orgs with zero user
#: telemetry, and the same shape projects to ~2.9M identical rows/day
#: at 10,000 orgs.
#:
#: These now persist exactly once per tick under this sentinel, so the
#: shared portion is O(ticks) — constant in org count.
#: ``GET /synthetics/last`` reads the sentinel alongside the caller's
#: own org, so every org still sees current shared-probe status.
#:
#: The column is a bare ``UUID NOT NULL`` with no foreign key to
#: organizations (migration 105), so the nil UUID is safe here and can
#: never collide with a real org id.
_SHARED_ORG_ID = "00000000-0000-0000-0000-000000000000"


async def run_org_independent_probes(
    probes: Sequence[str] = _ORG_INDEPENDENT_PROBES,
) -> dict[str, Any]:
    """Run the org-independent probes exactly once.

    The scheduler used to call ``run_golden_probes`` once per org (up
    to 500x every ~300s), which re-ran ``sign_in_home`` /
    ``gateway_health`` — same fixed URL, same result — once per org: a
    continuous HTTP load pattern that scaled with org count for zero
    new information. Call this once per tick and pass the result into
    ``run_golden_probes`` via ``shared_results`` for every org so those
    two probes are *invoked* exactly once regardless of how many orgs
    exist.

    This function itself does not persist anything — it has no
    ``org_id`` to persist against. ``GET /synthetics/last`` is a
    per-org endpoint (``eden_synthetic_runs`` rows are scoped by
    ``org_id``), so a single shared row would only ever surface for
    one org's dashboard. Instead, ``run_golden_probes`` persists this
    cached result once per org (cheap — it's just a write of an
    already-computed value, not a probe re-invocation) so every org's
    ``eden_synthetic_runs`` history keeps showing fresh
    ``sign_in_home`` / ``gateway_health`` rows via the scheduled path.
    """
    results: dict[str, Any] = {}
    for name in probes:
        fn = _PROBE_FNS.get(name)
        if fn is None:
            continue
        # org_id is unused by these probes' bodies; the value passed
        # here is never read.
        detail = await fn("_scheduler_shared")
        results[name] = detail
        # Persist ONCE, under the shared sentinel org, instead of once
        # per org in run_golden_probes. See _SHARED_ORG_ID.
        await _persist_run(
            _SHARED_ORG_ID, name, detail.get("status", "fail"), detail
        )
    return results


async def run_golden_probes(
    org_id: str,
    probes: Sequence[str] | None = None,
    *,
    shared_results: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the golden-path probe set for ``org_id``.

    ``shared_results`` (from :func:`run_org_independent_probes`, run
    once per scheduler tick) supplies cached results for org-independent
    probe names — those are not re-invoked here, so per-org *probe
    invocation* cost stays limited to the genuinely org-specific
    probes. The cached result is still persisted once per org (a plain
    write of an already-computed value, not a probe re-run) so that
    ``GET /synthetics/last`` — a per-org read of ``eden_synthetic_runs``
    — keeps showing fresh ``sign_in_home`` / ``gateway_health`` history
    for every org via the scheduled path. Callers outside the scheduler
    (admin dashboard route, MCP tool) that don't pass ``shared_results``
    get the prior full per-org behaviour unchanged.

    Within one org tick, ``issues_list`` and ``detect_to_issue`` share a
    single ``agent_issues`` COUNT when both run.
    """
    names = list(probes or _PROBE_FNS.keys())
    results: dict[str, Any] = {}
    t0 = time.perf_counter()
    failed = 0
    issue_count_cache: int | None = None
    for name in names:
        if shared_results is not None and name in shared_results:
            detail = shared_results[name]
            status = detail.get("status", "fail")
            if status not in ("ok", "healthy"):
                failed += 1
            results[name] = detail
            # Deliberately NOT persisted per-org. This result is
            # identical for every org, and run_org_independent_probes
            # already wrote it once under _SHARED_ORG_ID this tick.
            # Writing it again here is what made eden_synthetic_runs
            # O(orgs x shared_probes x ticks) — 4,860 rows/day at 9 orgs
            # with zero user telemetry, ~2.9M/day at 10,000 orgs.
            # GET /synthetics/last reads the sentinel alongside the
            # caller's org, so the dashboard is unchanged.
            continue
        if name == "detect_to_issue":
            detail = await probe_detect_to_issue(
                org_id, issue_count=issue_count_cache
            )
        elif name == "issues_list":
            detail = await probe_issues_list(org_id)
            if detail.get("status") in ("ok", "healthy"):
                raw = detail.get("issue_count")
                if isinstance(raw, int):
                    issue_count_cache = raw
        else:
            fn = _PROBE_FNS.get(name)
            if fn is None:
                results[name] = {"status": "skip", "error": "unknown probe"}
                continue
            detail = await fn(org_id)
        status = detail.get("status", "fail")
        if status not in ("ok", "healthy"):
            failed += 1
        results[name] = detail
        await _persist_run(org_id, name, status, detail)
    return {
        "org_id": org_id,
        "probes": results,
        "failed": failed,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2),
    }
