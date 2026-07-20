"""LP-10 — quota middleware fail-open / warm-snapshot.

Mutations must not 429 with "No recent quota snapshot" when the
cache is empty or stale. A successful header build (e.g. /auth/me)
must warm the cache for subsequent POSTs/PUTs.
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _quota_enabled_settings():
    settings = MagicMock()
    settings.quota_enabled = True
    return settings


def _under_cap_budget() -> dict:
    return {
        "cost_usd": {
            "used": 0.10,
            "soft_limit": 0.70,
            "hard_limit": 1.00,
            "status": "ok",
            "percentage": 10.0,
        },
        "tokens": {"used": 0, "soft_limit": 1, "hard_limit": 1, "status": "ok", "percentage": 0},
        "storage_mb": {"used": 0, "soft_limit": 1, "hard_limit": 1, "status": "ok", "percentage": 0},
        "sandbox_seconds": {"used": 0, "soft_limit": 1, "hard_limit": 1, "status": "ok", "percentage": 0},
        "plan_name": "org_free",
    }


class TestLp10FailOpen:
    def test_no_cache_does_not_block(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        blocked, detail = mw._cached_block_check("org-x", ["cost_usd"])
        assert blocked is False
        assert detail == ""
        assert "No recent quota snapshot" not in detail

    @pytest.mark.asyncio
    async def test_build_quota_headers_warms_cache(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        budget = _under_cap_budget()

        class _FakeService:
            async def get_budget_status(self, org_id):
                return budget

        mw._usage_service = _FakeService()
        headers = await mw._build_quota_headers("org-warm")
        assert "X-Quota-Cost-Used" in headers
        assert "org-warm" in mw._last_known_hard_limits
        blocked, _ = mw._cached_block_check("org-warm", ["cost_usd"])
        assert blocked is False

    @pytest.mark.asyncio
    async def test_dispatch_allows_mutation_with_empty_cache_live_ok(
        self,
    ) -> None:
        """Cold cache + live under-cap → request proceeds (no 429)."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        with patch(
            "eden.config.get_settings",
            return_value=_quota_enabled_settings(),
        ):
            inner_called = {"n": 0}

            async def inner(scope, receive, send):
                inner_called["n"] += 1
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"", "more_body": False})

            mw = QuotaEnforcementMiddleware(inner)
            mw._resolve_org_id = AsyncMock(return_value="org-cold")  # type: ignore[method-assign]
            mw._build_quota_headers = AsyncMock(return_value={})  # type: ignore[method-assign]
            mw._check_hard_limits = AsyncMock(return_value=(False, ""))  # type: ignore[method-assign]

            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.0"},
                "method": "PUT",
                "path": "/orgs/org-cold/sidebar-prefs",
                "raw_path": b"/orgs/org-cold/sidebar-prefs",
                "headers": [],
                "query_string": b"",
            }
            sent: list = []

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(msg):
                sent.append(msg)

            await mw(scope, receive, send)
            starts = [m for m in sent if m["type"] == "http.response.start"]
            assert starts and starts[0]["status"] != 429
            assert inner_called["n"] == 1
            mw._check_hard_limits.assert_awaited()

    @pytest.mark.asyncio
    async def test_live_fetch_failure_without_cache_fails_open(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())

        class _Boom:
            async def get_budget_status(self, org_id):
                raise RuntimeError("postgres down")

        mw._usage_service = _Boom()
        blocked, detail = await mw._check_hard_limits("org-x", ["cost_usd"])
        assert blocked is False
        assert detail == ""

    @pytest.mark.asyncio
    async def test_live_fetch_failure_with_fresh_over_cap_still_blocks(
        self,
    ) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        mw._record_hard_limits(
            "org-over",
            {
                "cost_usd": {
                    "used": 2.0,
                    "hard_limit": 1.0,
                    "status": "hard_exceeded",
                },
            },
        )

        class _Boom:
            async def get_budget_status(self, org_id):
                raise RuntimeError("postgres down")

        mw._usage_service = _Boom()
        blocked, detail = await mw._check_hard_limits("org-over", ["cost_usd"])
        assert blocked is True
        assert "cap" in detail.lower() or "fail-closed" in detail.lower()

    def test_stale_cache_age_helper(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        assert mw._budget_staleness("missing") is None
        mw._record_hard_limits(
            "org-age",
            {"cost_usd": {"used": 0, "hard_limit": 1.0, "status": "ok"}},
        )
        age = mw._budget_staleness("org-age")
        assert age is not None
        assert age < 1.0
        # Backdate past staleness limit — cached check must fail-open.
        ts, view = mw._last_known_hard_limits["org-age"]
        mw._last_known_hard_limits["org-age"] = (time.monotonic() - 90.0, view)
        blocked, _ = mw._cached_block_check("org-age", ["cost_usd"])
        assert blocked is False
