"""Runtime Protection & Guardrails (Cat 15) — intervention + log + metrics.

Four services:

* :class:`InterventionEngine` — the headline guardrail route.
  Incomplete / unevaluable policy sets fail closed
  (``verdict: "block"``, ``live: false``). Only enforced
  detector policies flip the envelope to ``live: true``.

* :class:`InterventionLog` — read the log of decisions
  (queries the existing ``intervention_log`` table).

* :class:`GuardrailMetrics` — dashboard counters (trigger rate
  per org, per policy, per action).

Eval-to-guardrail promotion/demotion is handled by the canonical
:class:`eden.evaluation.eval_intel.integration.EvalToGuardrailLink`
(FEAT-34). Shared DB helpers
(:func:`_insert_eval_to_guardrail_link`,
:func:`_disable_eval_guardrail_link`) live in this module.

Closed-loop wiring:

* :class:`InterventionEngine` fires
  :func:`GuardrailHook.on_judge_threshold_breach` when a
  judge-driven policy is reliably catching real issues.
"""

from __future__ import annotations

import contextlib
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from .detectors import HallucinationBlocker, PIIFirewall, PromptInjectionDetector
from .policy import (
    ACTION_RANK,
    VALID_ACTIONS,
    _fetch_policies,
    _ok_envelope,
    policy_matches_direction,
)

logger = logging.getLogger(__name__)


# ─── Postgres helpers ─────────────────────────────────────────────


async def _log_intervention(
    org_id: str,
    *,
    policy_id: str | None,
    trace_id: str | None,
    verdict: str,
    action_taken: str,
    edited_text: str | None = None,
    reason: str | None = None,
) -> dict[str, Any] | None:
    """Insert a row into ``intervention_log`` (and
    ``guardrail_evaluations`` for the head-200-only audit
    trail) and return the row.

    Returns ``None`` if the substrate is unavailable.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("guardrails: postgres import failed: %s", exc)
        return None

    try:
        client = await get_postgres_client()
    except Exception:
        return None
    if client is None:
        return None
    int_id = str(uuid.uuid4())
    # Schema has no dedicated ``action`` column; persist action_taken
    # as a reason prefix so scan-history can filter honestly.
    action = (action_taken or verdict or "allow")[:64]
    reason_raw = (reason or "").strip()
    if reason_raw.startswith("action="):
        reason_out = reason_raw[:2000] or None
    else:
        reason_out = f"action={action}|{reason_raw}"[:2000] or None
    try:
        row = await client.fetchrow(
            """
            INSERT INTO intervention_log
                (id, org_id, policy_id, trace_id, verdict,
                 edited_text, reason)
            VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)
            RETURNING id, org_id, policy_id, trace_id, verdict,
                      edited_text, reason, created_at
            """,
            int_id,
            org_id,
            policy_id,
            (trace_id or "")[:128] or None,
            (verdict or "allow")[:16],
            (edited_text or "")[:4000] or None,
            reason_out,
        )
    except Exception as exc:
        logger.debug("guardrails: intervention_log insert failed: %s", exc)
        return None
    if row is None:
        return None
    out = _row_to_dict(row)
    out["action"] = action
    return out


async def _log_evaluation(
    org_id: str,
    *,
    policy_id: str | None,
    input_payload: dict[str, Any],
    verdict: str,
    action_taken: str,
) -> None:
    """Insert a row into ``guardrail_evaluations`` (the
    head-200-only audit trail). Best-effort — failures are
    logged at debug."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
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
            INSERT INTO guardrail_evaluations
                (id, org_id, policy_id, input_json, verdict, action_taken)
            VALUES (gen_random_uuid(), $1, $2::uuid, $3, $4, $5)
            """,
            org_id,
            policy_id,
            json.dumps(input_payload)[:4000],
            verdict[:16],
            action_taken[:16],
        )
    except Exception as exc:
        logger.debug("guardrails: evaluation insert failed: %s", exc)


async def _fetch_intervention_log(
    org_id: str,
    *,
    limit: int = 50,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """Query ``intervention_log`` for the org."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return []
    try:
        client = await get_postgres_client()
    except Exception:
        return []
    if client is None:
        return []
    if since is None:
        # Default: last 7 days
        since = datetime.now(UTC) - timedelta(days=7)
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, policy_id, trace_id, verdict,
                   edited_text, reason, created_at
            FROM intervention_log
            WHERE org_id = $1 AND created_at >= $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            org_id, since, int(limit),
        )
    except Exception as exc:
        logger.debug("guardrails: log fetch failed: %s", exc)
        return []
    return [_enrich_intervention_row(_row_to_dict(r)) for r in (rows or [])]


