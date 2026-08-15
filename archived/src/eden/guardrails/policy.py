"""Runtime Protection & Guardrails (Cat 15) — policy CRUD + content
policy enforcer.

This module owns the policy lifecycle for the org's guardrail
surface. A ``GuardrailPolicy`` row is the unit of opt-in: it
declares *what* to check (``type``), *how* to check it
(``spec``), and *what to do* on a match (``action``).

The 10 services in the Cat 15 surface:

* :class:`GuardrailPolicy` — CRUD for policies (type, spec, action).
* :class:`PromptInjectionDetector` — Galileo-style injection scan
  (in :mod:`eden.guardrails.detectors`).
* :class:`PIIFirewall` — Lunary-style redaction
  (in :mod:`eden.guardrails.detectors`).
* :class:`HallucinationBlocker` — Galileo-style output check
  (in :mod:`eden.guardrails.detectors`).
* :class:`ContentPolicyEnforcer` — generic content policy
  (keyword + regex) — implemented here.
* :class:`InterventionEngine` — apply the policies and choose
  ``allow`` / ``deny`` / ``edit`` action
  (in :mod:`eden.guardrails.intervention`).
* Eval-to-guardrail promotion — see
  :class:`eden.evaluation.eval_intel.integration.EvalToGuardrailLink`
  (FEAT-34 canonical implementation).
* :class:`LLMFirewall` — Lunary-style pre-LLM-call firewall
  (in :mod:`eden.guardrails.detectors`).
* :class:`InterventionLog` — query the log of decisions
  (in :mod:`eden.guardrails.intervention`).
* :class:`GuardrailMetrics` — dashboard counters
  (in :mod:`eden.guardrails.intervention`).

The v0 ship:

* **DB-backed** — every read/write goes through the existing
  ``guardrail_policies`` / ``guardrail_evaluations`` /
  ``intervention_log`` tables (created in migration 020). The
  service layer never fabricates policy state.
* **Fail-closed for** :class:`InterventionEngine` — incomplete
  / unevaluable policy sets return ``verdict: "block"`` with
  ``live: false``. Enforced detector policies flip ``live``.
* **Closed-loop wiring** — the :class:`InterventionEngine`
  fires :class:`GuardrailHook.on_judge_threshold_breach` when
  a judge-driven policy is reliably catching real issues
  (mirrors the Galileo eval-to-guardrail lifecycle).

See ``docs/eden-observability-gap-roadmap.md`` (Cat 15) and
``docs/observability-gap/15-runtime-protection-guardrails.md``.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.intelligence_envelope import not_implemented  # noqa: F401  (re-exported in tests)

logger = logging.getLogger(__name__)


# ─── Policy type / action validation ──────────────────────────────

#: Policy ``type`` is one of these canonical names. The front-end
#: uses the same enum so an unsupported type surfaces as a
#: validation error in the form, not at evaluation time.
VALID_POLICY_TYPES: frozenset[str] = frozenset(
    {
        "prompt_injection",   # Galileo-style scan on the input
        "pii_redaction",      # Lunary-style redaction
        "hallucination",      # Cat 3 judge-driven output check
        "content_policy",     # OrgAdmin keyword / regex blocklist
        "judge_link",         # EvalToGuardrailLink promoted judge
    }
)

#: Status values written to ``guardrail_policies.status`` today.
#: ``GuardrailPolicy.create`` inserts ``active``; demotion sets
#: ``disabled``. Portal cards may also surface ``shadow`` when the row
#: (or alias) is ``shadow`` / ``dry_run`` / ``monitor`` — see
#: ``_map_guardrail_status`` in ``eden.api.routes.portal``.
VALID_POLICY_STATUSES: frozenset[str] = frozenset({"active", "disabled"})

#: Policy ``action`` is one of these. The
#: :class:`InterventionEngine` returns the most-restrictive
#: action from the matched policies.
VALID_ACTIONS: frozenset[str] = frozenset(
    {"allow", "warn", "redact", "block", "escalate"}
)

#: Policy ``direction`` scopes a policy to the call sites it applies
#: to — ``"input"`` (guarding an inbound prompt), ``"output"``
#: (guarding an outbound completion), or ``"both"`` (applies
#: regardless of call direction). Matches the convention already
#: used by the in-memory ``eden.guardrails.evaluator.GuardrailPolicy``
#: dataclass. Defaults to ``"both"`` to preserve pre-existing
#: (direction-agnostic) enforcement behaviour.
VALID_DIRECTIONS: frozenset[str] = frozenset({"input", "output", "both"})

#: Action ordering — higher = more restrictive. The
#: :class:`InterventionEngine` reduces a set of matches to the
#: action at the top of the stack.
ACTION_RANK: dict[str, int] = {
    "allow": 0,
    "warn": 1,
    "redact": 2,
    "escalate": 3,
    "block": 4,
}


# ─── Postgres helpers ─────────────────────────────────────────────


async def _insert_policy(
    org_id: str,
    *,
    name: str,
    type_: str,
    spec: dict[str, Any],
    action: str,
    direction: str = "both",
) -> dict[str, Any] | None:
    """Insert a ``guardrail_policies`` row and return it.

    Returns ``None`` if the Postgres substrate is unavailable
    (test envs that don't mock it) or if the SQL raises. The
    caller turns the ``None`` into a stub envelope so the API
    never 500s on a missing optional subsystem.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("guardrails: postgres import failed: %s", exc)
        return None

    try:
        client = await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("guardrails: get_postgres_client failed: %s", exc)
        return None
    if client is None:
        return None

    policy_id = str(uuid.uuid4())
    spec_json = json.dumps(spec)
    try:
        row = await client.fetchrow(
            """
            INSERT INTO guardrail_policies
                (id, org_id, name, type, spec_json, action, direction, status)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'active')
            RETURNING id, org_id, name, type, spec_json, action,
                      direction, status, created_at
            """,
            policy_id,
            org_id,
            name[:128],
            type_[:32],
            spec_json,
            action[:16],
            (direction or "both")[:16],
        )
    except Exception as exc:
        logger.debug("guardrails: insert_policy failed: %s", exc)
        return None
    if row is None:
        return None
    return _row_to_policy(row)


async def _fetch_policies(
    org_id: str,
    *,
    status: str = "active",
) -> list[dict[str, Any]]:
    """List all policies for the org (filtered by status)."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("guardrails: postgres import failed: %s", exc)
        return []

    try:
        client = await get_postgres_client()
    except Exception:
        return []
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, name, type, spec_json, action,
                   direction, status, created_at
            FROM guardrail_policies
            WHERE org_id = $1 AND status = $2
            ORDER BY created_at DESC
            """,
            org_id, status,
        )
    except Exception as exc:
        logger.debug("guardrails: fetch_policies failed: %s", exc)
        return []
    return [_row_to_policy(r) for r in (rows or [])]


