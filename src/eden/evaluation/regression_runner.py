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
        for case in cases:
            status, reason = await self._evaluate_case(case)
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

    async def _evaluate_case(self, case: RegressionCase) -> tuple[str, str]:
        """Evaluate one case.

        Returns ``(status, reason)`` with status in
        ``{"passed", "failed", "skipped", "error"}``. Infrastructure
        failure is an *error*, never a silent pass (fail closed).
        """
        expected = case.expected_data or {}
        no_stumble = expected.get("no_stumble_kinds") or []
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