def _enrich_intervention_row(d: dict[str, Any]) -> dict[str, Any]:
    """Synthesize ``action`` from reason prefix or verdict/reason heuristics."""
    if not d:
        return d
    if d.get("action"):
        return d
    reason = str(d.get("reason") or "")
    if reason.startswith("action="):
        d["action"] = reason[7:].split("|", 1)[0][:64]
        return d
    rl = reason.lower()
    verdict = str(d.get("verdict") or "allow")
    if "injection" in rl:
        d["action"] = f"injection_{verdict}"
    elif "pii" in rl or (d.get("edited_text") and verdict in ("redact", "warn", "block")):
        d["action"] = f"pii_{verdict}" if "pii" in rl else "pii_redact"
    else:
        d["action"] = verdict
    return d


async def _insert_eval_to_guardrail_link(
    org_id: str,
    *,
    judge_name: str,
    guardrail_policy_id: str,
    threshold: float,
    status: str = "active",
) -> str | None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return None
    try:
        client = await get_postgres_client()
    except Exception:
        return None
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            INSERT INTO eval_to_guardrail_links
                (id, org_id, judge_name, guardrail_policy_id,
                 threshold, status)
            VALUES (gen_random_uuid(), $1, $2, $3::uuid, $4, $5)
            RETURNING id
            """,
            org_id, judge_name[:64], guardrail_policy_id,
            float(threshold), status[:16],
        )
    except Exception as exc:
        logger.debug("guardrails: link insert failed: %s", exc)
        return None
    if row is None:
        return None
    try:
        d = dict(row)
    except Exception:
        return None
    return str(d.get("id"))


async def _disable_eval_guardrail_link(
    org_id: str,
    *,
    judge_name: str,
    reason: str = "",
) -> dict[str, Any]:
    """Disable the promoted judge guardrail + link rows for an org."""
    out: dict[str, Any] = {
        "judge_name": judge_name,
        "policy_ids": [],
        "link_ids": [],
        "disabled": False,
        "reason": reason[:512],
    }
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return out
    try:
        client = await get_postgres_client()
    except Exception:
        return out
    if client is None:
        return out
    jname = judge_name[:64]
    try:
        link_rows = await client.fetch(
            """
            SELECT id, guardrail_policy_id
            FROM eval_to_guardrail_links
            WHERE org_id = $1 AND judge_name = $2 AND status = 'active'
            """,
            org_id,
            jname,
        )
    except Exception as exc:
        logger.debug("guardrails: link fetch failed: %s", exc)
        return out
    policy_ids: list[str] = []
    link_ids: list[str] = []
    for row in link_rows or []:
        try:
            d = dict(row)
        except Exception:
            continue
        lid = d.get("id")
        pid = d.get("guardrail_policy_id")
        if lid is not None:
            link_ids.append(str(lid))
        if pid is not None:
            policy_ids.append(str(pid))
    if not link_ids and not policy_ids:
        return out
    try:
        async with client.transaction():
            if link_ids:
                await client.execute(
                    """
                    UPDATE eval_to_guardrail_links
                    SET status = 'disabled'
                    WHERE org_id = $1 AND judge_name = $2 AND status = 'active'
                    """,
                    org_id,
                    jname,
                )
            if policy_ids:
                await client.execute(
                    """
                    UPDATE guardrail_policies
                    SET status = 'disabled'
                    WHERE org_id = $1
                      AND id = ANY($2::uuid[])
                      AND status = 'active'
                    """,
                    org_id,
                    policy_ids,
                )
        out["policy_ids"] = policy_ids
        out["link_ids"] = link_ids
        out["disabled"] = True
    except Exception as exc:
        logger.debug("guardrails: disable link failed: %s", exc)
    return out


def _hallucination_action_for(
    p_action: str | None,
    *,
    overlap_ratio: float,
    is_refusal: bool,
) -> str | None:
    """This policy's resulting action, or ``None`` if not triggered.

    Mirrors :meth:`HallucinationBlocker.check`'s own banding (a
    refusal is never flagged; below ``0.2`` overlap is "ungrounded"
    and uses the policy's own ``action``; the ``0.2``-``0.4`` "weak"
    band is always capped at ``warn`` regardless of the policy's
    configured action, same as the detector). Extracted here so
    :meth:`InterventionEngine.evaluate_and_act` can apply it once
    per matching policy instead of only the org's first
    ``hallucination`` policy.
    """
    if is_refusal:
        return None
    if overlap_ratio < 0.2:
        return p_action if p_action in VALID_ACTIONS else "block"
    if overlap_ratio < 0.4:
        return "warn"
    return None


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Normalise an asyncpg Record into a JSON-friendly dict."""
    if row is None:
        return {}
    if isinstance(row, dict):
        d = dict(row)
    else:
        try:
            d = dict(row)
        except Exception:
            return {}
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif v is not None and not isinstance(v, (str, int, float, bool, list, dict)):
            d[k] = str(v)
    return d


