"""FEAT-125 — portal guardrail kind/status normalisation."""

from __future__ import annotations

from eden.api.routes.portal import _map_guardrail_kind, _map_guardrail_status
from eden.guardrails.policy import VALID_POLICY_STATUSES, VALID_POLICY_TYPES


def test_map_guardrail_kind_passes_through_valid_policy_types() -> None:
    for kind in VALID_POLICY_TYPES:
        assert _map_guardrail_kind(kind) == kind


def test_map_guardrail_kind_normalises_legacy_labels() -> None:
    assert _map_guardrail_kind("pii_redaction") == "pii_redaction"
    assert _map_guardrail_kind("PII") == "pii_redaction"
    assert _map_guardrail_kind("content_policy") == "content_policy"
    assert _map_guardrail_kind("toxicity") == "content_policy"
    assert _map_guardrail_kind("tool_allowlist") == "content_policy"
    assert _map_guardrail_kind("custom") == "content_policy"
    assert _map_guardrail_kind("prompt_injection") == "prompt_injection"
    assert _map_guardrail_kind("judge_link") == "judge_link"


def test_map_guardrail_status_matches_portal_contract() -> None:
    assert _map_guardrail_status("active") == "active"
    assert _map_guardrail_status("enabled") == "active"
    assert _map_guardrail_status("shadow") == "shadow"
    assert _map_guardrail_status("dry_run") == "shadow"
    assert _map_guardrail_status("monitor") == "shadow"
    assert _map_guardrail_status("disabled") == "disabled"
    assert _map_guardrail_status("off") == "disabled"


def test_valid_policy_statuses_subset_of_portal_card_statuses() -> None:
    """Persisted statuses are a subset of what portal cards may return."""
    portal_statuses = {"active", "shadow", "disabled"}
    assert portal_statuses >= VALID_POLICY_STATUSES
