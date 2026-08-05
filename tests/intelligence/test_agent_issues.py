"""F28/F29 — stumble writer + issue promoter (Wave 1).

Uses an in-memory Postgres fake that understands exactly the queries the
issues layer runs, so the dedup / promotion / regression logic is
exercised for real (not mocked away).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.issues.models import StumbleCreate


class _FakePG:
    """Minimal asyncpg-like fake for agent_stumbles / agent_issues."""

    def __init__(self) -> None:
        self.stumbles: dict[tuple, dict[str, Any]] = {}
        self.issues: dict[tuple, dict[str, Any]] = {}

    # ── connection acquisition / txn (used by IssuePromoter) ────────
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
                self.stumbles[key]["detail"] = detail
                return {"id": self.stumbles[key]["id"], "inserted": False}
            row = {
                "id": sid, "org_id": org, "trace_id": trace,
                "session_id": session, "user_id": user, "agent_id": agent,
                "span_id": span, "kind": kind, "fingerprint": fp,
                "title": title, "detail": detail, "severity": sev,
                "detected_by": by, "detected_at": datetime.now(UTC),
            }
            self.stumbles[key] = row
            return {"id": sid, "inserted": True}
        if "FROM agent_issues" in s and "FOR UPDATE" in s:
            org, fp = args
            return self.issues.get((org, fp))
        if "FROM agent_issues" in s and "AND id =" in s:
            org, iid = args
            for r in self.issues.values():
                if r["id"] == str(iid) and r["org_id"] == org:
                    return r
            return None
        if "FROM agent_issues" in s and "fingerprint = $2" in s:
            org, fp = args
            return self.issues.get((org, fp))
        if "FROM agent_stumbles" in s and "id = $2" in s:
            org, sid = args
            for r in self.stumbles.values():
                if str(r["id"]) == str(sid) and r["org_id"] == org:
                    return r
            return None
        return None

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        s = " ".join(sql.split())
        if "FROM agent_issues" in s:
            org = args[0]
            return [r for r in self.issues.values() if r["org_id"] == org]
        if "FROM agent_stumbles" in s:
            org = args[0]
            return [r for r in self.stumbles.values() if r["org_id"] == org]
        return []

    async def execute(self, sql: str, *args: Any) -> str:
        s = " ".join(sql.split())
        if "INSERT INTO agent_issues" in s:
            (iid, org, fp, kind, title, sev, agent, ucount, affected,
             stumble_id) = args
            now = datetime.now(UTC)
            self.issues[(org, fp)] = {
                "id": iid, "org_id": org, "fingerprint": fp, "kind": kind,
                "title": title, "status": "open", "severity": sev,
                "agent_id": agent, "stumble_count": 1, "user_count": ucount,
                "repetition_count": 1,
                "affected_user_ids": list(affected),
                "example_stumble_ids": [stumble_id],
                "triage_result": None, "first_seen": now, "last_seen": now,
            }
            return "INSERT 0 1"
        if "UPDATE agent_issues" in s and "stumble_count = stumble_count + 1" in s:
            (org, iid, status, rep, sev, ucount, affected, examples) = args
            for r in self.issues.values():
                if r["id"] == iid:
                    r["stumble_count"] += 1
                    r["status"] = status
                    r["repetition_count"] = rep
                    r["severity"] = sev
                    r["user_count"] = ucount
                    r["affected_user_ids"] = list(affected)
                    r["example_stumble_ids"] = list(examples)
                    return "UPDATE 1"
            return "UPDATE 0"
        if "UPDATE agent_issues" in s and "SET status = $3" in s:
            org, iid, status = args
            for r in self.issues.values():
                if r["id"] == iid and r["org_id"] == org:
                    r["status"] = status
                    return "UPDATE 1"
            return "UPDATE 0"
        if "SET triage_result" in s:
            org, iid, tr = args
            for r in self.issues.values():
                if r["id"] == iid and r["org_id"] == org:
                    r["triage_result"] = tr
                    return "UPDATE 1"
            return "UPDATE 0"
        return "OK"


def _sc(trace_id: str, *, user_id: str = "u1", tool: str = "search") -> StumbleCreate:
    return StumbleCreate(
        org_id="org_test",
        trace_id=trace_id,
        kind="tool_error",
        title="search tool timed out",
        detail={"tool_name": tool, "error": "Timeout after 30s"},
        detected_by="auto_scanner",
        agent_id="agent-a",
        user_id=user_id,
    )


@pytest.mark.asyncio
async def test_create_persists_and_promotes() -> None:
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook = hook_factory.return_value
        hook.on_issue_created = AsyncMock(return_value="a1")
        res = await StumbleWriter().create(_sc("trace-1"))

    assert res["stumble_id"] is not None
    assert res["inserted"] is True
    issue = res["issue"]
    assert issue is not None
    assert issue.was_created is True
    assert issue.stumble_count == 1
    # on_issue_created fired for a brand-new issue.
    hook.on_issue_created.assert_awaited_once()


@pytest.mark.asyncio
async def test_second_matching_stumble_increments_not_duplicates() -> None:
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook = hook_factory.return_value
        hook.on_issue_created = AsyncMock(return_value="a1")
        writer = StumbleWriter()
        await writer.create(_sc("trace-1", user_id="u1"))
        r2 = await writer.create(_sc("trace-2", user_id="u2"))

    # One issue only.
    assert len(pg.issues) == 1
    assert r2["issue"].stumble_count == 2
    assert r2["issue"].was_created is False
    assert r2["issue"].user_count == 2  # two distinct users
    # Hook fired only for the first (create), not the plain increment.
    assert hook.on_issue_created.await_count == 1


@pytest.mark.asyncio
async def test_same_trace_is_deduped_at_stumble_level() -> None:
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
        writer = StumbleWriter()
        await writer.create(_sc("trace-1"))
        r2 = await writer.create(_sc("trace-1"))  # identical trace

    assert r2["inserted"] is False  # deduped
    assert len(pg.stumbles) == 1


@pytest.mark.asyncio
async def test_resolve_then_new_stumble_regresses() -> None:
    from eden.issues.repo import IssuesRepo
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook = hook_factory.return_value
        hook.on_issue_created = AsyncMock(return_value="a")
        writer = StumbleWriter()
        r1 = await writer.create(_sc("trace-1"))
        issue_id = r1["issue"].id
        # Resolve it.
        await IssuesRepo().set_status("org_test", issue_id, "resolved")
        # New matching stumble → regression.
        r3 = await writer.create(_sc("trace-9"))

    assert r3["issue"].status == "regressed"
    assert r3["issue"].was_regressed is True
    assert r3["issue"].repetition_count == 2
    # Hook fired for the initial create AND the regression.
    assert hook.on_issue_created.await_count == 2


@pytest.mark.asyncio
async def test_rescan_same_trace_does_not_bump_stumble_count() -> None:
    """WP0: re-scanning the same trace (ON CONFLICT dedup) must not
    promote again — the issue's stumble_count stays put."""
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook = hook_factory.return_value
        hook.on_issue_created = AsyncMock(return_value="a1")
        writer = StumbleWriter()
        r1 = await writer.create(_sc("trace-1"))
        # Re-scan the exact same trace/kind/fingerprint N times.
        for _ in range(4):
            await writer.create(_sc("trace-1"))

    assert len(pg.issues) == 1
    assert r1["issue"].stumble_count == 1
    # The single issue row was never bumped past the initial insert.
    only_issue = next(iter(pg.issues.values()))
    assert only_issue["stumble_count"] == 1
    # Hook fired exactly once (initial create), never on the dedups.
    assert hook.on_issue_created.await_count == 1