# ─── Canonical enforcement types (FEAT-37) ───────────────────────
#
# Single source of truth for which policy types
# :meth:`InterventionEngine.evaluate_and_act` actually enforces.
# ``judge_link`` (written by legacy promotion shims and some Cat 3
# rows) is intentionally excluded — see
# ``docs/docs/observability/37-runtime-guardrails.md``
# ("Single source of truth: which guardrail enforcement path is
# active (FEAT-37)").
_ENFORCED_POLICY_TYPES = frozenset(
    {
        "prompt_injection",
        "pii_redaction",
        "hallucination",
        "content_policy",
    }
)


# ─── InterventionEngine ──────────────────────────────────────────
#
# ARCHITECTURE (FEAT-37): ``InterventionEngine.evaluate_and_act`` is
# Eden's *only* canonical content-safety enforcement pipeline. The
# trajectory hot path (``POST /v1/guardrails/trajectory/check`` and
# ``TrajectoryInterventionGatewayFilter``) is a separate, legitimate
# surface for cost/loop/latency — it must never be substituted in
# place of this method. Bypass detection:
# :func:`is_evaluate_and_act_patched` + :func:`record_guardrail_bypass_if_detected`.
# Full statement: ``docs/docs/observability/37-runtime-guardrails.md`` §
# "Single source of truth: which guardrail enforcement path is active".


