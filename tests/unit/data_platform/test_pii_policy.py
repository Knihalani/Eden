"""Tests for PIIMasker with per-tenant policy (Phase 7.3a)."""

import sys

import pytest

sys.path.insert(0, "src")

from eden.data_platform.pii import PIIMasker, PIIMaskingError, PIIPolicy


def test_default_masker_masks_email():
    masker = PIIMasker()
    out = masker.mask("Contact alice@example.com please")
    assert "[EMAIL_REDACTED]" in out


def test_policy_can_disable_a_category():
    """Disabling a category means its pattern is not applied."""
    policy = PIIPolicy(
        enabled_categories={"phone", "ssn"},  # no email
    )
    masker = PIIMasker(policy=policy)
    out = masker.mask("alice@example.com and 555-123-4567")
    # Email not masked
    assert "alice@example.com" in out
    # Phone IS masked
    assert "[PHONE_REDACTED]" in out


def test_policy_can_add_extra_redact_keys():
    """Extra keys get added to the sensitive-key set."""
    policy = PIIPolicy(redact_keys_extra={"internal_token"})
    masker = PIIMasker(policy=policy)
    out = masker.mask({"internal_token": "abc123", "name": "alice"})
    assert out["internal_token"] == "[INTERNAL_TOKEN_REDACTED]"
    assert out["name"] == "alice"


def test_fail_closed_raises_on_credential():
    """When fail_closed_on_credentials=True and a credential is
    detected, mask() raises PIIMaskingError."""
    policy = PIIPolicy(fail_closed_on_credentials=True)
    masker = PIIMasker(policy=policy)
    # Bearer eyJ (a JWT)
    with pytest.raises(PIIMaskingError):
        masker.mask("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature")


def test_fail_closed_off_does_not_raise():
    """When fail_closed_on_credentials=False, the credential is
    simply redacted — no exception."""
    policy = PIIPolicy(fail_closed_on_credentials=False)
    masker = PIIMasker(policy=policy)
    out = masker.mask("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig")
    # The JWT is masked
    assert "[JWT_REDACTED]" in out


def test_policy_from_db_row():
    """PIIPolicy.from_db_row accepts a Postgres row dict."""
    row = {
        "enabled_categories": ["email", "phone"],
        "disabled_categories": ["ssn"],
        "fail_closed_on_credentials": True,
        "redact_keys_extra": ["internal_token"],
    }
    policy = PIIPolicy.from_db_row(row)
    assert policy.enabled_categories == {"email", "phone"}
    assert policy.disabled_categories == {"ssn"}
    assert policy.fail_closed_on_credentials is True
    assert "internal_token" in policy.redact_keys_extra
    # active = enabled - disabled
    assert "email" in policy.active_categories
    assert "ssn" not in policy.active_categories


def test_credential_categories_subset():
    """credential_categories is the intersection of active + known
    credential categories."""
    policy = PIIPolicy(
        enabled_categories={"email", "jwt", "api_key"},
    )
    creds = policy.credential_categories
    assert "jwt" in creds
    assert "api_key" in creds
    assert "email" not in creds
