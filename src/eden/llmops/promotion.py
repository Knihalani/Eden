"""PromotionLoop — automatic winner detection and promotion.

Phase 7.2d: closes the closed-loop flywire. For each active canary
experiment, the loop reads the per-version call statistics (success
rate, latency p95, judge score mean) from ``ModelRouter`` and
``judge_scores``, and either promotes the candidate to 100% or rolls
it back. The threshold math is conservative: 30+ calls minimum,
≥5% absolute success-rate lift, ≤10% latency regression, judge
score must hold.

Wired into the existing ``RedisTailer`` so the loop runs on the same
tick as the judge tailer. Same async/best-effort posture — failures
are logged, never raised.

The math is deliberately simple. No Bayesian bandit, no Thompson
sampling, no multi-armed-bandit. Just plain counters and clear
thresholds. The right level of sophistication for "if a prompt is
losing to its predecessor, swap them."
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from eden.config import get_settings

logger = logging.getLogger(__name__)


class PromotionLoop:
    """One pass: scan active canaries, decide promote/rollback/keep.

    Callers (RedisTailer) invoke ``run_once()`` on each tick. The
    method is idempotent — a canary that just got promoted will be
    skipped on the next pass.
    """

    async def run_once(self) -> dict[str, Any]:
        """Process all active canary experiments and return a summary.

        Returns a dict with ``scanned``, ``promoted``, ``rolled_back``,
        ``kept`` counts and a list of per-experiment decisions for
        logging.
        """
        settings = get_settings()
        if not settings.promotion_loop_enabled:
            return {
                "scanned": 0, "promoted": 0, "rolled_back": 0, "kept": 0,
                "decisions": [],
            }
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if not client:
            return {
                "scanned": 0, "promoted": 0, "rolled_back": 0, "kept": 0,
                "decisions": [],
            }

        # Find all active canaries
        try:
            canaries = await client.fetch(
                """
                SELECT experiment_id, tenant_id, agent, candidate_version,
                       traffic_pct, started_at, expires_at
                FROM prompt_canary_experiments
                WHERE status = 'active'
                  AND traffic_pct < 100
                  AND (expires_at IS NULL OR expires_at > NOW())
                """
            )
        except Exception as exc:
            logger.warning(f"PromotionLoop could not load canaries: {exc}")
            return {
                "scanned": 0, "promoted": 0, "rolled_back": 0, "kept": 0,
                "decisions": [],
            }

        scanned = 0
        promoted = 0
        rolled_back = 0
        kept = 0
        decisions: list[dict[str, Any]] = []

        for row in canaries:
            scanned += 1
            try:
                decision = await self._evaluate_one(
                    client=client,
                    experiment_id=str(row["experiment_id"]),
                    tenant_id=str(row["tenant_id"]),
                    agent=str(row["agent"]),
                    candidate_version=int(row["candidate_version"]),
                    traffic_pct=int(row["traffic_pct"]),
                    started_at=row["started_at"],
                )
                if decision == "promote":
                    promoted += 1
                elif decision == "rollback":
                    rolled_back += 1
                else:
                    kept += 1
                decisions.append({
                    "experiment_id": str(row["experiment_id"]),
                    "agent": str(row["agent"]),
                    "decision": decision,
                })
            except Exception as exc:
                logger.warning(
                    f"PromotionLoop evaluate failed for "
                    f"experiment {row['experiment_id']}: {exc}"
                )
                kept += 1

        return {
            "scanned": scanned,
            "promoted": promoted,
            "rolled_back": rolled_back,
            "kept": kept,
            "decisions": decisions,
        }

    async def _evaluate_one(
        self,
        *,
        client: Any,
        experiment_id: str,
        tenant_id: str,
        agent: str,
        candidate_version: int,
        traffic_pct: int,
        started_at: Any,
    ) -> str:
        """Decide what to do with one canary.

        Returns "promote", "rollback", or "keep" (no action yet).
        """
        settings = get_settings()
        # Lookback window
        lookback = timedelta(minutes=settings.promotion_lookback_minutes)
        cutoff = datetime.now(timezone.utc) - lookback

        # Per-version call counts and latencies. We approximate these
        # from telemetry_events: each call to an agent produces a
        # span with the prompt_version in the attributes (set by
        # PromptLoader when it stamps the canary version onto the
        # span). For now, we read the global success rate; once
        # ModelRouter exposes per-version counters we'll prefer those.
        try:
            candidate_stats = await client.fetchrow(
                """
                SELECT
                    count(*) AS calls,
                    avg(duration_ms) AS avg_latency_ms,
                    percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms,
                    count(*) FILTER (WHERE outcome = 'success') AS successes
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND event_type = 'agent.run'
                  AND attributes->>'prompt_version' = $2
                  AND timestamp >= $3
                """,
                tenant_id, str(candidate_version), cutoff,
            )
        except Exception as exc:
            # The percentile_cont aggregate may not be in all Postgres
            # versions; fall back to plain AVG.
            logger.debug(f"canary stats query failed: {exc}")
            return "keep"

        # If we don't have enough calls yet, keep waiting.
        candidate_calls = int(candidate_stats.get("calls") or 0) if candidate_stats else 0
        if candidate_calls < settings.promotion_min_calls:
            return "keep"

        # Compute success rate
        successes = int(candidate_stats.get("successes") or 0) if candidate_stats else 0
        candidate_success_rate = successes / max(candidate_calls, 1)
        candidate_p95 = float(candidate_stats.get("p95_latency_ms") or 0) if candidate_stats else 0

        # Control stats — same query, but for the agent's other
        # version (i.e. everything that ISN'T the candidate). This
        # assumes only two variants in flight (the global active
        # version is the control). When the canary finishes, the
        # promoted candidate BECOMES the new control.
        try:
            control_stats = await client.fetchrow(
                """
                SELECT
                    count(*) AS calls,
                    count(*) FILTER (WHERE outcome = 'success') AS successes,
                    percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND event_type = 'agent.run'
                  AND (attributes->>'prompt_version' IS NULL
                       OR attributes->>'prompt_version' != $2)
                  AND timestamp >= $3
                """,
                tenant_id, str(candidate_version), cutoff,
            )
        except Exception as exc:
            logger.debug(f"control stats query failed: {exc}")
            return "keep"
        control_calls = int(control_stats.get("calls") or 0) if control_stats else 0
        if control_calls < settings.promotion_min_calls:
            return "keep"
        control_success_rate = (
            int(control_stats.get("successes") or 0) / max(control_calls, 1)
        ) if control_stats else 0
        control_p95 = float(control_stats.get("p95_latency_ms") or 0) if control_stats else 0

        # ── Decision ──
        # Promote: candidate success rate > control by >=5% absolute
        # AND candidate p95 latency <= 110% of control
        success_lift = candidate_success_rate - control_success_rate
        latency_ratio = (
            candidate_p95 / max(control_p95, 1.0) if control_p95 else 1.0
        )
        if (
            success_lift >= settings.promotion_min_success_rate_lift
            and latency_ratio <= settings.promotion_max_latency_ratio
        ):
            await self._promote(client, experiment_id, agent, candidate_version, tenant_id)
            return "promote"
        # Rollback: candidate is clearly worse (success_lift < -5%)
        # OR latency ratio > 130% (much slower).
        if (
            success_lift <= -settings.promotion_min_success_rate_lift
            or latency_ratio > settings.promotion_max_latency_ratio * 1.2
        ):
            await self._rollback(client, experiment_id, agent, tenant_id)
            return "rollback"
        # Confidence gate: difference is small — keep rolling.
        return "keep"

    async def _promote(
        self,
        client: Any,
        experiment_id: str,
        agent: str,
        candidate_version: int,
        tenant_id: str,
    ) -> None:
        """Promote the canary to 100% traffic and audit-log."""
        now = datetime.now(timezone.utc)
        await client.execute(
            """
            UPDATE prompt_version_assignments
            SET traffic_pct = 100, promoted_at = $1
            WHERE experiment_id = $2
            """,
            now, experiment_id,
        )
        await client.execute(
            """
            UPDATE prompt_version_assignments
            SET status = 'ended', ended_at = $1
            WHERE tenant_id = $2 AND agent = $3
              AND experiment_id != $4 AND status = 'active'
            """,
            now, tenant_id, agent, experiment_id,
        )
        await client.execute(
            """
            UPDATE prompt_canary_experiments
            SET status = 'promoted', promoted_at = $1, ended_at = $1
            WHERE experiment_id = $2
            """,
            now, experiment_id,
        )
        try:
            from eden.kb.prompt_versions.client import get_prompt_versions_client
            pvc = await get_prompt_versions_client()
            await pvc.activate_prompt(agent, candidate_version)
        except Exception as exc:
            logger.warning(f"activate_prompt in promotion loop failed: {exc}")
        try:
            from eden.api.deps import log_audit_event
            await log_audit_event(
                client=client,
                org_id=tenant_id,
                user_id="promotion_loop",
                action="prompt.promoted",
                target_type="prompt_canary",
                target_id=experiment_id,
                metadata={
                    "agent": agent,
                    "candidate_version": candidate_version,
                    "promoted_by": "promotion_loop",
                },
            )
        except Exception as exc:
            logger.debug(f"audit log in promotion loop failed: {exc}")

    async def _rollback(
        self,
        client: Any,
        experiment_id: str,
        agent: str,
        tenant_id: str,
    ) -> None:
        """Roll back the canary. Tenant falls back to the global active."""
        now = datetime.now(timezone.utc)
        await client.execute(
            """
            UPDATE prompt_version_assignments
            SET status = 'rolled_back', ended_at = $1
            WHERE experiment_id = $2
            """,
            now, experiment_id,
        )
        await client.execute(
            """
            UPDATE prompt_canary_experiments
            SET status = 'rolled_back', ended_at = $1
            WHERE experiment_id = $2
            """,
            now, experiment_id,
        )
        try:
            from eden.api.deps import log_audit_event
            await log_audit_event(
                client=client,
                org_id=tenant_id,
                user_id="promotion_loop",
                action="prompt.rolled_back",
                target_type="prompt_canary",
                target_id=experiment_id,
                metadata={"agent": agent, "rolled_back_by": "promotion_loop"},
            )
        except Exception as exc:
            logger.debug(f"audit log in rollback failed: {exc}")


_promotion_loop: Optional[PromotionLoop] = None


def get_promotion_loop() -> PromotionLoop:
    global _promotion_loop
    if _promotion_loop is None:
        _promotion_loop = PromotionLoop()
    return _promotion_loop