class InterventionEngine:
    """The headline guardrail route.

    :func:`evaluate_and_act` evaluates ``text`` against every
    active policy of types in :data:`_ENFORCED_POLICY_TYPES`
    (``prompt_injection``, ``pii_redaction``, ``hallucination``,
    ``content_policy``) and returns the most-restrictive verdict.
    ``judge_link`` policies are *not* enforced here (they may exist
    for record-keeping / gateway hot-reload but do not flip
    ``live: true`` on this path). The action also drives the
    *editing* of the text — for ``redact`` actions the returned
    ``edited_text`` has the PII / injection match replaced with a
    placeholder.

    **Direction filtering:** a policy's ``direction`` field
    (``"input"`` / ``"output"`` / ``"both"``, see
    :data:`eden.guardrails.policy.VALID_DIRECTIONS`) scopes it to
    the ``direction`` the caller passes to :func:`evaluate_and_act`
    (mirrors the filter already used by the pure-Python
    :func:`eden.guardrails.evaluator.evaluate` sibling). A
    ``hallucination`` policy scoped ``direction="output"``, for
    example, is skipped entirely on an ``direction="input"`` call —
    so it can no longer false-positive-block plain user input just
    because ``context`` happens to be absent there. Existing rows
    (migrated to ``direction="both"``) keep matching every call, so
    this is opt-in for orgs that scope a new policy.

    **Most-restrictive-per-type aggregation:** every active,
    direction-matching policy of a given type is evaluated (not just
    the first, ``created_at``-ordered one) and the most restrictive
    resulting action among them is what's applied for that type —
    the same reduction the docstring already promises across types.

    **Fail-closed behaviour:** when the org has zero active
    policies, policy fetch fails, or only unevaluated types
    (e.g. ``judge_link``) exist, the engine returns
    ``verdict: "block"`` with ``live: false``. Enforced
    detector policies are what flip the envelope to
    ``live: true``.
    """

    name = "intervention_engine"

    async def evaluate_and_act(
        self,
        org_id: str,
        *,
        text: str,
        context: str | None = None,
        trace_id: str | None = None,
        direction: str = "input",
    ) -> dict[str, Any]:
        """Evaluate every active, direction-matching policy and return the verdict.

        Args:
            org_id: The org whose policies to consult.
            text: The text to evaluate (the inbound prompt or the
                outbound completion, depending on ``direction``).
            context: Grounding context for ``hallucination`` policies.
                Only meaningful for ``direction="output"`` calls —
                typically absent on ``direction="input"`` calls.
            trace_id: Optional trace to correlate the logged
                intervention with.
            direction: ``"input"`` (guarding an inbound prompt,
                the default — matches the common case of a
                caller with no ``context``), ``"output"``
                (guarding an outbound completion), or ``"both"``
                (bypass direction filtering entirely — every
                policy of an enforced type is considered
                regardless of its own ``direction``). A policy
                matches an ``"input"``/``"output"`` call if its own
                ``direction`` equals the call's, or the policy is
                scoped ``"both"``.

        Returns ``data: {"verdict": "...", "edited_text": "...",
        "matched_policies": [...], "action_breakdown": {...}}``.
        ``verdict`` is the most-restrictive action across all
        matched policies; ``edited_text`` is the (possibly
        redacted) text the caller should use downstream.
        """
        if not isinstance(text, str) or not text:
            return _ok_envelope(
                self.name,
                {
                    "verdict": "allow",
                    "edited_text": text or "",
                    "matched_policies": [],
                    "action_breakdown": {},
                    "live": False,
                    "reason": "empty_text",
                },
            )

        try:
            policies = await _fetch_policies(org_id, status="active")
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("intervention: fetch failed: %s", exc)
            return _ok_envelope(
                self.name,
                {
                    "verdict": "block",
                    "edited_text": text,
                    "matched_policies": [],
                    "action_breakdown": {},
                    "live": False,
                    "reason": "policy_fetch_failed",
                },
            )
        if not policies:
            # Fail closed — no policies means enforcement incomplete.
            return _ok_envelope(
                self.name,
                {
                    "verdict": "block",
                    "edited_text": text,
                    "matched_policies": [],
                    "action_breakdown": {},
                    "live": False,
                    "reason": "no_active_policies",
                },
            )

        # judge_link policies are declared but not evaluated here —
        # do not advertise live enforcement solely because they exist.
        enforced_policies = [
            p for p in policies if p.get("type") in _ENFORCED_POLICY_TYPES
        ]
        if not enforced_policies:
            has_judge = any(p.get("type") == "judge_link" for p in policies)
            return _ok_envelope(
                self.name,
                {
                    "verdict": "block",
                    "edited_text": text,
                    "matched_policies": [],
                    "action_breakdown": {},
                    "live": False,
                    "reason": (
                        "judge_link_not_enforced"
                        if has_judge
                        else "no_enforced_policies"
                    ),
                },
            )

        edited = text
        matched: list[dict[str, Any]] = []
        breakdown: dict[str, int] = {}
        verdict_rank = 0
        verdict = "allow"

        def _direction_ok(p: dict[str, Any]) -> bool:
            # direction="both" (the caller, not the policy) means
            # "don't filter" — every policy of an enforced type is
            # considered regardless of its own direction scope.
            return direction == "both" or policy_matches_direction(p, direction)

        # Prompt injection — every direction-matching policy of this
        # type is evaluated (not just the org's first); the most
        # restrictive resulting action across all of them wins.
        pi_policies = [
            p
            for p in policies
            if p.get("type") == "prompt_injection" and _direction_ok(p)
        ]
        if pi_policies:
            r = await PromptInjectionDetector().scan(org_id, text=text)
            d = (r.get("data") or {})
            if d.get("matches"):
                for p in pi_policies:
                    p_action = p.get("action")
                    if p_action not in VALID_ACTIONS:
                        p_action = d.get("verdict", "allow")
                    if p_action == "allow":
                        continue
                    matched.append(
                        {
                            "policy_id": p.get("id"),
                            "policy_name": p.get("name"),
                            "type": p.get("type"),
                            "verdict": p_action,
                        }
                    )
                    breakdown["prompt_injection"] = (
                        breakdown.get("prompt_injection", 0) + 1
                    )
                    if ACTION_RANK.get(p_action, 0) > verdict_rank:
                        verdict_rank = ACTION_RANK.get(p_action, 0)
                        verdict = p_action

        # PII redaction — same aggregation: every direction-matching
        # pii_redaction policy contributes its own action (default
        # "redact" if unset/invalid); the most restrictive wins.
        pii_policies = [
            p
            for p in policies
            if p.get("type") == "pii_redaction" and _direction_ok(p)
        ]
        if pii_policies:
            r = await PIIFirewall().redact(org_id, text=edited)
            d = (r.get("data") or {})
            new_matches = d.get("matches", []) or []
            if new_matches:
                # Apply redaction to the edited text
                sorted_matches = sorted(
                    new_matches, key=lambda m: -m.get("start", 0)
                )
                for m in sorted_matches:
                    s = m.get("start", 0)
                    e = m.get("end", 0)
                    if 0 <= s <= e <= len(edited):
                        edited = (
                            edited[:s]
                            + m.get("placeholder", "[REDACTED]")
                            + edited[e:]
                        )
                for p in pii_policies:
                    p_action = p.get("action")
                    if p_action not in VALID_ACTIONS:
                        p_action = "redact"
                    matched.append(
                        {
                            "policy_id": p.get("id"),
                            "policy_name": p.get("name"),
                            "type": p.get("type"),
                            "verdict": p_action,
                            "match_count": len(new_matches),
                        }
                    )
                    breakdown["pii_redaction"] = (
                        breakdown.get("pii_redaction", 0) + len(new_matches)
                    )
                    if ACTION_RANK.get(p_action, 0) > verdict_rank:
                        verdict_rank = ACTION_RANK.get(p_action, 0)
                        verdict = p_action

        # Hallucination (output check) — uses context if provided.
        # Every direction-matching hallucination policy contributes
        # its own action (subject to the same "weak overlap always
        # caps at warn" banding the detector itself uses); the most
        # restrictive wins.
        hallu_policies = [
            p
            for p in policies
            if p.get("type") == "hallucination" and _direction_ok(p)
        ]
        if hallu_policies:
            r = await HallucinationBlocker().check(
                org_id, candidate=text, context=context or ""
            )
            d = (r.get("data") or {})
            overlap_ratio = d.get("overlap_ratio", 0.0) or 0.0
            is_refusal = bool(d.get("is_refusal"))
            for p in hallu_policies:
                p_action = _hallucination_action_for(
                    p.get("action"),
                    overlap_ratio=overlap_ratio,
                    is_refusal=is_refusal,
                )
                if p_action is None:
                    continue
                matched.append(
                    {
                        "policy_id": p.get("id"),
                        "policy_name": p.get("name"),
                        "type": p.get("type"),
                        "verdict": p_action,
                    }
                )
                breakdown["hallucination"] = (
                    breakdown.get("hallucination", 0) + 1
                )
                if ACTION_RANK.get(p_action, 0) > verdict_rank:
                    verdict_rank = ACTION_RANK.get(p_action, 0)
                    verdict = p_action

        # Content policy (keywords / regex). ContentPolicyEnforcer.enforce
        # already aggregates across every content_policy of the org
        # (no first-match short-circuit) — we just need to (a) pass
        # ``direction`` through so it applies the same direction
        # filter, and (b) attribute each match back to its actual
        # matched policy rather than the first content_policy row.
        from .policy import ContentPolicyEnforcer

        content_policies = [
            p
            for p in policies
            if p.get("type") == "content_policy" and _direction_ok(p)
        ]
        if content_policies:
            r = await ContentPolicyEnforcer().enforce(
                org_id, text=text, direction=direction
            )
            d = (r.get("data") or {})
            cp_matches = d.get("matches", []) or []
            cp_verdict = d.get("verdict", "allow")
            if cp_verdict != "allow" or cp_matches:
                # Look up each matched policy's *own* configured action —
                # ``cp_verdict`` above is the aggregate across every
                # matched content_policy (used only for the overall
                # verdict/rank below), not the per-policy action. Using
                # it for a per-match entry would misattribute a stricter
                # sibling policy's action to this one (e.g. a warn-action
                # policy would be reported as having produced "block").
                content_by_id = {p.get("id"): p for p in content_policies}
                by_policy: dict[str | None, dict[str, Any]] = {}
                for m in cp_matches:
                    pid = m.get("policy_id")
                    pol = content_by_id.get(pid)
                    p_action = (pol or {}).get("action")
                    if p_action not in VALID_ACTIONS:
                        p_action = cp_verdict
                    entry = by_policy.setdefault(
                        pid,
                        {
                            "policy_id": pid,
                            "policy_name": m.get("policy_name"),
                            "type": "content_policy",
                            "verdict": p_action,
                            "match_count": 0,
                        },
                    )
                    entry["match_count"] += 1
                matched.extend(by_policy.values())
                breakdown["content_policy"] = (
                    breakdown.get("content_policy", 0) + len(cp_matches)
                )
                if ACTION_RANK.get(cp_verdict, 0) > verdict_rank:
                    verdict_rank = ACTION_RANK.get(cp_verdict, 0)
                    verdict = cp_verdict

        # Judge-link policies are wired but not actively checked
        # here — the Cat 3 judge_runner has already scored the
        # candidate; the policy simply declares "this judge is
        # blocking on threshold breach." The hook
        # (GuardrailHook.on_judge_threshold_breach) is what
        # flips the verdict for a judge_link policy.

        # Persist the intervention (best-effort) + log the eval
        first_policy_id = (
            matched[0].get("policy_id") if matched else None
        )
        with contextlib.suppress(Exception):  # pragma: no cover - defensive
            await _log_intervention(
                org_id,
                policy_id=first_policy_id,
                trace_id=trace_id,
                verdict=verdict,
                action_taken=verdict,
                edited_text=(edited if edited != text else None),
                reason=(
                    f"matched_policies={[m.get('policy_id') for m in matched]}"
                    if matched
                    else "no_match"
                ),
            )
        with contextlib.suppress(Exception):  # pragma: no cover - defensive
            await _log_evaluation(
                org_id,
                policy_id=first_policy_id,
                input_payload={
                    "trace_id": trace_id,
                    "text_length": len(text),
                    "context_length": len(context or ""),
                },
                verdict=verdict,
                action_taken=verdict,
            )

        return _ok_envelope(
            self.name,
            {
                "verdict": verdict,
                "edited_text": edited,
                "matched_policies": matched,
                "action_breakdown": breakdown,
                "live": True,
            },
        )


