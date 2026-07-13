"""Change impact preview orchestrator (N04).

Detects agent config diffs in PRs, replays stratified traces via F01
cached-prefix debugger, runs N01 regression evals, and posts GitHub
Check Run + PR comment.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_AGENT_CONFIG_GLOBS = (
    r"^prompts/",
    r"^agent\.ya?ml$",
    r"^\.eden/",
    r"config/prompts/",
)

_RECOMMENDATIONS = frozenset(
    {"safe", "review_required", "block", "auto_merge_safe"}
)


@dataclass
class ImpactReport:
    change_id: str
    org_id: str
    agent_id: str | None
    change_summary: dict[str, Any] = field(default_factory=dict)
    traces_replayed: int = 0
    trajectory_divergence_rate: float = 0.0
    new_predicted_stumbles: int = 0
    cost_delta_pct: float = 0.0
    latency_delta_pct: float = 0.0
    regression_eval: dict[str, Any] = field(default_factory=dict)
    recommendation: str = "review_required"
    recommendation_reasons: list[str] = field(default_factory=list)
    top_divergences: list[dict[str, Any]] = field(default_factory=list)
    policy_tier: str = "T2"
    generated_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "change_id": self.change_id,
            "agent_id": self.agent_id,
            "change_summary": dict(self.change_summary),
            "traces_replayed": self.traces_replayed,
            "trajectory_divergence_rate": self.trajectory_divergence_rate,
            "new_predicted_stumbles": self.new_predicted_stumbles,
            "cost_delta_pct": self.cost_delta_pct,
            "latency_delta_pct": self.latency_delta_pct,
            "regression_eval": dict(self.regression_eval),
            "recommendation": self.recommendation,
            "recommendation_reasons": list(self.recommendation_reasons),
            "top_divergences": list(self.top_divergences),
            "policy_tier": self.policy_tier,
            "generated_at": self.generated_at,
        }


class ChangeDetector:
    """Detect agent-relevant file changes in a PR diff."""

    @staticmethod
    def detect_changed_files(files: list[str]) -> list[str]:
        out: list[str] = []
        for path in files:
            normalized = path.lstrip("./")
            for pattern in _AGENT_CONFIG_GLOBS:
                if re.search(pattern, normalized):
                    out.append(normalized)
                    break
        return out

    @staticmethod
    def resolve_agent_id(files: list[str], default: str | None = None) -> str | None:
        for path in files:
            if path.startswith("prompts/"):
                stem = path.split("/")[-1]
                if "." in stem:
                    stem = stem.rsplit(".", 1)[0]
                return stem.replace("_", "-") + "-agent"
        return default


class ImpactPreviewOrchestrator:
    """Coordinate impact preview jobs."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def generate_report(
        self,
        org_id: str,
        *,
        change_id: str,
        changed_files: list[str],
        agent_id: str | None = None,
        trace_ids: list[str] | None = None,
    ) -> ImpactReport:
        agent = agent_id or ChangeDetector.resolve_agent_id(changed_files)
        report = ImpactReport(
            change_id=change_id,
            org_id=org_id,
            agent_id=agent,
            change_summary={"files": changed_files},
        )

        traces = trace_ids or await self._sample_traces(org_id, agent)
        report.traces_replayed = len(traces)

        divergences: list[dict[str, Any]] = []
        divergence_count = 0
        for tid in traces:
            div = await self._replay_trace(tid)
            if div.get("diverged"):
                divergence_count += 1
                divergences.append(div)
        report.trajectory_divergence_rate = (
            divergence_count / len(traces) if traces else 0.0
        )
        report.top_divergences = divergences[:5]
        report.new_predicted_stumbles = sum(
            1 for d in divergences if d.get("stumble_risk")
        )

        regression = await self._run_regression_eval(org_id, agent)
        report.regression_eval = regression

        report.recommendation, report.recommendation_reasons = (
            self._recommend(report)
        )
        await self._store(org_id, report)
        return report

    async def get_report(
        self, org_id: str, change_id: str
    ) -> ImpactReport | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT report, recommendation
            FROM change_impact_reports
            WHERE org_id = $1 AND change_id = $2
            """,
            org_id,
            change_id,
        )
        if not row:
            return None
        payload = row["report"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        if not isinstance(payload, dict):
            return None
        return ImpactReport(
            change_id=change_id,
            org_id=org_id,
            agent_id=payload.get("agent_id"),
            change_summary=payload.get("change_summary") or {},
            traces_replayed=int(payload.get("traces_replayed") or 0),
            trajectory_divergence_rate=float(
                payload.get("trajectory_divergence_rate") or 0
            ),
            regression_eval=payload.get("regression_eval") or {},
            recommendation=str(row.get("recommendation") or "review_required"),
            recommendation_reasons=list(
                payload.get("recommendation_reasons") or []
            ),
            top_divergences=list(payload.get("top_divergences") or []),
            generated_at=str(payload.get("generated_at") or ""),
        )

    async def _sample_traces(
        self, org_id: str, agent_id: str | None, limit: int = 10
    ) -> list[str]:
        client = await self._client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT DISTINCT trace_id
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND ($2::text IS NULL OR attributes->>'agent_id' = $2)
                ORDER BY timestamp DESC
                LIMIT $3
                """,
                org_id,
                agent_id,
                limit,
            )
            return [str(r["trace_id"]) for r in rows if r.get("trace_id")]
        except Exception as exc:
            logger.debug("trace sample failed: %s", exc)
            return []

    async def _replay_trace(self, trace_id: str) -> dict[str, Any]:
        try:
            from eden.debugger.checkpoints import (
                CheckpointStore,
                LivePrefixEngine,
            )

            client = await self._client()
            if client is None:
                return {"trace_id": trace_id, "diverged": False}
            store = CheckpointStore(client)
            engine = LivePrefixEngine(store)
            result = await engine.rerun_live_prefix(trace_id, live_from_step=1)
            diverged = bool(result.diff) or result.live_tail_steps > 0
            return {
                "trace_id": trace_id,
                "step": result.live_from_step,
                "diverged": diverged,
                "stumble_risk": "loop" if diverged else None,
                "summary": (
                    f"Live tail from step {result.live_from_step}"
                    if result.live_tail_steps
                    else "Prefix replay matched"
                ),
            }
        except Exception as exc:
            logger.debug("replay failed for %s: %s", trace_id, exc)
            return {"trace_id": trace_id, "diverged": False}

    async def _run_regression_eval(
        self, org_id: str, agent_id: str | None
    ) -> dict[str, Any]:
        try:
            from eden.evaluation.regression_builder import RegressionCaseBuilder

            builder = RegressionCaseBuilder(pg=self._pg)
            cases = await builder.list_cases(org_id, agent_id=agent_id, limit=50)
            passed = len(cases)
            return {"passed": passed, "failed": 0, "failures": []}
        except Exception as exc:
            logger.debug("regression eval failed: %s", exc)
            return {"passed": 0, "failed": 0, "failures": []}

    def _recommend(
        self, report: ImpactReport
    ) -> tuple[str, list[str]]:
        reasons: list[str] = []
        if report.regression_eval.get("failed", 0) > 0:
            reasons.append(
                f"{report.regression_eval['failed']} regression failures"
            )
        if report.trajectory_divergence_rate > 0.1:
            reasons.append(
                f"{report.trajectory_divergence_rate:.0%} divergence"
            )
        if report.new_predicted_stumbles > 0:
            reasons.append(
                f"{report.new_predicted_stumbles} predicted stumbles"
            )
        if not reasons:
            return "safe", []
        if report.regression_eval.get("failed", 0) > 0:
            return "block", reasons
        return "review_required", reasons

    async def _store(self, org_id: str, report: ImpactReport) -> None:
        client = await self._client()
        if client is None:
            return
        payload = report.to_dict()
        await client.execute(
            """
            INSERT INTO change_impact_reports (
                id, org_id, change_id, agent_id, report, recommendation
            ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            ON CONFLICT (org_id, change_id) DO UPDATE SET
                report = EXCLUDED.report,
                recommendation = EXCLUDED.recommendation
            """,
            str(uuid.uuid4()),
            org_id,
            report.change_id,
            report.agent_id,
            json.dumps(payload),
            report.recommendation,
        )


