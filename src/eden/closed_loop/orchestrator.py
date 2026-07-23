"""ClosedLoopOrchestrator (F46) — the loop's brain.

Consumes :class:`LoopEvent`s and drives the issue lifecycle by delegating
to existing services (triage F30, remediation N20/N21, verify, alerts
F47). Each handler advances the F46 state machine and emits the next
event so the loop is fully event-driven and idempotent.

Autonomy gating (N22, Wave 5) is applied in ``_decide_remediation`` /
``_gate`` — until then the default posture is *advisory* (recommend).
Remediation execution (heal/patch) and verification (Wave 6) are invoked
via lazy imports so this module stays import-safe as those land.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.closed_loop.event_bus import publish
from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.state_machine import apply_transition

logger = logging.getLogger(__name__)

# Heal action_types SelfHealer understands (fast-path autonomous heals).
_HEALABLE = {"rollback", "reweight", "cache_bust"}


class ClosedLoopOrchestrator:
    async def emit(self, event: LoopEvent) -> None:
        await publish(event)

    async def on_event(self, event: LoopEvent) -> None:
        handler = {
            EventType.ISSUE_CREATED: self._on_issue_created,
            EventType.TRIAGE_COMPLETED: self._on_triage_completed,
            EventType.HEAL_EXECUTED: self._on_heal_executed,
            EventType.VERIFY_PASSED: self._on_verify_passed,
            EventType.VERIFY_FAILED: self._on_verify_failed,
        }.get(event.type)
        if handler is None:
            logger.debug("orchestrator: no handler for %s", event.type)
            return
        await handler(event)

    # ── issue_created → triage + alert ──────────────────────────────

    async def _on_issue_created(self, event: LoopEvent) -> None:
        from eden.closed_loop.efficiency import AgentEfficiencyController
        from eden.issues.triage_agent import TriageAgent

        triage_result: dict[str, Any] | None = None
        try:
            ctrl = AgentEfficiencyController()
            allowed, reason = await ctrl.should_run_triage(
                event.org_id, event.issue_id, force=False
            )
            if not allowed and reason == "already_triaged":
                triage_result = await self._reload_triage(event)
            elif not allowed:
                logger.info(
                    "orchestrator: triage suppressed issue=%s reason=%s",
                    event.issue_id,
                    reason,
                )
                return
            else:
                res = await TriageAgent().triage(
                    event.org_id, event.issue_id
                )
                triage_result = (res or {}).get("data", {}).get("triage_result")
        except Exception as exc:
            logger.warning("orchestrator: triage failed: %s", exc)

        await apply_transition(
            event.org_id,
            event.issue_id,
            event_type=EventType.TRIAGE_COMPLETED,
            reason="auto-triage on issue_created",
            detail={"source": (triage_result or {}).get("source")},
        )
        await self._maybe_alert(event, triage_result)
        await self.emit(
            LoopEvent(
                type=EventType.TRIAGE_COMPLETED,
                org_id=event.org_id,
                issue_id=event.issue_id,
                ref=event.ref,
                payload={"triage_result": triage_result or {}},
            )
        )

    # ── triage_completed → recommend | heal | patch | human ─────────

    async def _on_triage_completed(self, event: LoopEvent) -> None:
        triage_result = event.payload.get("triage_result") or {}
        if not triage_result:
            triage_result = await self._reload_triage(event)

        decision = await self._decide_remediation(event, triage_result)
        logger.info(
            "orchestrator: issue=%s decision=%s", event.issue_id, decision
        )
        if decision == "heal":
            await self._request_heal(event, triage_result)
        elif decision == "patch":
            await self._request_patch(event, triage_result)
        elif decision == "human":
            await self._escalate_human(event, triage_result)
        # "recommend"/"observe" → stay triaged (advisory only).

    async def _on_heal_executed(self, event: LoopEvent) -> None:
        # Fix applied → move to verifying + schedule the verify check.
        await apply_transition(
            event.org_id,
            event.issue_id,
            event_type=EventType.HEAL_EXECUTED,
            reason="remediation executed",
            detail=event.payload,
        )
        await self._schedule_verify(event)

    async def _on_verify_passed(self, event: LoopEvent) -> None:
        await apply_transition(
            event.org_id,
            event.issue_id,
            event_type=EventType.VERIFY_PASSED,
            reason="verification passed",
            detail=event.payload,
        )
        await self._flywheel_on_resolved(event)

    async def _on_verify_failed(self, event: LoopEvent) -> None:
        await apply_transition(
            event.org_id,
            event.issue_id,
            event_type=EventType.VERIFY_FAILED,
            reason="verification failed",
            detail=event.payload,
        )
        await self._escalate_human(event, event.payload)

    # ── remediation decision (Wave 5 replaces with autonomy policy) ──

    async def _decide_remediation(
        self, event: LoopEvent, triage_result: dict[str, Any]
    ) -> str:
        """Choose recommend | heal | patch | human under the N22 policy.

        The autonomy engine is asked ``decide(policy, action)`` for the
        first suggested action; the verdict (allow / require_approval /
        deny) is audited, then translated into a loop decision. A P0 or
        an explicit auto-escalate always surfaces to a human.
        """
        from eden.closed_loop.playbook_router import enrich_triage_with_playbook

        triage_result = enrich_triage_with_playbook(triage_result)
        suggested = triage_result.get("suggested_actions") or []
        first_type = None
        for a in suggested:
            if isinstance(a, dict):
                first_type = a.get("action_type") or a.get("type")
                break

        wants_heal = first_type in _HEALABLE
        wants_patch = first_type in ("propose_patch", "patch", "code_change")

        # D3 playbook router — fill missing heal action from issue kind.
        if not wants_heal and not wants_patch:
            try:
                from eden.closed_loop.playbooks import resolve_playbook
                from eden.issues.repo import IssuesRepo

                issue = await IssuesRepo().get_issue(
                    event.org_id, event.issue_id
                )
                playbook = resolve_playbook(
                    issue.kind if issue else None, triage_result
                )
                if playbook in _HEALABLE:
                    wants_heal = True
                    first_type = playbook
                    triage_result = {
                        **triage_result,
                        "suggested_heal": playbook,
                        "playbook_source": "kind_router",
                    }
            except Exception as exc:
                logger.debug("orchestrator: playbook router failed: %s", exc)

        # N22 — effective maintenance mode (compliance override + budget
        # downgrade applied inside ``evaluate_mode``).
        mode = await self._gate(event, triage_result, first_type)
        escalate = bool(triage_result.get("auto_escalate") or _is_p0(triage_result))

        if escalate:
            return "human"

        if mode == "observe":
            return "human" if escalate else "recommend"

        if wants_heal or wants_patch:
            decision = await self._decide_action(event, first_type or "")
            if decision == "allow" and wants_heal:
                return "heal"
            if decision == "allow" and wants_patch:
                return "patch"
            if decision == "require_approval":
                # A pending action row already exists (recorded by the
                # hook); surface to a human when it's high severity.
                return "human" if escalate else "recommend"
            # deny → advisory only.
            return "human" if escalate else "recommend"

        return "human" if escalate else "recommend"

    async def _decide_action(self, event: LoopEvent, action_type: str) -> str:
        """Resolve the policy + return the audited decision for one action."""
        try:
            from eden.closed_loop.autonomy_policy import (
                audit,
                decide,
                resolve,
            )

            policy = await resolve(
                event.org_id, event.payload.get("agent_id")
            )
            verdict, reason, tier = decide(policy, action_type)
            await audit(
                event.org_id,
                agent_id=event.payload.get("agent_id"),
                action=action_type,
                tier=tier,
                decision=verdict,
                reason=reason,
            )
            return verdict
        except Exception as exc:
            logger.debug("orchestrator: policy decide failed: %s", exc)
            return "require_approval"

    async def _gate(
        self,
        event: LoopEvent,
        triage_result: dict[str, Any],
        action_type: str | None,
    ) -> str:
        """Return the effective maintenance mode
        (``observe``/``assisted``/``autonomous``) with the N22 compliance
        override + daily-budget downgrade applied. Safe default:
        ``assisted``."""
        try:
            from eden.closed_loop.autonomy_policy import (  # noqa: PLC0415
                evaluate_mode,
            )

            return await evaluate_mode(
                event.org_id,
                agent_id=event.payload.get("agent_id"),
                action_type=action_type,
                triage_result=triage_result,
            )
        except Exception:
            return "assisted"

    # ── remediation execution (Wave 6 fills heal/patch/verify) ──────

    async def _request_heal(
        self, event: LoopEvent, triage_result: dict[str, Any]
    ) -> None:
        from eden.closed_loop.playbooks import resolve_playbook

        action_type = resolve_playbook(None, triage_result) or ""
        for a in triage_result.get("suggested_actions") or []:
            if isinstance(a, dict):
                at = a.get("action_type") or a.get("type")
                if at in _HEALABLE:
                    action_type = at
                    break
        if action_type:
            verdict = await self._decide_action(event, action_type)
            if verdict != "allow":
                logger.info(
                    "orchestrator: heal blocked by N22 issue=%s action=%s verdict=%s",
                    event.issue_id,
                    action_type,
                    verdict,
                )
                # Surface denial to Improve cockpit via audit (already
                # written by _decide_action) + escalate when P0.
                return

        # Kill switch fail-closed before mutating.
        if action_type:
            try:
                from eden.llmops.feature_kills import is_autonomy_action_enabled

                if not await is_autonomy_action_enabled(
                    event.org_id, action_type
                ):
                    from eden.closed_loop.autonomy_policy import audit

                    await audit(
                        event.org_id,
                        agent_id=event.payload.get("agent_id"),
                        action=action_type,
                        tier="kill_switch",
                        decision="deny",
                        reason=f"kill switch disabled for {action_type}",
                    )
                    logger.info(
                        "orchestrator: heal kill-switched issue=%s action=%s",
                        event.issue_id,
                        action_type,
                    )
                    return
            except Exception as exc:
                logger.warning(
                    "orchestrator: kill switch check failed (fail-closed): %s",
                    exc,
                )
                return

        await apply_transition(
            event.org_id,
            event.issue_id,
            event_type=EventType.HEAL_REQUESTED,
            reason="autonomous heal requested",
            detail={"suggested": triage_result.get("suggested_actions")},
        )
        try:
            from eden.autonomous.investigation import SelfHealer

            healer = SelfHealer()
            heal_from_issue = getattr(healer, "heal_from_issue", None)
            if heal_from_issue is None:
                return
            result = await heal_from_issue(event.org_id, event.issue_id)
            if (result or {}).get("data", {}).get("status") in (
                "executed",
                "applied",
            ):
                await self.emit(
                    LoopEvent(
                        type=EventType.HEAL_EXECUTED,
                        org_id=event.org_id,
                        issue_id=event.issue_id,
                        ref=event.ref,
                        payload={"heal": result.get("data", {})},
                    )
                )
        except Exception as exc:
            logger.warning("orchestrator: heal failed: %s", exc)

    async def _request_patch(
        self, event: LoopEvent, triage_result: dict[str, Any]
    ) -> None:
        await apply_transition(
            event.org_id,
            event.issue_id,
            event_type=EventType.PATCH_PROPOSED,
            reason="autonomous patch proposed",
            detail={"suggested": triage_result.get("suggested_actions")},
        )
        try:
            from eden.closed_loop.efficiency import AgentEfficiencyController
            from eden.improvement.agent import request_sweep

            allowed, reason = await AgentEfficiencyController().should_run_patch(
                event.org_id, event.issue_id
            )
            if not allowed:
                logger.info(
                    "orchestrator: patch suppressed issue=%s reason=%s",
                    event.issue_id,
                    reason,
                )
                return
            await request_sweep(
                event.org_id,
                agent_id=event.payload.get("agent_id"),
                issue_id=event.issue_id,
            )
        except Exception as exc:
            logger.debug("orchestrator: improvement sweep unavailable: %s", exc)

    async def _schedule_verify(self, event: LoopEvent) -> None:
        try:
            from eden.closed_loop.verify import schedule_verify

            await schedule_verify(event.org_id, event.issue_id, ref=event.ref)
        except Exception as exc:
            logger.debug("orchestrator: verify scheduler unavailable: %s", exc)

    async def _escalate_human(
        self, event: LoopEvent, triage_result: dict[str, Any] | None
    ) -> None:
        await self.emit(
            LoopEvent(
                type=EventType.ESCALATED_HUMAN,
                org_id=event.org_id,
                issue_id=event.issue_id,
                ref=event.ref,
                payload={"triage_result": triage_result or {}},
            )
        )
        await self._maybe_alert(event, triage_result, human=True)

    async def _maybe_alert(
        self,
        event: LoopEvent,
        triage_result: dict[str, Any] | None,
        *,
        human: bool = False,
    ) -> None:
        # Sparse SendKit email alerts (P0/P1 / verify-failed / human).
        try:
            from eden.services.alert_email import send_issue_alert_email

            triage = triage_result or {}
            severity = str(
                triage.get("severity")
                or triage.get("priority")
                or getattr(event, "severity", None)
                or ""
            )
            if human:
                kind = "human_escalation"
            elif getattr(event, "type", None) and "verify" in str(
                getattr(event.type, "value", event.type)
            ).lower():
                kind = "verify_failed"
            else:
                kind = "issue_created"
            await send_issue_alert_email(
                org_id=event.org_id,
                event_kind=kind,
                issue_id=getattr(event, "issue_id", None),
                severity=severity,
                title=str(triage.get("title") or triage.get("summary") or kind),
                detail=str(triage.get("reason") or triage.get("summary") or ""),
                extra={"ref": getattr(event, "ref", None)},
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("orchestrator._maybe_alert email failed: %s", exc)

    async def _reload_triage(self, event: LoopEvent) -> dict[str, Any]:
        try:
            from eden.issues.repo import IssuesRepo

            issue = await IssuesRepo().get_issue(event.org_id, event.issue_id)
            return (issue.triage_result or {}) if issue else {}
        except Exception:
            return {}

    # ── G9: hook → loop bridge ──────────────────────────────────────

    def subscribe(self) -> None:
        """Bridge the promotion hooks into the loop (G9).

        Wraps ``IssueHook.on_issue_created`` so every created/regressed
        issue also emits an ``issue_created`` LoopEvent. Idempotent — a
        second call is a no-op.
        """
        try:
            from eden.llmops.promotion_hooks import get_issue_hook
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("orchestrator.subscribe: import failed: %s", exc)
            return
        hook = get_issue_hook()
        if getattr(hook, "_loop_wrapped", False):
            return
        original = hook.on_issue_created
        orch = self

        async def _wrapped(
            org_id: str,
            *,
            issue_id: str,
            fingerprint: str,
            kind: str,
            severity: str,
            title: str,
            regressed: bool = False,
            user_count: int | None = None,
            stumble_count: int | None = None,
        ) -> Any:
            action_id = await original(
                org_id,
                issue_id=issue_id,
                fingerprint=fingerprint,
                kind=kind,
                severity=severity,
                title=title,
                regressed=regressed,
                user_count=user_count,
                stumble_count=stumble_count,
            )
            try:
                await orch.emit(
                    LoopEvent(
                        type=EventType.ISSUE_CREATED,
                        org_id=org_id,
                        issue_id=issue_id,
                        ref=fingerprint,
                        payload={
                            "kind": kind,
                            "severity": severity,
                            "title": title,
                            "regressed": regressed,
                            "action_id": action_id,
                            "user_count": user_count,
                            "stumble_count": stumble_count,
                        },
                    )
                )
            except Exception as exc:
                logger.debug("orchestrator.subscribe: emit failed: %s", exc)
            return action_id

        hook.on_issue_created = _wrapped  # type: ignore[assignment]
        hook._loop_wrapped = True  # type: ignore[attr-defined]
        logger.info("orchestrator: subscribed to issue hooks (G9)")

    async def _flywheel_on_resolved(self, event: LoopEvent) -> None:
        """N19 — issue verified → KB flywheel + F39 shadow nudge draft."""
        try:
            from eden.issues.repo import IssuesRepo
            from eden.kb.flywheel.coordinator import get_flywheel_coordinator

            issue = await IssuesRepo().get_issue(event.org_id, event.issue_id)
            if issue is None:
                return
            await get_flywheel_coordinator().on_issue_resolved(
                {
                    "org_id": event.org_id,
                    "id": issue.id,
                    "agent_id": issue.agent_id,
                    "title": issue.title,
                    "kind": issue.kind,
                    "stumble_count": issue.stumble_count,
                    "triage_result": issue.triage_result,
                }
            )
        except Exception as exc:
            logger.debug("orchestrator: flywheel on resolved failed: %s", exc)


def _is_p0(triage_result: dict[str, Any]) -> bool:
    checks = triage_result.get("p0_checks") or []
    return bool(checks)


_orchestrator: ClosedLoopOrchestrator | None = None


def get_orchestrator() -> ClosedLoopOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = ClosedLoopOrchestrator()
    return _orchestrator
