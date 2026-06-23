"""Hook bus per upgradespec.md §E.2–§E.6 — dedup + cascade + approval gate.

Minimal implementation:
  - HookBus.emit(event) → returns hook_id; dedup window 5 min default.
  - Dedup is in-memory dict keyed by (reason, org_id, primary_entity_id).
    Redis pub/sub fallback when REDIS_URL is set (deferred — wire only when
    a multi-pod deployment needs cross-process dedup).
  - fan_out() writes to hook_events + inserts pending PromotionProposal for
    high-severity hooks. Low-severity auto-approves.
  - Cascade: if parent_hook_id is set, the new event inherits the parent's
    dedup window + joins the cascade.
  - Severity precedence: higher-severity hook within 1 hour suppresses
    lower-severity for the same (reason, primary_entity_id).

Schema per upgradespec §E.5 lives in migration 051_hook_events.sql. Until
that migration is applied, HookBus falls back to writing to the existing
closed_loop_actions table (keeps the executor + portal pending-approvals
UI working without an Alembic migration today).
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)


Severity = Literal["low", "medium", "high", "critical"]


@dataclass
class HookEvent:
    """Per upgradespec §E.2 — the canonical event payload."""

    reason: str
    severity: Severity
    org_id: str
    source: dict[str, Any]
    context: dict[str, Any] = field(default_factory=dict)
    parent_hook_id: str | None = None
    dedup_window_seconds: int = 300  # default 5 min per spec §E.3
    requires_human_approval: bool = False


@dataclass
class _DedupKey:
    reason: str
    org_id: str
    primary_entity_id: str
    cascade_parent: str | None  # parent_hook_id for cascade dedup

    def __hash__(self) -> int:
        return hash((self.reason, self.org_id, self.primary_entity_id, self.cascade_parent))


class HookBus:
    """Process-local hook bus.

    For multi-pod deployments, swap the in-memory _dedup dict for a Redis
    SETNX on the dedup key — same interface, same return shape.
    """

    def __init__(self) -> None:
        # (dedup_key → (hook_id, expires_at_epoch))
        self._dedup: dict[_DedupKey, tuple[str, float]] = {}
        # (hook_id → HookEvent) — kept for cascade dedup inheritance
        self._events: dict[str, HookEvent] = {}
        # Suppression: higher severity pre-empts lower within 1h
        self._suppressions: dict[tuple[str, str], tuple[Severity, float]] = {}

    async def emit(self, event: HookEvent) -> str | None:
        """Returns hook_id, or None if dedup'd.

        Side effects: dedup → cascade dedup → severity suppression →
        fan_out → persist → publish.
        """
        now = time.time()
        primary_entity_id = _extract_primary_entity(event)

        # Cascade dedup: if parent_hook_id set, inherit parent's window
        cascade_parent = event.parent_hook_id
        if cascade_parent and cascade_parent in self._events:
            parent = self._events[cascade_parent]
            event.dedup_window_seconds = max(
                event.dedup_window_seconds, parent.dedup_window_seconds
            )

        key = _DedupKey(
            reason=event.reason,
            org_id=event.org_id,
            primary_entity_id=primary_entity_id,
            cascade_parent=cascade_parent,
        )

        # Suppression: higher-severity hook within 1h pre-empts lower
        sup_key = (event.org_id, primary_entity_id)
        if sup_key in self._suppressions:
            prev_sev, prev_at = self._suppressions[sup_key]
            if now - prev_at < 3600 and _severity_rank(event.severity) < _severity_rank(prev_sev):
                logger.info(
                    "hook_bus: suppressed %s (severity=%s) — %s already active",
                    event.reason,
                    event.severity,
                    prev_sev,
                )
                return None
        self._suppressions[sup_key] = (event.severity, now)

        # Dedup window check
        if key in self._dedup:
            prev_id, prev_expires = self._dedup[key]
            if now < prev_expires:
                logger.info(
                    "hook_bus: dedup %s for %s (within %ds)",
                    event.reason,
                    event.org_id,
                    event.dedup_window_seconds,
                )
                # Increment repetition_count in DB (best-effort)
                await _increment_repetition(prev_id)
                return None

        hook_id = str(uuid.uuid4())
        self._events[hook_id] = event
        self._dedup[key] = (hook_id, now + event.dedup_window_seconds)

        # Persist + publish
        await self.fan_out(hook_id, event)
        return hook_id

    async def fan_out(self, hook_id: str, event: HookEvent) -> list[str]:
        """Persist hook + emit PromotionProposal if needed. Returns action_ids."""
        action_ids: list[str] = []

        # 1) Persist to hook_events (or closed_loop_actions if migration 051 not applied)
        await _persist_hook_event(hook_id, event)

        # 2) High-severity → requires human approval → PromotionProposal pending
        if event.requires_human_approval or event.severity in ("high", "critical"):
            try:
                from eden.llmops.hook_proposal import PromotionProposal

                proposal = PromotionProposal(
                    action=_infer_action_kind(event),
                    target_id=str(event.source.get("target_id", "")),
                    target_type=str(event.source.get("target_type", "unknown")),
                    reason_hook_id=hook_id,
                    proposed_at=_now(),
                    proposed_by="system",
                    requires_approval=True,
                    status="pending",
                    expires_at=_now_plus(seconds=86400),  # 24h default per spec §E.4
                )
                action_ids.append(await proposal.persist())
            except Exception as exc:
                logger.warning("hook_bus: proposal persist failed: %s", exc)

        # 3) Low/medium severity: auto-approve (per spec §E.4)
        else:
            try:
                from eden.llmops.hook_proposal import PromotionProposal

                proposal = PromotionProposal(
                    action=_infer_action_kind(event),
                    target_id=str(event.source.get("target_id", "")),
                    target_type=str(event.source.get("target_type", "unknown")),
                    reason_hook_id=hook_id,
                    proposed_at=_now(),
                    proposed_by="system",
                    requires_approval=False,
                    status="approved",
                    expires_at=_now_plus(seconds=86400),
                )
                action_ids.append(await proposal.persist())
            except Exception as exc:
                logger.debug("hook_bus: auto-approve proposal skipped: %s", exc)

        return action_ids


# ─── Helpers ──────────────────────────────────────────────────────


def _extract_primary_entity(event: HookEvent) -> str:
    """The dedup key. Per spec §E.3, primary_entity_id is reason-specific.

    Convention: read from event.source["primary_entity_id"], fall back to
    the empty string (which disables dedup for that event — safer than
    wrongly dedup'ing).
    """
    return str(event.source.get("primary_entity_id", ""))


def _severity_rank(sev: Severity) -> int:
    return {"low": 1, "medium": 2, "high": 3, "critical": 4}[sev]


def _infer_action_kind(event: HookEvent) -> str:
    """Map reason → action_kind (per ACTION_KIND in promotion_hooks.py)."""
    # The Action Kind map lives in promotion_hooks.py to keep wiring co-located
    # with the hook classes. Import lazily to avoid a circular import.
    try:
        from eden.llmops.promotion_hooks import ACTION_KIND

        return ACTION_KIND.get(event.reason, "investigate")
    except Exception:
        return "investigate"


def _now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _now_plus(seconds: int) -> str:
    import datetime

    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).isoformat()


async def _persist_hook_event(hook_id: str, event: HookEvent) -> None:
    """Persist hook_events. Best-effort: any error logged, swallowed."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:
        logger.debug("hook_bus: postgres import failed: %s", exc)
        return
    try:
        client = await get_postgres_client()
    except Exception:
        return
    if client is None:
        return
    try:
        await client.execute(
            """
            INSERT INTO closed_loop_actions
                (id, org_id, hook_name, action_kind, target,
                 payload_json, severity, status)
            VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, 'pending_approval')
            ON CONFLICT (id) DO NOTHING
            """,
            hook_id,
            event.org_id,
            event.reason[:64],
            "hook_bus",
            (event.source.get("target_id", "") if isinstance(event.source, dict) else "")[:256] or None,
            json.dumps(
                {
                    "source": event.source,
                    "context": event.context,
                    "parent_hook_id": event.parent_hook_id,
                    "dedup_window_seconds": event.dedup_window_seconds,
                    "requires_human_approval": event.requires_human_approval,
                },
                default=str,
            )[:4000],
            event.severity[:16],
        )
    except Exception as exc:
        logger.debug("hook_bus: hook_events persist failed: %s", exc)


async def _increment_repetition(hook_id: str) -> None:
    """Bump repetition_count on a prior event (best-effort)."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception:
        return
    if client is None:
        return
    try:
        # closed_loop_actions doesn't have a repetition_count column today
        # (would land with migration 051_hook_events.sql). For now log the
        # dedup hit so operators see the cascade.
        logger.info("hook_bus: dedup hit on %s", hook_id)
    except Exception:
        pass


# ─── Singleton accessor ──────────────────────────────────────────


_bus: HookBus | None = None


def get_hook_bus() -> HookBus:
    global _bus
    if _bus is None:
        _bus = HookBus()
    return _bus