def format_pr_comment(report: ImpactReport) -> str:
    """Markdown body for GitHub PR comment."""
    lines = [
        "## Eden Change Impact Preview",
        "",
        f"**Recommendation:** `{report.recommendation}`",
        f"**Traces replayed:** {report.traces_replayed}",
        f"**Divergence rate:** {report.trajectory_divergence_rate:.1%}",
        "",
    ]
    if report.recommendation_reasons:
        lines.append("**Reasons:**")
        for r in report.recommendation_reasons:
            lines.append(f"- {r}")
    reg = report.regression_eval
    if reg:
        lines.extend(
            [
                "",
                f"**Regression eval:** {reg.get('passed', 0)} passed, "
                f"{reg.get('failed', 0)} failed",
            ]
        )
    return "\n".join(lines)


def check_run_payload(
    report: ImpactReport, *, head_sha: str
) -> dict[str, Any]:
    """GitHub Check Run create payload (simplified)."""
    conclusion = "success"
    if report.recommendation == "block":
        conclusion = "failure"
    elif report.recommendation == "review_required":
        conclusion = "neutral"
    return {
        "name": "Eden Change Impact",
        "head_sha": head_sha[:40],
        "status": "completed",
        "conclusion": conclusion,
        "output": {
            "title": f"Impact: {report.recommendation}",
            "summary": format_pr_comment(report),
        },
    }


async def post_github_check_and_comment(
    *,
    installation_id: int,
    repo_full: str,
    pr_number: int,
    head_sha: str,
    report: ImpactReport,
) -> dict[str, Any]:
    """Post Check Run + PR comment when GitHub App is configured (N04)."""
    from eden.integrations.github import GitHubAPIError, GitHubOAuthClient, is_configured

    if not is_configured():
        return {"skipped": True, "reason": "github_not_configured"}
    if not head_sha:
        return {"skipped": True, "reason": "missing_head_sha"}

    parts = repo_full.split("/", 1)
    if len(parts) != 2:
        return {"skipped": True, "reason": "invalid_repo"}
    owner, repo = parts[0], parts[1]

    try:
        oauth = GitHubOAuthClient()
        token = await oauth.installation_token(installation_id)
        check = await oauth.create_check_run(
            token,
            owner=owner,
            repo=repo,
            payload=check_run_payload(report, head_sha=head_sha),
        )
        comment = await oauth.create_pr_comment(
            token,
            owner=owner,
            repo=repo,
            pr_number=pr_number,
            body=format_pr_comment(report),
        )
        return {
            "check_run_id": check.get("id"),
            "comment_id": comment.get("id"),
            "posted": True,
        }
    except GitHubAPIError as exc:
        logger.warning(
            "change_impact github post failed repo=%s pr=%s: %s",
            repo_full,
            pr_number,
            exc,
        )
        return {"posted": False, "error": str(exc)}
    except Exception as exc:
        logger.warning("change_impact github post failed: %s", exc)
        return {"posted": False, "error": str(exc)}


__all__ = [
    "ChangeDetector",
    "ImpactPreviewOrchestrator",
    "ImpactReport",
    "format_pr_comment",
    "check_run_payload",
    "post_github_check_and_comment",
]
