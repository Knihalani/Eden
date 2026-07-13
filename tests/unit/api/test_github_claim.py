"""Claim installation request validation."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

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
