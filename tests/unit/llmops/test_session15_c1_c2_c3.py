"""Session 15 tests — Judge concurrency + judges auth + intelligence RBAC (C-1/2/3).

Three audit items:

* **C-1** — ``JudgeRunner.run_for_event`` ran judges sequentially
  in a for-loop (runner.py:69-78). A 4-judge trace at 800ms each
  cost 3.2s on the hot path; gather fan-out brings it to ~800ms.
  Fix: ``asyncio.gather`` with a per-tenant semaphore bounded by
  ``max_concurrent_per_tenant`` (default 4).

* **C-2** — ``routes/judges.py`` mounted ``/run``, ``/``, and
  ``/{judge_run_id}`` with only ``Depends(get_current_user)``. Any
  authenticated user could read or run judges on any tenant's
  trace_id by guessing ``org_id`` in the path.
  Fix: add ``Depends(require_org_member)`` so the path's org_id
  is verified against the caller's org membership.

* **C-3** — Six intelligence routers mounted ``get_current_user``
  only at the router level (no org-membership check). A user
  authenticated to org A could read or mutate org B's
  governance/cost/eval/memory/agents/code-change data.
  Fix: add ``Depends(require_org_member)`` to each router's
  ``dependencies=[...]``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from starlette.testclient import TestClient

from eden.llmops.judges.base import Judge, JudgeContext, JudgeScore

# ─── Test doubles ────────────────────────────────────────────────


class _FakeJudge(Judge):
    """A judge that sleeps for ``delay_s`` before returning a score.

    The sleep is the lever C-1 uses to prove concurrency: 4 judges
    at 100ms each run in ~100ms (parallel) vs ~400ms (sequential).
    """

    def __init__(
        self,
        name: str = "fake_judge",
        score: float = 0.5,
        delay_s: float = 0.1,
        raise_exc: bool = False,
    ) -> None:
        self.name = name
        self.version = "test"
        self.model_slot = "fast"
        self._score = score
        self._delay_s = delay_s
        self._raise = raise_exc

    async def score(self, event, ctx) -> JudgeScore:
        await asyncio.sleep(self._delay_s)
        if self._raise:
            raise RuntimeError("boom")
        return JudgeScore(
            judge_name=self.name,
            judge_version="test",
            trace_id=ctx.trace_id or event.trace_id,
            span_id=event.span_id,
            score=self._score,
            rationale=f"from {self.name}",
            model="test",
        )


class _FakeEvent:
    """Bare-minimum event the runner reads (trace_id, span_id)."""

    def __init__(self, trace_id: str = "tr1", span_id: str = "sp1") -> None:
        self.event_id = "e1"
        self.trace_id = trace_id
        self.span_id = span_id
        self.event_type = "otel.chat"
        self.payload: dict[str, Any] = {}
        self.attributes: dict[str, Any] = {}
        self.tags: list[str] = []


# ─── C-1: JudgeRunner concurrent fan-out ─────────────────────────


class TestC1JudgeRunnerConcurrent:
    """Pre-fix: 4 judges × 100ms ran in 400ms (sequential).
    Post-fix: they run in ~100ms via asyncio.gather."""

    @pytest.mark.asyncio
    async def test_four_judges_run_concurrently(self) -> None:
        """Wall-clock for 4 judges × 100ms must be < 250ms —
        well below the sequential 400ms."""
        from eden.llmops.judges.runner import JudgeRunner

        judges = [_FakeJudge(name=f"j{i}", delay_s=0.1) for i in range(4)]
        runner = JudgeRunner(max_concurrent_per_tenant=4)
        # Patch _persist so we don't hit Postgres.
        runner._persist = AsyncMock()  # type: ignore[method-assign]

        ev = _FakeEvent()
        t0 = time.monotonic()
        results = await runner.run_for_event(ev, judges)
        elapsed = time.monotonic() - t0

        assert len(results) == 4
        # Sequential would be ~0.4s; concurrent should be ~0.1s.
        # Allow generous slack for the asyncio scheduler.
        assert elapsed < 0.25, (
            f"C-1 regression: 4 judges × 100ms took {elapsed:.3f}s "
            f"(sequential would be ~0.4s; concurrent should be ~0.1s)"
        )

    @pytest.mark.asyncio
    async def test_judge_failure_isolated(self) -> None:
        """One judge raising MUST NOT break the others."""
        from eden.llmops.judges.runner import JudgeRunner

        judges = [
            _FakeJudge(name="ok-1"),
            _FakeJudge(name="bad", raise_exc=True),
            _FakeJudge(name="ok-2"),
        ]
        runner = JudgeRunner(max_concurrent_per_tenant=4)
        runner._persist = AsyncMock()  # type: ignore[method-assign]

        results = await runner.run_for_event(_FakeEvent(), judges)
        names = sorted(s.judge_name for s in results)
        assert names == ["ok-1", "ok-2"], (
            "C-1 regression: a raising judge blocked the others"
        )

    @pytest.mark.asyncio
    async def test_semaphore_caps_fanout(self) -> None:
        """With max_concurrent_per_tenant=2 and 4 judges × 100ms,
        total time is ~200ms (two waves of 2), not 100ms."""
        from eden.llmops.judges.runner import JudgeRunner

        judges = [_FakeJudge(name=f"j{i}", delay_s=0.1) for i in range(4)]
        runner = JudgeRunner(max_concurrent_per_tenant=2)
        runner._persist = AsyncMock()  # type: ignore[method-assign]

        t0 = time.monotonic()
        results = await runner.run_for_event(_FakeEvent(), judges)
        elapsed = time.monotonic() - t0

        assert len(results) == 4
        # Two parallel waves × 100ms = ~200ms.
        # Must be > 0.15s (sequential is 0.4s, so cap is working).
        assert elapsed >= 0.15, (
            "C-1 regression: semaphore did not cap fan-out"
        )
        # And under the sequential bound — proves gather is used.
        assert elapsed < 0.35, (
            f"C-1 regression: capped run took {elapsed:.3f}s "
            f"(should be ~0.2s with cap=2)"
        )

    @pytest.mark.asyncio
    async def test_empty_judge_list_returns_empty(self) -> None:
        from eden.llmops.judges.runner import JudgeRunner

        runner = JudgeRunner()
        runner._persist = AsyncMock()  # type: ignore[method-assign]
        results = await runner.run_for_event(_FakeEvent(), [])
        assert results == []


# ─── C-2: Judges API requires org membership ─────────────────────


def _make_judges_app(
    *,
    member_org_id: str | None = "org-A",
) -> TestClient:
    """Build a TestClient for the judges router with overridable
    ``require_org_member`` so we can simulate in-org vs cross-org."""

    from eden.api.routes import judges as judges_routes

    app = FastAPI()
    app.include_router(judges_routes.router)

    # Stub require_org_member: succeeds iff path org_id == member_org_id.
    async def _fake_require_org_member(
        x_org_id: str | None = None,
        payload: dict | None = None,
    ) -> dict:
        # Match the real ``require_org_member`` signature so FastAPI
        # doesn't try to bind the path's org_id as a query param.
        if member_org_id is None:
            raise HTTPException(
                status_code=403,
                detail="Not a member of this organization",
            )
        return {"id": member_org_id, "role": "owner"}

    # Stub postgres (no real DB hit).
    class _StubPG:
        async def fetch(self, *a, **k):
            return []

        async def fetchrow(self, *a, **k):
            return None

        async def fetchval(self, *a, **k):
            return 0

        async def execute(self, *a, **k):
            return None

    async def _fake_get_postgres_client():
        return _StubPG()

    app.dependency_overrides[judges_routes.get_current_user] = lambda: {
        "user_id": "u-1", "email": "x@y.z",
    }
    app.dependency_overrides[judges_routes.require_org_member] = (
        _fake_require_org_member
    )

    # Patch _fetch_events_for_trace at the module level.
    judges_routes._fetch_events_for_trace = AsyncMock(return_value=[])

    # Patch get_judge_registry + get_postgres_client module-globals.
    with patch.object(
        judges_routes, "get_judge_registry",
        return_value=MagicMock(all=lambda: [], get=lambda n: None),
    ), patch(
        "eden.storage.postgres.get_postgres_client",
        _fake_get_postgres_client,
    ):
        # Yield inside the patch context so the overrides see it.
        yield TestClient(app)


class TestC2JudgesApiRequiresOrgMember:
    """Pre-fix: any authenticated user could read or run judges on
    any org's traces. Post-fix: the path's org_id is checked."""

    def test_run_requires_org_membership(self) -> None:
        """A user authenticated to org-A calling /orgs/org-B/...
        is rejected with 403."""
        from eden.api.routes import judges as judges_routes

        app = FastAPI()
        app.include_router(judges_routes.router)

        async def _fail_require_org_member(
            x_org_id: str | None = None,
            payload: dict | None = None,
        ) -> dict:
            # Match require_org_member's real signature so FastAPI
            # doesn't bind path/query params.
            raise HTTPException(403, "Not a member of this organization")

        app.dependency_overrides[judges_routes.get_current_user] = lambda: {
            "user_id": "u-1", "email": "x@y.z",
        }
        app.dependency_overrides[judges_routes.require_org_member] = (
            _fail_require_org_member
        )
        with patch.object(
            judges_routes, "get_judge_registry",
            return_value=MagicMock(all=lambda: []),
        ):
            client = TestClient(app)
            r = client.post(
                "/orgs/org-B/observability/judges/run",
                json={"trace_id": "tr-1", "sync": True},
            )
            assert r.status_code == 403, (
                f"C-2 regression: /run allowed cross-org access: "
                f"{r.status_code} {r.text}"
            )

    def test_list_requires_org_membership(self) -> None:
        from eden.api.routes import judges as judges_routes

        app = FastAPI()
        app.include_router(judges_routes.router)

        async def _fail_require_org_member(
            x_org_id: str | None = None,
            payload: dict | None = None,
        ) -> dict:
            # Match require_org_member's real signature so FastAPI
            # doesn't bind path/query params.
            raise HTTPException(403, "Not a member of this organization")

        app.dependency_overrides[judges_routes.get_current_user] = lambda: {
            "user_id": "u-1", "email": "x@y.z",
        }
        app.dependency_overrides[judges_routes.require_org_member] = (
            _fail_require_org_member
        )
        client = TestClient(app)
        r = client.get("/orgs/org-B/observability/judges")
        assert r.status_code == 403, (
            f"C-2 regression: GET / allowed cross-org: {r.status_code}"
        )

    def test_get_by_id_requires_org_membership(self) -> None:
        from eden.api.routes import judges as judges_routes

        app = FastAPI()
        app.include_router(judges_routes.router)

        async def _fail_require_org_member(
            x_org_id: str | None = None,
            payload: dict | None = None,
        ) -> dict:
            # Match require_org_member's real signature so FastAPI
            # doesn't bind path/query params.
            raise HTTPException(403, "Not a member of this organization")

        app.dependency_overrides[judges_routes.get_current_user] = lambda: {
            "user_id": "u-1", "email": "x@y.z",
        }
        app.dependency_overrides[judges_routes.require_org_member] = (
            _fail_require_org_member
        )
        client = TestClient(app)
        r = client.get("/orgs/org-B/observability/judges/abc-123")
        assert r.status_code == 403, (
            f"C-2 regression: GET /{{id}} allowed cross-org: "
            f"{r.status_code}"
        )

    def test_route_depends_on_require_org_member(self) -> None:
        """Static check: the route declarations include
        ``Depends(require_org_member)``."""
        from eden.api.routes import judges as judges_routes

        app = FastAPI()
        app.include_router(judges_routes.router)
        # Check the runtime dependency tree.
        # FastAPI stores the dependant tree per route.
        any_check = False
        for route in app.routes:
            if not hasattr(route, "dependant"):
                continue
            for dep in route.dependant.dependencies:
                if dep.call is judges_routes.require_org_member:
                    any_check = True
                    break
        assert any_check, (
            "C-2 regression: no judges route uses require_org_member"
        )


# ─── C-3: Intelligence routers require org membership ─────────────


_INTEL_ROUTERS = [
    "intelligence_user",
    "intelligence_code_change",
    "intelligence_governance",
    "intelligence_cost",
    "intelligence_eval",
    "intelligence_memory",
    "intelligence_agents",
]


class TestC3IntelligenceRbac:
    """Six routers mounted ``get_current_user`` only at the
    router-level. Post-fix: each requires ``require_org_member``
    so cross-org access is 403."""

    @pytest.mark.parametrize("router_module", _INTEL_ROUTERS)
    def test_router_depends_on_require_org_member(
        self, router_module: str,
    ) -> None:
        """Static check: the router's dependency tree includes
        ``require_org_member``."""
        from eden.api.deps import require_org_member
        from eden.api.routes import judges as judges_routes

        mod = __import__(
            f"eden.api.routes.{router_module}", fromlist=["router"],
        )
        app = FastAPI()
        app.include_router(mod.router)

        any_check = False
        for route in app.routes:
            if not hasattr(route, "dependant"):
                continue
            # Walk the dependant tree (router-level deps are
            # attached as dependencies of the route's dependant).
            stack = [route.dependant]
            while stack:
                d = stack.pop()
                stack.extend(d.dependencies)
                if d.call is require_org_member:
                    any_check = True
                    break
            if any_check:
                break
        assert any_check, (
            f"C-3 regression: {router_module} has no route guarded "
            f"by require_org_member"
        )

    def test_cross_org_request_returns_403(self) -> None:
        """End-to-end: hit /orgs/org-B/intelligence/user/... as
        a user authenticated to org-A → 403."""
        from eden.api.deps import require_org_member
        from eden.api.routes import intelligence_user

        app = FastAPI()
        app.include_router(intelligence_user.router)

        async def _fail_member(
            x_org_id: str | None = None,
            payload: dict | None = None,
        ) -> dict:
            # Match require_org_member's real signature so FastAPI
            # doesn't bind path/query params.
            raise HTTPException(403, "Not a member of this organization")

        app.dependency_overrides[require_org_member] = _fail_member
        app.dependency_overrides[intelligence_user.get_current_user] = (
            lambda: {"user_id": "u-1", "email": "x@y.z"}
        )
        # Disable the feature-flag dep so we don't need to set env.
        from eden.api.deps import require_feature_flag
        async def _no_flag(*a, **k):
            return True
        app.dependency_overrides[require_feature_flag] = _no_flag

        client = TestClient(app)
        # A GET that exists on the router (no auth-failure precedence).
        r = client.get(
            "/orgs/org-B/intelligence/user/goals?user_id=u-1"
        )
        assert r.status_code == 403, (
            f"C-3 regression: cross-org allowed on user route: "
            f"{r.status_code} {r.text}"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