@pytest.mark.asyncio
async def test_five_stumbles_three_users_aggregates() -> None:
    """WP0/F29: 5 distinct-trace stumbles → 1 issue, count=5, users=3."""
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    users = ["u1", "u2", "u3", "u1", "u2"]
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook = hook_factory.return_value
        hook.on_issue_created = AsyncMock(return_value="a1")
        writer = StumbleWriter()
        last = None
        for i, uid in enumerate(users):
            last = await writer.create(_sc(f"trace-{i}", user_id=uid))

    assert len(pg.issues) == 1
    assert last["issue"].stumble_count == 5
    assert last["issue"].user_count == 3
    # Only the first create fired the issue hook.
    assert hook.on_issue_created.await_count == 1


@pytest.mark.asyncio
async def test_dedup_returns_no_issue_and_records_metric() -> None:
    """WP0: a deduped write returns issue=None and increments the
    deduped metric (not the created metric)."""
    from eden.issues import metrics
    from eden.issues.stumble_writer import StumbleWriter

    before = metrics.get_stumble_stats()
    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
        writer = StumbleWriter()
        await writer.create(_sc("trace-1"))
        r2 = await writer.create(_sc("trace-1"))

    assert r2["inserted"] is False
    assert r2["issue"] is None
    after = metrics.get_stumble_stats()
    assert after["created_total"] >= before["created_total"] + 1
    assert after["deduped_total"] >= before["deduped_total"] + 1


