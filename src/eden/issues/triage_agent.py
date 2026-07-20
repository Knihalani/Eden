"""TriageAgent — StatGate-first issue triage (F30 / N08).

Facade over the existing :class:`InvestigationAgent` (reuse, not a
parallel ReAct engine):

1. Load the issue + its top-5 example stumbles.
2. **Active-work suppress**: open proposed patch, pending verify, or
   remediating status → return cached/suppressed (no LLM) unless
   ``force=True``.
3. **Cache**: return existing ``triage_result`` unless ``force``, severity
   escalated since triage, or StatGate would newly auto-escalate.
4. **StatGate-first**: deterministic P0 path (``source="statgate"``).
5. Optional org triage budget — unset / ``<=0`` = unlimited.
6. Otherwise delegate to ``InvestigationAgent.investigate``.

Results are persisted to ``agent_issues.triage_result`` and returned in
the standard envelope shape.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, date, datetime
from typing import Any

from eden.issues.repo import IssuesRepo
from eden.issues.statgate_scorer import StatGateIncidentScorer

logger = logging.getLogger(__name__)

# Rough per-triage LLM cost estimate ($) used to debit the daily budget
# when the provider does not report an exact cost.
_TRIAGE_COST_ESTIMATE_USD = 0.02

# Hard timeout for the LLM investigation. p95 target is <60s; the 90s
# ceiling guarantees a bounded response — on timeout we persist a partial
# ``source="timeout"`` result instead of blocking the loop.
_LLM_TIMEOUT_S = 90.0

# Manual (force=True) triage rate limit: max N per rolling hour per org.
_MANUAL_TRIAGE_PER_HOUR = 10

# Max bounded evidence-gathering tool calls (thin ReAct loop).
_MAX_REACT_CALLS = 8

# Issue statuses that mean remediation is already in flight.
_REMEDIATING_STATUSES = frozenset({"fix_pending", "verifying"})

# Open proposed_patches statuses that should suppress re-triage.
_OPEN_PATCH_STATUSES = ("proposed", "approved", "needs_revision")

# F46 ``_decide_remediation`` branches on these action types.
_ALLOWED_ACTION_TYPES = frozenset(
    {
        "rollback",
        "reweight",
        "cache_bust",
        "propose_patch",
        "escalate",
        # F30 portal debugger handoff (not MCP).
        "debugger_rerun",
        "prompt_fix",
        "nudge",
        "mcp_handoff",
    }
)

_ACTION_ALIASES: dict[str, str] = {
    "patch": "propose_patch",
    "code_change": "propose_patch",
    "fix": "propose_patch",
    "heal": "rollback",
    "heal_rollback": "rollback",
    "revert": "rollback",
    "rebalance": "reweight",
    "bust_cache": "cache_bust",
    "human": "escalate",
    "page": "escalate",
    "alert": "escalate",
    "review": "escalate",
    # MCP handoff aliases.
    "prompt": "prompt_fix",
    "prompt_change": "prompt_fix",
    "prompt_patch": "prompt_fix",
    "add_nudge": "nudge",
    "runtime_nudge": "nudge",
    "handoff": "mcp_handoff",
    "mcp": "mcp_handoff",
    "cursor": "mcp_handoff",
}

_SEVERITY_RANK: dict[str, int] = {"p0": 0, "p1": 1, "p2": 2, "p3": 3}


class TriageAgent:
    def __init__(
        self,
        repo: IssuesRepo | None = None,
        scorer: StatGateIncidentScorer | None = None,
    ) -> None:
        self._repo = repo or IssuesRepo()
        self._scorer = scorer or StatGateIncidentScorer()

    async def triage(
        self, org_id: str, issue_id: str, *, force: bool = False
    ) -> dict[str, Any]:
        issue = await self._repo.get_issue(org_id, issue_id)
        if issue is None:
            return _envelope(
                "triage",
                {"issue_id": issue_id, "message": "issue not found"},
                status="not_found",
            )

        # ── Manual triage rate limit (10/hr/org) ──
        if force and not await self._manual_rate_ok(org_id):
            return _envelope(
                "triage",
                {
                    "issue_id": issue_id,
                    "triage_result": issue.triage_result or {},
                    "cached": bool(issue.triage_result),
                    "rate_limited": True,
                    "limit_per_hour": _MANUAL_TRIAGE_PER_HOUR,
                },
                status="rate_limited",
            )

        # ── Active-work suppress (unless manual force) ──
        if not force and await self._has_active_work(org_id, issue):
            return _envelope(
                "triage",
                {
                    "issue_id": issue_id,
                    "triage_result": issue.triage_result or {},
                    "cached": True,
                    "suppressed": "active_work",
                },
            )

        stumbles = await self._repo.list_stumbles(
            org_id, fingerprint=issue.fingerprint, limit=5
        )
        issue_row = _issue_to_row(issue)

        # ── Cache unless force / severity escalate / new StatGate P0 ──
        if issue.triage_result and not force:
            score_preview = self._scorer.score(issue_row, stumbles)
            if not _should_invalidate_cache(issue, score_preview):
                return _envelope(
                    "triage",
                    {
                        "issue_id": issue_id,
                        "triage_result": issue.triage_result,
                        "cached": True,
                    },
                )

        # ── StatGate-first (deterministic, no LLM) ──
        score = self._scorer.score(issue_row, stumbles)
        if score.auto_escalate:
            triage_result = {
                "root_cause": self._statgate_root_cause(score, issue),
                "confidence": 0.95,
                "source": "statgate",
                "auto_escalate": True,
                "p0_checks": score.p0_checks,
                "suggested_actions": _statgate_actions(score),
                "evidence_span_ids": _evidence_span_ids(stumbles),
                "fingerprint": issue.fingerprint,
                "linked_files": _linked_files_hints(stumbles, issue.triage_result),
                "severity_at_triage": issue.severity,
                "triaged_at": datetime.now(UTC).isoformat(),
            }
            triage_result = _enrich_playbook(triage_result, issue)
            triage_result = _append_debugger_handoff(triage_result, stumbles)
            await self._repo.set_triage_result(org_id, issue_id, triage_result)
            return _envelope(
                "triage",
                {"issue_id": issue_id, "triage_result": triage_result},
            )

        # ── Optional budget gate (unset / <=0 = unlimited) ──
        if not await self._budget_ok(org_id):
            triage_result = {
                "root_cause": "deferred — daily triage budget exhausted",
                "confidence": 0.0,
                "source": "budget_exceeded",
                "suggested_actions": [],
                "evidence_span_ids": [],
                "fingerprint": issue.fingerprint,
                "severity_at_triage": issue.severity,
                "triaged_at": datetime.now(UTC).isoformat(),
            }
            triage_result = _enrich_playbook(triage_result, issue)
            triage_result = _append_debugger_handoff(triage_result, stumbles)
            await self._repo.set_triage_result(org_id, issue_id, triage_result)
            return _envelope(
                "triage",
                {"issue_id": issue_id, "triage_result": triage_result},
                status="budget_exceeded",
            )

        # ── Bounded evidence gathering (thin ReAct loop, ≤8 tool calls) ──
        evidence = await self._gather_evidence(org_id, issue, stumbles)

        # ── LLM triage via InvestigationAgent (issue: trigger) ──
        # Hard 90s ceiling → partial ``source="timeout"`` on breach.
        try:
            from eden.autonomous import InvestigationAgent

            inv = await asyncio.wait_for(
                InvestigationAgent().investigate(
                    org_id, trigger=f"issue:{issue_id}"
                ),
                timeout=_LLM_TIMEOUT_S,
            )
        except TimeoutError:
            logger.warning(
                "triage_agent: investigation timed out issue=%s (>%ss)",
                issue_id,
                _LLM_TIMEOUT_S,
            )
            triage_result = {
                "root_cause": "partial — investigation exceeded time budget",
                "confidence": 0.0,
                "source": "timeout",
                "auto_escalate": False,
                "p0_checks": [],
                "suggested_actions": [
                    {
                        "type": "escalate",
                        "action_type": "escalate",
                        "summary": "Investigation timed out — human review",
                        "auto": False,
                    }
                ],
                "evidence_span_ids": evidence["span_ids"],
                "fingerprint": issue.fingerprint,
                "linked_files": evidence["linked_files"],
                "react_calls": evidence["react_calls"],
                "severity_at_triage": issue.severity,
                "triaged_at": datetime.now(UTC).isoformat(),
            }
            triage_result = _enrich_playbook(triage_result, issue)
            triage_result = _append_debugger_handoff(triage_result, stumbles)
            await self._repo.set_triage_result(org_id, issue_id, triage_result)
            return _envelope(
                "triage",
                {"issue_id": issue_id, "triage_result": triage_result},
                status="timeout",
            )
        except Exception as exc:
            logger.warning("triage_agent: investigate failed: %s", exc)
            inv = {}

        data = (inv or {}).get("data", {}) if isinstance(inv, dict) else {}
        findings = data.get("findings") or []
        remediations = data.get("proposed_remediations") or []
        llm_used = bool(data.get("llm_used"))

        triage_result = {
            "root_cause": _first_summary(findings)
            or "no detailed root cause identified",
            "confidence": _max_confidence(findings),
            "source": "llm" if llm_used else "heuristic",
            "auto_escalate": False,
            "p0_checks": [],
            "suggested_actions": _map_remediations(remediations),
            "evidence_span_ids": evidence["span_ids"] or _evidence_span_ids(stumbles),
            "fingerprint": issue.fingerprint,
            "linked_files": _linked_files_hints(stumbles, data) or evidence["linked_files"],
            "investigation_id": data.get("investigation_id"),
            "react_calls": evidence["react_calls"],
            "severity_at_triage": issue.severity,
            "triaged_at": datetime.now(UTC).isoformat(),
        }
        triage_result = _enrich_playbook(triage_result, issue)
        triage_result = _append_debugger_handoff(triage_result, stumbles)
        await self._repo.set_triage_result(org_id, issue_id, triage_result)
        if llm_used:
            await self._debit_budget(org_id, _TRIAGE_COST_ESTIMATE_USD)
        return _envelope(
            "triage", {"issue_id": issue_id, "triage_result": triage_result}
        )

    # ── thin ReAct evidence gathering ───────────────────────────────

    async def _gather_evidence(
        self, org_id: str, issue: Any, seed_stumbles: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Bounded evidence collection over the issue's stumbles.

        Each stumble inspected counts as one "tool call"; capped at
        ``_MAX_REACT_CALLS`` so the loop is deterministic and cheap. Returns
        distinct ``span_ids`` + ``linked_files`` gathered from the evidence.
        """
        span_ids: list[Any] = []
        seen_spans: set[str] = set()
        pool = list(seed_stumbles)
        # One extra page fetch (a tool call) to widen the evidence set.
        if len(pool) < _MAX_REACT_CALLS:
            try:
                more = await self._repo.list_stumbles(
                    org_id, fingerprint=issue.fingerprint, limit=_MAX_REACT_CALLS
                )
                pool = more or pool
            except Exception:
                pass

        calls = 0
        for s in pool:
            if calls >= _MAX_REACT_CALLS:
                break
            calls += 1
            sid = s.get("span_id") if isinstance(s, dict) else None
            if sid and str(sid) not in seen_spans:
                seen_spans.add(str(sid))
                span_ids.append(sid)

        linked_files = _linked_files_hints(pool, None)
        return {
            "span_ids": span_ids,
            "linked_files": linked_files,
            "react_calls": calls,
        }

    async def _manual_rate_ok(self, org_id: str) -> bool:
        """Enforce ≤``_MANUAL_TRIAGE_PER_HOUR`` manual triages/hour/org."""
        try:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
            if redis is None:
                return True
            key = f"triage_manual:{org_id}:{datetime.now(UTC).strftime('%Y%m%d%H')}"
            pipe = redis.pipeline(transaction=False)
            pipe.incr(key)
            pipe.expire(key, 3600)
            count, _ = await pipe.execute()
            return int(count) <= _MANUAL_TRIAGE_PER_HOUR
        except Exception:  # pragma: no cover - redis optional
            return True

    # ── active-work helpers ─────────────────────────────────────────

    async def _has_active_work(self, org_id: str, issue: Any) -> bool:
        if str(getattr(issue, "status", "") or "") in _REMEDIATING_STATUSES:
            return True
        if await self._has_open_patch(org_id, issue):
            return True
        if await self._has_pending_verify(org_id, issue):
            return True
        return False

    async def _has_open_patch(self, org_id: str, issue: Any) -> bool:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return False
            rca_id = f"iss_{issue.id}"
            placeholders = ", ".join(f"${i}" for i in range(3, 3 + len(_OPEN_PATCH_STATUSES)))
            sql = (
                "SELECT 1 FROM proposed_patches "
                f"WHERE org_id = $1 AND rca_id = $2 AND status IN ({placeholders}) "
                "LIMIT 1"
            )
            async with client.acquire() as conn:
                row = await conn.fetchrow(
                    sql, org_id, rca_id, *_OPEN_PATCH_STATUSES
                )
            return row is not None
        except Exception as exc:  # pragma: no cover - optional substrate
            logger.debug("triage_agent: open-patch check failed: %s", exc)
            return False

    async def _has_pending_verify(self, org_id: str, issue: Any) -> bool:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return False
            async with client.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT 1 FROM issue_verifications
                    WHERE org_id = $1
                      AND status = 'pending'
                      AND (issue_id::text = $2 OR fingerprint = $3)
                    LIMIT 1
                    """,
                    org_id,
                    str(issue.id),
                    str(issue.fingerprint or ""),
                )
            return row is not None
        except Exception as exc:  # pragma: no cover - optional substrate
            logger.debug("triage_agent: pending-verify check failed: %s", exc)
            return False

    # ── budget helpers — unlimited unless org/settings set a positive cap ──

    def _budget_key(self, org_id: str) -> str:
        return f"triage_spend:{org_id}:{date.today().isoformat()}"

    async def _resolve_budget_cap(self, org_id: str) -> float | None:
        """Return a positive USD cap, or ``None`` when unlimited.

        Org ``code_change_policy.max_triage_cost_usd_per_day`` wins when
        present (including explicit ``null`` / ``<=0`` → unlimited).
        Otherwise fall back to settings; ``<=0`` means unlimited.
        """
        try:
            from eden.patches.policy import get_org_code_change_policy

            policy = await get_org_code_change_policy(org_id)
            if isinstance(policy, dict) and "max_triage_cost_usd_per_day" in policy:
                raw = policy.get("max_triage_cost_usd_per_day")
                if raw is None:
                    return None
                cap = float(raw)
                return cap if cap > 0 else None
        except Exception:
            pass
        try:
            from eden.config import get_settings

            cap = float(getattr(get_settings(), "max_triage_cost_usd_per_day", 0.0) or 0.0)
        except Exception:
            return None
        return cap if cap > 0 else None

    async def _budget_ok(self, org_id: str) -> bool:
        try:
            from eden.llmops.feature_kills import is_feature_enabled

            if not await is_feature_enabled(org_id, "triage"):
                return False
        except Exception:
            pass
        cap = await self._resolve_budget_cap(org_id)
        if cap is None:
            return True
        try:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
            if redis is None:
                return True
            spent = await redis.get(self._budget_key(org_id))
            return float(spent or 0.0) < cap
        except Exception:  # pragma: no cover - redis optional
            return True

    async def _debit_budget(self, org_id: str, amount: float) -> None:
        if await self._resolve_budget_cap(org_id) is None:
            return
        try:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
            if redis is None:
                return
            key = self._budget_key(org_id)
            # Always refresh TTL in the same round-trip as the debit so
            # we never leave a counter without expiry (and avoid a second
            # command on the common path).
            pipe = redis.pipeline(transaction=False)
            pipe.incrbyfloat(key, amount)
            pipe.expire(key, 129_600)
            await pipe.execute()
        except Exception:  # pragma: no cover - redis optional
            pass

    @staticmethod
    def _statgate_root_cause(score: Any, issue: Any) -> str:
        checks = ", ".join(score.p0_checks) or "p0"
        return f"Deterministic P0 escalation ({checks}) for {issue.kind} issue"


def _append_debugger_handoff(
    triage_result: dict[str, Any], stumbles: list[dict[str, Any]]
) -> dict[str, Any]:
    """Attach portal debugger deep-link metadata (F30 — not MCP)."""
    trace_id: str | None = None
    for stumble in stumbles:
        if isinstance(stumble, dict) and stumble.get("trace_id"):
            trace_id = str(stumble["trace_id"])
            break
    if not trace_id:
        return triage_result

    actions = list(triage_result.get("suggested_actions") or [])
    if not any(a.get("type") == "debugger_rerun" for a in actions if isinstance(a, dict)):
        actions.insert(
            0,
            {
                "type": "debugger_rerun",
                "action_type": "debugger_rerun",
                "summary": "Replay prefix in hermetic debugger",
                "trace_id": trace_id,
            },
        )
    return {
        **triage_result,
        "suggested_actions": actions,
        "debugger_trace_id": trace_id,
    }


def _enrich_playbook(triage_result: dict[str, Any], issue: Any) -> dict[str, Any]:
    from eden.closed_loop.playbook_router import enrich_triage_with_playbook

    out = enrich_triage_with_playbook(triage_result)
    out["issue_kind"] = getattr(issue, "kind", None)
    return out


def _should_invalidate_cache(issue: Any, score: Any) -> bool:
    """True when cached triage must be recomputed."""
    prior = issue.triage_result or {}
    if score.auto_escalate and not bool(prior.get("auto_escalate")):
        return True
    if _severity_escalated(issue.severity, prior):
        return True
    return False


def _severity_escalated(current: str, prior_triage: dict[str, Any]) -> bool:
    prior = prior_triage.get("severity_at_triage") or prior_triage.get("severity")
    if not prior:
        return False
    cur_rank = _SEVERITY_RANK.get(str(current), 99)
    prior_rank = _SEVERITY_RANK.get(str(prior), 99)
    return cur_rank < prior_rank


def _normalize_action_type(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if not text:
        return "escalate"
    mapped = _ACTION_ALIASES.get(text, text)
    if mapped in _ALLOWED_ACTION_TYPES:
        return mapped
    return "propose_patch" if "patch" in mapped or "fix" in mapped else "escalate"


def _statgate_actions(score: Any) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    heal = score.suggested_heal
    if heal:
        action_type = _normalize_action_type(heal)
        actions.append(
            {
                "type": action_type,
                "action_type": action_type,
                "summary": f"Auto-suggested heal: {action_type}",
                "auto": True,
            }
        )
    elif score.auto_escalate:
        actions.append(
            {
                "type": "escalate",
                "action_type": "escalate",
                "summary": "StatGate P0 — escalate to human",
                "auto": False,
            }
        )
    return actions


def _map_remediations(remediations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in remediations:
        if not isinstance(r, dict):
            continue
        action = _normalize_action_type(
            r.get("action") or r.get("action_type") or r.get("type")
        )
        out.append(
            {
                "type": action,
                "action_type": action,
                "summary": r.get("summary") or r.get("description") or str(action),
                "blast_radius": r.get("blast_radius"),
            }
        )
    return out


def _evidence_span_ids(stumbles: list[dict[str, Any]]) -> list[Any]:
    return [s.get("span_id") for s in stumbles if s.get("span_id")]


def _linked_files_hints(
    stumbles: list[dict[str, Any]], extra: dict[str, Any] | None
) -> list[str]:
    files: list[str] = []
    seen: set[str] = set()

    def _add(path: Any) -> None:
        if not isinstance(path, str):
            return
        cleaned = path.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            files.append(cleaned)

    if isinstance(extra, dict):
        for key in ("linked_files", "files", "file_paths"):
            raw = extra.get(key)
            if isinstance(raw, list):
                for item in raw:
                    _add(item)
    for s in stumbles:
        detail = s.get("detail") if isinstance(s, dict) else None
        if not isinstance(detail, dict):
            continue
        for key in ("file", "file_path", "path", "linked_files"):
            val = detail.get(key)
            if isinstance(val, list):
                for item in val:
                    _add(item)
            else:
                _add(val)
    return files


def _first_summary(findings: list[dict[str, Any]]) -> str | None:
    for f in findings:
        if isinstance(f, dict) and f.get("summary"):
            return str(f["summary"])
    return None


def _max_confidence(findings: list[dict[str, Any]]) -> float:
    best = 0.0
    for f in findings:
        if isinstance(f, dict):
            try:
                best = max(best, float(f.get("confidence", 0.0)))
            except (TypeError, ValueError):
                continue
    return best or 0.5


def _issue_to_row(issue: Any) -> dict[str, Any]:
    return {
        "id": issue.id,
        "org_id": issue.org_id,
        "fingerprint": issue.fingerprint,
        "kind": issue.kind,
        "severity": issue.severity,
        "title": issue.title,
        "stumble_count": issue.stumble_count,
        "user_count": issue.user_count,
        "triage_result": issue.triage_result,
    }


def _envelope(
    feature: str, data: dict[str, Any], *, status: str = "ok"
) -> dict[str, Any]:
    return {
        "status": status,
        "feature": feature,
        "live": True,
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }
