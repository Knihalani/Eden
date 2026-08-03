"""Closed-loop event model (F46)."""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


class EventType:
    """Loop event types (string constants — serialised into Redis)."""

    ISSUE_CREATED = "issue_created"
    TRIAGE_COMPLETED = "triage_completed"
    TRIAGE_FAILED = "triage_failed"
    HEAL_REQUESTED = "heal_requested"
    HEAL_EXECUTED = "heal_executed"
    HEAL_FAILED = "heal_failed"
    PATCH_PROPOSED = "patch_proposed"
    RECOMMENDED = "recommended"
    VERIFY_SCHEDULED = "verify_scheduled"
    VERIFY_PASSED = "verify_passed"
    VERIFY_FAILED = "verify_failed"
    ESCALATED_HUMAN = "escalated_human"


ALL_EVENT_TYPES = frozenset(
    v for k, v in vars(EventType).items() if not k.startswith("_") and isinstance(v, str)
)


@dataclass(slots=True)
class LoopEvent:
    """A single closed-loop event.

    ``ref`` is a stable secondary key (e.g. the issue fingerprint or an
    action id) used together with ``type`` + ``issue_id`` to build the
    idempotency key ``{issue_id}:{type}:{ref}``.
    """

    type: str
    org_id: str
    issue_id: str
    ref: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    ts: float = field(default_factory=time.time)

    def idempotency_key(self) -> str:
        return f"{self.issue_id}:{self.type}:{self.ref}"

    def to_fields(self) -> dict[str, str]:
        return {
            "event_id": self.event_id,
            "type": self.type,
            "org_id": self.org_id,
            "issue_id": self.issue_id,
            "ref": self.ref,
            "ts": str(self.ts),
            "payload": json.dumps(self.payload, default=str),
        }

    @classmethod
    def from_fields(cls, fields: dict[str, Any]) -> LoopEvent:
        def _dec(v: Any) -> str:
            return v.decode() if isinstance(v, bytes) else str(v)

        data = {
            (_dec(k)): _dec(v) for k, v in (fields or {}).items()
        }
        payload: dict[str, Any] = {}
        raw = data.get("payload")
        if raw:
            try:
                payload = json.loads(raw)
            except (TypeError, ValueError):
                payload = {}
        return cls(
            type=data.get("type", ""),
            org_id=data.get("org_id", ""),
            issue_id=data.get("issue_id", ""),
            ref=data.get("ref", ""),
            payload=payload,
            event_id=data.get("event_id", uuid.uuid4().hex),
            ts=float(data.get("ts") or time.time()),
        )
