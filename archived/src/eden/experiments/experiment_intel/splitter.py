"""Cat 12 — :class:`TrafficSplitter`.

A/B/n traffic splitting at the user level. The splitter
assigns a user to a variant deterministically (the same user
on the same experiment always lands on the same variant),
reads the variant weights from the persisted
``experiment_traffic_splits`` row, and persists new splits
on creation.

The default behaviour is a **fixed** split (``control``
vs ``treatment``) — the v1 appendix recommendation. A v2.1
upgrade path (multi-armed bandit with epsilon-greedy or
Thompson sampling) is in the open-questions section of the
appendix.

Routes exposed:

* ``POST /orgs/{org_id}/intelligence/experiments/split`` —
  assign a user to a variant for an experiment id
  (``variant_id`` = ``"control" | "treatment" | <custom>``)
* ``POST /orgs/{org_id}/intelligence/experiments/traffic-split`` —
  create a new traffic split (writes the row in
  ``experiment_traffic_splits`` so subsequent ``split``
  calls honour the weights)
* ``GET  /orgs/{org_id}/intelligence/experiments/traffic-split/{exp_id}`` —
  list the variants and weights for an experiment

The service degrades gracefully when its dependencies are
missing or empty — a missing traffic-split row falls back to
an even 50/50 split between control and treatment, so the
route is always callable in a test / preview environment.

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.experiments._common import (
    _assign_variant_by_weight,
    _fetch_traffic_splits,
    _upsert_traffic_split,
    empty_envelope,
    experiment_id,
    ok_envelope,
)

logger = logging.getLogger(__name__)


#: Default split when the DB has no row for the experiment.
#: Matches the canary-deploy convention: 99% control / 1%
#: treatment, which is the canary's safe default.
DEFAULT_CONTROL_WEIGHT: float = 0.99
DEFAULT_TREATMENT_WEIGHT: float = 0.01


class TrafficSplitter:
    """A/B/n traffic splitting at the user level.

    The :class:`name` is ``"traffic_splitter"`` and matches
    the ``feature`` field in the response envelope. All
    public methods return the live envelope on success.
    """

    name = "traffic_splitter"

    async def split(
        self,
        org_id: str,
        *,
        experiment_id: str | None = None,
        name: str | None = None,
        user_id: str,
    ) -> dict[str, Any]:
        """Assign a ``user_id`` to a variant for ``experiment_id``.

        The caller may pass either an explicit
        ``experiment_id`` (the persistent row id) or a
        ``name`` (a friendly name we hash into a stable id
        for first-time traffic splits). When both are
        provided, ``experiment_id`` wins. The variant is
        looked up in :data:`experiment_traffic_splits`; if
        the row is missing, we fall back to the
        :data:`DEFAULT_CONTROL_WEIGHT` /
        :data:`DEFAULT_TREATMENT_WEIGHT` split so the route
        is always usable in a preview environment.

        Returns the live envelope with
        ``{experiment_id, variant_id, bucket}`` data.
        """
        if not user_id:
            return empty_envelope(
                self.name,
                message="user_id is required",
            )
        exp_id = experiment_id or (
            experiment_id_str(org_id, name) if name else None
        )
        if not exp_id:
            return empty_envelope(
                self.name,
                message="experiment_id or name is required",
            )
        rows = await _fetch_traffic_splits(org_id, exp_id)
        if not rows:
            # Persist a default split so subsequent calls
            # are deterministic. The persist is best-effort.
            await _upsert_traffic_split(
                org_id=org_id, exp_id=exp_id,
                name=name or exp_id,
                control_version="default",
                treatment_version="default",
                control_weight=DEFAULT_CONTROL_WEIGHT,
                treatment_weight=DEFAULT_TREATMENT_WEIGHT,
                duration_hours=24,
                stopping_rule="auto",
            )
            rows = await _fetch_traffic_splits(org_id, exp_id) or [
                {"variant_id": "control", "weight": DEFAULT_CONTROL_WEIGHT},
                {"variant_id": "treatment", "weight": DEFAULT_TREATMENT_WEIGHT},
            ]
        # Sort the rows so the assignment is reproducible
        # across calls (Postgres doesn't guarantee
        # row-order on a partial index).
        sorted_rows = sorted(rows, key=lambda r: r.get("variant_id", ""))
        variants = [
            (str(r.get("variant_id") or ""), float(r.get("weight") or 0.0))
            for r in sorted_rows
        ]
        # Drop empty variant ids.
        variants = [(vid, w) for vid, w in variants if vid]
        if not variants:
            variants = [
                ("control", DEFAULT_CONTROL_WEIGHT),
                ("treatment", DEFAULT_TREATMENT_WEIGHT),
            ]
        variant_id = _assign_variant_by_weight(
            user_id=user_id, experiment_id_str=exp_id, variants=variants,
        )
        total = sum(w for _, w in variants)
        bucket = _bucket_fraction(
            user_id=user_id, experiment_id_str=exp_id, total=total,
        )
        return ok_envelope(
            self.name,
            data={
                "experiment_id": exp_id,
                "user_id": user_id,
                "variant_id": variant_id,
                "bucket": round(bucket, 6),
                "weights": [
                    {"variant_id": vid, "weight": w}
                    for vid, w in variants
                ],
            },
        )

    async def create_split(
        self,
        org_id: str,
        *,
        name: str,
        control_version: str,
        treatment_version: str,
        control_weight: float = DEFAULT_CONTROL_WEIGHT,
        treatment_weight: float = DEFAULT_TREATMENT_WEIGHT,
        duration_hours: int = 24,
        stopping_rule: str = "auto",
    ) -> dict[str, Any]:
        """Create (or replace) a traffic split.

        Writes a row in
        :data:`experiment_traffic_splits` with the variant
        weights. The next ``split`` call will honour the
        new weights. Idempotent on ``(org_id, name)``.
        """
        if not name:
            return empty_envelope(
                self.name,
                message="name is required",
            )
        if control_weight < 0 or treatment_weight < 0:
            return empty_envelope(
                self.name,
                message="weights must be non-negative",
            )
        if control_weight + treatment_weight <= 0:
            return empty_envelope(
                self.name,
                message="control_weight + treatment_weight must be > 0",
            )
        if stopping_rule not in {"auto", "manual"}:
            return empty_envelope(
                self.name,
                message="stopping_rule must be 'auto' or 'manual'",
            )
        exp_id = experiment_id(org_id, name)
        await _upsert_traffic_split(
            org_id=org_id, exp_id=exp_id, name=name,
            control_version=control_version,
            treatment_version=treatment_version,
            control_weight=float(control_weight),
            treatment_weight=float(treatment_weight),
            duration_hours=int(duration_hours),
            stopping_rule=stopping_rule,
        )
        return ok_envelope(
            self.name,
            data={
                "experiment_id": exp_id,
                "name": name,
                "control_version": control_version,
                "treatment_version": treatment_version,
                "control_weight": float(control_weight),
                "treatment_weight": float(treatment_weight),
                "duration_hours": int(duration_hours),
                "stopping_rule": stopping_rule,
                "status": "active",
            },
        )

    async def list_splits(
        self,
        org_id: str,
        *,
        experiment_id: str | None = None,
        name: str | None = None,
    ) -> dict[str, Any]:
        """List the variants and weights for an experiment.

        The caller may pass either an explicit
        ``experiment_id`` or a ``name`` (we hash the name
        into a stable id, matching the ``create_split``
        path).
        """
        exp_id = experiment_id or (
            experiment_id_str(org_id, name) if name else None
        )
        if not exp_id:
            return empty_envelope(
                self.name,
                message="experiment_id or name is required",
                data={"variants": []},
            )
        rows = await _fetch_traffic_splits(org_id, exp_id)
        if not rows:
            return empty_envelope(
                self.name,
                message="no traffic split for that experiment",
                data={"experiment_id": exp_id, "variants": []},
            )
        return ok_envelope(
            self.name,
            data={
                "experiment_id": exp_id,
                "variants": [
                    {
                        "variant_id": str(r.get("variant_id")),
                        "weight": float(r.get("weight") or 0.0),
                        "status": str(r.get("status") or "active"),
                    }
                    for r in rows
                ],
            },
        )


# ── Private helpers ───────────────────────────────────────────────────


def experiment_id_str(org_id: str, name: str | None) -> str | None:
    """Hash a friendly name into the same id ``create_split``
    would have produced. Centralised so the read and write
    paths never disagree on the id derivation."""
    if not name:
        return None
    return experiment_id(org_id, name)


def _bucket_fraction(
    *, user_id: str, experiment_id_str: str, total: float,
) -> float:
    """The unit-interval bucket the user landed in, scaled to
    the total weight. Returned as a stable float for
    debugging."""
    from eden.experiments._common import _hash_to_unit_interval
    return _hash_to_unit_interval(experiment_id_str, user_id) * total


# Re-export so the route module can resolve the id helper
# without reaching into :mod:`eden.experiments._common`.
__all__ = [
    "DEFAULT_CONTROL_WEIGHT",
    "DEFAULT_TREATMENT_WEIGHT",
    "TrafficSplitter",
]
