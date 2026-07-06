"""Incident-driven PR trigger.

The brief is explicit:

> When Eden detects a service outage or quality
> degradation, spawn a lightweight context-gathering
> agent first; only spawn the coding agent if the
> issue is genuinely code-fixable.

This module is that flow. The two stages are
deliberately separate functions so they can be tested
in isolation and reused:

* :func:`gather_context` — collect evidence: repo
  metadata, affected files, blast radius, quality
  score, history. Produces a :class:`IncidentContext`
  dataclass.
* :func:`run` — the orchestrator. Calls gather_context,
  runs the gate, and either spawns the PR agent or
  writes a report-only record.

The trigger does NOT touch the database directly. It
delegates persistence to the discipline layer's
:func:`discipline.store.record_outcome` and the
existing Cat 23 ``PRCreator`` surface.

The trigger never fabricates a PR: if the gate says
no, the result is a structured ``report_only`` record.
"""

from __future__ import annotations

import contextlib
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class IncidentContext:
    """The evidence bundle the gate evaluates.

    Attributes:
        org_id: The org the incident belongs to.
        repo_id: The Eden-internal repo id (may be empty).
        repo_full_name: ``owner/name`` for the linked repo.
        branch: The default branch.
        incident_summary: Natural-language description.
        error_signature: Error type / message / stack.
        trace_ids: Trace ids backing the incident.
        file_path_hint: First-pass file path (from RCA).
        candidate_id: Stable id (cluster id / RCA id).
        evidence_count: How many distinct evidence rows.
        rca_confidence: 0-1 RCA confidence (optional).
        quality_score: 0-1 patch quality (default 0).
        blast_radius_score: 0-1 blast radius (default 0).
        reverted_history: Count of recent reverts (default 0).
        denied_history: Count of recent denials (default 0).
        fix_area_localized: True if ≤3 files (default False).
        can_validate: True if tests/checks available.
        protected_path_match: True if a protected path.
        graph_files: Files the repo graph surfaced.
        graph_snippets: ``(path, excerpt)`` snippets.
        raw_evidence: A free-form dict the caller can attach
            for audit logging.
    """

    org_id: str
    repo_id: str = ""
    repo_full_name: str = ""
    branch: str = "main"
    incident_summary: str = ""
    error_signature: str = ""
    trace_ids: tuple[str, ...] = field(default_factory=tuple)
    file_path_hint: str = ""
    candidate_id: str = ""
    evidence_count: int = 0
    rca_confidence: float = 0.0
    quality_score: float = 0.0
    blast_radius_score: float = 0.0
    reverted_history: int = 0
    denied_history: int = 0
    fix_area_localized: bool = False
    can_validate: bool = False
    protected_path_match: bool = False
    graph_files: tuple[str, ...] = field(default_factory=tuple)
    graph_snippets: tuple[tuple[str, str], ...] = field(default_factory=tuple)
    raw_evidence: dict[str, Any] = field(default_factory=dict)


def gather_context(
    incident: dict[str, Any],
    *,
    repo_connector: Any | None = None,
    knowledge_graph: Any | None = None,
) -> IncidentContext:
    """Collect the non-async evidence the gate needs.

    Pure-ish: builds the context dataclass from the input
    + the supplied helpers. No DB writes. The async
    graph query is handled by the caller (see
    :func:`run`) so this function is safe in sync
    contexts too.
    """
    org_id = str(incident.get("org_id") or "")
    repo_full_name = str(incident.get("repo_full_name") or "")
    branch = str(incident.get("branch") or "main")
    incident_summary = str(
        incident.get("summary") or incident.get("description") or "",
    )
    error_signature = str(incident.get("error_signature") or "")
    trace_ids = tuple(incident.get("trace_ids") or ())
    file_path_hint = str(incident.get("file_path_hint") or "")
    candidate_id = str(
        incident.get("cluster_id")
        or incident.get("rca_id")
        or incident.get("incident_id")
        or "",
    )
    graph_files: tuple[str, ...] = tuple(incident.get("graph_files") or ())
    graph_snippets: tuple[tuple[str, str], ...] = tuple(
        incident.get("graph_snippets") or ()
    )

    # If the caller's file_path_hint is empty but the
    # graph surfaced candidates, promote the top hit.
    if not file_path_hint and graph_files:
        file_path_hint = graph_files[0]

    return IncidentContext(
        org_id=org_id,
        repo_id=str(incident.get("repo_id") or ""),
        repo_full_name=repo_full_name,
        branch=branch,
        incident_summary=incident_summary,
        error_signature=error_signature,
        trace_ids=trace_ids,
        file_path_hint=file_path_hint,
        candidate_id=candidate_id,
        evidence_count=int(incident.get("evidence_count") or 0),
        rca_confidence=float(incident.get("rca_confidence") or 0.0),
        quality_score=float(incident.get("quality_score") or 0.0),
        blast_radius_score=float(
            incident.get("blast_radius_score") or 0.0,
        ),
        reverted_history=int(incident.get("reverted_history") or 0),
        denied_history=int(incident.get("denied_history") or 0),
        fix_area_localized=bool(
            incident.get("fix_area_localized", False),
        ),
        can_validate=bool(incident.get("can_validate", False)),
        protected_path_match=bool(
            incident.get("protected_path_match", False),
        ),
        graph_files=graph_files,
        graph_snippets=graph_snippets,
        raw_evidence=dict(incident.get("raw_evidence") or {}),
    )


