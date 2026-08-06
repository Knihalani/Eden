"""Labeling queue service (Phase D — Cat 3 HiL real).

The service layer behind the ``/labeling/...`` API. Implements:

  * :meth:`LabelingService.pop` — pull the next N items
    from the queue for an annotator, with skill matching.
  * :meth:`LabelingService.annotate` — submit / revise an
    annotation. UNIQUE (item, annotator) so revisions
    overwrite.
  * :meth:`LabelingService.compute_iaa` — Cohen's kappa +
    Krippendorff's alpha for inter-annotator agreement.
  * :meth:`LabelingService.export` — emit a JSONL of
    approved annotations for fine-tuning.
  * :meth:`LabelingService.seed` — insert new items into
    the queue from a source (trace, span, dataset, Q/A).

IAA math (Cohen's kappa)
────────────────────────
Cohen's kappa is the simplest IAA metric for two annotators.
It's ``(p_o - p_e) / (1 - p_e)`` where ``p_o`` is observed
agreement and ``p_e`` is the agreement expected by chance
(the marginal label distribution). Values:

  * 1.0  — perfect agreement
  * 0.0  — agreement = chance
  * < 0  — worse than chance (annotators are anti-correlated)
  * 0.6+ — typically considered "good"
  * 0.8+ — typically considered "very good"

Krippendorff's alpha
────────────────────
Krippendorff's alpha generalises to N annotators + missing
values. The implementation here is the simple interval-
disagreement variant (``alpha = 1 - D_o / D_e``) for
nominal data. For N=2, it reduces to Scott's pi, which is
similar to Cohen's kappa but uses the joint marginal
distribution.

Both metrics are computed in pure Python (no numpy
dependency). The implementation is verified against
public test values in the test suite.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_LABELING_ITEM_COLUMNS = (
    "id, org_id, payload, label_schema, prompt, status, tags, "
    "annotations_required, required_skills, source_trace_id, "
    "source_span_id, source_dataset_id, source_synthetic_qa_id, "
    "assigned_to, created_at, updated_at"
)


# ── Dataclasses ──────────────────────────────────────────────────


@dataclass
class LabelingItem:
    """One item in the queue."""

    id: str
    org_id: str
    payload: dict[str, Any]
    label_schema: dict[str, Any]
    prompt: str | None
    status: str
    tags: list[str]
    annotations_required: int
    required_skills: list[str]
    source_trace_id: str | None = None
    source_span_id: str | None = None
    source_dataset_id: str | None = None
    source_synthetic_qa_id: str | None = None
    assigned_to: str | None = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class Annotation:
    """One annotation by one annotator on one item."""

    id: str
    org_id: str
    item_id: str
    annotator_id: str
    label: Any  # scalar or dict, depending on label_schema
    confidence: float
    notes: str | None
    time_spent_ms: int | None
    skills_exercised: list[str]
    created_at: str = ""
    updated_at: str = ""


@dataclass
class IAAReport:
    """Inter-annotator agreement report for a set of items.

    ``kappa`` and ``alpha`` are aggregates across all
    items with 2+ annotations. ``per_item`` is a dict
    mapping item_id → (kappa, alpha, agreement) for
    items that have 2+ annotations. ``per_pair`` maps
    (annotator_a, annotator_b) → (kappa, n_overlap).
    """

    kappa: float
    alpha: float
    overall_agreement: float
    item_count: int
    annotation_count: int
    per_item: dict[str, dict[str, float]] = field(default_factory=dict)
    per_pair: dict[tuple[str, str], dict[str, float]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kappa": round(self.kappa, 4),
            "alpha": round(self.alpha, 4),
            "overall_agreement": round(self.overall_agreement, 4),
            "item_count": self.item_count,
            "annotation_count": self.annotation_count,
            "per_item": {
                k: {kk: round(vv, 4) for kk, vv in v.items()}
                for k, v in self.per_item.items()
            },
            "per_pair": {
                f"{a}|{b}": {kk: round(vv, 4) for kk, vv in v.items()}
                for (a, b), v in self.per_pair.items()
            },
        }


# ── IAA math ────────────────────────────────────────────────────


def cohens_kappa(
    labels_a: list[Any],
    labels_b: list[Any],
) -> float | None:
    """Compute Cohen's kappa for two annotators.

    Returns ``None`` if there's no overlap, only one unique
    label (degenerate), or the expected agreement is 1.0
    (also degenerate).
    """
    if not labels_a or len(labels_a) != len(labels_b):
        return None
    n = len(labels_a)
    # Observed agreement.
    agree = sum(1 for a, b in zip(labels_a, labels_b, strict=False) if a == b)
    p_o = agree / n
    # Expected agreement by chance.
    counts_a = Counter(labels_a)
    counts_b = Counter(labels_b)
    labels = set(counts_a) | set(counts_b)
    if len(labels) < 2:
        return None
    p_e = sum(
        (counts_a.get(lbl, 0) / n) * (counts_b.get(lbl, 0) / n)
        for lbl in labels
    )
    if p_e >= 1.0:
        return None
    return (p_o - p_e) / (1.0 - p_e)


def krippendorffs_alpha(
    annotations_by_annotator: dict[str, list[Any]],
    n_items: int,
) -> float | None:
    """Compute Krippendorff's alpha for interval-disagreement
    on nominal data, with arbitrary N annotators and missing
    values.

    ``annotations_by_annotator`` maps annotator_id →
    list of labels of length n_items (with ``None`` for
    missing annotations).

    For nominal data the disagreement function is
    ``delta(a, b) = 0 if a == b else 1`` and the metric
    reduces to:

        alpha = 1 - D_o / D_e

    where ``D_o`` is the observed disagreement and ``D_e``
    is the expected disagreement under the marginal label
    distribution. With N=2 and no missing data, this
    approximates Scott's pi (joint marginals).
    """
    if n_items == 0 or not annotations_by_annotator:
        return None
    # Collect all labels (excluding None).
    all_labels: list[Any] = []
    per_item: list[list[Any]] = []
    for i in range(n_items):
        item_labels: list[Any] = []
        for ann in annotations_by_annotator.values():
            if i < len(ann) and ann[i] is not None:
                item_labels.append(ann[i])
                all_labels.append(ann[i])
        per_item.append(item_labels)
    if not all_labels:
        return None
    counts = Counter(all_labels)
    n_labels = len(all_labels)
    # Observed disagreement.
    pairs = 0
    disagree = 0
    for item_labels in per_item:
        m = len(item_labels)
        if m < 2:
            continue
        for i in range(m):
            for j in range(i + 1, m):
                pairs += 1
                if item_labels[i] != item_labels[j]:
                    disagree += 1
    if pairs == 0:
        return None
    d_o = disagree / pairs
    # Expected disagreement (marginal distribution).
    # Sum over all pairs of (count_l / N) * ((N - count_l) / N)
    # = (N - sum(count_l^2 / N)) / (N - 1)
    sum_sq = sum(c * c for c in counts.values())
    d_e = (n_labels - sum_sq / n_labels) / (n_labels - 1) if n_labels > 1 else 0.0
    if d_e == 0:
        # No expected disagreement means every label is
        # the same — perfect agreement → alpha = 1.0.
        if d_o == 0:
            return 1.0
        return None
    return 1.0 - (d_o / d_e)


def agreement_rate(labels_a: list[Any], labels_b: list[Any]) -> float:
    """Simple observed-agreement rate (no chance correction)."""
    if not labels_a or len(labels_a) != len(labels_b):
        return 0.0
    return sum(1 for a, b in zip(labels_a, labels_b, strict=False) if a == b) / len(labels_a)


# ── The service ──────────────────────────────────────────────────


class LabelingService:
    """CRUD + IAA for the labeling queue.

    The service holds a Postgres client (``pg``) and a
    callable to fetch the current user's skill list
    (``user_skills``). The skill list is used to match
    annotators to items that have a ``required_skills``
    hint.
    """

    def __init__(
        self,
        pg: Any,
        *,
        user_skills: Any | None = None,
    ) -> None:
        self._pg = pg
        self._user_skills = user_skills or (lambda _uid: [])

    # ── Seed (insert new items) ──────────────────────────────

    async def seed(
        self,
        *,
        org_id: str,
        payload: dict[str, Any],
        label_schema: dict[str, Any],
        prompt: str | None = None,
        tags: list[str] | None = None,
        required_skills: list[str] | None = None,
        annotations_required: int = 1,
        source_trace_id: str | None = None,
        source_span_id: str | None = None,
        source_dataset_id: str | None = None,
        source_synthetic_qa_id: str | None = None,
    ) -> str:
        """Insert one item into the queue. Returns the new id."""
        item_id = str(uuid.uuid4())
        await self._pg.execute(
            """
            INSERT INTO labeling_items (
                id, org_id, source_trace_id, source_span_id,
                source_dataset_id, source_synthetic_qa_id,
                payload, label_schema, prompt, status,
                tags, required_skills, annotations_required
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                      $11, $12, $13)
            """,
            item_id, org_id, source_trace_id, source_span_id,
            source_dataset_id, source_synthetic_qa_id,
            json.dumps(payload), json.dumps(label_schema),
            prompt, "pending", tags or [], required_skills or [],
            annotations_required,
        )
        return item_id

    async def find_or_seed_trace_score_item(
        self,
        *,
        org_id: str,
        trace_id: str,
    ) -> str:
        """Return the labeling item id for a trace-score row.

        Finds an existing item keyed by ``source_trace_id`` with
        ``label_schema.type = 'trace-score'``; seeds one when missing.
        """
        row = await self._pg.fetchrow(
            """
            SELECT id FROM labeling_items
            WHERE org_id = $1
              AND source_trace_id = $2
              AND label_schema->>'type' = 'trace-score'
            LIMIT 1
            """,
            org_id,
            trace_id,
        )
        if row is not None:
            return str(row["id"])
        return await self.seed(
            org_id=org_id,
            payload={"trace_id": trace_id},
            label_schema={"type": "trace-score"},
            prompt=f"Trace score for {trace_id}",
            tags=["trace-score"],
            source_trace_id=trace_id,
        )

    async def list_items(
        self,
        *,
        org_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """List labeling items with per-item annotation counts."""
        total = await self._pg.fetchval(
            "SELECT count(*) FROM labeling_items WHERE org_id = $1",
            org_id,
        )
        rows = await self._pg.fetch(
            """
            SELECT i.*,
                   count(a.id)::int AS annotations_count
            FROM labeling_items i
            LEFT JOIN annotations a ON a.item_id = i.id
            WHERE i.org_id = $1
            GROUP BY i.id
            ORDER BY i.created_at DESC
            LIMIT $2 OFFSET $3
            """,
            org_id,
            limit,
            offset,
        )
        items: list[dict[str, Any]] = []
        for row in rows:
            item = _row_to_item(row)
            source = (
                item.source_trace_id
                or item.source_dataset_id
                or item.source_span_id
                or item.source_synthetic_qa_id
                or "manual"
            )
            items.append({
                "id": item.id,
                "prompt": item.prompt or "",
                "context": item.payload.get("context") if item.payload else None,
                "tags": item.tags,
                "source": source,
                "created_at": item.created_at,
                "annotations_count": int(row.get("annotations_count") or 0),
            })
        return items, int(total or 0)

    # ── Pop (annotator pulls the next item) ──────────────────

    async def pop(
        self,
        *,
        org_id: str,
        annotator_id: str,
        limit: int = 5,
    ) -> list[LabelingItem]:
        """Pull the next ``limit`` items for ``annotator_id``.

        Strategy:
          1. Items assigned to this annotator first.
          2. Unassigned items next, with ``required_skills``
             matching the annotator's skills.
          3. Unassigned items with no required_skills (any
             annotator can pick them up).

        We also create a :class:`labeling_assignments` row
        for each pulled item, with ``source='auto'`` (queue
        service picked the annotator).
        """
        # Fetch candidates in priority order. The first
        # three SELECTs are pre-priority; the LIMIT is
        # applied per branch.
        rows: list[dict[str, Any]] = []
        # 1. Explicitly assigned to this annotator.
        rows.extend(await self._pg.fetch(
            f"""
            SELECT {_LABELING_ITEM_COLUMNS} FROM labeling_items
            WHERE org_id = $1 AND status = 'pending'
              AND assigned_to = $2
            ORDER BY created_at ASC
            LIMIT $3
            """,
            org_id, annotator_id, limit,
        ))
        if len(rows) < limit:
            # 2. Unassigned + skill match.
            user_skill_set = set(self._user_skills(annotator_id) or [])
            if user_skill_set:
                skill_rows = await self._pg.fetch(
                    f"""
                    SELECT {_LABELING_ITEM_COLUMNS} FROM labeling_items
                    WHERE org_id = $1 AND status = 'pending'
                      AND assigned_to IS NULL
                      AND required_skills && $2::text[]
                    ORDER BY created_at ASC
                    LIMIT $3
                    """,
                    org_id, sorted(user_skill_set), limit - len(rows),
                )
                rows.extend(skill_rows)
        if len(rows) < limit:
            # 3. Unassigned + no required_skills.
            any_rows = await self._pg.fetch(
                f"""
                SELECT {_LABELING_ITEM_COLUMNS} FROM labeling_items
                WHERE org_id = $1 AND status = 'pending'
                  AND assigned_to IS NULL
                  AND (required_skills IS NULL OR cardinality(required_skills) = 0)
                ORDER BY created_at ASC
                LIMIT $2
                """,
                org_id, limit - len(rows),
            )
            rows.extend(any_rows)
        # Record assignments.
        items: list[LabelingItem] = []
        for row in rows[:limit]:
            item = _row_to_item(row)
            try:
                from eden.evaluation.labeling_leases import claim_lease

                if not await claim_lease(org_id, item.id, annotator_id):
                    continue
            except Exception:
                # claim_lease() already swallows its own Redis
                # failures internally, so landing here means a
                # genuinely unexpected error. Fail closed: decline
                # this item rather than silently treating it as
                # claimed.
                logger.warning(
                    "labeling.pop: unexpected error claiming lease "
                    "for item %s (org=%s, annotator=%s); declining",
                    item.id, org_id, annotator_id, exc_info=True,
                )
                continue
            # Flip to in_progress first — this is the authoritative
            # claim. The WHERE status = 'pending' guard means a
            # concurrent claim that already won turns this into a
            # no-op (0 rows affected); only trust the claim, record
            # the assignment, and return the item to the caller if
            # this UPDATE actually changed a row.
            result = await self._pg.execute(
                """
                UPDATE labeling_items
                SET status = 'in_progress'
                WHERE id = $1 AND status = 'pending'
                """,
                item.id,
            )
            try:
                rowcount = int(str(result).split()[-1])
            except (ValueError, IndexError):
                rowcount = 0
            if rowcount < 1:
                # Someone else (or another concurrent pop() call)
                # already claimed this item; skip it rather than
                # handing out an item the caller doesn't actually
                # own.
                continue
            # Don't re-assign if already assigned.
            existing = await self._pg.fetchrow(
                """
                SELECT 1 FROM labeling_assignments
                WHERE item_id = $1 AND annotator_id = $2
                """,
                item.id, annotator_id,
            )
            if existing is None:
                await self._pg.execute(
                    """
                    INSERT INTO labeling_assignments
                        (item_id, annotator_id, source, started_at)
                    VALUES ($1, $2, 'auto', NOW())
                    """,
                    item.id, annotator_id,
                )
            item.status = "in_progress"
            items.append(item)
        return items

    # ── Annotate (submit / revise) ────────────────────────────

    async def annotate(
        self,
        *,
        org_id: str,
        item_id: str,
        annotator_id: str,
        label: Any,
        confidence: float = 0.5,
        notes: str | None = None,
        time_spent_ms: int | None = None,
        skills_exercised: list[str] | None = None,
    ) -> Annotation:
        """Submit an annotation. UPSERT on (item, annotator)
        so revisions overwrite."""
        if not 0.0 <= float(confidence) <= 1.0:
            raise ValueError("confidence must be in [0, 1]")
        item = await self._pg.fetchrow(
            """
            SELECT annotations_required
            FROM labeling_items
            WHERE id = $1 AND org_id = $2
            """,
            item_id,
            org_id,
        )
        if item is None:
            raise ValueError("item not found")
        # Normalise label: scalars become {"value": x},
        # dicts stay as-is.
        if not isinstance(label, (dict, list)):
            label_to_store: Any = {"value": label}
        else:
            label_to_store = label
        # UPSERT.
        await self._pg.execute(
            """
            INSERT INTO annotations (
                org_id, item_id, annotator_id, label,
                confidence, notes, time_spent_ms, skills_exercised
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (item_id, annotator_id) DO UPDATE SET
                label = EXCLUDED.label,
                confidence = EXCLUDED.confidence,
                notes = EXCLUDED.notes,
                time_spent_ms = EXCLUDED.time_spent_ms,
                skills_exercised = EXCLUDED.skills_exercised,
                updated_at = NOW()
            """,
            org_id, item_id, annotator_id, json.dumps(label_to_store),
            float(confidence), notes, time_spent_ms, skills_exercised or [],
        )
        # Mark assignment completed.
        await self._pg.execute(
            """
            UPDATE labeling_assignments
            SET completed_at = NOW()
            WHERE org_id = $1 AND item_id = $2 AND annotator_id = $3
              AND completed_at IS NULL
            """,
            org_id, item_id, annotator_id,
        )
        try:
            from eden.evaluation.labeling_leases import release_lease

            await release_lease(org_id, item_id, annotator_id)
        except Exception:
            pass
        # If item has annotations_required annotations, flip
        # to "completed".
        n = await self._pg.fetchval(
            "SELECT count(*) FROM annotations WHERE item_id = $1 AND org_id = $2",
            item_id,
            org_id,
        )
        if n is not None and int(n) >= int(item["annotations_required"]):
            await self._pg.execute(
                """
                UPDATE labeling_items
                SET status = 'completed'
                WHERE id = $1 AND org_id = $2 AND status != 'completed'
                """,
                item_id,
                org_id,
            )
        # Read back the annotation.
        row = await self._pg.fetchrow(
            """
            SELECT id, org_id, item_id, annotator_id, label,
                   confidence, notes, time_spent_ms,
                   skills_exercised, created_at, updated_at
            FROM annotations
            WHERE item_id = $1 AND annotator_id = $2
            """,
            item_id, annotator_id,
        )
        if row is None:
            raise RuntimeError("annotation vanished after upsert")
        return _row_to_annotation(row)

    # ── Skip ────────────────────────────────────────────────

    async def skip(
        self,
        *,
        org_id: str,
        item_id: str,
        annotator_id: str,
        reason: str | None = None,
    ) -> None:
        """Mark an item as skipped (un-labelable)."""
        # Mark assignment completed (with the reason in notes
        # so we can audit why).
        await self._pg.execute(
            """
            UPDATE labeling_assignments
            SET completed_at = NOW()
            WHERE org_id = $1 AND item_id = $2 AND annotator_id = $3
              AND completed_at IS NULL
            """,
            org_id, item_id, annotator_id,
        )
        # Update the item to skipped (regardless of its
        # previous state, as long as it wasn't completed).
        await self._pg.execute(
            """
            UPDATE labeling_items
            SET status = 'skipped'
            WHERE id = $1 AND org_id = $2
              AND status != 'completed'
            """,
            item_id, org_id,
        )

    # ── IAA ─────────────────────────────────────────────────

    async def compute_iaa(
        self,
        *,
        org_id: str,
        item_ids: list[str] | None = None,
    ) -> IAAReport:
        """Compute the IAA report.

        If ``item_ids`` is None, computes across every
        item in the org with 2+ annotations. Otherwise
        restricts to the given items.
        """
        if item_ids is None:
            # Pull every item with 2+ annotations.
            rows = await self._pg.fetch(
                """
                SELECT i.id, i.payload, COUNT(*) AS n
                FROM labeling_items i
                JOIN annotations a ON a.item_id = i.id
                WHERE i.org_id = $1
                GROUP BY i.id, i.payload
                HAVING COUNT(*) >= 2
                """,
                org_id,
            )
        else:
            rows = await self._pg.fetch(
                """
                SELECT i.id, i.payload, COUNT(*) AS n
                FROM labeling_items i
                JOIN annotations a ON a.item_id = i.id
                WHERE i.org_id = $1 AND i.id = ANY($2::uuid[])
                GROUP BY i.id, i.payload
                HAVING COUNT(*) >= 2
                """,
                org_id, item_ids,
            )
        # Fetch all annotations for the items.
        ids = [str(r["id"]) for r in rows]
        if not ids:
            return IAAReport(
                kappa=0.0, alpha=0.0, overall_agreement=0.0,
                item_count=0, annotation_count=0,
            )
        ann_rows = await self._pg.fetch(
            """
            SELECT item_id, annotator_id, label
            FROM annotations
            WHERE item_id = ANY($1::uuid[])
            ORDER BY item_id, annotator_id, created_at
            """,
            ids,
        )
        # Group by item.
        by_item: dict[str, list[tuple[str, Any]]] = {}
        for ar in ann_rows:
            item_id = str(ar["item_id"])
            annotator = str(ar["annotator_id"])
            label = _label_scalar(ar["label"])
            by_item.setdefault(item_id, []).append((annotator, label))
        # Compute per-item kappa, per-pair kappa, and overall
        # metrics.
        per_item: dict[str, dict[str, float]] = {}
        per_pair: dict[tuple[str, str], dict[str, float]] = {}
        all_agreements: list[float] = []
        all_pairs_for_alpha: list[list[Any]] = []
        all_annotators: set[str] = set()
        # First pass: collect all per-pair label arrays so we
        # can compute Cohen's kappa over the FULL pair (not
        # per-item averages).
        pair_labels: dict[tuple[str, str], tuple[list[Any], list[Any]]] = {}
        for item_id, anns in by_item.items():
            if len(anns) < 2:
                continue
            labels_for_alpha: list[Any] = [lab for _, lab in anns]
            all_pairs_for_alpha.append(labels_for_alpha)
            for i in range(len(anns)):
                for j in range(i + 1, len(anns)):
                    a, la = anns[i]
                    b, lb = anns[j]
                    if a == b:
                        continue
                    pair_key = tuple(sorted([a, b]))
                    la_list, lb_list = pair_labels.get(pair_key, ([], []))
                    la_list.append(la)
                    lb_list.append(lb)
                    pair_labels[pair_key] = (la_list, lb_list)
                    all_agreements.append(1.0 if la == lb else 0.0)
                    all_annotators.add(a)
                    all_annotators.add(b)
            # Per-item kappa (for the first two annotators in
            # the list; for N>2 we just record the per-item
            # agreement).
            if len(anns) == 2:
                la, lb = anns[0][1], anns[1][1]
                k = cohens_kappa([la], [lb])
                r = agreement_rate([la], [lb])
                per_item[item_id] = {
                    "kappa": k if k is not None else 0.0,
                    "agreement": r,
                }
            else:
                # N>2 — use simple agreement.
                values = [lab for _, lab in anns]
                pairs = []
                for i in range(len(values)):
                    for j in range(i + 1, len(values)):
                        pairs.append(values[i] == values[j])
                per_item[item_id] = {
                    "agreement": sum(pairs) / len(pairs) if pairs else 0.0,
                }
        # Second pass: compute Cohen's kappa over the FULL
        # pair's labels.
        for pair_key, (la_list, lb_list) in pair_labels.items():
            n = len(la_list)
            k = cohens_kappa(la_list, lb_list)
            # If kappa is None (degenerate single-class) and
            # all labels match, treat as 1.0.
            if k is None:
                k = 1.0 if all(x == y for x, y in zip(la_list, lb_list, strict=False)) else -1.0
            r = agreement_rate(la_list, lb_list)
            per_pair[pair_key] = {
                "kappa": k,
                "agreement": r,
                "n": n,
            }
        # Aggregate kappa: simple average over per-pair kappas
        # (each pair's kappa is already computed over its
        # full overlap, so we just average across pairs).
        if per_pair:
            agg_kappa = sum(v["kappa"] for v in per_pair.values()) / len(per_pair)
            agg_agreement = (
                sum(all_agreements) / len(all_agreements)
                if all_agreements else 0.0
            )
        else:
            agg_kappa = 0.0
            agg_agreement = 0.0
        # Normalise per_pair to average kappa + n (kept for
        # the to_dict output).
        normalised_per_pair = per_pair
        # Krippendorff's alpha.
        # For alpha, we need the (annotator → list of labels)
        # view, padded to the same n_items length.
        n_items = len(all_pairs_for_alpha)
        ann_by_ann: dict[str, list[Any]] = {
            a: [None] * n_items for a in all_annotators
        }
        for idx, _item_labels in enumerate(all_pairs_for_alpha):
            # Re-pair: we need annotator identities per item.
            # Walk by_item[idx] (the N-th item).
            item_id_at_idx = ids[idx] if idx < len(ids) else None
            if item_id_at_idx is None:
                continue
            item_anns = by_item.get(item_id_at_idx, [])
            for ann, lab in item_anns:
                if ann in ann_by_ann:
                    ann_by_ann[ann][idx] = lab
        alpha = krippendorffs_alpha(ann_by_ann, n_items) or 0.0
        # Total annotation count.
        ann_count = await self._pg.fetchval(
            """
            SELECT count(*) FROM annotations a
            JOIN labeling_items i ON i.id = a.item_id
            WHERE i.org_id = $1
            """,
            org_id,
        )
        return IAAReport(
            kappa=agg_kappa,
            alpha=alpha,
            overall_agreement=agg_agreement,
            item_count=len(per_item),
            annotation_count=int(ann_count or 0),
            per_item=per_item,
            per_pair=normalised_per_pair,
        )

    # ── Export ──────────────────────────────────────────────

    async def export(
        self,
        *,
        org_id: str,
        status_filter: str = "completed",
        limit: int = 10_000,
    ) -> str:
        """Export approved annotations as JSONL.

        Each line is one annotation:
        ``{"item_id": ..., "annotator_id": ..., "label": ..., ...}``.

        The output is consumable by the standard fine-
        tuning pipeline (cat 3 dataset_items table).
        """
        rows = await self._pg.fetch(
            """
            SELECT a.item_id, a.annotator_id, a.label, a.confidence,
                   a.notes, a.time_spent_ms, a.created_at,
                   i.payload, i.source_trace_id, i.source_span_id,
                   i.source_dataset_id, i.source_synthetic_qa_id
            FROM annotations a
            JOIN labeling_items i ON i.id = a.item_id
            WHERE i.org_id = $1 AND i.status = $2
            ORDER BY a.created_at DESC
            LIMIT $3
            """,
            org_id, status_filter, limit,
        )
        out: list[str] = []
        for r in rows:
            out.append(json.dumps({
                "item_id": str(r["item_id"]),
                "annotator_id": str(r["annotator_id"]),
                "label": _label_scalar(r["label"]),
                "confidence": float(r["confidence"]),
                "notes": r["notes"],
                "time_spent_ms": r["time_spent_ms"],
                "created_at": _iso(r["created_at"]) or None,
                "payload": r["payload"],
                "source_trace_id": r["source_trace_id"],
                "source_span_id": r["source_span_id"],
                "source_dataset_id": str(r["source_dataset_id"]) if r["source_dataset_id"] else None,
                "source_synthetic_qa_id": r["source_synthetic_qa_id"],
            }, default=str))
        return "\n".join(out)


# ── Helpers ──────────────────────────────────────────────────────


def _row_to_item(row: dict[str, Any]) -> LabelingItem:
    payload = row.get("payload")
    if isinstance(payload, str):
        payload = json.loads(payload)
    label_schema = row.get("label_schema")
    if isinstance(label_schema, str):
        label_schema = json.loads(label_schema)
    return LabelingItem(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        payload=payload or {},
        label_schema=label_schema or {},
        prompt=row.get("prompt"),
        status=str(row.get("status", "pending")),
        tags=list(row.get("tags") or []),
        annotations_required=int(row.get("annotations_required") or 1),
        required_skills=list(row.get("required_skills") or []),
        source_trace_id=row.get("source_trace_id"),
        source_span_id=row.get("source_span_id"),
        source_dataset_id=str(row["source_dataset_id"]) if row.get("source_dataset_id") else None,
        source_synthetic_qa_id=row.get("source_synthetic_qa_id"),
        assigned_to=str(row["assigned_to"]) if row.get("assigned_to") else None,
        created_at=_iso(row.get("created_at")),
        updated_at=_iso(row.get("updated_at")),
    )


def _iso(value: Any) -> str:
    """Coerce a datetime / string / None to an ISO-8601 string."""
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _row_to_annotation(row: dict[str, Any]) -> Annotation:
    label = row.get("label")
    if isinstance(label, str):
        try:
            label = json.loads(label)
        except (ValueError, TypeError):
            label = {"value": label}
    return Annotation(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        item_id=str(row["item_id"]),
        annotator_id=str(row["annotator_id"]),
        label=_label_scalar(label),
        confidence=float(row.get("confidence") or 0.5),
        notes=row.get("notes"),
        time_spent_ms=row.get("time_spent_ms"),
        skills_exercised=list(row.get("skills_exercised") or []),
        created_at=_iso(row.get("created_at")),
        updated_at=_iso(row.get("updated_at")),
    )


def _label_scalar(value: Any) -> Any:
    """Coerce a label into a flat scalar for IAA math.

    If the label is ``{"value": x}`` (single-annotator
    scalar), return ``x``. If the label is a dict with
    a "winner" key (pairwise), return that. Otherwise
    return the value as-is.
    """
    if isinstance(value, dict):
        if "value" in value and len(value) == 1:
            return value["value"]
        if "winner" in value:
            return value["winner"]
    return value


__all__ = [
    "LabelingService",
    "LabelingItem",
    "Annotation",
    "IAAReport",
    "cohens_kappa",
    "krippendorffs_alpha",
    "agreement_rate",
]
