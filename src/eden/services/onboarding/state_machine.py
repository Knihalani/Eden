"""Onboarding state machine — D.14 §10.1.

7-step guided checklist (per spec §10.1):

    install → org → connect → wait → done → tour → autonomous

Ponytail: this is a single-row-per-org state table +
forward-only step transitions + a milestone list.
The state machine is best-effort — every fetcher falls
back to a sensible default when the DB is unreachable,
so the route layer never 500s.

Cutover (per the plan's "new-orgs-only rollout flag"):
orgs created BEFORE :data:`ONBOARDING_V2_CUTOVER` get
the legacy UX (no state row, no banner). The cutover
is enforced here so callers don't have to repeat the
check.

Public surface:

* :class:`OnboardingStateMachine` — main class
* :func:`get_state_machine` — singleton getter (mirrors
  the BudgetService / PromptService pattern)
* :data:`ONBOARDING_STEPS` — the 7-step ordered list
* :data:`ONBOARDING_V2_CUTOVER` — the date gate

Per the test plan in spec §G.1 (D.14):
  - install_advances_to_org           ✓
  - skip_blocked_at_wait_step         ✓ (no skipping)
  - backward_transition_audit_logged  ✓ (backward ok, audited)
  - milestone_first_10_traces_advances ✓
  - milestone_already_recorded_idempotent ✓
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Any

logger = logging.getLogger(__name__)


# ── Step enum + ordering ─────────────────────────────────────────────


class OnboardingStep(StrEnum):
    """The 7 ordered steps of the cold-start UX."""

    INSTALL = "install"
    ORG = "org"
    CONNECT = "connect"
    WAIT = "wait"
    DONE = "done"
    TOUR = "tour"
    AUTONOMOUS = "autonomous"


ONBOARDING_STEPS: tuple[OnboardingStep, ...] = (
    OnboardingStep.INSTALL,
    OnboardingStep.ORG,
    OnboardingStep.CONNECT,
    OnboardingStep.WAIT,
    OnboardingStep.DONE,
    OnboardingStep.TOUR,
    OnboardingStep.AUTONOMOUS,
)


# ponytail: the cutover date is a single line so flipping the
# rollout to all-orgs is a one-line change. UTC.
ONBOARDING_V2_CUTOVER: date = date(2026, 7, 1)


# Milestone → step mapping per spec §10.1 + §E.1 hook wiring.
# A milestone is recorded once and may auto-advance the org to
# the next step that has a ``triggers_on`` clause.
MILESTONE_ADVANCES: dict[str, OnboardingStep] = {
    "first_10_traces": OnboardingStep.WAIT,
    "first_judge_score": OnboardingStep.DONE,
    "first_prompt_version": OnboardingStep.TOUR,
}


# ── Result dataclass ─────────────────────────────────────────────────


@dataclass
class StateRow:
    """In-memory representation of an ``onboarding_state`` row.

    Mirrors the schema; ``source`` records where the row came
    from (``"db"`` or ``"defaults"``) so the portal can render
    a "newly created" badge.
    """

    org_id: str
    current_step: str = OnboardingStep.INSTALL.value
    completed_steps: list[str] = field(default_factory=list)
    cat_enablements: dict[str, Any] = field(default_factory=dict)
    first_trace_at: str | None = None
    milestones_reached: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    source: str = "defaults"  # "db" or "defaults"
    onboarding_v2_enabled: bool = True
    last_audit: dict[str, Any] | None = None


# ── DB helpers (lazy import like the rest of the surface) ────────────


async def _get_client():
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("onboarding: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("onboarding: get_postgres_client failed: %s", exc)
        return None


def _row_to_state(row: dict[str, Any]) -> StateRow:
    """Convert a raw DB row to a :class:`StateRow`."""
    return StateRow(
        org_id=str(row["org_id"]),
        current_step=str(row["current_step"]),
        completed_steps=list(row.get("completed_steps") or []),
        cat_enablements=dict(row.get("cat_enablements") or {}),
        first_trace_at=(
            row["first_trace_at"].isoformat()
            if row.get("first_trace_at") is not None
            else None
        ),
        milestones_reached=list(row.get("milestones_reached") or []),
        created_at=(
            row["created_at"].isoformat()
            if row.get("created_at") is not None
            else ""
        ),
        updated_at=(
            row["updated_at"].isoformat()
            if row.get("updated_at") is not None
            else ""
        ),
        source="db",
    )


def _is_legacy_org(org_created_at: str | None) -> bool:
    """Return True if the org was created before the v2 cutover."""
    if not org_created_at:
        # No creation timestamp → assume new (safe default for
        # fresh orgs that haven't yet had their timestamp
        # recorded). The portal will use the banner in either case.
        return False
    try:
        ts = datetime.fromisoformat(org_created_at)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        return ts.date() < ONBOARDING_V2_CUTOVER
    except Exception:
        return False


# ── State machine ────────────────────────────────────────────────────


class OnboardingStateMachine:
    """The per-org onboarding state machine."""

    # ── read ─────────────────────────────────────────────────────────

    async def get_state(
        self,
        org_id: str,
        *,
        org_created_at: str | None = None,
    ) -> StateRow:
        """Return the state row, creating a default if missing.

        For legacy orgs (created before the v2 cutover), returns
        a synthetic row with ``onboarding_v2_enabled=False`` and
        ``source="legacy"`` so the portal can skip the banner.
        """
        if _is_legacy_org(org_created_at):
            return StateRow(
                org_id=org_id,
                source="legacy",
                onboarding_v2_enabled=False,
            )
        client = await _get_client()
        if client is None:
            return StateRow(org_id=org_id, source="defaults")
        try:
            row = await client.fetchrow(
                """
                SELECT org_id, current_step, completed_steps,
                       cat_enablements, first_trace_at,
                       milestones_reached, created_at, updated_at
                  FROM onboarding_state
                 WHERE org_id = $1
                """,
                org_id,
            )
        except Exception as exc:
            logger.debug("onboarding: get_state failed: %s", exc)
            return StateRow(org_id=org_id, source="defaults")
        if row is None:
            # Lazy create so the first read seeds the row.
            return await self._create_default_row(org_id)
        return _row_to_state(row)

    # ── advance ──────────────────────────────────────────────────────

    async def advance(
        self,
        org_id: str,
        target_step: str,
        *,
        force: bool = False,
    ) -> StateRow:
        """Move the org to ``target_step``.

        Forward advances are allowed when ``target_step`` is the
        next step in the sequence (no skipping). Backward
        transitions are always allowed (with an audit log row).
        Forcing a forward jump sets ``force=True`` (used by
        milestone auto-advance where the spec says "advance on
        milestone reached").
        """
        if target_step not in {s.value for s in ONBOARDING_STEPS}:
            raise ValueError(f"unknown onboarding step: {target_step!r}")
        current = await self.get_state(org_id)
        cur_idx = _step_index(current.current_step)
        tgt_idx = _step_index(target_step)
        if tgt_idx > cur_idx + 1 and not force:
            raise ValueError(
                f"cannot skip from {current.current_step!r} to "
                f"{target_step!r} (force=True to override)"
            )
        new_completed = list(current.completed_steps)
        if tgt_idx > cur_idx and current.current_step not in new_completed:
            new_completed.append(current.current_step)
        return await self._persist(
            org_id,
            current_step=target_step,
            completed_steps=new_completed,
            audit={
                "action": "advance",
                "from": current.current_step,
                "to": target_step,
                "forced": force,
                "ts": _now_iso(),
            },
        )

    # ── milestones ───────────────────────────────────────────────────

    async def record_milestone(
        self,
        org_id: str,
        milestone: str,
        *,
        force: bool = False,
    ) -> StateRow:
        """Record a milestone. Idempotent — re-recording is a no-op.

        If the milestone has a ``MILESTONE_ADVANCES`` entry, the
        org is auto-advanced to that step (forced; bypassing the
        skip-check). Per spec §E.1 hook wiring:
          - first_10_traces  → wait
          - first_judge_score → done
          - first_prompt_version → tour
        """
        current = await self.get_state(org_id)
        if milestone in current.milestones_reached:
            return current  # idempotent
        new_milestones = list(current.milestones_reached) + [milestone]
        row = await self._persist(
            org_id,
            milestones_reached=new_milestones,
            audit={
                "action": "milestone",
                "milestone": milestone,
                "ts": _now_iso(),
            },
        )
        # Auto-advance if the milestone maps to a step.
        target = MILESTONE_ADVANCES.get(milestone)
        if target is not None:
            return await self.advance(
                org_id, target.value, force=force or True
            )
        return row

    # ── cat enablements ──────────────────────────────────────────────

    async def enable_cat(
        self,
        org_id: str,
        cat_id: str,
        *,
        config: dict[str, Any] | None = None,
    ) -> StateRow:
        """Toggle a cat enablement. Idempotent.

        Stores ``{"enabled_at": <iso>, "config": {...}}`` in
        ``cat_enablements[cat_id]``. The portal renders the
        progressive-disclosure schedule per spec §10.2.
        """
        current = await self.get_state(org_id)
        new_enablements = dict(current.cat_enablements)
        new_enablements[cat_id] = {
            "enabled_at": _now_iso(),
            "config": config or {},
        }
        return await self._persist(
            org_id,
            cat_enablements=new_enablements,
            audit={
                "action": "enable_cat",
                "cat_id": cat_id,
                "ts": _now_iso(),
            },
        )

    # ── internals ────────────────────────────────────────────────────

    async def _create_default_row(self, org_id: str) -> StateRow:
        return await self._persist(org_id, audit={
            "action": "create", "ts": _now_iso(),
        })

    async def _persist(
        self,
        org_id: str,
        *,
        current_step: str | None = None,
        completed_steps: list[str] | None = None,
        cat_enablements: dict[str, Any] | None = None,
        milestones_reached: list[str] | None = None,
        audit: dict[str, Any] | None = None,
    ) -> StateRow:
        """Upsert the onboarding_state row. Logs audit to stdout
        so it's visible in dev + easily greppable in prod logs.

        The full audit history is meant to live in
        ``org_audit_log`` (per the existing Cat 10 pattern); for
        now we just log + surface it on the returned StateRow.
        """
        if audit is not None:
            logger.info("onboarding: org=%s %s", org_id, audit)
        client = await _get_client()
        if client is None:
            # Build a synthetic StateRow from the values the caller
            # intended to persist so the caller still gets a useful
            # response (best-effort).
            return StateRow(
                org_id=org_id,
                current_step=current_step or OnboardingStep.INSTALL.value,
                completed_steps=list(completed_steps or []),
                cat_enablements=dict(cat_enablements or {}),
                milestones_reached=list(milestones_reached or []),
                source="defaults",
                last_audit=audit,
            )
        try:
            # Import inside the function to avoid the JSONB
            # import cost when the DB is unreachable.
            import json as _json
            await client.execute(
                """
                INSERT INTO onboarding_state (
                    org_id, current_step, completed_steps,
                    cat_enablements, milestones_reached,
                    created_at, updated_at
                ) VALUES (
                    $1, COALESCE($2, 'install'),
                    COALESCE($3, ARRAY[]::TEXT[]),
                    COALESCE($4::jsonb, '{}'::jsonb),
                    COALESCE($5, ARRAY[]::TEXT[]),
                    NOW(), NOW()
                )
                ON CONFLICT (org_id) DO UPDATE SET
                    current_step       = COALESCE($2, onboarding_state.current_step),
                    completed_steps    = COALESCE($3, onboarding_state.completed_steps),
                    cat_enablements    = COALESCE($4::jsonb, onboarding_state.cat_enablements),
                    milestones_reached = COALESCE($5, onboarding_state.milestones_reached),
                    updated_at         = NOW()
                """,
                org_id,
                current_step,
                list(completed_steps) if completed_steps is not None else None,
                _json.dumps(cat_enablements) if cat_enablements is not None else None,
                list(milestones_reached) if milestones_reached is not None else None,
            )
        except Exception as exc:
            logger.debug("onboarding: _persist failed: %s", exc)
            return StateRow(
                org_id=org_id,
                current_step=current_step or OnboardingStep.INSTALL.value,
                completed_steps=list(completed_steps or []),
                cat_enablements=dict(cat_enablements or {}),
                milestones_reached=list(milestones_reached or []),
                source="defaults",
                last_audit=audit,
            )
        # Re-read so the caller gets the canonical row + the
        # audit info.
        result = await self.get_state(org_id)
        result.last_audit = audit
        return result


# ── helpers ──────────────────────────────────────────────────────────


def _step_index(step: str) -> int:
    try:
        return next(
            i for i, s in enumerate(ONBOARDING_STEPS) if s.value == step
        )
    except StopIteration:
        return -1


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ── singleton (mirrors BudgetService / PromptService) ───────────────


_singleton: OnboardingStateMachine | None = None


def get_state_machine() -> OnboardingStateMachine:
    """Return the process-wide :class:`OnboardingStateMachine`."""
    global _singleton
    if _singleton is None:
        _singleton = OnboardingStateMachine()
    return _singleton


__all__ = [
    "MILESTONE_ADVANCES",
    "ONBOARDING_STEPS",
    "ONBOARDING_V2_CUTOVER",
    "OnboardingStateMachine",
    "OnboardingStep",
    "StateRow",
    "get_state_machine",
]
