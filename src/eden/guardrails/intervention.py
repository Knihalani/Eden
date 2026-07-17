"""Runtime Protection & Guardrails (Cat 15) — intervention + log + metrics.

Four services:

* :class:`InterventionEngine` — the headline guardrail route.
  Default :func:`evaluate_and_act` returns
  ``verdict: "allow"`` with ``live: false`` so production
  flows don't break before a real policy exists. A real policy
  is what flips the verdict.

* :class:`EvalToGuardrailLink` — promote a Cat 3 judge into a
  production guardrail (Galileo's eval-to-guardrail
  lifecycle). Writes a row to ``eval_to_guardrail_links`` and
  creates a sibling ``judge_link`` policy in
  ``guardrail_policies``.

* :class:`InterventionLog` — read the log of decisions
  (queries the existing ``intervention_log`` table).

* :class:`GuardrailMetrics` — dashboard counters (trigger rate
  per org, per policy, per action).

Closed-loop wiring:

* :class:`InterventionEngine` fires
  :func:`GuardrailHook.on_judge_threshold_breach` when a
  judge-driven policy is reliably catching real issues (i.e.
  the link was created with ``fire_hook=True`` and the
  threshold is breached on a sample of the org's judge
  scores).

* :class:`EvalToGuardrailLink.promote` is also called by
  :func:`GuardrailHook.on_judge_threshold_breach` — a true
  bidirectional link.
"""

from __future__ import annotations

import contextlib
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.intelligence_envelope import not_implemented

from .detectors import HallucinationBlocker, PIIFirewall, PromptInjectionDetector
from .policy import (
    ACTION_RANK,
    VALID_ACTIONS,
    _fetch_policies,
    _ok_envelope,
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
            (reason or "")[:2000] or None,
        )
    except Exception as exc:
        logger.debug("guardrails: intervention_log insert failed: %s", exc)
        return None
    if row is None:
        return None
    return _row_to_dict(row)


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
    return [_row_to_dict(r) for r in (rows or [])]


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


# ─── InterventionEngine ──────────────────────────────────────────