# ── Route smoke tests ───────────────────────────────────────────────


def _client(pg: _FakePG) -> TestClient:
    from eden.api.deps import get_current_user, require_path_org_access

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "u1",
        "org_id": "org_test",
    }

    async def _path_org(org_id: str = "org_test") -> str:
        return org_id

    app.dependency_overrides[require_path_org_access] = _path_org
    import eden.api.routes.agent_issues as mod

    async def _flag_on() -> None:
        return None

    for r in mod.router.routes:
        if not hasattr(r, "dependant"):
            continue
        for d in r.dependant.dependencies:
            if d.call.__name__ == "_dependency":
                app.dependency_overrides[d.call] = _flag_on
    if hasattr(mod, "_require_path_org"):
        app.dependency_overrides[mod._require_path_org] = lambda: "org_test"
    app.include_router(mod.router)
    return TestClient(app)


def test_resolve_rejects_invalid_status() -> None:
    """BUG-3: an unknown status must 400, not silently coerce to resolved."""
    pg = _FakePG()

    async def _seed() -> str:
        from eden.issues.stumble_writer import StumbleWriter

        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            res = await StumbleWriter().create(_sc("trace-1"))
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "bogus-typo"},
        )
        assert r.status_code == 400
        # The issue must not have been mutated.
        row = next(iter(pg.issues.values()))
        assert row["status"] == "open"


def test_resolve_confirmed_feeds_shadow_detector() -> None:
    """FEAT-8 (P0-A): resolving an issue whose example stumble came from
    the signal investigator must record operator confirm feedback on the
    originating shadow detector (nl_signals row)."""
    from eden.issues.models import StumbleCreate
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()

    async def _seed() -> str:
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            sc = StumbleCreate(
                org_id="org_test",
                trace_id="trace-shadow-1",
                kind="tool_error",
                title="shadow-detected stumble",
                detail={"signal_id": "sig-abc", "source": "signal_investigator"},
                detected_by="signal_investigator",
                agent_id="agent-a",
                user_id="u1",
            )
            res = await StumbleWriter().create(sc)
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    feedback_mock = AsyncMock(return_value=True)
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.services.soft_issue_review.record_shadow_feedback", feedback_mock
    ):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "resolved"},
        )
        assert r.status_code == 200

    feedback_mock.assert_awaited_once_with(
        "org_test", "sig-abc", confirm=True, dismiss=None
    )


def test_resolve_ignored_dismisses_shadow_detector() -> None:
    """FEAT-8 (P0-A): resolving with status=ignored records a dismiss."""
    from eden.issues.models import StumbleCreate
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()

    async def _seed() -> str:
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            sc = StumbleCreate(
                org_id="org_test",
                trace_id="trace-shadow-2",
                kind="tool_error",
                title="shadow-detected stumble",
                detail={"signal_id": "sig-xyz", "source": "signal_investigator"},
                detected_by="signal_investigator",
                agent_id="agent-a",
                user_id="u1",
            )
            res = await StumbleWriter().create(sc)
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    feedback_mock = AsyncMock(return_value=True)
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.services.soft_issue_review.record_shadow_feedback", feedback_mock
    ):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "ignored"},
        )
        assert r.status_code == 200

    feedback_mock.assert_awaited_once_with(
        "org_test", "sig-xyz", confirm=None, dismiss=True
    )


def test_resolve_non_signal_investigator_stumble_skips_shadow_feedback() -> None:
    """FEAT-9 (P0-B): a stumble not sourced from the signal investigator
    (e.g. ``detected_by="auto_scanner"``) must not trigger shadow-detector
    feedback on resolve."""
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()

    async def _seed() -> str:
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            res = await StumbleWriter().create(_sc("trace-auto-1"))
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    feedback_mock = AsyncMock(return_value=True)
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.services.soft_issue_review.record_shadow_feedback", feedback_mock
    ):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "resolved"},
        )
        assert r.status_code == 200

    feedback_mock.assert_not_awaited()


def test_resolve_missing_stumble_skips_shadow_feedback_no_error() -> None:
    """FEAT-9 (P0-B): if the issue's example stumble no longer exists
    (e.g. ``get_stumble`` returns ``None``), resolve must still succeed
    and must not call ``record_shadow_feedback``."""
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()

    async def _seed() -> str:
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            res = await StumbleWriter().create(_sc("trace-missing-1"))
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    # Point the issue's example stumble at an id that doesn't exist.
    for row in pg.issues.values():
        if row["id"] == issue_id:
            row["example_stumble_ids"] = ["does-not-exist"]

    feedback_mock = AsyncMock(return_value=True)
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.services.soft_issue_review.record_shadow_feedback", feedback_mock
    ):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "resolved"},
        )
        assert r.status_code == 200

    feedback_mock.assert_not_awaited()


def test_resolve_no_example_stumbles_skips_shadow_feedback_no_error() -> None:
    """FEAT-9 (P0-B): an issue with no ``example_stumble_ids`` at all must
    resolve cleanly and must not call ``record_shadow_feedback``."""
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()

    async def _seed() -> str:
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            res = await StumbleWriter().create(_sc("trace-empty-1"))
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    for row in pg.issues.values():
        if row["id"] == issue_id:
            row["example_stumble_ids"] = []

    feedback_mock = AsyncMock(return_value=True)
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.services.soft_issue_review.record_shadow_feedback", feedback_mock
    ):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "resolved"},
        )
        assert r.status_code == 200

    feedback_mock.assert_not_awaited()


def test_resolve_malformed_detail_json_does_not_error() -> None:
    """FEAT-9 (P0-B): a signal-investigator stumble whose ``detail`` column
    holds malformed JSON must not raise; resolve should succeed and
    ``record_shadow_feedback`` must not be called."""
    from eden.issues.models import StumbleCreate
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()

    async def _seed() -> str:
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            sc = StumbleCreate(
                org_id="org_test",
                trace_id="trace-shadow-malformed",
                kind="tool_error",
                title="shadow-detected stumble",
                detail={"signal_id": "sig-bad", "source": "signal_investigator"},
                detected_by="signal_investigator",
                agent_id="agent-a",
                user_id="u1",
            )
            res = await StumbleWriter().create(sc)
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    # Corrupt the persisted detail so json.loads() raises.
    for row in pg.stumbles.values():
        row["detail"] = "{not valid json"

    feedback_mock = AsyncMock(return_value=True)
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.services.soft_issue_review.record_shadow_feedback", feedback_mock
    ):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "resolved"},
        )
        assert r.status_code == 200

    feedback_mock.assert_not_awaited()


def test_resolve_acknowledged_persists_as_triaged() -> None:
    """BUG-4: 'acknowledged' has no legal value in the ``agent_issues``
    status CHECK constraint (see
    db_migrations/versions/136_issue_status_escalated.py); the route must
    map it onto 'triaged' rather than writing the raw value, which used
    to raise a CheckViolation that ``IssuesRepo.set_status`` silently
    swallowed (the Acknowledge button no-op'd)."""
    pg = _FakePG()

    async def _seed() -> str:
        from eden.issues.stumble_writer import StumbleWriter

        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            res = await StumbleWriter().create(_sc("trace-ack"))
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "acknowledged"},
        )
        assert r.status_code == 200
        body = r.json()["data"]
        assert body["updated"] is True
        # Response still echoes the app-level status the caller asked for...
        assert body["status"] == "acknowledged"
        # ...but the row that was actually written is the DB-legal mapped
        # value, not the raw (CHECK-constraint-illegal) "acknowledged".
        row = next(iter(pg.issues.values()))
        assert row["status"] == "triaged"


