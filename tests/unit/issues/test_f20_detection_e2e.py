"""F20 — fixture ingest → trace.finalized → consumer → stumble row.

Exercises the whole auto-detection path end-to-end against an in-memory
Postgres fake: emit a finalized trace, run the consumer handler, and
assert a ``tool_error`` stumble row lands within the latency budget.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "fixtures"
    / "traces"
    / "issues"
    / "tool_error_trace.json"
)


class _FakePG:
    def __init__(self) -> None:
        self.stumbles: dict[tuple, dict[str, Any]] = {}
        self.issues: dict[tuple, dict[str, Any]] = {}

    def acquire(self) -> Any:
        pg = self

        class _Ctx:
            async def __aenter__(self) -> Any:
                return pg

            async def __aexit__(self, *a: Any) -> bool:
                return False

        return _Ctx()

    def transaction(self) -> Any:
        class _T:
            async def __aenter__(self) -> None:
                return None

            async def __aexit__(self, *a: Any) -> bool:
                return False

        return _T()

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        s = " ".join(sql.split())
        if "INSERT INTO agent_stumbles" in s:
            (sid, org, trace, session, user, agent, span, kind, fp,
             title, detail, sev, by) = args
            key = (org, trace, kind, fp)
            if key in self.stumbles:
                return {"id": self.stumbles[key]["id"], "inserted": False}
            self.stumbles[key] = {
                "id": sid, "org_id": org, "trace_id": trace, "kind": kind,
                "fingerprint": fp, "title": title, "detail": detail,
                "severity": sev, "detected_by": by, "span_id": span,
            }
            return {"id": sid, "inserted": True}
        if "FROM agent_issues" in s and "FOR UPDATE" in s:
            org, fp = args
            return self.issues.get((org, fp))
        if "FROM organizations" in s:
            return None
        return None

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        return []

    async def execute(self, sql: str, *args: Any) -> str:
        s = " ".join(sql.split())
        if "INSERT INTO agent_issues" in s:
            (iid, org, fp, kind, title, sev, agent, ucount, affected,
             stumble_id) = args
            self.issues[(org, fp)] = {
                "id": iid, "org_id": org, "fingerprint": fp, "kind": kind,
                "title": title, "status": "open", "severity": sev,
                "stumble_count": 1, "user_count": ucount,
                "repetition_count": 1, "affected_user_ids": list(affected),
                "example_stumble_ids": [stumble_id],
            }
        return "OK"


@pytest.mark.asyncio
async def test_fixture_ingest_to_stumble_under_60s() -> None:
    import eden.workers.trace_finalized_consumer as mod

    payload = json.loads(_FIXTURE.read_text())
    pg = _FakePG()

    redis = AsyncMock()
    redis.xack = AsyncMock()

    fields = {
        b"org_id": payload["org_id"].encode(),
        b"trace_id": payload["trace_id"].encode(),
        b"agent_id": payload["agent_id"].encode(),
        b"session_id": b"",
        b"user_id": b"",
    }

    start = time.perf_counter()
    with patch(
        "eden.storage.postgres.get_postgres_client", return_value=pg
    ), patch(
        "eden.insights.rca._common._fetch_trace_events",
        AsyncMock(return_value=payload["events"]),
    ), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory, patch(
        "eden.issues.detection_settings.resolve_profile",
        AsyncMock(return_value="standard"),
    ):
        hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
        consumer = mod.TraceFinalizedConsumer()
        # Neutralize optional downstream side-paths for a focused E2E.
        consumer._maybe_prod_eval = AsyncMock()  # type: ignore[method-assign]
        await consumer._handle(redis, f"{int(time.time()*1000)}-0", fields)
    elapsed = time.perf_counter() - start

    # A tool_error stumble was written for the fixture trace.
    kinds = {v["kind"] for v in pg.stumbles.values()}
    assert "tool_error" in kinds
    assert elapsed < 60.0
    redis.xack.assert_awaited_once()


@pytest.mark.asyncio
async def test_minimal_profile_skips_slow_detector() -> None:
    """detection_profile=minimal only runs tool_error + task_failure."""
    from eden.issues.auto_scanner import AutoIssueScanner

    payload = json.loads(_FIXTURE.read_text())
    # Add a slow span that would trip slow_trace under standard.
    events = payload["events"] + [
        {"event_type": "span.end", "duration_ms": 90_000, "attributes": {}}
    ]

    captured: list[Any] = []

    class _W:
        async def create(self, sc: Any) -> dict[str, Any]:
            captured.append(sc)
            return {"stumble_id": "s", "inserted": True, "issue": None}

    scanner = AutoIssueScanner(writer=_W())  # type: ignore[arg-type]
    await scanner.scan(
        "org", "t", events=events, detection_profile="minimal"
    )
    kinds = {sc.kind for sc in captured}
    assert "timeout" not in kinds  # slow_trace suppressed
    assert "tool_error" in kinds
    assert "task_failure" in kinds
    assert "loop" not in kinds
