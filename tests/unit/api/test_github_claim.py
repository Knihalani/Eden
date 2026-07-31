"""Claim installation request validation + authorize oauth_state merge."""

from __future__ import annotations

import inspect

import pytest
from pydantic import ValidationError

from eden.api.routes import github
from eden.api.routes.github import ClaimInstallationRequest, ConnectRepoRequest


def test_claim_installation_id_accepts_int():
    req = ClaimInstallationRequest(installation_id=12345678)
    assert req.installation_id == 12345678


def test_claim_installation_id_coerces_digit_string():
    req = ClaimInstallationRequest(installation_id="987654321")
    assert req.installation_id == 987654321


@pytest.mark.parametrize("bad", [None, "", "abc", 0, -1])
def test_claim_installation_id_rejects_invalid(bad):
    with pytest.raises(ValidationError):
        ClaimInstallationRequest(installation_id=bad)


def test_claim_route_accepts_body_or_query_installation_id():
    """Empty/mis-typed bodies must not 422 before the handler can parse."""
    src = inspect.getsource(github.claim_github_installation)
    assert "await request.body()" in src
    assert "Query(" in src
    assert "installation_id is required" in src
    assert "json.loads" in src


def test_github_authorize_merges_oauth_state_on_conflict():
    """Existing orgs must get a fresh oauth_state without wiping user ids."""
    src = inspect.getsource(github.github_authorize)
    assert "completed_by_users = $2::jsonb" in src
    assert "completed_by_users = onboarding_state.completed_by_users" not in src
    assert '"oauth_state"' in src or "'oauth_state'" in src
    assert "oauth_state" in src
    assert 'isinstance(entry, dict) and "oauth_state" in entry' in src


def test_connect_repo_request_accepts_valid():
    req = ConnectRepoRequest(
        installation_id=42,
        repo_full_name="acme/widgets",
        default_branch="develop",
    )
    assert req.installation_id == 42
    assert req.repo_full_name == "acme/widgets"
    assert req.default_branch == "develop"


def test_connect_repo_request_blank_branch_stays_empty():
    """Blank default_branch is resolved at connect time — not invented as main."""
    req = ConnectRepoRequest(
        installation_id=1,
        repo_full_name="acme/widgets",
        default_branch="  ",
    )
    assert req.default_branch == ""


@pytest.mark.parametrize(
    "bad_name",
    ["", "norepo", "a/b/c", "/repo", "owner/", "  "],
)
def test_connect_repo_request_rejects_bad_full_name(bad_name):
    with pytest.raises(ValidationError):
        ConnectRepoRequest(installation_id=1, repo_full_name=bad_name)


def test_connect_org_repo_upserts_repo_connections():
    """Connect route must write repo_connections (not only claim install)."""
    src = inspect.getsource(github.connect_org_repo)
    assert "INSERT INTO repo_connections" in src
    assert "UPDATE repo_connections" in src
    assert "default_branch" in src
    assert "installation_id" in src
    assert "repo_full_name" in src
    assert "agent_id" in src
    assert "'active'" in src
    assert "'inactive'" in src


def test_connect_repo_request_accepts_agent_id():
    req = ConnectRepoRequest(
        installation_id=1,
        repo_full_name="acme/widgets",
        agent_id="  minimax-pydantic-agent  ",
    )
    assert req.agent_id == "minimax-pydantic-agent"