# Captured at import time, before any wiring (``install_all`` in
# ``eden.observability.trace_quality.wiring``) has a chance to run.
# ``is_evaluate_and_act_patched`` compares the *current* bound
# attribute against this reference to detect a full-function
# monkey-patch — the kind ``install_cat15_trajectory_replaces_intervention``
# performed (FEAT-3/FEAT-4; the wiring has since been removed, see
# ``wiring.install_all``'s docstring). A response-content check
# (:func:`record_guardrail_bypass_if_detected`) cannot catch this
# case on its own, because the patch replaces the function outright —
# only comparing function identity from outside the (possibly
# replaced) function can.
_ORIGINAL_EVALUATE_AND_ACT = InterventionEngine.evaluate_and_act


def is_evaluate_and_act_patched() -> bool:
    """True when ``InterventionEngine.evaluate_and_act`` no longer points at this module's original implementation."""
    return InterventionEngine.evaluate_and_act is not _ORIGINAL_EVALUATE_AND_ACT


# ─── Guardrail-bypass monitoring (FEAT-33) ─────────────────────────
#
# Defense-in-depth. Eden previously shipped a default-on hot-path
# monkey-patch, ``install_cat15_trajectory_replaces_intervention``
# (``eden.observability.trace_quality.wiring``), that silently
# rebound ``InterventionEngine.evaluate_and_act`` — the real,
# fail-closed content-safety guardrail (prompt injection, PII
# redaction, hallucination, content policy) — to the unrelated Cat 15
# trajectory hot path (cost/loop/latency checks) whenever a
# ``trace_id`` was present, and tagged its responses
# ``"feature": "trajectory_guardrail"``. That wiring has been removed
# (FEAT-3/FEAT-4), but nothing previously alerted when it *was* firing
# in production — the bug was only caught by a strategic code review.
# The two functions below are cheap, always-on monitoring so a
# reintroduction of the same substitution (by this wiring or any
# future one) is visible in logs/metrics immediately instead of only
# via code review:
#
# * :func:`record_guardrail_bypass_if_detected` — call with the
#   envelope every production caller of ``evaluate_and_act`` gets
#   back. Increments a counter and logs CRITICAL when the envelope
#   carries the trajectory-hot-path marker. Because the check runs in
#   the *caller* after the (possibly patched) function returns, it
#   still fires even if ``evaluate_and_act`` has been fully replaced.
# * :func:`is_evaluate_and_act_patched` (above) — an identity check
#   wiring code can run right after installing every wiring, to catch
#   a substitution even on organizations that never call ``/evaluate``
#   frequently enough to surface it via response inspection alone.