def test_resolve_surfaces_genuine_set_status_error() -> None:
    """BUG-4: a real failure inside ``set_status`` (e.g. a CheckViolation)
    must come back as a non-200 error, not a false-positive 200 —
    the portal's optimistic-update revert + error toast only fires when
    the request actually throws/rejects."""
    import eden.api.routes.agent_issues as mod

    pg = _FakePG()

    async def _seed() -> str:
        from eden.issues.stumble_writer import StumbleWriter

        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            res = await StumbleWriter().create(_sc("trace-err"))
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch.object(
        mod._repo, "set_status", AsyncMock(side_effect=RuntimeError("check violation"))
    ):
        client = _client(pg)
        r = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "acknowledged"},
        )
        assert r.status_code == 500
        # The row must not have been mutated.
        row = next(iter(pg.issues.values()))
        assert row["status"] == "open"


def test_list_and_get_issue_routes() -> None:
    pg = _FakePG()

    async def _seed() -> str:
        from eden.issues.stumble_writer import StumbleWriter

        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            res = await StumbleWriter().create(_sc("trace-1"))
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
        client = _client(pg)
        r = client.get("/orgs/org_test/agent-issues")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["data"]["count"] == 1

        r2 = client.get(f"/orgs/org_test/agent-issues/{issue_id}")
        assert r2.status_code == 200
        assert r2.json()["data"]["issue"]["id"] == issue_id

        r3 = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "resolved"},
        )
        assert r3.status_code == 200
        assert r3.json()["data"]["status"] == "resolved"


# ── WP1: stumble surface (SDK create path, read routes, bench) ───────


def test_stumble_read_and_create_routes() -> None:
    """F28: POST /stumbles (SDK path), GET /stumbles (filters), GET /{id}."""
    pg = _FakePG()

    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
        client = _client(pg)

        # SDK self-diagnostic create.
        created = client.post(
            "/orgs/org_test/stumbles",
            json={
                "trace_id": "trace-sdk",
                "kind": "self_diagnostic",
                "title": "low confidence answer",
                "detail": {"confidence": 0.2},
                "agent_id": "agent-a",
            },
        )
        assert created.status_code == 200
        assert created.json()["data"]["inserted"] is True

        # List filtered by trace_id + kind.
        listed = client.get(
            "/orgs/org_test/stumbles",
            params={"trace_id": "trace-sdk", "kind": "self_diagnostic"},
        )
        assert listed.status_code == 200
        stumbles = listed.json()["data"]["stumbles"]
        assert len(stumbles) == 1
        assert stumbles[0]["kind"] == "self_diagnostic"
        stumble_id = stumbles[0]["id"]

        # Get by id.
        got = client.get(f"/orgs/org_test/stumbles/{stumble_id}")
        assert got.status_code == 200
        assert got.json()["data"]["stumble"]["id"] == stumble_id

        # Unknown id → not_found envelope.
        missing = client.get(f"/orgs/org_test/stumbles/{uuid.uuid4()}")
        assert missing.status_code == 200
        assert missing.json()["status"] == "not_found"


@pytest.mark.asyncio
async def test_stumble_write_p95_under_budget() -> None:
    """F28 AC: write p95 < 30ms across 100 concurrent creates (mock DB)."""
    import asyncio
    import time

    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
        writer = StumbleWriter()

        latencies: list[float] = []

        async def _one(i: int) -> None:
            t0 = time.perf_counter()
            await writer.create(_sc(f"bench-trace-{i}"))
            latencies.append((time.perf_counter() - t0) * 1000.0)

        await asyncio.gather(*(_one(i) for i in range(100)))

    latencies.sort()
    p95 = latencies[int(0.95 * (len(latencies) - 1))]
    assert len(latencies) == 100
    assert p95 < 30.0, f"p95={p95:.2f}ms exceeds 30ms budget"
