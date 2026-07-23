"""Phase 2 — quota middleware headers cache.

``get_budget_status(org_id)`` must be called at most once per org
within the ``_HEADERS_CACHE_TTL_S`` window on the GET/HEAD
headers-only path — two GET dispatches for the same org within the
TTL should collapse into a single ``UsageService.get_budget_status``
call, mirroring the ``_tier_cache`` pattern in
``TenantRateLimitMiddleware``.
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _quota_enabled_settings():
    settings = MagicMock()
    settings.quota_enabled = True
    return settings


def _budget() -> dict:
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


async def _dispatch_get(mw, path: str = "/orgs/org-cache/agents") -> list[dict]:
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "method": "GET",
        "path": path,
        "raw_path": path.encode(),
        "headers": [(b"x-org-id", b"org-cache")],
        "query_string": b"",
    }
    sent: list = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        sent.append(msg)

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    mw.app = inner
    await mw(scope, receive, send)
    return sent


class TestQuotaHeadersCache:
    @pytest.mark.asyncio
    async def test_two_gets_same_org_within_ttl_call_get_budget_status_once(
        self,
    ) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        with patch(
            "eden.config.get_settings",
            return_value=_quota_enabled_settings(),
        ):
            mw = QuotaEnforcementMiddleware(MagicMock())
            call_count = {"n": 0}

            class _FakeService:
                async def get_budget_status(self, org_id):
                    call_count["n"] += 1
                    return _budget()

            mw._usage_service = _FakeService()

            sent1 = await _dispatch_get(mw)
            sent2 = await _dispatch_get(mw)

            assert call_count["n"] == 1

            for sent in (sent1, sent2):
                starts = [m for m in sent if m["type"] == "http.response.start"]
                assert starts
                header_map = {
                    k.decode("latin1"): v.decode("latin1")
                    for k, v in starts[0]["headers"]
                }
                assert header_map.get("x-quota-cost-used") == "0.1"

    @pytest.mark.asyncio
    async def test_cache_expires_after_ttl_and_refetches(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        call_count = {"n": 0}

        class _FakeService:
            async def get_budget_status(self, org_id):
                call_count["n"] += 1
                return _budget()

        mw._usage_service = _FakeService()

        await mw._build_quota_headers("org-ttl")
        assert call_count["n"] == 1

        # Still fresh — no refetch.
        await mw._build_quota_headers("org-ttl")
        assert call_count["n"] == 1

        # Backdate the cache entry past the TTL — must refetch.
        budget, headers, _expires = mw._headers_cache["org-ttl"]
        mw._headers_cache["org-ttl"] = (
            budget,
            headers,
            time.monotonic() - 1.0,
        )
        await mw._build_quota_headers("org-ttl")
        assert call_count["n"] == 2

    @pytest.mark.asyncio
    async def test_headers_cache_ttl_within_15_to_30s(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        assert 15.0 <= QuotaEnforcementMiddleware._HEADERS_CACHE_TTL_S <= 30.0

    @pytest.mark.asyncio
    async def test_different_orgs_do_not_share_cache_entry(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        call_count = {"n": 0}

        class _FakeService:
            async def get_budget_status(self, org_id):
                call_count["n"] += 1
                return _budget()

        mw._usage_service = _FakeService()

        await mw._build_quota_headers("org-a")
        await mw._build_quota_headers("org-b")
        assert call_count["n"] == 2

    @pytest.mark.asyncio
    async def test_mutating_hard_limit_enforcement_still_uses_live_or_fresh_snapshot(
        self,
    ) -> None:
        """Phase 2 must not weaken enforcement: a mutating request for an
        org already over its hard cap is still blocked even though the
        headers cache is warm."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        with patch(
            "eden.config.get_settings",
            return_value=_quota_enabled_settings(),
        ):
            mw = QuotaEnforcementMiddleware(MagicMock())

            over_cap = _budget()
            over_cap["cost_usd"] = {
                "used": 2.0,
                "soft_limit": 0.7,
                "hard_limit": 1.0,
                "status": "hard_exceeded",
                "percentage": 200.0,
            }

            class _FakeService:
                async def get_budget_status(self, org_id):
                    return over_cap

            mw._usage_service = _FakeService()

            # Warm the headers cache exactly like a prior GET would.
            await mw._build_quota_headers("org-over-cache")

            inner_called = {"n": 0}

            async def inner(scope, receive, send):
                inner_called["n"] += 1
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"", "more_body": False})

            mw.app = inner
            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.0"},
                "method": "POST",
                "path": "/orgs/org-over-cache/sidebar-prefs",
                "raw_path": b"/orgs/org-over-cache/sidebar-prefs",
                "headers": [(b"x-org-id", b"org-over-cache")],
                "query_string": b"",
            }
            sent: list = []

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(msg):
                sent.append(msg)

            await mw(scope, receive, send)
            starts = [m for m in sent if m["type"] == "http.response.start"]
            assert starts and starts[0]["status"] == 429
            assert inner_called["n"] == 0