_guardrail_bypass_counts: dict[str, int] = {}


def record_guardrail_bypass_if_detected(
    result: dict[str, Any] | None, *, org_id: str = "", source: str = "response"
) -> bool:
    """Increment + log when a guardrail response carries the trajectory-hot-path marker.

    Returns ``True`` (after firing a CRITICAL log line and
    incrementing ``eden_guardrail_bypass_detected_total``) when
    ``result["feature"] == "trajectory_guardrail"`` — the signature
    of the removed ``install_cat15_trajectory_replaces_intervention``
    monkey-patch (or any future wiring that reintroduces the same
    substitution). Safe to call on every response: a single dict
    lookup on the overwhelming majority of calls where the real
    content-safety check ran.

    ``source`` distinguishes a live response-content detection
    (``"response"``, the default) from a startup identity check
    (``"install_all"`` — see ``wiring.install_all``) in the log line
    and the per-key counter.
    """
    feature = result.get("feature") if isinstance(result, dict) else None
    if feature != "trajectory_guardrail":
        return False
    key = f"{source}:{org_id or 'unknown'}"
    _guardrail_bypass_counts[key] = _guardrail_bypass_counts.get(key, 0) + 1
    # Wave 3 (3.4): a bypass means the guardrail that should have fired
    # did NOT run — a real false-negative outcome for the evidence gate.
    # Best-effort async write; skipped when no loop is running (the sync
    # counter above still records the event either way).
    try:
        import asyncio

        loop = asyncio.get_running_loop()
        if loop and org_id:

            async def _record() -> None:
                try:
                    from eden.promotion.outcome_records import (
                        record_guardrail_outcome,
                    )

                    await record_guardrail_outcome(
                        org_id,
                        "trajectory_guardrail",
                        outcome_success=False,
                        metric_delta={"source": source, "event": "bypass_detected"},
                    )
                except Exception:  # noqa: BLE001
                    pass

            loop.create_task(_record())
    except RuntimeError:
        pass
    logger.critical(
        "guardrails: evaluate_and_act bypass detected (source=%s org=%s) — "
        "response tagged feature=trajectory_guardrail. The real "
        "content-safety check (prompt injection / PII / hallucination / "
        "content policy) did NOT run; a cost/loop/latency check ran in "
        "its place. This is the signature of the removed "
        "install_cat15_trajectory_replaces_intervention monkey-patch.",
        source,
        org_id or "unknown",
    )
    return True


