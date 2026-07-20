"""Claim installation request validation + authorize oauth_state merge."""

from __future__ import annotations

import inspect

import pytest
from pydantic import ValidationError

from eden.api.routes import github
from eden.api.routes.github import ClaimInstallationRequest


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


def test_github_authorize_merges_oauth_state_on_conflict():
    """Existing orgs must get a fresh oauth_state without wiping user ids."""
    src = inspect.getsource(github.github_authorize)
    assert "completed_by_users = $2::jsonb" in src
    assert "completed_by_users = onboarding_state.completed_by_users" not in src
    assert '"oauth_state"' in src or "'oauth_state'" in src
    assert "oauth_state" in src
    assert 'isinstance(entry, dict) and "oauth_state" in entry' in src
