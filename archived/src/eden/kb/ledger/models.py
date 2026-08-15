"""Ledger entry models."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class LedgerEntry:
    id: str
    org_id: str
    agent_id: str
    ledger_id: str
    chapter: str
    text: str
    citations: list[str] = field(default_factory=list)
    weight: float = 1.0
    source_ids: list[str] = field(default_factory=list)
    version: int = 1

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> LedgerEntry:
        citations = row.get("citations") or []
        source_ids = row.get("source_ids") or []
        return cls(
            id=str(row["id"]),
            org_id=str(row["org_id"]),
            agent_id=str(row["agent_id"]),
            ledger_id=str(row["ledger_id"]),
            chapter=str(row.get("chapter") or "general"),
            text=str(row.get("text") or ""),
            citations=list(citations) if isinstance(citations, list) else [],
            weight=float(row.get("weight") or 1.0),
            source_ids=list(source_ids) if isinstance(source_ids, list) else [],
            version=int(row.get("version") or 1),
        )
