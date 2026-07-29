"""ImprovementAgent full sweep orchestration (N23)."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from typing import Any

from eden.improvement import plans_repo, runs_repo
from eden.improvement import settings as imp_settings
from eden.improvement.planner import PlanCandidate, persist_candidates, rank_candidates
from eden.improvement.sweep_budget import (
    begin_sweep_llm_budget,
    clear_sweep_llm_budget,
)

logger = logging.getLogger(__name__)

_SWEEP_TIMEOUT_S = 300
_SIGMA_THRESHOLD = 2.0
_LOCKFILE_PATHS = (
    "requirements.txt",
    "poetry.lock",
    "package-lock.json",
    "pyproject.toml",
)
_KNOWN_CVE_HINTS: dict[str, tuple[str, str]] = {
    "pillow": ("CVE-2023-50445", "high"),
    "requests": ("CVE-2024-35195", "medium"),
    "urllib3": ("CVE-2024-37891", "medium"),
    "django": ("CVE-2024-38875", "high"),
    "cryptography": ("CVE-2024-26130", "high"),
}


async def _pg_fetch(query: str, *args: Any) -> list[dict[str, Any]]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception:
        return []
    if client is None:
        return []
    try:
        rows = await client.fetch(query, *args)
    except Exception as exc:
        logger.debug("improvement sweep pg: %s", exc)
        return []
    return [dict(r) for r in (rows or [])]


async def _github_linked(org_id: str) -> bool:
    rows = await _pg_fetch(
        """
        SELECT 1 FROM org_github_installations
        WHERE org_id = $1 AND suspended_at IS NULL
        LIMIT 1
        """,
        org_id,
    )
    return bool(rows)


def _z_exceeds(
    value: float, mean: float, std: float, *, threshold: float = _SIGMA_THRESHOLD
) -> bool:
    if value <= mean:
        return False
    if std > 0:
        return (value - mean) / std >= threshold
    if mean > 0:
        return value >= mean * (1 + threshold * 0.25)
    return value > 0


def _parse_deps_from_lockfile(path: str, content: str) -> list[str]:
    names: list[str] = []
    if path.endswith("requirements.txt"):
        for line in content.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            pkg = re.split(r"[<>=!~\[]", line, maxsplit=1)[0].strip().lower()
            if pkg:
                names.append(pkg)
    elif path.endswith("pyproject.toml"):
        for match in re.finditer(r'["\']([a-zA-Z0-9_-]+)["\']\s*=', content):
            names.append(match.group(1).lower())
    elif path.endswith("package-lock.json"):
        for match in re.finditer(r'"([^"/]+)":\s*\{', content):
            pkg = match.group(1).lower()
            if pkg not in ("dependencies", "devDependencies", "packages"):
                names.append(pkg)
    elif path.endswith("poetry.lock"):
        for match in re.finditer(r'^name = "([^"]+)"', content, re.MULTILINE):
            names.append(match.group(1).lower())
    return names


def _agent_enabled(org_id: str) -> bool:
    """Sync gate for sweep entry — checks global flag only (async routes use gates)."""
    try:
        from eden.config import get_settings

        if getattr(get_settings(), "improvement_agent_v1", False):
            return True
    except Exception:
        pass
    return False


async def _agent_enabled_for_org(org_id: str) -> bool:
    try:
        from eden.preview.gates import improvement_agent_enabled

        return await improvement_agent_enabled(org_id)
    except Exception:
        return _agent_enabled(org_id)


class ImprovementAgent:
    """Recurring improvement sweep across six signal classes."""

    async def sweep(
        self,
        org_id: str,
        *,
        since: datetime | None = None,
        agent_id: str | None = None,
        issue_id: str | None = None,
        trigger: str = "manual",
    ) -> dict[str, Any]:
        if not await _agent_enabled_for_org(org_id):
            return {"status": "disabled", "reason": "improvement_agent_v1=false"}

        try:
            return await asyncio.wait_for(
                self._sweep_body(
                    org_id,
                    since=since,
                    agent_id=agent_id,
                    issue_id=issue_id,
                    trigger=trigger,
                ),
                timeout=_SWEEP_TIMEOUT_S,
            )
        except TimeoutError:
            logger.warning(
                "improvement.sweep timed out org=%s after %ss",
                org_id,
                _SWEEP_TIMEOUT_S,
            )
            return {
                "status": "failed",
                "error": f"sweep_timeout:{_SWEEP_TIMEOUT_S}s",
            }

    async def _sweep_body(
        self,
        org_id: str,
        *,
        since: datetime | None = None,
        agent_id: str | None = None,
        issue_id: str | None = None,
        trigger: str = "manual",
    ) -> dict[str, Any]:
        watermark = since or await runs_repo.get_watermark(org_id)
        run = await runs_repo.create_run(
            org_id,
            last_run_at=watermark,
            agent_id=agent_id,
            metadata={"trigger": trigger, "issue_id": issue_id},
        )
        run_id = str(run.get("id") or "")
        cfg = await imp_settings.get_settings(org_id)
        max_plans = int(cfg.get("improvement_max_plans_per_sweep", 10))
        max_code = int(cfg.get("improvement_max_code_patch_per_sweep", 3))
        max_advisory = int(cfg.get("improvement_max_advisory_per_sweep", 5))
        max_generates = int(cfg.get("improvement_max_generates_per_sweep", 3))
        try:
            from eden.config import get_settings as get_global

            max_llm = int(
                getattr(get_global(), "patch_max_llm_calls_per_sweep", 8) or 8
            )
        except Exception:
            max_llm = 8

        begin_sweep_llm_budget(max_llm)
        candidates: list[PlanCandidate] = []
        llm_cost = 0.0
        issue_plan_ids: list[str] = []
        issue_created_n = 0
        issue_skipped_n = 0
        try:
            if issue_id:
                from eden.improvement.issue_patch_trigger import propose_plan_for_issue

                result = await propose_plan_for_issue(
                    org_id, issue_id, run_id=run_id
                )
                cost = float((result.get("plan") or {}).get("llm_cost_usd") or 0)
                created_n = 1 if result.get("status") == "proposed" else 0
                skipped_n = 0 if created_n else 1
                await runs_repo.finish_run(
                    org_id,
                    run_id,
                    status="completed",
                    plans_created=created_n,
                    plans_skipped_dedup=skipped_n,
                    llm_cost_usd=cost,
                )
                await _emit_sweep_completed(org_id, run_id, created_n)
                return {
                    "status": "completed",
                    "run_id": run_id,
                    "plans_created": created_n,
                    "plans_skipped_dedup": skipped_n,
                    "llm_cost_usd": cost,
                    "plan_ids": [result["plan_id"]] if result.get("plan_id") else [],
                    "scoped_issue_id": issue_id,
                }

            gen = await self._rank_and_generate_issue_patches(
                org_id,
                watermark,
                agent_id,
                run_id=run_id,
                max_generates=min(max_generates, max_code),
            )
            issue_created_n = int(gen.get("created") or 0)
            issue_skipped_n = int(gen.get("skipped") or 0)
            llm_cost += float(gen.get("cost_usd") or 0)
            issue_plan_ids = list(gen.get("plan_ids") or [])

            candidates.extend(await self._from_traces(org_id, watermark, agent_id))
            candidates.extend(await self._from_metrics(org_id, agent_id))
            candidates.extend(await self._from_repo_health(org_id, agent_id))
            candidates.extend(await self._from_cost_anomalies(org_id, agent_id))
            candidates.extend(
                await self._from_prompt_nudge_candidates(org_id, agent_id)
            )
            # Advisory lane only — never fake empty code_patch.
            candidates = [
                c
                for c in candidates
                if c.plan_kind != "code_patch"
                or (c.diff_unified and str(c.diff_unified).strip())
            ]

            llm_cost += sum(c.llm_cost_usd for c in candidates)
            advisory_budget = min(
                max_advisory, max(0, max_plans - issue_created_n)
            )
            created, skipped = await persist_candidates(
                org_id,
                candidates,
                run_id=run_id,
                max_plans=advisory_budget,
                max_code_patch=0,
                max_advisory=advisory_budget,
            )
            all_ids = issue_plan_ids + [p["id"] for p in created]
            total_created = issue_created_n + len(created)
            total_skipped = issue_skipped_n + skipped
            await runs_repo.finish_run(
                org_id,
                run_id,
                status="completed",
                plans_created=total_created,
                plans_skipped_dedup=total_skipped,
                llm_cost_usd=llm_cost,
            )
            await _emit_sweep_completed(org_id, run_id, total_created)
            return {
                "status": "completed",
                "run_id": run_id,
                "plans_created": total_created,
                "plans_skipped_dedup": total_skipped,
                "llm_cost_usd": llm_cost,
                "plan_ids": all_ids,
                "code_patch_created": issue_created_n,
                "advisory_created": len(created),
            }
        except Exception as exc:
            logger.warning("improvement.sweep failed org=%s: %s", org_id, exc)
            await runs_repo.finish_run(
                org_id,
                run_id,
                status="failed",
                llm_cost_usd=llm_cost,
                error=str(exc),
            )
            return {"status": "failed", "run_id": run_id, "error": str(exc)}
        finally:
            clear_sweep_llm_budget()

    async def _from_issue(
        self, org_id: str, issue_id: str, *, run_id: str
    ) -> list[PlanCandidate]:
        from eden.improvement.issue_patch_trigger import propose_plan_for_issue

        result = await propose_plan_for_issue(org_id, issue_id, run_id=run_id)
        if result.get("status") != "proposed" or not result.get("plan"):
            return []
        plan = result["plan"]
        return [
            PlanCandidate(
                plan_kind=plan.get("plan_kind", "code_patch"),
                title=plan.get("title", "Code patch"),
                source_ref=plan.get("source_ref", f"issue:{issue_id}"),
                source_fingerprint=plan.get("source_fingerprint", f"issue:{issue_id}"),
                agent_id=plan.get("agent_id"),
                summary=plan.get("summary"),
                diff_unified=plan.get("diff_unified"),
                files_changed=plan.get("files_changed") or [],
                evidence=plan.get("evidence") or {},
                triage_snapshot=plan.get("triage_snapshot"),
                llm_cost_usd=float(plan.get("llm_cost_usd") or 0),
                severity=str((plan.get("evidence") or {}).get("severity", "medium")),
                confidence=float((plan.get("evidence") or {}).get("confidence", 0.6)),
            )
        ]

    async def _rank_and_generate_issue_patches(
        self,
        org_id: str,
        since: datetime,
        agent_id: str | None,
        *,
        run_id: str,
        max_generates: int = 3,
    ) -> dict[str, Any]:
        """Cheap collect → filter → rank → top-K PatchGenerator invokes."""
        from eden.improvement.issue_patch_trigger import (
            build_candidate_from_issue,
            issue_passes_cheap_gates,
            propose_plan_for_issue,
        )

        pending: list[Any] = []
        try:
            from eden.issues.repo import IssuesRepo

            for status in ("open", "regressed"):
                rows = await IssuesRepo().list_issues(org_id, status=status, limit=50)
                for issue in rows:
                    if agent_id and issue.agent_id and issue.agent_id != agent_id:
                        continue
                    ok, _reason = issue_passes_cheap_gates(issue)
                    if not ok:
                        continue
                    pending.append(issue)
        except Exception as exc:
            logger.debug("sweep issues collect: %s", exc)
            return {"created": 0, "skipped": 0, "cost_usd": 0.0, "plan_ids": []}

        fps = [f"issue:{issue.id}" for issue in pending]
        existing = await plans_repo.find_open_fingerprints(org_id, fps)
        rejected_skip = 0
        candidates: list[PlanCandidate] = []
        for issue in pending:
            fp = f"issue:{issue.id}"
            if fp in existing:
                continue
            if await plans_repo.is_rejection_active(
                org_id,
                title=issue.title or issue.fingerprint,
                fingerprint=fp,
            ):
                rejected_skip += 1
                continue
            if await plans_repo.find_blocking_by_fingerprint(org_id, fp):
                continue
            cand = await build_candidate_from_issue(org_id, issue)
            if cand:
                candidates.append(cand)

        ranked = rank_candidates(candidates)
        top = ranked[: max(0, int(max_generates))]
        created = 0
        skipped = rejected_skip + max(0, len(ranked) - len(top))
        cost = 0.0
        plan_ids: list[str] = []
        for cand in top:
            issue_id = str((cand.evidence or {}).get("issue_id") or "")
            if not issue_id and cand.source_fingerprint.startswith("issue:"):
                issue_id = cand.source_fingerprint.split(":", 1)[1]
            if not issue_id:
                skipped += 1
                continue
            result = await propose_plan_for_issue(org_id, issue_id, run_id=run_id)
            if result.get("status") == "proposed" and result.get("plan_id"):
                created += 1
                plan_ids.append(str(result["plan_id"]))
                cost += float(
                    (result.get("plan") or {}).get("llm_cost_usd")
                    or result.get("cost_usd")
                    or 0
                )
            else:
                skipped += 1
        return {
            "created": created,
            "skipped": skipped,
            "cost_usd": cost,
            "plan_ids": plan_ids,
            "ranked": len(ranked),
            "generated": len(top),
        }

    async def _from_issues(
        self, org_id: str, since: datetime, agent_id: str | None
    ) -> list[PlanCandidate]:
        """Deprecated empty-card path — kept for tests; returns []."""
        return []

    async def _from_traces(
        self, org_id: str, since: datetime, agent_id: str | None
    ) -> list[PlanCandidate]:
        out: list[PlanCandidate] = []
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return out
            clauses = ["org_id = $1", "finalized_at > $2"]
            args: list[Any] = [org_id, since]
            if agent_id:
                args.append(agent_id)
                clauses.append(f"agent_id = ${len(args)}")
            args.append(50)
            rows = await client.fetch(
                f"""
                SELECT id, agent_id, total_cost_usd
                FROM traces
                WHERE {' AND '.join(clauses)}
                ORDER BY finalized_at DESC
                LIMIT ${len(args)}
                """,
                *args,
            )
            trace_rows = list(rows or [])
            existing = await plans_repo.find_open_fingerprints(
                org_id, [f"trace:{r['id']}" for r in trace_rows]
            )
            for r in trace_rows:
                trace_id = str(r["id"])
                fp = f"trace:{trace_id}"
                if fp in existing:
                    continue
                cost = float(r.get("total_cost_usd") or 0)
                if cost < 1.0:
                    continue
                out.append(
                    PlanCandidate(
                        plan_kind="config_change",
                        title=f"High-cost trace {trace_id[:12]}",
                        source_ref=f"trace:{trace_id}",
                        source_fingerprint=fp,
                        agent_id=r.get("agent_id"),
                        summary="Trace cost spike since last sweep",
                        evidence={
                            "trace_id": trace_id,
                            "cost_usd": cost,
                            "tags": ["cost_spike"],
                            "severity": "medium",
                            "confidence": 0.4,
                        },
                        severity="medium",
                        confidence=0.4,
                    )
                )
        except Exception as exc:
            logger.debug("sweep traces: %s", exc)
        return out

    async def _from_metrics(
        self, org_id: str, agent_id: str | None
    ) -> list[PlanCandidate]:
        out: list[PlanCandidate] = []
        try:
            agent_clause = ""
            args: list[Any] = [org_id]
            if agent_id:
                args.append(agent_id)
                agent_clause = f" AND agent_id = ${len(args)}"

            trace_24h = await _pg_fetch(
                f"""
                SELECT agent_id,
                       COALESCE(SUM(total_cost_usd), 0) AS cost_24h,
                       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
                           AS p95_latency_24h,
                       COUNT(*)::int AS trace_count
                FROM traces
                WHERE org_id = $1
                  AND finalized_at >= NOW() - INTERVAL '24 hours'
                  AND agent_id IS NOT NULL
                  {agent_clause}
                GROUP BY agent_id
                """,
                *args,
            )
            trace_baseline = await _pg_fetch(
                f"""
                WITH daily AS (
                    SELECT agent_id,
                           date_trunc('day', finalized_at) AS day,
                           COALESCE(SUM(total_cost_usd), 0) AS daily_cost,
                           percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
                               AS daily_p95
                    FROM traces
                    WHERE org_id = $1
                      AND finalized_at >= NOW() - INTERVAL '7 days'
                      AND agent_id IS NOT NULL
                      {agent_clause}
                    GROUP BY agent_id, date_trunc('day', finalized_at)
                )
                SELECT agent_id,
                       AVG(daily_cost) AS mean_cost,
                       COALESCE(STDDEV(daily_cost), 0) AS std_cost,
                       AVG(daily_p95) AS mean_p95,
                       COALESCE(STDDEV(daily_p95), 0) AS std_p95
                FROM daily
                GROUP BY agent_id
                """,
                *args,
            )
            baseline_by_agent = {str(r["agent_id"]): r for r in trace_baseline}

            stumble_24h = await _pg_fetch(
                f"""
                SELECT agent_id, COUNT(*)::float AS stumbles_24h
                FROM agent_stumbles
                WHERE org_id = $1
                  AND detected_at >= NOW() - INTERVAL '24 hours'
                  AND agent_id IS NOT NULL
                  {agent_clause}
                GROUP BY agent_id
                """,
                *args,
            )
            stumble_baseline = await _pg_fetch(
                f"""
                WITH daily AS (
                    SELECT agent_id,
                           date_trunc('day', detected_at) AS day,
                           COUNT(*)::float AS daily_cnt
                    FROM agent_stumbles
                    WHERE org_id = $1
                      AND detected_at >= NOW() - INTERVAL '7 days'
                      AND agent_id IS NOT NULL
                      {agent_clause}
                    GROUP BY agent_id, date_trunc('day', detected_at)
                )
                SELECT agent_id,
                       AVG(daily_cnt) AS mean_stumbles,
                       COALESCE(STDDEV(daily_cnt), 0) AS std_stumbles
                FROM daily
                GROUP BY agent_id
                """,
                *args,
            )
            stumble_24h_by = {str(r["agent_id"]): float(r["stumbles_24h"]) for r in stumble_24h}
            stumble_base_by = {str(r["agent_id"]): r for r in stumble_baseline}

            for row in trace_24h:
                aid = str(row.get("agent_id") or "")
                if not aid:
                    continue
                base = baseline_by_agent.get(aid) or {}
                cost_24h = float(row.get("cost_24h") or 0)
                p95_24h = float(row.get("p95_latency_24h") or 0)
                mean_cost = float(base.get("mean_cost") or 0)
                std_cost = float(base.get("std_cost") or 0)
                mean_p95 = float(base.get("mean_p95") or 0)
                std_p95 = float(base.get("std_p95") or 0)

                cost_spike = _z_exceeds(cost_24h, mean_cost, std_cost)
                latency_spike = _z_exceeds(p95_24h, mean_p95, std_p95)

                stumble_row = stumble_base_by.get(aid) or {}
                stumbles_24h = stumble_24h_by.get(aid, 0.0)
                mean_stumbles = float(stumble_row.get("mean_stumbles") or 0)
                std_stumbles = float(stumble_row.get("std_stumbles") or 0)
                stumble_spike = _z_exceeds(stumbles_24h, mean_stumbles, std_stumbles)

                if cost_spike and latency_spike:
                    fp = f"metric:{aid}:routing"
                    if await plans_repo.find_open_by_fingerprint(org_id, fp):
                        continue
                    out.append(
                        PlanCandidate(
                            plan_kind="guardrail_tune",
                            title=f"Routing mismatch: {aid}",
                            source_ref=f"sweep:metric:{aid}",
                            source_fingerprint=fp,
                            agent_id=aid,
                            summary=(
                                "24h cost and p95 latency exceed 7d baseline by >2σ — "
                                "possible routing table mismatch"
                            ),
                            evidence={
                                "metric": "routing_mismatch",
                                "cost_24h_usd": cost_24h,
                                "p95_latency_24h_ms": p95_24h,
                                "baseline_cost_usd": mean_cost,
                                "baseline_p95_ms": mean_p95,
                                "severity": "high",
                                "confidence": 0.7,
                            },
                            severity="high",
                            confidence=0.7,
                            estimated_blast_radius="medium",
                        )
                    )
                    continue

                for metric, value, mean, std, title, kind in (
                    (
                        "cost",
                        cost_24h,
                        mean_cost,
                        std_cost,
                        f"Cost spike: {aid}",
                        "config_change",
                    ),
                    (
                        "latency",
                        p95_24h,
                        mean_p95,
                        std_p95,
                        f"Latency SLO breach: {aid}",
                        "config_change",
                    ),
                ):
                    if not _z_exceeds(value, mean, std):
                        continue
                    fp = f"metric:{aid}:{metric}"
                    if await plans_repo.find_open_by_fingerprint(org_id, fp):
                        continue
                    out.append(
                        PlanCandidate(
                            plan_kind=kind,
                            title=title,
                            source_ref=f"sweep:metric:{aid}:{metric}",
                            source_fingerprint=fp,
                            agent_id=aid,
                            summary=f"24h {metric} exceeds 7d rolling baseline by >2σ",
                            evidence={
                                "metric": metric,
                                "value_24h": value,
                                "baseline_mean": mean,
                                "baseline_std": std,
                                "severity": "medium",
                                "confidence": 0.65,
                            },
                            severity="medium",
                            confidence=0.65,
                        )
                    )

                if stumble_spike:
                    fp = f"metric:{aid}:stumble_rate"
                    if await plans_repo.find_open_by_fingerprint(org_id, fp):
                        continue
                    out.append(
                        PlanCandidate(
                            plan_kind="guardrail_tune",
                            title=f"Stumble rate spike: {aid}",
                            source_ref=f"sweep:metric:{aid}:stumble_rate",
                            source_fingerprint=fp,
                            agent_id=aid,
                            summary="24h stumble rate exceeds 7d baseline by >2σ",
                            evidence={
                                "metric": "stumble_rate",
                                "stumbles_24h": stumbles_24h,
                                "baseline_mean": mean_stumbles,
                                "baseline_std": std_stumbles,
                                "severity": "high",
                                "confidence": 0.7,
                            },
                            severity="high",
                            confidence=0.7,
                        )
                    )
        except Exception as exc:
            logger.debug("sweep metrics: %s", exc)
        return out

    async def _from_repo_health(
        self, org_id: str, agent_id: str | None
    ) -> list[PlanCandidate]:
        out: list[PlanCandidate] = []
        try:
            if not await _github_linked(org_id):
                return out

            agent_rows = await _pg_fetch(
                """
                SELECT DISTINCT agent_id FROM traces
                WHERE org_id = $1 AND agent_id IS NOT NULL
                ORDER BY agent_id
                LIMIT 20
                """,
                org_id,
            )
            agents = [str(r["agent_id"]) for r in agent_rows if r.get("agent_id")]
            if agent_id:
                agents = [agent_id]

            from eden.providers.repo import get_default_repo_provider

            provider = get_default_repo_provider()
            for aid in agents:
                if not aid:
                    continue
                fp_scan = f"repo:{aid}:health"
                if await plans_repo.find_open_by_fingerprint(org_id, fp_scan):
                    continue

                findings: list[dict[str, Any]] = []
                deps: list[str] = []
                lockfile_found = False
                for path in _LOCKFILE_PATHS:
                    try:
                        content = await provider.read_file(path)
                    except Exception:
                        continue
                    if not content:
                        continue
                    if path.endswith(".lock") or path == "package-lock.json":
                        lockfile_found = True
                    deps.extend(_parse_deps_from_lockfile(path, content))

                if not deps and not lockfile_found:
                    req_exists = False
                    for path in ("requirements.txt", "pyproject.toml"):
                        try:
                            if await provider.read_file(path):
                                req_exists = True
                                break
                        except Exception:
                            continue
                    if req_exists:
                        findings.append(
                            {
                                "kind": "stale_lockfile",
                                "message": "Dependency manifest without lockfile",
                            }
                        )

                for dep in set(deps):
                    hint = _KNOWN_CVE_HINTS.get(dep)
                    if hint:
                        findings.append(
                            {
                                "kind": "cve_advisory",
                                "package": dep,
                                "cve": hint[0],
                                "severity": hint[1],
                            }
                        )

                if not findings:
                    continue

                has_cve = any(f.get("kind") == "cve_advisory" for f in findings)
                # Advisory only — never invent empty code_patch cards.
                plan_kind = "config_change"
                sev = "high" if has_cve else "medium"
                out.append(
                    PlanCandidate(
                        plan_kind=plan_kind,
                        title=f"Repo health: {aid}",
                        source_ref=f"sweep:repo:{aid}",
                        source_fingerprint=fp_scan,
                        agent_id=aid,
                        summary="Shallow lockfile / CVE advisory scan findings",
                        evidence={
                            "findings": findings,
                            "packages_scanned": len(set(deps)),
                            "severity": sev,
                            "confidence": 0.55,
                        },
                        severity=sev,
                        confidence=0.55,
                        estimated_blast_radius="low",
                    )
                )
        except Exception as exc:
            logger.debug("sweep repo_health: %s", exc)
        return out

    async def _from_cost_anomalies(
        self, org_id: str, agent_id: str | None
    ) -> list[PlanCandidate]:
        out: list[PlanCandidate] = []
        try:
            from eden.services import budget_service

            budget = await budget_service.get_budget(org_id)
            window = str(budget.get("window") or "monthly")
            consumption = await budget_service.get_consumption(org_id, window=window)
            hard = float(budget.get("cost_hard_limit_usd") or 0)
            used = float(consumption.get("cost_usd") or 0)
            threshold_pct = int(budget.get("threshold_alert_pct") or 80)
            if hard > 0:
                pct = used / hard * 100.0
                if pct >= threshold_pct:
                    fp = f"cost:org:budget:{window}"
                    if not await plans_repo.find_open_by_fingerprint(org_id, fp):
                        sev = "critical" if pct >= 100 else "high"
                        out.append(
                            PlanCandidate(
                                plan_kind="config_change",
                                title=f"Budget threshold breached ({pct:.0f}% of cap)",
                                source_ref=f"sweep:cost:org:{window}",
                                source_fingerprint=fp,
                                summary=(
                                    f"Org spend ${used:.2f} is {pct:.1f}% of "
                                    f"${hard:.2f} hard limit (alert at {threshold_pct}%)"
                                ),
                                evidence={
                                    "metric": "budget_breach",
                                    "cost_used_usd": used,
                                    "cost_hard_limit_usd": hard,
                                    "pct_of_hard": round(pct, 2),
                                    "threshold_alert_pct": threshold_pct,
                                    "window": window,
                                    "severity": sev,
                                    "confidence": 0.85,
                                },
                                severity=sev,
                                confidence=0.85,
                            )
                        )

            agent_clause = ""
            args: list[Any] = [org_id]
            if agent_id:
                args.append(agent_id)
                agent_clause = f" AND agent_id = ${len(args)}"

            spend_24h = await _pg_fetch(
                f"""
                SELECT agent_id, COALESCE(SUM(cost_usd), 0) AS spend_24h
                FROM usage_events
                WHERE org_id = $1
                  AND timestamp >= NOW() - INTERVAL '24 hours'
                  AND agent_id IS NOT NULL
                  {agent_clause}
                GROUP BY agent_id
                """,
                *args,
            )
            spend_baseline = await _pg_fetch(
                f"""
                WITH daily AS (
                    SELECT agent_id,
                           date_trunc('day', timestamp) AS day,
                           COALESCE(SUM(cost_usd), 0) AS daily_spend
                    FROM usage_events
                    WHERE org_id = $1
                      AND timestamp >= NOW() - INTERVAL '7 days'
                      AND agent_id IS NOT NULL
                      {agent_clause}
                    GROUP BY agent_id, date_trunc('day', timestamp)
                )
                SELECT agent_id,
                       AVG(daily_spend) AS mean_spend,
                       COALESCE(STDDEV(daily_spend), 0) AS std_spend
                FROM daily
                GROUP BY agent_id
                """,
                *args,
            )
            base_by = {str(r["agent_id"]): r for r in spend_baseline}
            for row in spend_24h:
                aid = str(row.get("agent_id") or "")
                spend = float(row.get("spend_24h") or 0)
                base = base_by.get(aid) or {}
                mean = float(base.get("mean_spend") or 0)
                std = float(base.get("std_spend") or 0)
                if not _z_exceeds(spend, mean, std):
                    continue
                fp = f"cost:agent:{aid}:spike"
                if await plans_repo.find_open_by_fingerprint(org_id, fp):
                    continue
                out.append(
                    PlanCandidate(
                        plan_kind="config_change",
                        title=f"Per-agent spend spike: {aid}",
                        source_ref=f"sweep:cost:agent:{aid}",
                        source_fingerprint=fp,
                        agent_id=aid,
                        summary="24h agent spend exceeds 7d daily baseline by >2σ",
                        evidence={
                            "metric": "agent_spend_spike",
                            "spend_24h_usd": spend,
                            "baseline_mean_usd": mean,
                            "baseline_std_usd": std,
                            "severity": "high",
                            "confidence": 0.75,
                        },
                        severity="high",
                        confidence=0.75,
                    )
                )
        except Exception as exc:
            logger.debug("sweep cost_anomalies: %s", exc)
        return out

    async def _from_prompt_nudge_candidates(
        self, org_id: str, agent_id: str | None
    ) -> list[PlanCandidate]:
        out: list[PlanCandidate] = []
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return out
            if agent_id:
                rows = await client.fetch(
                    """
                    SELECT id, agent_id, name FROM nudges
                    WHERE org_id = $1 AND agent_id = $2 AND mode = 'shadow'
                    LIMIT 10
                    """,
                    org_id,
                    agent_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT id, agent_id, name FROM nudges
                    WHERE org_id = $1 AND mode = 'shadow'
                    LIMIT 10
                    """,
                    org_id,
                )
            nudge_rows = list(rows or [])
            existing = await plans_repo.find_open_fingerprints(
                org_id, [f"nudge:{r['id']}" for r in nudge_rows]
            )
            for r in nudge_rows:
                nid = str(r["id"])
                fp = f"nudge:{nid}"
                if fp in existing:
                    continue
                out.append(
                    PlanCandidate(
                        plan_kind="nudge_promote",
                        title=f"Promote shadow nudge: {r.get('name')}",
                        source_ref=f"nudge:{nid}",
                        source_fingerprint=fp,
                        agent_id=r.get("agent_id"),
                        evidence={"nudge_id": nid, "severity": "medium", "confidence": 0.5},
                        severity="medium",
                        confidence=0.5,
                    )
                )
        except Exception as exc:
            logger.debug("sweep nudges: %s", exc)
        return out


async def _emit_sweep_completed(org_id: str, run_id: str, count: int) -> None:
    try:
        from eden.llmops.hooks_bus import HookEvent, get_hook_bus

        await get_hook_bus().emit(
            HookEvent(
                reason="improvement.sweep_completed",
                severity="low",
                org_id=org_id,
                source={
                    "primary_entity_id": run_id,
                    "plans_created": count,
                },
            )
        )
    except Exception as exc:
        logger.debug("sweep_completed hook failed: %s", exc)


async def request_sweep(
    org_id: str,
    *,
    agent_id: str | None = None,
    issue_id: str | None = None,
) -> dict[str, Any]:
    """F46 on-demand entry: scoped sweep after triage code_change."""
    return await ImprovementAgent().sweep(
        org_id,
        agent_id=agent_id,
        issue_id=issue_id,
        trigger="improvement.run_requested",
    )
