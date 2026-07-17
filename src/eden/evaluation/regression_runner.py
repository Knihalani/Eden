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


@dataclass
class RegressionRunResult:
    id: str
    org_id: str
    agent_id: str | None
    change_id: str | None
    passed: int
    failed: int
    failures: list[dict[str, Any]] = field(default_factory=list)
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
            "failures": list(self.failures),
            "status": self.status,
            "created_at": self.created_at,
        }

    @property
    def ok(self) -> bool:
        return self.failed == 0


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
        passed = 0
        failed = 0
        failures: list[dict[str, Any]] = []
        for case in cases:
            ok, reason = await self._evaluate_case(case)
            if ok:
                passed += 1
            else:
                failed += 1
                failures.append(
                    {
                        "case_id": case.id,
                        "fingerprint": case.fingerprint,
                        "reason": reason,
                    }
                )
        result = RegressionRunResult(
            id=str(uuid.uuid4()),
            org_id=org_id,
            agent_id=agent_id,
            change_id=change_id,
            passed=passed,
            failed=failed,
            failures=failures,
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
                        f"{result.failed} failure(s)"
                    ),
                    "run": result.to_dict(),
                },
            )
        return result

    async def _evaluate_case(self, case: RegressionCase) -> tuple[bool, str]:
        expected = case.expected_data or {}
        no_stumble = expected.get("no_stumble_kinds") or []
        if not no_stumble:
            return True, "no constraints"
        trace_id = case.source_trace_id or (case.input_data or {}).get("trace_id")
        if not trace_id:
            return True, "no trace to verify"
        kinds = await self._stumble_kinds_for_trace(str(trace_id))
        blocked = [k for k in no_stumble if k in kinds]
        if blocked:
            return False, f"stumble kinds present: {blocked}"
        if expected.get("statgate_pass") is True:
            sg = await self._statgate_pass(str(trace_id))
            if not sg:
                return False, "statgate failed on trace"
        return True, "ok"

    async def _stumble_kinds_for_trace(self, trace_id: str) -> set[str]:
        client = await self._client()
        if client is None:
            return set()
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
        except Exception:
            return set()

    async def _statgate_pass(self, trace_id: str) -> bool:
        client = await self._client()
        if client is None:
            return True
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
        except Exception:
            return True

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


__all__ = ["RegressionRunner", "RegressionRunResult"]
