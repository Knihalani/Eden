"""DeterministicJudgeRegistry — CRUD for deterministic judges backed by the
metric_studio custom-metrics store (W4-4, plan item 9.10).

A *deterministic judge* is a named eval rule that runs one of the
playground scorer functions (``exact_match``, ``regex``, ``json_valid``,
etc.) against a payload without calling any LLM. Judge definitions are
stored as ``kind: deterministic`` entries in the per-org
``organizations.settings.custom_metrics`` JSONB array — the same store
used by :class:`CustomMetricRegistry` — with an extra ``scorer_config``
field that carries the scorer type and any type-specific parameters.

Lifecycle
---------
Deterministic judges have two states:
* **active** — the default on creation; the judge is available for
  execution.
* **archived** — set by :meth:`delete` (soft-delete); the entry stays
  in the store for audit purposes but is excluded from :meth:`list` by
  default.

Persistence shape (one entry in ``custom_metrics``)::

    {
        "judge_id":    "djudge_<hex12>",
        "name":        "No-secrets check",
        "kind":        "deterministic",
        "scorer_type": "regex",
        "scorer_config": {"pattern": "sk_(live|test)_[A-Za-z0-9]{20,}"},
        "status":      "active",
        "created_at":  "<iso8601>",
        "created_by":  "user@example.com",
    }

See plan item 9.10 and ``docs/docs/how-to/judges.md``.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from ._common import (
    _load_org_custom_metrics,
    _ok_envelope,
    _save_org_custom_metrics,
    _validation_envelope,
)

logger = logging.getLogger(__name__)

# The scorer types that are deterministic (no LLM call).
# ``llm_judge`` is intentionally excluded — it delegates to the
# LLM-as-judge path and must not be registered as a deterministic
# judge.
DETERMINISTIC_SCORER_TYPES: frozenset[str] = frozenset(
    {
        "exact_match",
        "contains",
        "icontains",
        "regex",
        "json_valid",
        "levenshtein_ratio",
    }
)


class DeterministicJudgeRegistry:
    """Create / list / get / delete deterministic judges.

    Each method returns the same ``_ok_envelope`` shape used by the
    rest of the metric_studio surface so the portal can render
    responses uniformly.
    """

    name = "deterministic_judge_registry"

    # ── write operations (admin-gated at the route layer) ───────────

    async def create(
        self,
        org_id: str,
        *,
        name: str,
        scorer_type: str,
        scorer_config: dict[str, Any] | None = None,
        created_by: str | None = None,
    ) -> dict[str, Any]:
        """Register a new deterministic judge.

        Validation:
        * ``name`` must be non-empty.
        * ``scorer_type`` must be one of :data:`DETERMINISTIC_SCORER_TYPES`.
        * ``regex`` scorer requires a non-empty ``pattern`` in
          ``scorer_config``.

        Returns the live envelope with ``judge_id``.
        """
        name = (name or "").strip()
        if not name:
            return _validation_envelope(self.name, "name is required")

        scorer_type = (scorer_type or "").strip()
        if scorer_type not in DETERMINISTIC_SCORER_TYPES:
            valid = sorted(DETERMINISTIC_SCORER_TYPES)
            return _validation_envelope(
                self.name,
                f"scorer_type must be one of {valid}; got {scorer_type!r}",
            )

        # Type-specific validation
        cfg = dict(scorer_config or {})
        if scorer_type == "regex" and not (cfg.get("pattern") or "").strip():
            return _validation_envelope(
                self.name,
                "scorer_type=regex requires scorer_config.pattern",
            )

        judge_id = f"djudge_{uuid.uuid4().hex[:12]}"
        created_at = datetime.now(UTC).isoformat()

        entry: dict[str, Any] = {
            "judge_id": judge_id,
            "name": name,
            "kind": "deterministic",
            "scorer_type": scorer_type,
            "scorer_config": cfg,
            "status": "active",
            "created_at": created_at,
            "created_by": created_by or "",
        }

        metrics = await _load_org_custom_metrics(org_id)
        metrics.append(entry)
        await _save_org_custom_metrics(org_id, metrics)

        return _ok_envelope(
            self.name,
            {
                "created": True,
                "judge_id": judge_id,
                "name": name,
                "kind": "deterministic",
                "scorer_type": scorer_type,
                "scorer_config": cfg,
                "status": "active",
                "created_at": created_at,
            },
        )

    async def delete(
        self,
        org_id: str,
        judge_id: str,
    ) -> dict[str, Any]:
        """Soft-delete a deterministic judge (sets status → archived).

        No-op if the judge is already archived. Returns 404-style
        data when the judge does not exist.
        """
        metrics = await _load_org_custom_metrics(org_id)
        target: dict[str, Any] | None = None
        for m in metrics:
            if m.get("judge_id") == judge_id and m.get("kind") == "deterministic":
                target = m
                break

        if target is None:
            return _ok_envelope(
                self.name,
                {
                    "deleted": False,
                    "found": False,
                    "judge_id": judge_id,
                },
            )

        if target.get("status") == "archived":
            return _ok_envelope(
                self.name,
                {
                    "deleted": True,
                    "already_archived": True,
                    "judge_id": judge_id,
                },
            )

        target["status"] = "archived"
        target["archived_at"] = datetime.now(UTC).isoformat()
        await _save_org_custom_metrics(org_id, metrics)

        return _ok_envelope(
            self.name,
            {
                "deleted": True,
                "judge_id": judge_id,
                "status": "archived",
            },
        )

    # ── read operations ─────────────────────────────────────────────

    async def list(
        self,
        org_id: str,
        *,
        include_archived: bool = False,
    ) -> dict[str, Any]:
        """List all deterministic judges for the org.

        Excludes archived judges by default. Pass
        ``include_archived=True`` to include them.
        """
        metrics = await _load_org_custom_metrics(org_id)
        judges = [
            m
            for m in metrics
            if m.get("kind") == "deterministic"
            and (include_archived or m.get("status") != "archived")
        ]
        # Newest first
        judges.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return _ok_envelope(
            self.name,
            {"judges": judges, "count": len(judges)},
        )

    async def get(
        self,
        org_id: str,
        judge_id: str,
    ) -> dict[str, Any]:
        """Return a single deterministic judge by id."""
        metrics = await _load_org_custom_metrics(org_id)
        for m in metrics:
            if m.get("judge_id") == judge_id and m.get("kind") == "deterministic":
                return _ok_envelope(
                    self.name,
                    {"judge": m, "found": True},
                )
        return _ok_envelope(
            self.name,
            {"judge": None, "found": False, "judge_id": judge_id},
        )

    # ── execution ────────────────────────────────────────────────────

    async def execute(
        self,
        org_id: str,
        judge_id: str,
        *,
        output: str,
        expected: str | None = None,
        input_text: str | None = None,
    ) -> dict[str, Any]:
        """Run a deterministic judge against a payload.

        Executes the registered scorer function in-process — no LLM
        call, no I/O (beyond loading the judge definition). The score
        is returned immediately.

        ``output`` is the model response to evaluate.
        ``expected`` is the reference value for scorers that need it
        (``exact_match``, ``contains``, ``levenshtein_ratio``).
        ``input_text`` is passed to the scorer spec for context.
        """
        from eden.playground.scorers import run_scorers

        metrics = await _load_org_custom_metrics(org_id)
        target: dict[str, Any] | None = None
        for m in metrics:
            if m.get("judge_id") == judge_id and m.get("kind") == "deterministic":
                target = m
                break

        if target is None:
            return _ok_envelope(
                self.name,
                {
                    "executed": False,
                    "found": False,
                    "judge_id": judge_id,
                },
            )

        if target.get("status") == "archived":
            return _ok_envelope(
                self.name,
                {
                    "executed": False,
                    "found": True,
                    "judge_id": judge_id,
                    "reason": "judge is archived",
                },
            )

        scorer_type = target.get("scorer_type", "")
        scorer_config = dict(target.get("scorer_config") or {})
        # Build the scorer spec in the same shape run_scorers expects.
        spec: dict[str, Any] = {"type": scorer_type, **scorer_config}

        results = run_scorers(
            [spec],
            output=str(output or ""),
            expected=expected,
            input_text=input_text,
        )
        result = results[0] if results else {"score": None, "name": scorer_type}

        return _ok_envelope(
            self.name,
            {
                "executed": True,
                "judge_id": judge_id,
                "name": target.get("name", ""),
                "scorer_type": scorer_type,
                "score": result.get("score"),
                "detail": result.get("detail"),
            },
        )
