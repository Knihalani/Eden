"""Token-savings honesty tests for the optimization routes.

Data-integrity audit 2026-08: ``compression_ratio`` and
``coalesced_requests`` were permanently hardcoded to ``1.0`` / ``0``
as placeholders. Neither stat is tracked anywhere (the gateway
coalescer keeps no totals; nothing measures prompt compression), so
the contract is now: ``None`` means "not tracked" — never an
invented number.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from eden.api.routes.optimization import (
    TokenSavingsResponse,
    _empty_optimization_overview,
    get_token_savings,
)


class TestTokenSavingsHonesty:
    def test_untracked_fields_default_to_none(self) -> None:
        resp = TokenSavingsResponse(
            tokens_saved=10, estimated_cost_saved_cents=0.1
        )
        assert resp.compression_ratio is None
        assert resp.coalesced_requests is None

    def test_empty_overview_does_not_fabricate_savings(self) -> None:
        overview = _empty_optimization_overview("org_x", days=7)
        assert overview.savings.compression_ratio is None
        assert overview.savings.coalesced_requests is None

    @pytest.mark.asyncio
    async def test_savings_route_reports_untracked_as_none(self) -> None:
        router = MagicMock()
        router.get_stats.return_value = {"tokens_saved": 1000}
        with patch(
            "eden.api.routes.optimization._get_model_router",
            return_value=router,
        ):
            resp = await get_token_savings(
                org_id="org_x", user={}, _check_billing_view={}
            )
        assert resp.tokens_saved == 1000
        assert resp.estimated_cost_saved_cents == pytest.approx(8.85)
        assert resp.compression_ratio is None
        assert resp.coalesced_requests is None