def get_guardrail_bypass_counts() -> dict[str, int]:
    """Cumulative bypass-detection counts, keyed ``"<source>:<org_id>"``. For ``/metrics``."""
    return dict(_guardrail_bypass_counts)


# ─── LegacyEvalToGuardrailLink (non-enforcing, FEAT-34/37) ───────
#
# Historical Cat 15 promotion shim kept for callers that still import
# from this module. Writes ``judge_link`` policies that
# :meth:`InterventionEngine.evaluate_and_act` never enforces (see
# :data:`_ENFORCED_POLICY_TYPES`). For production promotion/demotion
# use :class:`eden.evaluation.eval_intel.integration.EvalToGuardrailLink`.


class LegacyEvalToGuardrailLink:
    """Non-enforcing eval-to-guardrail record keeper (legacy).

    .. deprecated::
        Use :class:`eden.evaluation.eval_intel.integration.EvalToGuardrailLink`
        for production promotion — it hot-reloads the live gateway filter.
        This class only persists a ``judge_link`` row that
        :meth:`InterventionEngine.evaluate_and_act` explicitly does
        **not** enforce.
    """

    name = "legacy_eval_to_guardrail"

    async def promote(
        self,
        org_id: str,
        *,
        judge_name: str,
        threshold: float,
    ) -> dict[str, Any]:
        """Write a ``judge_link`` policy row (not enforced by evaluate_and_act)."""
        import json

        from eden.evaluation.eval_intel._common import _insert_guardrail_policy

        if not isinstance(judge_name, str) or not judge_name.strip():
            return _ok_envelope(
                self.name,
                {
                    "status": "error",
                    "message": "judge_name must be a non-empty string",
                },
            )
        judge_name = judge_name.strip()[:64]
        spec = {"judge_name": judge_name, "threshold": float(threshold)}
        policy_id = await _insert_guardrail_policy(
            org_id,
            name=f"judge_link:{judge_name}@{threshold}",
            type_="judge_link",
            spec_json=json.dumps(spec),
            action="block_if_below",
            status="active",
        )
        if policy_id is None:
            return _ok_envelope(
                self.name,
                {
                    "status": "error",
                    "message": "guardrail policy insert failed",
                },
            )
        await _insert_eval_to_guardrail_link(
            org_id,
            judge_name=judge_name,
            guardrail_policy_id=policy_id,
            threshold=threshold,
            status="active",
        )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "guardrail_policy_id": policy_id,
                "judge_name": judge_name,
                "threshold": threshold,
                "type": "judge_link",
                "enforced_by_evaluate_and_act": False,
                "status": "active",
            },
        )

    async def demote(
        self,
        org_id: str,
        *,
        judge_name: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """Disable promoted judge rows (DB only — no live filter reload)."""
        result = await _disable_eval_guardrail_link(
            org_id, judge_name=judge_name, reason=reason,
        )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "judge_name": judge_name,
                "disabled": bool(result.get("disabled")),
                "policy_ids": result.get("policy_ids") or [],
                "link_ids": result.get("link_ids") or [],
                "reason": reason,
            },
        )


