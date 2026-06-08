"""Unit tests for the marketplace models + state machine.

We don't try to hit the database here — the service layer is
covered by integration tests. These tests focus on the
Pydantic models and the pure-function helpers so the API
contract stays stable as the service grows.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from eden.marketplace.models import (
    EnvCardState,
    ForkRequest,
    QualityBand,
    SubmitRequest,
    _band_from_score,
)


# ────────────────────────────────────────────────────────────────────────
# Quality band derivation
# ────────────────────────────────────────────────────────────────────────


def test_quality_band_thresholds():
    assert _band_from_score(0.95) == QualityBand.HIGH
    assert _band_from_score(0.85) == QualityBand.HIGH
    assert _band_from_score(0.7) == QualityBand.MEDIUM
    assert _band_from_score(0.6) == QualityBand.MEDIUM
    assert _band_from_score(0.5) == QualityBand.LOW
    assert _band_from_score(0.0) == QualityBand.LOW


def test_quality_band_handles_none():
    assert _band_from_score(None) == QualityBand.LOW


# ────────────────────────────────────────────────────────────────────────
# SubmitRequest validation
# ────────────────────────────────────────────────────────────────────────


def _valid_submit_kwargs() -> dict:
    return {
        "spec_id": "00000000-0000-0000-0000-000000000001",
        "slug": "my-cool-env",
        "title": "My Cool Env",
        "summary": "A summary that is at least ten characters long",
        "category": "coding",
        "tags": ["python", "static-analysis"],
    }


def test_submit_request_accepts_minimal_valid_payload():
    req = SubmitRequest(**_valid_submit_kwargs())
    assert req.slug == "my-cool-env"
    assert req.license == "mit"  # default
    assert req.submit_for_review is False


def test_submit_request_rejects_invalid_slug():
    bad = _valid_submit_kwargs()
    bad["slug"] = "Invalid Slug With Spaces"
    with pytest.raises(ValidationError):
        SubmitRequest(**bad)


def test_submit_request_rejects_too_short_title():
    bad = _valid_submit_kwargs()
    bad["title"] = "ab"
    with pytest.raises(ValidationError):
        SubmitRequest(**bad)


def test_submit_request_rejects_too_many_tags():
    bad = _valid_submit_kwargs()
    bad["tags"] = [f"tag-{i}" for i in range(21)]
    with pytest.raises(ValidationError):
        SubmitRequest(**bad)


# ────────────────────────────────────────────────────────────────────────
# ForkRequest validation
# ────────────────────────────────────────────────────────────────────────


def test_fork_request_accepts_minimal_valid_payload():
    req = ForkRequest(slug="my-fork")
    assert req.slug == "my-fork"
    assert req.title is None
    assert req.summary is None


def test_fork_request_rejects_invalid_slug():
    with pytest.raises(ValidationError):
        ForkRequest(slug="My Fork")
    with pytest.raises(ValidationError):
        ForkRequest(slug="-leading-dash")


# ────────────────────────────────────────────────────────────────────────
# EnvCardState values
# ────────────────────────────────────────────────────────────────────────


def test_env_card_state_values_match_db_constraint():
    # The migration uses these exact strings as the CHECK constraint.
    expected = {"draft", "submitted", "in_review", "published", "archived", "retired"}
    actual = {state.value for state in EnvCardState}
    assert actual == expected