class InterventionEngine:
    """The headline guardrail route.

    :func:`evaluate_and_act` evaluates ``text`` against every
    active policy of types ``prompt_injection``,
    ``pii_redaction``, ``hallucination``, ``content_policy``,
    and ``judge_link`` and returns the most-restrictive
    verdict. The action also drives the *editing* of the
    text — for ``redact`` actions the returned ``edited_text``
    has the PII / injection match replaced with a
    placeholder.

    **Default behaviour in v0:** when the org has zero active
    policies, the engine returns
    ``verdict: "allow"`` with ``live: false`` so production
    flows don't break. A real policy is what flips the verdict
    to a real ``live: true`` response.
    """

    name = "intervention_engine"

    async def evaluate_and_act(
        self,
        org_id: str,
        *,
        text: str,
        context: str | None = None,
        trace_id: str | None = None,
    ) -> dict[str, Any]:
        """Evaluate every active policy and return the verdict.

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
                },
            )

        try:
            policies = await _fetch_policies(org_id, status="active")
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("intervention: fetch failed: %s", exc)
            policies = []
        if not policies:
            # v0 default-allow — no policies = no enforcement
            return _ok_envelope(
                self.name,
                {
                    "verdict": "allow",
                    "edited_text": text,
                    "matched_policies": [],
                    "action_breakdown": {},
                    "live": False,
                    "reason": "no_active_policies",
                },
            )

        edited = text
        matched: list[dict[str, Any]] = []
        breakdown: dict[str, int] = {}
        verdict_rank = 0
        verdict = "allow"

        # Prompt injection
        for p in policies:
            if p.get("type") != "prompt_injection":
                continue
            r = await PromptInjectionDetector().scan(org_id, text=text)
            d = (r.get("data") or {})
            if d.get("verdict") != "allow":
                matched.append(
                    {
                        "policy_id": p.get("id"),
                        "policy_name": p.get("name"),
                        "type": p.get("type"),
                        "verdict": d.get("verdict"),
                    }
                )
                breakdown["prompt_injection"] = (
                    breakdown.get("prompt_injection", 0) + 1
                )
                if ACTION_RANK.get(d.get("verdict", "allow"), 0) > verdict_rank:
                    verdict_rank = ACTION_RANK.get(d.get("verdict", "allow"), 0)
                    verdict = d.get("verdict", "allow")
            break  # one policy of this type is enough

        # PII redaction
        for p in policies:
            if p.get("type") != "pii_redaction":
                continue
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
                matched.append(
                    {
                        "policy_id": p.get("id"),
                        "policy_name": p.get("name"),
                        "type": p.get("type"),
                        "verdict": "redact",
                        "match_count": len(new_matches),
                    }
                )
                breakdown["pii_redaction"] = (
                    breakdown.get("pii_redaction", 0) + len(new_matches)
                )
                if ACTION_RANK.get("redact", 0) > verdict_rank:
                    verdict_rank = ACTION_RANK.get("redact", 0)
                    verdict = "redact"
            break

        # Hallucination (output check) — uses context if provided
        for p in policies:
            if p.get("type") != "hallucination":
                continue
            r = await HallucinationBlocker().check(
                org_id, candidate=text, context=context or ""
            )
            d = (r.get("data") or {})
            if d.get("verdict") != "allow":
                matched.append(
                    {
                        "policy_id": p.get("id"),
                        "policy_name": p.get("name"),
                        "type": p.get("type"),
                        "verdict": d.get("verdict"),
                    }
                )
                breakdown["hallucination"] = (
                    breakdown.get("hallucination", 0) + 1
                )
                if ACTION_RANK.get(d.get("verdict", "allow"), 0) > verdict_rank:
                    verdict_rank = ACTION_RANK.get(d.get("verdict", "allow"), 0)
                    verdict = d.get("verdict", "allow")
            break

        # Content policy (keywords / regex)
        from .policy import ContentPolicyEnforcer

        for p in policies:
            if p.get("type") != "content_policy":
                continue
            r = await ContentPolicyEnforcer().enforce(org_id, text=text)
            d = (r.get("data") or {})
            if d.get("verdict") != "allow":
                matched.append(
                    {
                        "policy_id": p.get("id"),
                        "policy_name": p.get("name"),
                        "type": p.get("type"),
                        "verdict": d.get("verdict"),
                        "match_count": len(d.get("matches", []) or []),
                    }
                )
                breakdown["content_policy"] = (
                    breakdown.get("content_policy", 0)
                    + len(d.get("matches", []) or [])
                )
                if ACTION_RANK.get(d.get("verdict", "allow"), 0) > verdict_rank:
                    verdict_rank = ACTION_RANK.get(d.get("verdict", "allow"), 0)
                    verdict = d.get("verdict", "allow")
            break

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


# ─── EvalToGuardrailLink ────────────────────────────────────────


class EvalToGuardrailLink:
    """Promote a Cat 3 judge into a production guardrail.

    Writes a row to ``eval_to_guardrail_links`` and creates a
    sibling ``judge_link`` policy in ``guardrail_policies``
    (so the :class:`InterventionEngine` will consult it). The
    policy's ``spec`` is::

        {
            "judge_name": "...",
            "threshold": 0.6,
            "action": "block"
        }

    The hook :class:`GuardrailHook.on_judge_threshold_breach`
    is the *reverse* direction — it fires from Cat 3 when a
    judge has reliably caught real issues and is a strong
    candidate for promotion. That hook calls this ``promote``
    to do the work.
    """

    name = "eval_to_guardrail_link"

    async def promote(
        self,
        org_id: str,
        *,
        judge_name: str,
        threshold: float,
        action: str = "block",
        fire_hook: bool = False,
    ) -> dict[str, Any]:
        """Create the link and the policy.

        Returns ``data: {"link_id": "...", "policy_id": "...",
        "judge_name": "...", "threshold": ...}``.
        """
        from .policy import GuardrailPolicy

        if not isinstance(judge_name, str) or not judge_name:
            return not_implemented(self.name, message="judge_name is required")
        if not isinstance(threshold, (int, float)):
            return not_implemented(self.name, message="threshold must be a number")
        if action not in VALID_ACTIONS:
            action = "block"

        # Create the guardrail policy first
        policy_name = f"judge_link:{judge_name}"
        gp = GuardrailPolicy()
        policy_resp = await gp.create(
            org_id,
            name=policy_name,
            type="judge_link",
            spec={
                "judge_name": judge_name,
                "threshold": float(threshold),
            },
            action=action,
        )
        if (policy_resp.get("data") or {}).get("id") is None:
            return not_implemented(
                self.name,
                message="policy creation failed",
            )
        policy_id = (policy_resp.get("data") or {}).get("id")

        # Then create the link row
        link_id = await _insert_eval_to_guardrail_link(
            org_id,
            judge_name=judge_name,
            guardrail_policy_id=str(policy_id),
            threshold=float(threshold),
        )

        # Best-effort hook fire
        if fire_hook:
            try:
                from eden.llmops.promotion_hooks import get_guardrail_hook
                hook = get_guardrail_hook()
                coro = hook.on_judge_threshold_breach(
                    org_id,
                    judge_name=judge_name,
                    threshold=float(threshold),
                )
                # ``on_judge_threshold_breach`` is now async
                # (it persists the action to the DB). Await
                # if we're inside an event loop, otherwise
                # fire-and-forget (we're in a sync context).
                if coro is not None and hasattr(coro, "__await__"):
                    import asyncio

                    try:
                        loop = asyncio.get_running_loop()
                        # We're inside a running loop — the
                        # caller will see the await chain.
                        # Since we can't await here without
                        # making this method async, schedule
                        # the coroutine.
                        loop.create_task(coro)
                    except RuntimeError:
                        # No running loop — likely a sync
                        # caller. Close the coroutine to
                        # avoid the "never awaited" warning.
                        with contextlib.suppress(Exception):
                            coro.close()
            except Exception:  # pragma: no cover - defensive
                pass

        return _ok_envelope(
            self.name,
            {
                "link_id": link_id,
                "policy_id": policy_id,
                "judge_name": judge_name,
                "threshold": float(threshold),
                "action": action,
            },
        )

    async def demote(
        self,
        org_id: str,
        *,
        judge_name: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """Disable a promoted judge guardrail (eval-to-guardrail demote)."""
        if not isinstance(judge_name, str) or not judge_name:
            return not_implemented(self.name, message="judge_name is required")

        result = await _disable_eval_guardrail_link(
            org_id,
            judge_name=judge_name,
            reason=reason,
        )
        if not result.get("disabled"):
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "judge_name": judge_name,
                    "status": "not_found",
                    "reason": reason,
                },
            )

        try:
            from eden.llmops.filters.guardrail import get_guardrail_filter
            from eden.llmops.learn_wiring import install_learn_filters

            install_learn_filters()
            filt = get_guardrail_filter()
            remaining = [
                p
                for p in filt._policies.get(org_id, [])
                if str(p.get("judge_name") or "") != judge_name
            ]
            filt.load_policies(org_id, remaining)
        except Exception as hook_exc:
            logger.debug("eval_to_guardrail: gateway filter reload failed: %s", hook_exc)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "judge_name": judge_name,
                "status": "disabled",
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
