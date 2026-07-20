"""Regression tests for the July 2026 site-wide route redaction pass.

Four routes still echoed ``str(exc)`` in their 500 bodies before
the F-redact-jul06 fix:

- ``patterns.py::generate_env_for_pattern``  — INSERT jobs failure
- ``region.py::put_region``                  — UPDATE organizations failure
- ``retention_policy.py::put_retention_policy`` — INSERT retention failure
- ``pii_policy.py::put_pii_policy``          — INSERT pii_policy failure

Each leaked asyncpg table names, constraint names, and column
references. This file asserts that the 500 ``detail`` body now
contains only the curated fallback string.

The tests bypass the FastAPI auth deps by invoking the route
functions directly with the pre-resolved ``user`` kwarg (those are
``Depends(...)`` parameters the function itself doesn't dereference
in the failure path) and patching the ``require_org_permission``
import that lives inside the function body.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


# ---------------------------------------------------------------------------
# patterns.py — generate_env_for_pattern (retired)
# ---------------------------------------------------------------------------

def test_patterns_generate_env_route_removed():
    """generate-env was stripped with the env-gen product surface."""
    from eden.api.routes import patterns as patterns_route

    assert not hasattr(patterns_route, "generate_env_for_pattern")


# ---------------------------------------------------------------------------
# region.py — put_region
# ---------------------------------------------------------------------------

def test_region_put_region_redacts_db_error():
    from eden.api.routes import region as region_route

    exc = Exception(
        'asyncpg.exceptions.UndefinedColumnError: '
        'column "regions" of relation "organizations" does not exist'
    )
    fake_pg = AsyncMock()
    fake_pg.execute = AsyncMock(side_effect=exc)

    async def runner():
        with (
            patch.object(region_route, "require_org_permission", AsyncMock(return_value=None)),
            patch.object(region_route, "get_postgres_client", AsyncMock(return_value=fake_pg)),
        ):
            with pytest.raises(HTTPException) as ei:
                await region_route.put_region(
                    body=region_route.RegionIn(region="us"),
                    org_id="o",
                    user={"user_id": "u"},
                    payload={"sub": "u"},
                )
            assert ei.value.status_code == 503
            detail = ei.value.detail
            assert "organizations" not in detail
            assert "regions" not in detail

    asyncio.run(runner())


# ---------------------------------------------------------------------------
# retention_policy.py — put_retention_policy
# ---------------------------------------------------------------------------

def test_retention_put_retention_redacts_db_error():
    from eden.api.routes import retention_policy as rp_route

    exc = Exception(
        'asyncpg.exceptions.NotNullViolationError: '
        'null value in column "table_name" of relation '
        '"org_retention_policies" violates not-null constraint'
    )
    fake_pg = AsyncMock()
    fake_pg.execute = AsyncMock(side_effect=exc)

    async def runner():
        with (
            patch.object(rp_route, "require_org_permission", AsyncMock(return_value=None)),
            patch.object(rp_route, "get_postgres_client", AsyncMock(return_value=fake_pg)),
        ):
            with pytest.raises(HTTPException) as ei:
                await rp_route.put_retention_policy(
                    body=rp_route.RetentionPolicyIn(
                        table_name="events",
                        hot_days=7,
                        warm_days=30,
                        cold_days=90,
                        delete_days=365,
                        pii_scrub_after_days=30,
                        notes="",
                    ),
                    org_id="o",
                    user={"user_id": "u"},
                    payload={"sub": "u"},
                )
            assert ei.value.status_code == 503
            detail = ei.value.detail
            assert "org_retention_policies" not in detail
            assert "table_name" not in detail

    asyncio.run(runner())


# ---------------------------------------------------------------------------
# pii_policy.py — put_pii_policy
# ---------------------------------------------------------------------------

def test_pii_put_pii_redacts_db_error():
    from eden.api.routes import pii_policy as pii_route

    # Generic DB failure (not unique/FK/uuid) so the route maps to 503
    # and the detail body stays behind safe_detail.
    exc = Exception(
        'asyncpg.exceptions.UndefinedColumnError: '
        'column "bogus_col" of relation "org_pii_policies" does not exist'
    )
    fake_pg = AsyncMock()
    fake_pg.execute = AsyncMock(side_effect=exc)

    async def runner():
        with (
            patch.object(pii_route, "require_org_permission", AsyncMock(return_value=None)),
            patch.object(pii_route, "get_postgres_client", AsyncMock(return_value=fake_pg)),
            patch.object(pii_route, "invalidate_policy", MagicMock()),
        ):
            with pytest.raises(HTTPException) as ei:
                await pii_route.put_pii_policy(
                    body=pii_route.PIIPolicyIn(
                        enabled_categories=["email"],
                        disabled_categories=[],
                        fail_closed_on_credentials=True,
                        redact_keys_extra=[],
                        mode="redact",
                        notes="",
                    ),
                    org_id="o",
                    user={"user_id": "u"},
                    payload={"sub": "u"},
                )
            assert ei.value.status_code == 503
            detail = ei.value.detail
            assert "org_pii_policies" not in detail
            assert "bogus_col" not in detail

    asyncio.run(runner())