# ─── InterventionLog ────────────────────────────────────────────


class InterventionLog:
    """Read the log of decisions.

    Queries ``intervention_log`` for the org. The default
    window is 7 days; the caller can override via the
    ``since`` field (ISO-8601).
    """

    name = "intervention_log"

    async def query(
        self,
        org_id: str,
        *,
        limit: int = 50,
        since: str | None = None,
    ) -> dict[str, Any]:
        """List intervention log rows for the org."""
        since_dt: datetime | None = None
        if since:
            try:
                since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            except ValueError:
                since_dt = None
        try:
            rows = await _fetch_intervention_log(
                org_id, limit=limit, since=since_dt
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("intervention_log: fetch failed: %s", exc)
            rows = []
        return _ok_envelope(
            self.name,
            {"log": rows, "count": len(rows)},
        )


# ─── GuardrailMetrics ────────────────────────────────────────────


class GuardrailMetrics:
    """Dashboard counters.

    Computes per-org, per-policy, per-action aggregates over
    ``intervention_log`` for the last 7 days. The data is
    cheap to compute (a single ``fetch`` + in-memory reduce)
    so the dashboard hits this on every render.

    FEAT-38: ``intervention_log`` is the canonical audit trail for
    ``InterventionEngine.evaluate_and_act`` only. The removed
    trajectory-hot-path bypass (``feature=trajectory_guardrail``) never
    wrote here. Any future customer-facing metrics UI must read this
    table (or this class) and must reject payloads carrying the bypass
    marker — same rule as :func:`record_guardrail_bypass_if_detected`.
    """

    name = "guardrail_metrics"

    async def dashboard(
        self,
        org_id: str,
    ) -> dict[str, Any]:
        """Return the org's guardrail dashboard payload."""
        try:
            rows = await _fetch_intervention_log(
                org_id, limit=10_000, since=None
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("metrics: fetch failed: %s", exc)
            rows = []

        total = len(rows)
        by_action: dict[str, int] = {}
        by_policy: dict[str, int] = {}
        redacted = 0
        for r in rows:
            v = r.get("verdict", "allow")
            by_action[v] = by_action.get(v, 0) + 1
            pid = r.get("policy_id") or "none"
            by_policy[str(pid)] = by_policy.get(str(pid), 0) + 1
            if r.get("edited_text"):
                redacted += 1

        return _ok_envelope(
            self.name,
            {
                "total_interventions": total,
                "by_action": by_action,
                "by_policy": by_policy,
                "redactions": redacted,
                "window_days": 7,
            },
        )