def _row_to_policy(row: Any) -> dict[str, Any]:
    """Normalise an asyncpg Record into a serialisable dict."""
    if row is None:
        return {}
    if isinstance(row, dict):
        d = dict(row)
    else:
        try:
            d = dict(row)
        except Exception:
            return {}
    spec_json = d.get("spec_json")
    if isinstance(spec_json, str) and spec_json:
        try:
            d["spec"] = json.loads(spec_json)
        except Exception:
            d["spec"] = {}
    else:
        d["spec"] = {}
    d.pop("spec_json", None)
    # Stringify UUID / datetime for JSON serialisation.
    for k in ("id", "created_at"):
        v = d.get(k)
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif v is not None and not isinstance(v, str):
            d[k] = str(v)
    return d


# ─── GuardrailPolicy (CRUD) ───────────────────────────────────────


class GuardrailPolicy:
    """CRUD for guardrail policies.

    The policy is the unit of opt-in. Creating a policy
    *activates* it (``status='active'``); the
    :class:`InterventionEngine` will then consult it on every
    ``/evaluate`` call.

    The supported types are :data:`VALID_POLICY_TYPES`. The
    supported actions are :data:`VALID_ACTIONS`. A bad
    ``type`` or ``action`` returns the ``not_implemented``
    envelope with a clear ``message`` (the route layer surfaces
    it as a 400).
    """

    name = "guardrail_policy"

    async def create(
        self,
        org_id: str,
        *,
        name: str,
        type: str,
        spec: dict[str, Any],
        action: str = "allow",
        direction: str = "both",
    ) -> dict[str, Any]:
        """Create a new active policy for the org.

        ``direction`` scopes the policy to ``"input"`` (inbound
        prompt), ``"output"`` (outbound completion), or ``"both"``
        (the default — applies regardless of call direction, which
        preserves the pre-``direction`` enforcement behaviour).

        Returns the policy row in the standard ``ok`` envelope.
        """
        if not _validate_policy_type(type):
            return not_implemented(
                self.name,
                message=(
                    f"Unknown policy type {type!r}; "
                    f"expected one of {sorted(VALID_POLICY_TYPES)}"
                ),
            )
        if not _validate_action(action):
            return not_implemented(
                self.name,
                message=(
                    f"Unknown action {action!r}; "
                    f"expected one of {sorted(VALID_ACTIONS)}"
                ),
            )
        if not _validate_direction(direction):
            return not_implemented(
                self.name,
                message=(
                    f"Unknown direction {direction!r}; "
                    f"expected one of {sorted(VALID_DIRECTIONS)}"
                ),
            )
        if not isinstance(spec, dict):
            return not_implemented(
                self.name,
                message="spec must be a JSON object",
            )

        try:
            row = await _insert_policy(
                org_id,
                name=name,
                type_=type,
                spec=spec,
                action=action,
                direction=direction,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("guardrails.create: %s", exc)
            return not_implemented(self.name, message=str(exc))
        if row is None:
            return not_implemented(
                self.name,
                message="Policy persistence unavailable",
            )
        return _ok_envelope(self.name, row)

    async def list(
        self,
        org_id: str,
    ) -> dict[str, Any]:
        """List all active policies for the org.

        Returns ``data: {"policies": [...], "count": N}`` so the
        UI can show the count in a header without a second call.
        """
        try:
            rows = await _fetch_policies(org_id, status="active")
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("guardrails.list: %s", exc)
            rows = []
        return _ok_envelope(
            self.name,
            {"policies": rows, "count": len(rows)},
        )


# ─── ContentPolicyEnforcer ────────────────────────────────────────


class ContentPolicyEnforcer:
    """OrgAdmin-defined content policy (keyword + regex blocklist).

    The policy ``spec`` is ``{"blocklist": [...]}`` where
    ``blocklist`` is a list of case-insensitive keywords / regex
    patterns. Patterns starting with ``re:`` are compiled as
    case-insensitive regex; everything else is a substring match.

    The enforcer does *not* block on its own — it returns a
    verdict so the :class:`InterventionEngine` can aggregate
    across policies. The :class:`InterventionEngine` is the
    only authority on the final action.
    """

    name = "content_policy_enforcer"

    async def enforce(
        self,
        org_id: str,
        *,
        text: str,
        direction: str = "both",
    ) -> dict[str, Any]:
        """Scan ``text`` against the org's content policies.

        ``direction`` — ``"input"`` / ``"output"`` / ``"both"`` —
        scopes which policies are consulted, same convention as
        :data:`VALID_DIRECTIONS`. ``"both"`` (the default) only
        excludes policies explicitly scoped to the *other*
        direction; it does not disable filtering — pass the
        caller's own concrete direction to restrict further.

        Returns ``data: {"matches": [...], "verdict": "allow|warn|...|block"}``.
        ``matches`` is the list of matched policy ids + the
        triggering substring; ``verdict`` is the most-restrictive
        action of all matches (``allow`` if no match).
        """
        if not isinstance(text, str) or not text:
            return _ok_envelope(
                self.name,
                {"matches": [], "verdict": "allow"},
            )

        try:
            policies = await _fetch_policies(org_id, status="active")
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("content_enforcer: fetch failed: %s", exc)
            policies = []
        content_policies = [
            p
            for p in policies
            if p.get("type") == "content_policy"
            and (direction == "both" or policy_matches_direction(p, direction))
        ]
        if not content_policies:
            return _ok_envelope(
                self.name,
                {"matches": [], "verdict": "allow"},
            )

        matches: list[dict[str, Any]] = []
        verdict_rank = 0
        verdict = "allow"
        lowered = text.lower()
        for p in content_policies:
            spec = p.get("spec") or {}
            blocklist = spec.get("blocklist") or []
            p_action = p.get("action", "allow")
            for pattern in blocklist:
                pat = str(pattern).strip()
                if not pat:
                    continue
                if pat.startswith("re:"):
                    import re

                    try:
                        rx = re.compile(pat[3:], re.IGNORECASE)
                    except re.error:
                        continue
                    m = rx.search(text)
                    if m:
                        matches.append(
                            {
                                "policy_id": p.get("id"),
                                "policy_name": p.get("name"),
                                "match_type": "regex",
                                "match_value": m.group(0)[:200],
                            }
                        )
                        if ACTION_RANK.get(p_action, 0) > verdict_rank:
                            verdict_rank = ACTION_RANK.get(p_action, 0)
                            verdict = p_action
                    continue
                # Plain keyword
                if pat.lower() in lowered:
                    matches.append(
                        {
                            "policy_id": p.get("id"),
                            "policy_name": p.get("name"),
                            "match_type": "keyword",
                            "match_value": pat,
                        }
                    )
                    if ACTION_RANK.get(p_action, 0) > verdict_rank:
                        verdict_rank = ACTION_RANK.get(p_action, 0)
                        verdict = p_action
        return _ok_envelope(
            self.name,
            {"matches": matches, "verdict": verdict},
        )


# ─── Helpers ──────────────────────────────────────────────────────


def _validate_policy_type(t: str) -> bool:
    return isinstance(t, str) and t in VALID_POLICY_TYPES


def _validate_action(a: str) -> bool:
    return isinstance(a, str) and a in VALID_ACTIONS


def _validate_direction(d: str) -> bool:
    return isinstance(d, str) and d in VALID_DIRECTIONS


def policy_matches_direction(policy: dict[str, Any], direction: str) -> bool:
    """True if ``policy`` applies to a call of the given ``direction``.

    Mirrors :func:`eden.guardrails.evaluator.evaluate`'s filter: a
    policy matches if its own ``direction`` equals the call's, or the
    policy is scoped ``"both"`` (applies regardless of call
    direction). Policies fetched before the ``direction`` column
    existed (or any row missing the field) default to ``"both"`` so
    old rows keep firing everywhere, unchanged.
    """
    p_direction = policy.get("direction") or "both"
    return p_direction == direction or p_direction == "both"


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live ok-envelope for the Cat 15 surface.

    Outer ``live`` mirrors ``data.live`` when present so fail-closed
    / unenforced paths never advertise ``live: true`` for unrestricted
    traffic. CRUD and detector paths without an explicit ``data.live``
    keep ``live: true``.
    """
    live = True
    if isinstance(data, dict) and "live" in data:
        live = bool(data["live"])
    return {
        "status": "ok",
        "feature": feature,
        "live": live,
        "timestamp": _now_iso(),
        "data": data,
    }


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()
