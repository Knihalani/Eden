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


# ── PIIPolicy.mode (tri-state) ──────────────────────────────────────


class TestPIIPolicyMode:
    """The ``mode`` field is the preferred knob for the
    "designed to use the PII" case. It subsumes the boolean +
    category fields so customers think in one term."""

    def test_default_mode_is_redact(self):
        p = PIIPolicy()
        assert p.mode == "redact"
        assert p.fail_closed_on_credentials is False

    def test_mode_off_disables_all_categories(self):
        """``mode="off"`` is the documented "system designed to use
        the PII" case — the masker should run with zero active
        categories so no regex matches."""
        p = PIIPolicy(mode="off")
        assert p.mode == "off"
        assert p.enabled_categories == set()
        assert p.active_categories == set()
        assert p.fail_closed_on_credentials is False

    def test_mode_off_means_masker_runs_no_patterns(self):
        """End-to-end: a PIIMasker with mode="off" returns the input
        unchanged regardless of what PII is in it."""
        p = PIIPolicy(mode="off")
        masker = PIIMasker(policy=p)
        out = masker.mask("alice@example.com and 415-555-1234")
        # Both the email and the phone pass through unchanged.
        assert "alice@example.com" in out
        assert "415-555-1234" in out

    def test_mode_fail_closed_sets_fail_closed_flag(self):
        p = PIIPolicy(mode="fail_closed")
        assert p.mode == "fail_closed"
        assert p.fail_closed_on_credentials is True

    def test_invalid_mode_raises(self):
        with pytest.raises(ValueError):
            PIIPolicy(mode="nonsense")

    def test_from_db_row_with_mode_column(self):
        """When the row carries an explicit ``mode`` column (post-079
        migration), it's used directly."""
        row = {
            "mode": "off",
            "enabled_categories": list(_DEFAULT_CATEGORIES),
            "disabled_categories": [],
            "fail_closed_on_credentials": False,
        }
        p = PIIPolicy.from_db_row(row)
        assert p.mode == "off"
        assert p.enabled_categories == set()

    def test_from_db_row_without_mode_column(self):
        """Pre-079 rows lack ``mode``. The fallback must derive the
        right value from the legacy fields so existing tenants see
        no behaviour change."""
        # fail_closed row -> fail_closed
        row = {
            "enabled_categories": list(_DEFAULT_CATEGORIES),
            "disabled_categories": [],
            "fail_closed_on_credentials": True,
        }
        p = PIIPolicy.from_db_row(row)
        assert p.mode == "fail_closed"
        # Empty enabled_categories -> off (interpreted as "no mask")
        row = {
            "enabled_categories": [],
            "disabled_categories": [],
            "fail_closed_on_credentials": False,
        }
        p = PIIPolicy.from_db_row(row)
        assert p.mode == "off"
        # Default row -> redact
        row = {
            "enabled_categories": list(_DEFAULT_CATEGORIES),
            "disabled_categories": [],
            "fail_closed_on_credentials": False,
        }
        p = PIIPolicy.from_db_row(row)
        assert p.mode == "redact"

    def test_disabled_categories_excluded_from_active(self):
        """A category in ``disabled_categories`` is excluded even
        when it's in ``enabled_categories``."""
        p = PIIPolicy(
            enabled_categories={"email", "phone"},
            disabled_categories={"email"},
        )
        assert "email" not in p.active_categories
        assert "phone" in p.active_categories

    def test_active_categories_used_by_masker(self):
        """End-to-end: a category in ``disabled_categories`` is
        skipped by the masker even when the pattern matches."""
        p = PIIPolicy(
            enabled_categories={"email", "phone"},
            disabled_categories={"email"},
        )
        masker = PIIMasker(policy=p)
        out = masker.mask("alice@example.com and 555-123-4567")
        # Email disabled — passes through.
        assert "alice@example.com" in out
        # Phone enabled — masked.
        assert "[PHONE_REDACTED]" in out


from eden.data_platform.pii import _DEFAULT_CATEGORIES
