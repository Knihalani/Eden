"""Unit tests for the AUDN protocol (src/eden/kb/shared/audit.py).

These tests lock in the contract for the Archivist's KB write protocol —
particularly the distinction between UPDATE (newer evidence, replace) and
CONFLICT (mutually exclusive facts, requires resolution).
"""

from unittest.mock import MagicMock

import pytest

from eden.kb.shared.audit import (
    AUDNAction,
    AUDNResult,
    apply_audn,
    evaluate_audn,
)


# ─────────────────────────────────────────────────────────────────────────────
# evaluate_audn
# ─────────────────────────────────────────────────────────────────────────────


def test_evaluate_no_existing_returns_add():
    """No matching subject → ADD."""
    result = evaluate_audn(
        {"name": "gym", "entity_type": "framework"},
        existing=[],
    )
    assert result.action == AUDNAction.ADD
    assert "gym" in result.reason
    assert result.conflicting_entry is None


def test_evaluate_no_subject_key_returns_add():
    """Missing subject key → ADD (defensive default)."""
    result = evaluate_audn(
        {"entity_type": "framework"},
        existing=[{"name": "gym", "entity_type": "framework"}],
    )
    assert result.action == AUDNAction.ADD


def test_evaluate_contradiction_entity_type_returns_conflict():
    """Same name, different entity_type → CONFLICT (locks in Bug 1 fix).

    This test would have failed before the fix because the enum did not
    contain CONFLICT and the evaluator returned UPDATE.
    """
    proposed = {"name": "gym", "entity_type": "framework", "recorded_at": "2026-06-01"}
    existing = [
        {"name": "gym", "entity_type": "skill", "recorded_at": "2026-05-01", "id": "old-1"}
    ]
    result = evaluate_audn(proposed, existing)
    assert result.action == AUDNAction.CONFLICT
    assert result.conflicting_entry is existing[0]


def test_evaluate_contradiction_edge_type_returns_conflict():
    """Different edge_type on same subject also triggers CONFLICT."""
    proposed = {"name": "x", "edge_type": "USES", "recorded_at": "2026-06-01"}
    existing = [{"name": "x", "edge_type": "DEPENDS_ON", "recorded_at": "2026-05-01"}]
    result = evaluate_audn(proposed, existing)
    assert result.action == AUDNAction.CONFLICT


def test_evaluate_contradiction_category_returns_conflict():
    """Different category on same subject also triggers CONFLICT."""
    proposed = {"name": "x", "category": "skill", "recorded_at": "2026-06-01"}
    existing = [{"name": "x", "category": "exploit", "recorded_at": "2026-05-01"}]
    result = evaluate_audn(proposed, existing)
    assert result.action == AUDNAction.CONFLICT


def test_evaluate_temporal_upgrade_with_new_info_returns_update():
    """Newer timestamp + new property → UPDATE."""
    proposed = {
        "name": "gym",
        "entity_type": "framework",
        "properties": {"version": "0.29"},
        "recorded_at": "2026-06-01",
    }
    existing = [
        {
            "name": "gym",
            "entity_type": "framework",
            "properties": {"version": "0.28"},
            "recorded_at": "2026-05-01",
        }
    ]
    result = evaluate_audn(proposed, existing)
    assert result.action == AUDNAction.UPDATE


def test_evaluate_temporal_upgrade_without_new_info_returns_none():
    """Newer timestamp but no new info → NONE (skip write)."""
    proposed = {
        "name": "gym",
        "entity_type": "framework",
        "properties": {"version": "0.28"},
        "recorded_at": "2026-06-01",
    }
    existing = [
        {
            "name": "gym",
            "entity_type": "framework",
            "properties": {"version": "0.28"},
            "recorded_at": "2026-05-01",
        }
    ]
    result = evaluate_audn(proposed, existing)
    assert result.action == AUDNAction.NONE


def test_evaluate_duplicate_returns_none():
    """Same content, no newer timestamp → NONE."""
    proposed = {
        "name": "gym",
        "entity_type": "framework",
        "recorded_at": "2026-05-01",
    }
    existing = [
        {
            "name": "gym",
            "entity_type": "framework",
            "recorded_at": "2026-05-01",
        }
    ]
    result = evaluate_audn(proposed, existing)
    assert result.action == AUDNAction.NONE


def test_evaluate_brand_new_key_in_proposed_is_new_information():
    """Lock in Bug 4 fix: a key in proposed that doesn't exist in existing
    is still 'new information' (proposed adds fields existing lacks)."""
    from eden.kb.shared.audit import _has_new_information

    assert (
        _has_new_information(
            {"properties": {"v": 1}, "description": "x"},
            {"properties": {"v": 1}},
        )
        is True
    )
    assert (
        _has_new_information(
            {"properties": {"v": 1}},
            {"properties": {"v": 1}},
        )
        is False
    )


# ─────────────────────────────────────────────────────────────────────────────
# apply_audn
# ─────────────────────────────────────────────────────────────────────────────


def test_apply_audn_add_calls_insert():
    client = MagicMock()
    client.insert.return_value = True
    result = apply_audn(client, "skills", {"id": "x"}, AUDNResult(AUDNAction.ADD, "new"))
    assert result is True
    client.insert.assert_called_once()


def test_apply_audn_update_calls_update():
    client = MagicMock()
    client.update.return_value = True
    payload = {"id": "x"}
    result = apply_audn(
        client,
        "skills",
        payload,
        AUDNResult(AUDNAction.UPDATE, "newer"),
    )
    assert result is True
    client.update.assert_called_once()


def test_apply_audn_delete_calls_delete_with_id():
    client = MagicMock()
    client.delete.return_value = True
    result = apply_audn(
        client,
        "skills",
        {"id": "abc"},
        AUDNResult(AUDNAction.DELETE, "superseded"),
    )
    assert result is True
    client.delete.assert_called_once_with("skills", "abc")


def test_apply_audn_conflict_does_not_write():
    """CONFLICT requires resolution — apply_audn must NOT auto-write."""
    client = MagicMock()
    result = apply_audn(
        client,
        "skills",
        {"id": "x"},
        AUDNResult(AUDNAction.CONFLICT, "contradiction", conflicting_entry={"id": "y"}),
    )
    assert result is False
    client.insert.assert_not_called()
    client.update.assert_not_called()
    client.delete.assert_not_called()


def test_apply_audn_none_returns_false_without_writes():
    client = MagicMock()
    result = apply_audn(client, "skills", {"id": "x"}, AUDNResult(AUDNAction.NONE, "dup"))
    assert result is False
    client.insert.assert_not_called()
    client.update.assert_not_called()


# ─────────────────────────────────────────────────────────────────────────────
# Enum surface — locks the 5-value contract from ROADMAP.md
# ─────────────────────────────────────────────────────────────────────────────


def test_audn_action_has_five_values():
    names = {a.name for a in AUDNAction}
    assert names == {"ADD", "UPDATE", "DELETE", "NONE", "CONFLICT"}
