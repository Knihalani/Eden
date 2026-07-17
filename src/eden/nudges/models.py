"""F39 nudge object model."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

NudgeMode = Literal["shadow", "promoted", "archived"]
NudgeActionType = Literal[
    "system_append",
    "tool_block",
    "tool_rewrite",
    "subagent_hint",
    "inrun_rescue",
]


@dataclass
class Nudge:
    id: UUID
    org_id: str
    agent_id: str
    name: str
    trigger: dict[str, Any]
    action_type: NudgeActionType
    content: str
    mode: NudgeMode = "shadow"
    source_issue_id: UUID | None = None
    evidence: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Nudge:
        return cls(
            id=row["id"],
            org_id=str(row["org_id"]),
            agent_id=str(row["agent_id"]),
            name=str(row["name"]),
            trigger=dict(row.get("trigger") or {}),
            action_type=row["action_type"],
            content=str(row["content"]),
            mode=row.get("mode") or "shadow",
            source_issue_id=row.get("source_issue_id"),
            evidence=dict(row.get("evidence") or {}),
        )
