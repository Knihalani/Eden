"""Tests for per-org GitHub provider factory (Cat 23 Phase 2A)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.providers.factory import (
    get_pr_provider_for_org,
    get_repo_provider_for_org,
    resolve_active_repo_id,
)
from eden.providers.pr import GitHubPRProvider, LocalPRProvider
from eden.providers.repo import GitHubRepoProvider, LocalRepoProvider


@pytest.mark.asyncio
async def test_pr_provider_force_local() -> None:
    with patch.dict("os.environ", {"EDEN_PR_PROVIDER": "local"}, clear=False):
        provider = await get_pr_provider_for_org("org_a")
    assert isinstance(provider, LocalPRProvider)


@pytest.mark.asyncio
async def test_repo_provider_force_local() -> None:
    with patch.dict("os.environ", {"EDEN_PR_PROVIDER": "local"}, clear=False):
        provider = await get_repo_provider_for_org("org_a")
    assert isinstance(provider, LocalRepoProvider)


@pytest.mark.asyncio
async def test_pr_provider_from_active_connection() -> None:
    conn = {
        "installation_id": "12345",
        "repo_full_name": "acme/agent-runner",
        "provider": "github",
        "id": "repo_1",
    }
    token = MagicMock()
    token.token = "ghs_test_token"
    with (
        patch.dict("os.environ", {"EDEN_PR_PROVIDER": ""}, clear=False),
        patch(
            "eden.providers.factory.active_repo_connection",
            AsyncMock(return_value=conn),
        ),
        patch(
            "eden.providers.factory._mint_installation_token",
            AsyncMock(return_value="ghs_test_token"),
        ),
    ):
        provider = await get_pr_provider_for_org("org_a")
    assert isinstance(provider, GitHubPRProvider)
    assert provider.repo == "acme/agent-runner"
    assert provider.token == "ghs_test_token"


@pytest.mark.asyncio
async def test_repo_provider_from_active_connection() -> None:
    conn = {
        "installation_id": "99",
        "repo_full_name": "acme/widgets",
        "provider": "github",
        "id": "repo_2",
    }
    with (
        patch.dict("os.environ", {"EDEN_PR_PROVIDER": ""}, clear=False),
        patch(
            "eden.providers.factory.active_repo_connection",
            AsyncMock(return_value=conn),
        ),
        patch(
            "eden.providers.factory._mint_installation_token",
            AsyncMock(return_value="ghs_repo_token"),
        ),
    ):
        provider = await get_repo_provider_for_org("org_b")
    assert isinstance(provider, GitHubRepoProvider)
    assert provider.repo == "acme/widgets"
    assert provider.token == "ghs_repo_token"


@pytest.mark.asyncio
async def test_pr_provider_falls_back_without_connection() -> None:
    env = {
        k: v
        for k, v in __import__("os").environ.items()
        if k not in ("EDEN_PR_PROVIDER", "EDEN_GITHUB_TOKEN", "EDEN_GITHUB_REPO")
    }
    with (
        patch.dict("os.environ", env, clear=True),
        patch(
            "eden.providers.factory.active_repo_connection",
            AsyncMock(return_value=None),
        ),
    ):
        provider = await get_pr_provider_for_org("org_orphan")
    assert isinstance(provider, LocalPRProvider)


@pytest.mark.asyncio
async def test_resolve_active_repo_id_prefers_connection_id() -> None:
    conn = {
        "id": "repo-conn-9",
        "repo_full_name": "acme/widgets",
        "installation_id": "1",
        "provider": "github",
    }
    with patch(
        "eden.providers.factory.active_repo_connection",
        AsyncMock(return_value=conn),
    ):
        assert await resolve_active_repo_id("org_a") == "repo-conn-9"


@pytest.mark.asyncio
async def test_resolve_active_repo_id_falls_back_to_full_name() -> None:
    conn = {
        "id": "",
        "repo_full_name": "acme/widgets",
        "installation_id": "1",
        "provider": "github",
    }
    with patch(
        "eden.providers.factory.active_repo_connection",
        AsyncMock(return_value=conn),
    ):
        assert await resolve_active_repo_id("org_a") == "acme/widgets"


@pytest.mark.asyncio
async def test_resolve_active_repo_id_none_without_connection() -> None:
    with patch(
        "eden.providers.factory.active_repo_connection",
        AsyncMock(return_value=None),
    ):
        assert await resolve_active_repo_id("org_a") is None