async def run(
    incident: dict[str, Any],
    *,
    graph: Any | None = None,
    agent: Any | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the incident-driven trigger.

    1. :func:`gather_context`.
    2. Run the discipline :class:`ConfidenceGate`.
    3. Check the :class:`CircuitBreaker` (if open,
       take the report-only path).
    4. Check :class:`DedupeIndex` (if duplicate, take
       the report-only path).
    5. Check :class:`RateLimiter` (if over cap, take
       the report-only path).
    6. If everything clears, spawn the PR agent.
    7. Persist the outcome via
       :func:`discipline.store.record_outcome`.

    Returns a structured result the route layer can
    render to the user.
    """
    from eden.code_change.discipline import (
        RateLimiter,
        Trigger,
        compute_decision,
        record_outcome,
    )
    from eden.code_change.discipline.circuit_breaker import (
        CircuitBreaker,
    )
    from eden.code_change.discipline.dedupe import DedupeIndex

    # First, gather the sync (non-graph) context.
    context = gather_context(incident)
    if not context.org_id:
        return {
            "kind": "report_only",
            "reason": "missing_org_id",
            "summary": context.incident_summary,
        }
    trigger = Trigger(
        kind="incident",
        identifier=context.candidate_id or context.incident_summary[:80],
        summary=context.incident_summary,
        evidence_refs=context.trace_ids,
    )
    # Optionally enrich the context with a graph query.
    if graph is not None and context.repo_full_name and not context.graph_files:
        try:
            areas = await graph.find_affected_areas(
                context.repo_full_name,
                error_signature=context.error_signature,
                trace_ids=context.trace_ids,
                file_path_hint=context.file_path_hint,
                branch=context.branch,
            )
        except Exception as exc:
            logger.debug(
                "incident_trigger.run: graph query failed (degrading): %s",
                exc,
            )
            areas = []
        context.graph_files = tuple(a.path for a in areas if a.path)
        if not context.file_path_hint and context.graph_files:
            context.file_path_hint = context.graph_files[0]

    decision = compute_decision(
        trigger,
        rca_confidence=context.rca_confidence,
        quality_score=context.quality_score,
        blast_radius_score=context.blast_radius_score,
        evidence_count=context.evidence_count,
        reverted_history=context.reverted_history,
        denied_history=context.denied_history,
        protected_path_match=context.protected_path_match,
        fix_area_localized=context.fix_area_localized,
        can_validate=context.can_validate,
        file_paths=(context.file_path_hint, *context.graph_files),
        gate_policy=policy,
    )
    # 3. Circuit breaker
    breaker = CircuitBreaker(breaker_name="incident_pr")
    breaker_allows = False
    try:
        breaker_allows = await breaker.should_allow(context.org_id)
    except Exception as exc:
        logger.debug(
            "incident_trigger.run: breaker check failed (failing closed): %s",
            exc,
        )
        breaker_allows = False
    if not breaker_allows:
        with contextlib.suppress(Exception):
            await record_outcome(
                context.org_id,
                fingerprint=decision.fingerprint,
                trigger_kind="incident",
                outcome="breaker_open",
                score=decision.score,
                reasons=decision.reasons,
                repo_id=context.repo_id,
            )
        return {
            "kind": "report_only",
            "reason": "circuit_breaker_open",
            "summary": context.incident_summary,
            "score": decision.score,
            "reasons": decision.reasons,
            "fingerprint": decision.fingerprint,
        }

    # 4. Dedupe
    try:
        index = DedupeIndex()
        hit = await index.is_duplicate(
            context.org_id, decision.fingerprint,
        )
    except Exception as exc:
        logger.debug(
            "incident_trigger.run: dedupe failed (failing open): %s",
            exc,
        )
        hit = type("Hit", (), {"is_duplicate": False})()
    if getattr(hit, "is_duplicate", False):
        with contextlib.suppress(Exception):
            await record_outcome(
                context.org_id,
                fingerprint=decision.fingerprint,
                trigger_kind="incident",
                outcome="duplicate",
                score=decision.score,
                reasons=decision.reasons,
                repo_id=context.repo_id,
            )
        return {
            "kind": "report_only",
            "reason": "duplicate_in_window",
            "summary": context.incident_summary,
            "score": decision.score,
            "reasons": decision.reasons,
            "fingerprint": decision.fingerprint,
            "previous_outcome": getattr(hit, "last_outcome", ""),
        }

    # 5. Rate limit
    try:
        limiter = RateLimiter()
        rl = await limiter.check(context.org_id, context.repo_id)
    except Exception as exc:
        logger.debug(
            "incident_trigger.run: rate limit failed (failing closed): %s",
            exc,
        )
        rl = {"allowed": False, "reason": "rate_limit_check_failed"}
    if not rl.get("allowed", False):
        with contextlib.suppress(Exception):
            await record_outcome(
                context.org_id,
                fingerprint=decision.fingerprint,
                trigger_kind="incident",
                outcome="rate_limited",
                score=decision.score,
                reasons=decision.reasons,
                repo_id=context.repo_id,
            )
        return {
            "kind": "report_only",
            "reason": "rate_limit",
            "summary": context.incident_summary,
            "score": decision.score,
            "reasons": decision.reasons,
            "fingerprint": decision.fingerprint,
            "rate_limit": rl,
        }

    # 6. Gate decision
    if not decision.allowed:
        with contextlib.suppress(Exception):
            await record_outcome(
                context.org_id,
                fingerprint=decision.fingerprint,
                trigger_kind="incident",
                outcome="denied",
                score=decision.score,
                reasons=decision.reasons,
                repo_id=context.repo_id,
            )
        return {
            "kind": "report_only",
            "reason": "gate_denied",
            "summary": context.incident_summary,
            "score": decision.score,
            "reasons": decision.reasons,
            "fingerprint": decision.fingerprint,
        }

    # 7. Spawn the agent (or report-only when no agent).
    from eden.code_change.agent import PRCandidate
    candidate = PRCandidate(
        repo_full_name=context.repo_full_name,
        branch=context.branch,
        incident_summary=context.incident_summary,
        candidate_id=decision.fingerprint,
        graph_files=context.graph_files,
        graph_snippets=context.graph_snippets,
        evidence_refs=context.trace_ids,
        target_kind="incident",
        repo_id=context.repo_id,
        org_id=context.org_id,
    )
    if agent is None:
        from eden.code_change.agent import get_default_pr_agent
        agent = get_default_pr_agent()
    try:
        result = await agent.run(candidate, decision=decision)
    except Exception as exc:
        logger.debug("incident_trigger.run: agent failed: %s", exc)
        result = None
    if result is None or result.kind == "report_only":
        with contextlib.suppress(Exception):
            await record_outcome(
                context.org_id,
                fingerprint=decision.fingerprint,
                trigger_kind="incident",
                outcome="report_only",
                score=decision.score,
                reasons=decision.reasons,
                repo_id=context.repo_id,
            )
        return {
            "kind": "report_only",
            "reason": (
                result.reason if result is not None else "agent_unavailable"
            ),
            "summary": context.incident_summary,
            "score": decision.score,
            "reasons": decision.reasons,
            "fingerprint": decision.fingerprint,
            "agent": result.__dict__ if result is not None else None,
        }

    # Successful agent run — record + return the result.
    with contextlib.suppress(Exception):
        await record_outcome(
            context.org_id,
            fingerprint=decision.fingerprint,
            trigger_kind="incident",
            outcome=("merged" if result.kind == "pr_ready" else "allowed"),
            score=decision.score,
            reasons=decision.reasons,
            repo_id=context.repo_id,
        )
    return {
        "kind": result.kind,
        "title": result.title,
        "body": result.body,
        "diff": result.diff,
        "summary": context.incident_summary,
        "score": decision.score,
        "reasons": decision.reasons,
        "fingerprint": decision.fingerprint,
        "agent_conversation_id": result.conversation_id,
    }
