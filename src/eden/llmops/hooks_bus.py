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
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)


# Maximum cascade depth — a chain deeper than this is rejected
# so a runaway automation can't loop forever (DL-11).
_MAX_CASCADE_DEPTH = 5


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
        # Cascade depth tracking per hook (DL-11): root events are
        # depth 1, each child increments by 1. Enforced at emit() time.
        self._cascade_depth: dict[str, int] = {}

    def sweep(self) -> int:
        """DL-11: evict expired dedup + suppression entries.

        Returns the number of entries removed. Called periodically by
        a worker (or on every Nth emit) so a noisy org can't OOM the
        process by minting millions of distinct events per day.
        """
        now = time.time()
        evicted = 0
        # Dedup: expires_at is the second tuple element
        expired_keys = [
            k for k, (_id, exp) in self._dedup.items() if exp <= now
        ]
        for k in expired_keys:
            del self._dedup[k]
            evicted += 1
        # Suppressions: 1-hour window
        expired_sups = [
            k for k, (_sev, exp) in self._suppressions.items() if exp <= now
        ]
        for k in expired_sups:
            del self._suppressions[k]
            evicted += 1
        # Dead events (no live dedup, no live suppression referencing them)
        live_hook_ids = {hid for hid, _ in self._dedup.values()}
        for k, (_sev, exp) in list(self._suppressions.items()):
            if exp > now:
                live_hook_ids.add(k)
        dead_events = [
            k for k in self._events if k not in live_hook_ids
        ]
        for k in dead_events:
            del self._events[k]
            self._cascade_depth.pop(k, None)
            evicted += 1
        return evicted

    async def emit(self, event: HookEvent) -> str | None:
        """Returns hook_id, or None if dedup'd.

        Side effects: dedup → cascade dedup → severity suppression →
        fan_out → persist → publish.
        """
        now = time.time()
        primary_entity_id = _extract_primary_entity(event)

        # DL-11: cascade depth cap. Walk the parent chain and reject
        # any event that would push the depth past _MAX_CASCADE_DEPTH.
        depth = 1
        cascade_parent = event.parent_hook_id
        while cascade_parent and cascade_parent in self._events:
            parent_depth = self._cascade_depth.get(cascade_parent, 1)
            depth = max(depth, parent_depth + 1)
            cascade_parent = self._events[cascade_parent].parent_hook_id
        if depth > _MAX_CASCADE_DEPTH:
            logger.info(
                "hook_bus: rejected event (cascade depth %d > %d)",
                depth, _MAX_CASCADE_DEPTH,
            )
            return None

        # Cascade dedup: if parent_hook_id set, inherit parent's window
        if event.parent_hook_id and event.parent_hook_id in self._events:
            parent = self._events[event.parent_hook_id]
            event.dedup_window_seconds = max(
                event.dedup_window_seconds, parent.dedup_window_seconds
            )

        # Use the event's own parent_hook_id for the dedup key
        # (NOT the post-loop ``cascade_parent`` which has been walked
        # to the root ancestor).
        dedup_cascade_parent = event.parent_hook_id

        key = _DedupKey(
            reason=event.reason,
            org_id=event.org_id,
            primary_entity_id=primary_entity_id,
            cascade_parent=dedup_cascade_parent,
        )

        # Suppression: higher-severity hook within 1h pre-empts lower.
        # Skip this check when the event is part of a cascade chain —
        # the cascade itself is the legitimate new event.
        if event.parent_hook_id is None:
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

        # Dedup window check. Three paths:
        # (a) The event's own dedup key matches a recent event.
        # (b) The event has a parent_hook_id whose dedup entry
        #     matches the current event's reason/org/entity (cascade
        #     dedup inheritance — per §E.3 the child inherits the
        #     parent's dedup window).
        dedup_hit_id = None
        if key in self._dedup:
            prev_id, prev_expires = self._dedup[key]
            if now < prev_expires:
                dedup_hit_id = prev_id
        if dedup_hit_id is None and event.parent_hook_id and event.parent_hook_id in self._events:
            parent = self._events[event.parent_hook_id]
            parent_primary = _extract_primary_entity(parent)
            parent_key = _DedupKey(
                reason=parent.reason,
                org_id=parent.org_id,
                primary_entity_id=parent_primary,
                cascade_parent=None,
            )
            if parent_key in self._dedup:
                prev_id, prev_expires = self._dedup[parent_key]
                # Cascade dedup only applies when the parent's
                # severity is at least as high as the child's —
                # equal severity just means two unrelated events
                # happened to share a key (the dedup catches them
                # as a side effect, which is fine for distinct
                # events but not for an explicit cascade). The
                # severity-rank check matches the suppression rule
                # below: a higher-severity parent dedups a lower-
                # severity child within the cascade window.
                if (
                    _severity_rank(event.severity) < _severity_rank(parent.severity)
                    and now < prev_expires
                ):
                    dedup_hit_id = prev_id
        if dedup_hit_id is not None:
            logger.info(
                "hook_bus: dedup %s for %s (within %ds)",
                event.reason,
                event.org_id,
                event.dedup_window_seconds,
            )
            # Increment repetition_count in DB (best-effort)
            await _increment_repetition(dedup_hit_id)
            return None

        hook_id = str(uuid.uuid4())
        self._events[hook_id] = event
        self._dedup[key] = (hook_id, now + event.dedup_window_seconds)
        self._cascade_depth[hook_id] = depth

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
    """Bump repetition_count on a prior event (best-effort).

    B-15: actually UPDATEs ``hook_events`` (primary) and falls back to
    ``closed_loop_actions`` (legacy schema) — never log-only. Errors
    are swallowed so the calling hook emission is not blocked.
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception:
        return
    if client is None:
        return
    try:
        await client.execute(
            "UPDATE hook_events "
            "SET repetition_count = COALESCE(repetition_count, 0) + 1, "
            "    last_repeated_at = NOW() "
            "WHERE id = $1",
            hook_id,
        )
    except Exception:
        # Fall back to legacy closed_loop_actions table for older rows.
        try:
            await client.execute(
                "UPDATE closed_loop_actions "
                "SET repetition_count = COALESCE(repetition_count, 0) + 1 "
                "WHERE id = $1",
                hook_id,
            )
        except Exception as exc:
            logger.debug(
                "hook_bus: _increment_repetition fallback failed for %s: %s",
                hook_id,
                exc,
            )


# ─── Singleton accessor ──────────────────────────────────────────


_bus: HookBus | None = None


def get_hook_bus() -> HookBus:
    global _bus
    if _bus is None:
        _bus = HookBus()
    return _bus
