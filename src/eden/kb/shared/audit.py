from typing import Any, cast
"""AUDN protocol for Knowledge Base writes.

AUDN = Add / Update / Delete / None
Determines how to handle proposed KB writes based on existing entries.
"""

import logging
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class AUDNAction(Enum):
    """Possible actions for KB writes."""
    ADD = "ADD"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    NONE = "NONE"
    CONFLICT = "CONFLICT"


@dataclass
class AUDNResult:
    """Result of AUDN evaluation."""
    action: AUDNAction
    reason: str
    conflicting_entry: dict | None = None


def evaluate_audn(
    proposed: dict,
    existing: list[dict],
    subject_key: str = "name",
    timestamp_key: str = "recorded_at",
) -> AUDNResult:
    """Evaluate the appropriate AUDN action for a proposed write.

    Args:
        proposed: The proposed new entry
        existing: List of existing entries to check against
        subject_key: Key to identify the subject (e.g., 'name', 'id')
        timestamp_key: Key for the timestamp comparison

    Returns:
        AUDNResult with the recommended action and reason
    """
    subject = proposed.get(subject_key)
    if not subject:
        return AUDNResult(
            action=AUDNAction.ADD,
            reason=f"No subject key '{subject_key}' found, adding new entry"
        )

    # Find entries with matching subject
    matching = [e for e in existing if e.get(subject_key) == subject]

    if not matching:
        return AUDNResult(
            action=AUDNAction.ADD,
            reason=f"No existing entry for '{subject}', adding new"
        )

    # Check for contradictions
    for existing_entry in matching:
        if _contradicts(proposed, existing_entry):
            return AUDNResult(
                action=AUDNAction.CONFLICT,
                reason="Contradiction detected with existing entry",
                conflicting_entry=existing_entry,
            )

    # Check temporal ordering
    proposed_time = proposed.get(timestamp_key)
    existing_time = max(e.get(timestamp_key, "") for e in matching)

    if proposed_time and existing_time and proposed_time > existing_time:
        # Check if there's actual new information
        if _has_new_information(proposed, matching[0]):
            return AUDNResult(
                action=AUDNAction.UPDATE,
                reason=f"Newer timestamp and new information for '{subject}'"
            )
        else:
            return AUDNResult(
                action=AUDNAction.NONE,
                reason=f"No new information in update for '{subject}'"
            )

    # Check if proposed is duplicate
    if _is_duplicate(proposed, matching[0]):
        return AUDNResult(
            action=AUDNAction.NONE,
            reason=f"Duplicate entry for '{subject}'"
        )

    return AUDNResult(
        action=AUDNAction.UPDATE,
        reason=f"Updated information for '{subject}'"
    )


def _contradicts(a: dict, b: dict) -> bool:
    """Check if two entries contradict each other.

    Two entries contradict when they have the same subject but mutually
    exclusive properties (e.g., same entity_id but different entity_type,
    or same entity_id/user but different edge_type).
    """
    # Key fields that should be consistent for a given subject
    contradictory_keys = ["entity_type", "edge_type", "category"]
    return any(key in a and key in b and a[key] != b[key] for key in contradictory_keys)


def _has_new_information(proposed: dict, existing: dict) -> bool:
    """Check if proposed entry has meaningfully new information.

    A proposed key counts as "new information" if:
      - it's not present in existing, OR
      - it is present but the value differs.
    """
    relevant_keys = ["properties", "description", "embedding"]
    for key in relevant_keys:
        if key not in proposed:
            continue
        if key not in existing:
            return True  # brand-new key in proposed
        if proposed[key] != existing[key]:
            return True
    return False


def _is_duplicate(a: dict, b: dict) -> bool:
    """Check if two entries are duplicates."""
    exclude_keys = {"id", "created_at", "updated_at", "recorded_at", "invalid_at"}
    a_filtered = {k: v for k, v in a.items() if k not in exclude_keys}
    b_filtered = {k: v for k, v in b.items() if k not in exclude_keys}
    return a_filtered == b_filtered


def apply_audn(
    client: Any,
    collection: str,
    proposed: dict,
    audn_result: AUDNResult,
) -> bool:
    """Apply the AUDN action to the KB.

    Args:
        client: The KB client for the layer
        collection: Collection/table name
        proposed: The proposed entry
        audn_result: The AUDN evaluation result

    Returns:
        True if write was applied
    """
    if audn_result.action == AUDNAction.ADD:
        return cast(bool, client.insert(collection, proposed))
    elif audn_result.action == AUDNAction.UPDATE:
        return cast(bool, client.update(collection, proposed))
    elif audn_result.action == AUDNAction.DELETE:
        return cast(bool, client.delete(collection, proposed.get("id")))
    else:  # NONE
        return False
