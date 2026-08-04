"""N01 regression eval runner — executes stored cases and gates promotion."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.evaluation.regression_builder import RegressionCase, RegressionCaseBuilder

logger = logging.getLogger(__name__)

_CANARY_REGRESSION_TRAFFIC_THRESHOLD = 5


class TelemetryUnavailableError(RuntimeError):
    """Telemetry backend could not be queried — verification is impossible.

    Raised instead of silently returning "no stumbles" so an outage can
    never masquerade as a passing regression suite (fail closed).
    """


@dataclass
class RegressionRunResult:
    id: str
    org_id: str
    agent_id: str | None
    change_id: str | None
    passed: int
    failed: int
    skipped: int = 0
    errors: int = 0
    failures: list[dict[str, Any]] = field(default_factory=list)
    # Per-case outcome: {case_id, fingerprint, status, reason} for every
    # case, including skipped/error ones (visibility, N01 fail-closed).
    cases: list[dict[str, Any]] = field(default_factory=list)
    status: str = "completed"
    created_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "agent_id": self.agent_id,
            "change_id": self.change_id,
            "passed": self.passed,
            "failed": self.failed,
            "skipped": self.skipped,
            "errors": self.errors,
            "failures": list(self.failures),
            "cases": list(self.cases),
            "status": self.status,
            "created_at": self.created_at,
        }

    @property
    def ok(self) -> bool:
        """Gate verdict: zero failures AND zero errors (fail closed).

        Skipped cases pass the gate under the default
        ``regression_gate_skip_policy="allow"``; under ``"block"`` they
        fail it too.
        """
        if self.failed > 0 or self.errors > 0:
            return False
        if self.skipped > 0 and _skip_policy() == "block":
            return False
        return True


def _skip_policy() -> str:
    try:
        from eden.config import get_settings

        policy = get_settings().regression_gate_skip_policy
    except Exception:
        return "allow"
    return policy if policy in ("allow", "block") else "allow"


class RegressionRunner:
    """Run regression eval cases against expected constraints."""

    def __init__(self, pg: Any | None = None, *, memory_only: bool = False) -> None:
        self._pg = pg
        self._memory_only = memory_only
        self._builder = RegressionCaseBuilder(pg=pg)

    async def _client(self) -> Any | None:
        if self._memory_only:
            return None
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def run_suite(
        self,
        org_id: str,
        *,
        agent_id: str | None = None,
        change_id: str | None = None,
    ) -> RegressionRunResult:
        cases = await self._builder.list_cases(org_id, agent_id=agent_id, limit=100)
        counts = {"passed": 0, "failed": 0, "skipped": 0, "error": 0}
        failures: list[dict[str, Any]] = []
        case_results: list[dict[str, Any]] = []
        # Suite-wide replay budget (regression_replay_v1): shared across
        # cases so a 100-case suite cannot blow through the caps.
        replay_budget = {"llm_steps": 0, "cost_usd": 0.0}
        for case in cases:
            status, reason = await self._evaluate_case(
                case, replay_budget=replay_budget
            )
            counts[status] += 1
            entry = {
                "case_id": case.id,
                "fingerprint": case.fingerprint,
                "status": status,
                "reason": reason,
            }
            case_results.append(entry)
            if status in ("failed", "error"):
                failures.append(entry)
        result = RegressionRunResult(
            id=str(uuid.uuid4()),
            org_id=org_id,
            agent_id=agent_id,
            change_id=change_id,
            passed=counts["passed"],
            failed=counts["failed"],
            skipped=counts["skipped"],
            errors=counts["error"],
            failures=failures,
            cases=case_results,
        )
        await self._persist(result)
        return result

    async def require_pass_for_canary(
        self, org_id: str, *, agent_id: str | None, traffic_pct: int
    ) -> RegressionRunResult | None:
        """Block canary traffic >5% when regression suite fails (N01)."""
        if traffic_pct <= _CANARY_REGRESSION_TRAFFIC_THRESHOLD:
            return None
        result = await self.run_suite(org_id, agent_id=agent_id)
        if not result.ok:
            from fastapi import HTTPException

            raise HTTPException(
                status_code=409,
                detail={
                    "code": "regression_gate_failed",
                    "message": (
                        f"Regression gate blocked canary at {traffic_pct}%: "
                        f"{result.failed} failure(s), {result.errors} error(s), "
                        f"{result.skipped} skipped "
                        f"(skip_policy={_skip_policy()})"
                    ),
                    "breakdown": {
                        "passed": result.passed,
                        "failed": result.failed,
                        "skipped": result.skipped,
                        "errors": result.errors,
                        "skip_policy": _skip_policy(),
                    },
                    "run": result.to_dict(),
                },
            )
        return result

    async def _evaluate_case(
        self,
        case: RegressionCase,
        *,
        replay_budget: dict[str, Any] | None = None,
    ) -> tuple[str, str]:
        """Evaluate one case.

        Returns ``(status, reason)`` with status in
        ``{"passed", "failed", "skipped", "error"}``. Infrastructure
        failure is an *error*, never a silent pass (fail closed).

        When ``regression_replay_v1`` is ON and the case carries a
        stored failure signature + checkpoint reference, the stored
        input is replayed against *current* behavior first
        (reason ``replay_signature_absent`` / ``replay_signature_present``
        — proof-quality labels for the portal). Post-hoc trace checks
        remain the fallback when replay is impossible; replay
        infrastructure failure or a cost-cap abort is an *error*, never
        a pass.
        """
        expected = case.expected_data or {}
        no_stumble = expected.get("no_stumble_kinds") or []
        has_constraints = bool(no_stumble)

        if self._replay_enabled():
            ref = self._replay_ref(expected)
            if ref is not None:
                sig, cp_trace_id, available = ref
                if available:
                    verdict = await self._run_replay(
                        case.org_id, cp_trace_id, sig, budget=replay_budget
                    )
                    if verdict is not None:
                        return verdict
                # Replay impossible (no checkpoint / signature absent in
                # the original recording) — fall back to post-hoc trace
                # checks; when the case has no trace constraints either,
                # skip honestly.
                if not has_constraints:
                    return "skipped", "no_checkpoint"

        if not no_stumble:
            return "skipped", "no_constraints"
        trace_id = case.source_trace_id or (case.input_data or {}).get("trace_id")
        if not trace_id:
            return "skipped", "no_trace"
        try:
            kinds = await self._stumble_kinds_for_trace(str(trace_id))
        except TelemetryUnavailableError:
            return "error", "telemetry_unavailable"
        blocked = [k for k in no_stumble if k in kinds]
        if blocked:
            return "failed", f"stumble kinds present: {blocked}"
        if expected.get("statgate_pass") is True:
            try:
                sg = await self._statgate_pass(str(trace_id))
            except TelemetryUnavailableError:
                return "error", "telemetry_unavailable"
            if not sg:
                return "failed", "statgate failed on trace"
        return "passed", "ok"

    # ── replay verification (regression_replay_v1) ──────────────

    @staticmethod
    def _replay_enabled() -> bool:
        """Default OFF; any settings failure reads as OFF (today's path)."""
        try:
            from eden.config import get_settings

            return bool(getattr(get_settings(), "regression_replay_v1", False))
        except Exception:
            return False

    @staticmethod
    def _replay_ref(
        expected: dict[str, Any],
    ) -> tuple[Any, str, bool] | None:
        """``(signature, checkpoint_trace_id, available)`` or ``None``.

        ``None`` means the case carries no stored failure signature —
        it predates replay enrichment and follows today's post-hoc path
        untouched.
        """
        try:
            from eden.improvement.replay_verify import FailureSignature

            sig = FailureSignature.from_json(
                expected.get("failure_signature") or {}
            )
        except Exception:
            return None
        if sig is None:
            return None
        replay = expected.get("replay") or {}
        trace_id = str(replay.get("checkpoint_trace_id") or "").strip()
        available = bool(replay.get("checkpoint_available")) and bool(trace_id)
        return sig, trace_id, available

    @staticmethod
    def _replay_caps() -> tuple[int, float]:
        """Existing M7 replay cost caps (shared, not duplicated)."""
        try:
            from eden.config import get_settings

            s = get_settings()
            return (
                int(getattr(s, "replay_max_llm_steps", 3) or 3),
                float(getattr(s, "replay_max_cost_usd", 0.05) or 0.05),
            )
        except Exception:
            return 3, 0.05

    async def _run_replay(
        self,
        org_id: str,
        trace_id: str,
        sig: Any,
        *,
        budget: dict[str, Any] | None,
    ) -> tuple[str, str] | None:
        """Replay the stored failing step against current behavior.

        Returns a final ``(status, reason)`` verdict, or ``None`` when
        replay is impossible for this case (no checkpoints / signature
        absent in the original) and post-hoc fallback should apply.
        Infrastructure failure and cost-cap aborts are errors — replay
        can never silently pass (fail closed).
        """
        max_steps, max_cost = self._replay_caps()
        if budget is not None and (
            budget.get("llm_steps", 0) >= max_steps
            or budget.get("cost_usd", 0.0) >= max_cost
        ):
            return "error", "cost_cap"
        try:
            from eden.improvement.replay_verify import replay_case_signature

            result = await replay_case_signature(org_id, trace_id, sig)
        except Exception as exc:
            logger.warning("regression replay failed: %s", exc)
            return "error", "replay_failed"
        if budget is not None:
            budget["llm_steps"] = budget.get("llm_steps", 0) + int(
                result.traces_checked or 0
            )
            budget["cost_usd"] = budget.get("cost_usd", 0.0) + float(
                result.cost_usd or 0.0
            )
        if result.status == "passed":
            return "passed", "replay_signature_absent"
        if result.status == "failed":
            return "failed", "replay_signature_present"
        if result.reason == "cost_cap":
            return "error", "cost_cap"
        if result.reason in ("no_checkpoints", "signature_absent_in_original"):
            return None  # honest fallback to post-hoc verification
        return "error", "replay_failed"

    async def _stumble_kinds_for_trace(self, trace_id: str) -> set[str]:
        client = await self._client()
        if client is None:
            raise TelemetryUnavailableError("telemetry client unavailable")
        try:
            rows = await client.fetch(
                """
                SELECT attributes->>'stumble_kind' AS kind
                FROM telemetry_events
                WHERE trace_id = $1
                  AND attributes->>'stumble_kind' IS NOT NULL
                """,
                trace_id,
            )
            return {str(r["kind"]) for r in rows if r.get("kind")}
        except Exception as exc:
            raise TelemetryUnavailableError(
                f"stumble query failed: {exc}"
            ) from exc

    async def _statgate_pass(self, trace_id: str) -> bool:
        client = await self._client()
        if client is None:
            raise TelemetryUnavailableError("telemetry client unavailable")
        try:
            row = await client.fetchrow(
                """
                SELECT outcome FROM telemetry_events
                WHERE trace_id = $1 ORDER BY timestamp DESC LIMIT 1
                """,
                trace_id,
            )
            if row is None:
                return True
            return (row.get("outcome") or "success") == "success"
        except Exception as exc:
            raise TelemetryUnavailableError(
                f"statgate query failed: {exc}"
            ) from exc

    async def _persist(self, result: RegressionRunResult) -> None:
        client = await self._client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO regression_eval_runs
                (id, org_id, agent_id, change_id, passed, failed, failures, status)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8)
            """,
            result.id,
            result.org_id,
            result.agent_id,
            result.change_id,
            result.passed,
            result.failed,
            json.dumps(result.failures),
            result.status,
        )


__all__ = [
    "RegressionRunner",
    "RegressionRunResult",
    "TelemetryUnavailableError",
]
